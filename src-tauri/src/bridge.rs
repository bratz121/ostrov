// The PowerShell bridges from the Electron build, unchanged: media.ps1 (now playing,
// volume, full-screen detection) and notify.ps1 (Windows notifications).
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::App;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Bundled next to the app; during development they sit in the project root.
fn script(app: &AppHandle, name: &str) -> PathBuf {
    if let Ok(p) = app.path().resolve(name, tauri::path::BaseDirectory::Resource) {
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(name)
}

fn spawn(app: &AppHandle, name: &str) -> Option<std::process::Child> {
    Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script(app, name))
        .arg(std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()
}

pub fn media_write(app: &AppHandle, line: &str) {
    if let Some(stdin) = app.state::<App>().media_stdin.lock().unwrap().as_mut() {
        let _ = writeln!(stdin, "{line}");
    }
}

pub fn start_media(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(mut child) = spawn(&app, "media.ps1") {
            *app.state::<App>().media_stdin.lock().unwrap() = child.stdin.take();
            if let Some(out) = child.stdout.take() {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    let state = app.state::<App>();
                    match msg["type"].as_str() {
                        Some("state") => { *state.media.lock().unwrap() = msg.clone(); let _ = app.emit("media", msg); }
                        Some("art") => {
                            let art = json!({ "key": msg["key"], "data": msg["data"] });
                            *state.art.lock().unwrap() = art.clone();
                            let _ = app.emit("art", art);
                        }
                        Some("vol") => {
                            let vol = json!({ "level": msg["level"], "muted": msg["muted"] });
                            *state.volume.lock().unwrap() = vol.clone();
                            let _ = app.emit("vol", vol);
                        }
                        Some("fs") => crate::island::on_fullscreen(&app, &msg),
                        _ => {}
                    }
                }
            }
            let _ = child.wait();
        }
        std::thread::sleep(Duration::from_secs(3));
    });
}

fn from_yandex(n: &Value) -> bool {
    let s = format!("{} {}", n["app"].as_str().unwrap_or(""), n["aumid"].as_str().unwrap_or("")).to_lowercase();
    s.contains("yandex") || s.contains("яндекс")
}

fn is_own(n: &Value) -> bool {
    let s = format!("{} {}", n["app"].as_str().unwrap_or(""), n["aumid"].as_str().unwrap_or("")).to_lowercase();
    s.contains("ostrov") || s.contains("остров")
}

pub fn restart_notify(app: &AppHandle) {
    if let Some(mut c) = app.state::<App>().notify_child.lock().unwrap().take() {
        let _ = c.kill();
    }
}

pub fn start_notify(app: AppHandle) {
    std::thread::spawn(move || loop {
        let mut allowed = false;
        if let Some(mut child) = spawn(&app, "notify.ps1") {
            let out = child.stdout.take();
            *app.state::<App>().notify_child.lock().unwrap() = Some(child);
            if let Some(out) = out {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let Ok(n) = serde_json::from_str::<Value>(&line) else { continue };
                    let state = app.state::<App>();
                    match n["type"].as_str() {
                        Some("status") => {
                            allowed = n["access"] == "Allowed";
                            let access = json!({ "access": n["access"], "toasts": n["toasts"] });
                            *state.notify_access.lock().unwrap() = access.clone();
                            let _ = app.emit("notifyAccess", access);
                        }
                        Some("gone") => {
                            let mut msgs = state.msgs.lock().unwrap();
                            msgs.retain(|m| m["id"] != n["id"]);
                            let _ = app.emit("msgs", msgs.clone());
                        }
                        Some("add") if !is_own(&n) => {
                            let all = state.store.lock().unwrap().config["notifyFrom"] == "all";
                            if !all && !from_yandex(&n) {
                                continue;
                            }
                            let texts: Vec<String> = match &n["texts"] {
                                Value::Array(a) => a.iter().filter_map(|t| t.as_str().map(str::to_string)).filter(|t| !t.is_empty()).collect(),
                                Value::String(s) => vec![s.clone()],
                                _ => vec![],
                            };
                            let app_name = n["app"].as_str().filter(|s| !s.is_empty()).unwrap_or("Уведомление").to_string();
                            let msg = json!({
                                "id": n["id"], "app": app_name,
                                "title": texts.first().cloned().unwrap_or_else(|| app_name.clone()),
                                "body": texts.iter().skip(1).cloned().collect::<Vec<_>>().join(" · "),
                                "at": n["at"].as_u64().unwrap_or_else(crate::clip::now_ms),
                                "initial": n["initial"] == true,
                            });
                            let mut msgs = state.msgs.lock().unwrap();
                            msgs.retain(|m| m["id"] != msg["id"]);
                            msgs.insert(0, msg.clone());
                            msgs.truncate(40);
                            let _ = app.emit("msgs", msgs.clone());
                            if msg["initial"] != true {
                                let _ = app.emit("msg", msg);
                            }
                        }
                        _ => {}
                    }
                }
            }
            if let Some(mut c) = app.state::<App>().notify_child.lock().unwrap().take() {
                let _ = c.wait();
            }
        }
        std::thread::sleep(Duration::from_secs(if allowed { 3 } else { 60 }));
    });
}
