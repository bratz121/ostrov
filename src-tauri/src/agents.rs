// Status of a coding agent. Claude Code and Codex are read from their session logs;
// Cursor (and Claude's "waiting for you") arrive through hooks on a local port.
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const HOOK_PORT: u16 = 47800;
const DONE_VISIBLE_MS: u64 = 10 * 60 * 1000;
const WAITING_MAX_MS: u64 = 30 * 60 * 1000;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ms(p: &Path) -> Option<u64> {
    fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn newest_log(dir: &Path, depth: u32) -> Option<PathBuf> {
    fn walk(d: &Path, left: u32, best: &mut Option<(u64, PathBuf)>) {
        let Ok(entries) = fs::read_dir(d) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if left > 0 {
                    walk(&p, left - 1, best);
                }
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                if let Some(m) = mtime_ms(&p) {
                    if best.as_ref().map_or(true, |(bm, _)| m > *bm) {
                        *best = Some((m, p));
                    }
                }
            }
        }
    }
    let mut best = None;
    walk(dir, depth, &mut best);
    best.map(|(_, p)| p)
}

/// The last dozen JSON lines of a log, newest first.
fn tail(path: &Path) -> Vec<Value> {
    let Ok(mut f) = File::open(path) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let take = len.min(256 * 1024);
    let _ = f.seek(SeekFrom::Start(len - take));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).lines().rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .take(12).collect()
}

fn read_claude(path: &Path, age: u64) -> &'static str {
    let last = tail(path).into_iter().find(|e| e["type"] == "assistant" || e["type"] == "user");
    let Some(last) = last else { return if age < 15_000 { "working" } else { "idle" } };
    let stop = if last["type"] == "assistant" { last["message"]["stop_reason"].as_str().unwrap_or("") } else { "pending" };
    match stop {
        "end_turn" | "stop_sequence" => "done",
        // a tool can run for minutes without writing to the log
        "tool_use" | "pending" => if age < 15 * 60_000 { "working" } else { "idle" },
        _ => if age < 60_000 { "working" } else { "done" },
    }
}

fn read_codex(path: &Path, age: u64) -> &'static str {
    let kind = tail(path).first().and_then(|e| e["payload"]["type"].as_str().map(str::to_string)).unwrap_or_default();
    if kind == "task_complete" || kind == "turn_aborted" { "done" } else if age < 5 * 60_000 { "working" } else { "idle" }
}

/// What Claude waits for, from a Notification or PreToolUse hook. "Waiting for your
/// input" after a finished turn is skipped: the finished state already covers it.
pub fn ask_from(body: &Value) -> Option<(String, String)> {
    let kind = body["notification_type"].as_str().unwrap_or("");
    let message = body["message"].as_str().unwrap_or("");
    match body["tool_name"].as_str().unwrap_or("") {
        "AskUserQuestion" => {
            let q = body["tool_input"]["questions"][0]["question"].as_str().unwrap_or("");
            return Some(("question".into(), q.into()));
        }
        "ExitPlanMode" => return Some(("plan".into(), String::new())),
        _ => {}
    }
    let lower = message.to_lowercase();
    if kind == "idle_prompt" || kind == "auth_success" || lower.contains("waiting for your input") {
        return None;
    }
    if kind == "permission_prompt" || lower.contains("permission") {
        let detail = lower.find("permission to use ").map(|i| message[i + 18..].trim().to_string()).unwrap_or_default();
        return Some(("permission".into(), detail));
    }
    if kind == "elicitation_dialog" {
        return Some(("question".into(), message.into()));
    }
    (!message.is_empty()).then(|| ("attention".into(), message.into()))
}

#[derive(Default)]
struct Inner {
    agent: String,
    current: Value,
    log: Option<PathBuf>,
    last_scan: u64,
    cursor_status: String,
    waiting: Option<(u64, String, String, String)>, // at, ask, detail, project
}

pub struct Watcher {
    inner: Mutex<Inner>,
    on_change: Box<dyn Fn(&Value, &Value) + Send + Sync>,
}

impl Watcher {
    pub fn new(on_change: impl Fn(&Value, &Value) + Send + Sync + 'static) -> Arc<Watcher> {
        let w = Arc::new(Watcher {
            inner: Mutex::new(Inner { agent: "off".into(), current: json!({ "agent": "off", "status": "off", "since": now() }), cursor_status: "idle".into(), ..Default::default() }),
            on_change: Box::new(on_change),
        });
        let t = w.clone();
        std::thread::spawn(move || loop {
            t.tick();
            std::thread::sleep(Duration::from_millis(1500));
        });
        let s = w.clone();
        std::thread::spawn(move || s.serve());
        w
    }

    pub fn get(&self) -> Value {
        self.inner.lock().unwrap().current.clone()
    }

    pub fn set_agent(&self, name: &str) {
        {
            let mut i = self.inner.lock().unwrap();
            i.agent = name.into();
            i.log = None;
            i.cursor_status = "idle".into();
            i.waiting = None;
        }
        self.tick();
    }

    fn set(&self, i: &mut Inner, status: &str, extra: Value) -> Option<(Value, Value)> {
        let prev = i.current.clone();
        let same = prev["status"] == status && prev["agent"] == i.agent.as_str()
            && prev["ask"] == extra["ask"] && prev["detail"] == extra["detail"];
        if same {
            return None;
        }
        let since = if prev["status"] == status && prev["agent"] == i.agent.as_str() { prev["since"].clone() } else { json!(now()) };
        let mut cur = json!({ "agent": i.agent, "status": status, "since": since });
        if let Value::Object(m) = extra {
            for (k, v) in m {
                cur[k] = v;
            }
        }
        i.current = cur.clone();
        Some((cur, prev))
    }

    pub fn tick(&self) {
        let change = {
            let mut i = self.inner.lock().unwrap();
            self.compute(&mut i)
        };
        if let Some((cur, prev)) = change {
            (self.on_change)(&cur, &prev);
        }
    }

    fn compute(&self, i: &mut Inner) -> Option<(Value, Value)> {
        match i.agent.as_str() {
            "off" => return self.set(i, "off", json!({})),
            "cursor" => {
                let s = i.cursor_status.clone();
                return self.set(i, &s, json!({}));
            }
            _ => {}
        }
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
        let (dir, depth) = if i.agent == "claude" { (home.join(".claude").join("projects"), 2) } else { (home.join(".codex").join("sessions"), 4) };
        let t = now();
        if i.log.is_none() || t - i.last_scan > 15_000 {
            i.log = newest_log(&dir, depth);
            i.last_scan = t;
        }
        let Some(log) = i.log.clone() else { return self.set(i, "idle", json!({})) };
        let Some(mtime) = mtime_ms(&log) else { i.log = None; return None };
        if i.agent == "claude" {
            if let Some((at, ask, detail, project)) = i.waiting.clone() {
                // Claude wrote to its log after asking: it moved on (an answer or a refusal)
                if mtime > at + 4000 || t - at > WAITING_MAX_MS {
                    i.waiting = None;
                } else {
                    return self.set(i, "waiting", json!({ "ask": ask, "detail": detail, "project": project }));
                }
            }
        }
        let age = t.saturating_sub(mtime);
        let mut status = if i.agent == "claude" { read_claude(&log, age) } else { read_codex(&log, age) };
        if status == "done" && age > DONE_VISIBLE_MS {
            status = "idle";
        }
        self.set(i, status, json!({}))
    }

    fn on_claude(&self, event: &str, body: &Value) {
        {
            let mut i = self.inner.lock().unwrap();
            i.last_scan = 0;
            if event == "working" || event == "done" {
                i.waiting = None;
            } else if let Some((ask, detail)) = ask_from(body) {
                let project = body["cwd"].as_str().and_then(|c| Path::new(c).file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                i.waiting = Some((now(), ask, detail, project));
            }
        }
        self.tick();
    }

    fn serve(&self) {
        let Ok(server) = tiny_http::Server::http(("127.0.0.1", HOOK_PORT)) else { return };
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let mut parts = url.trim_start_matches('/').split('/');
            let (a, who, ev) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            let ok = a == "agent" && match (who, ev) {
                ("cursor", "working" | "done" | "idle") => {
                    self.inner.lock().unwrap().cursor_status = ev.into();
                    self.tick();
                    true
                }
                ("claude", "waiting" | "working" | "done") => {
                    let mut raw = String::new();
                    let _ = req.as_reader().take(64 * 1024).read_to_string(&mut raw);
                    let body = serde_json::from_str(&raw).unwrap_or(json!({}));
                    self.on_claude(ev, &body);
                    true
                }
                _ => false,
            };
            let _ = req.respond(tiny_http::Response::empty(if ok { 204 } else { 404 }));
        }
    }
}

pub fn cursor_hooks() -> String {
    serde_json::to_string_pretty(&json!({
        "version": 1,
        "hooks": {
            "beforeSubmitPrompt": [{ "command": format!("curl -s http://127.0.0.1:{HOOK_PORT}/agent/cursor/working") }],
            "stop": [{ "command": format!("curl -s http://127.0.0.1:{HOOK_PORT}/agent/cursor/done") }],
        }
    })).unwrap_or_default()
}
