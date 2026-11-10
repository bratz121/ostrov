#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod bridge;
mod clip;
mod drop;
mod island;
mod store;
mod win;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub struct App {
    pub store: Mutex<store::Store>,
    pub clips: Mutex<Vec<Value>>,
    pub clip_images: Mutex<HashMap<u64, Vec<u8>>>,
    pub last_clip: Mutex<String>,
    pub shelf: Mutex<Vec<Value>>,
    pub media: Mutex<Value>,
    pub art: Mutex<Value>,
    pub volume: Mutex<Value>,
    pub msgs: Mutex<Vec<Value>>,
    pub notify_access: Mutex<Value>,
    pub island_rect: Mutex<(f64, f64)>,
    pub media_stdin: Mutex<Option<ChildStdin>>,
    pub notify_child: Mutex<Option<Child>>,
    pub hidden: Mutex<(bool, bool)>, // (full-screen app, hidden from the tray)
    pub slim: Mutex<bool>,           // a window at the top edge under the island
    pub prev_foreground: Mutex<isize>,
    pub agents: Mutex<Option<Arc<agents::Watcher>>>,
}

const AGENT_NAMES: [(&str, &str); 3] = [("claude", "Claude"), ("cursor", "Cursor"), ("codex", "Codex")];

fn agent_name(id: &str) -> &'static str {
    AGENT_NAMES.iter().find(|(k, _)| *k == id).map(|(_, v)| *v).unwrap_or("Агент")
}

fn waiting_title(ask: &str) -> &'static str {
    match ask {
        "permission" => "Claude ждёт разрешения",
        "question" => "Claude задаёт вопрос",
        "plan" => "Claude ждёт одобрения плана",
        _ => "Claude ждёт вас",
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------- file shelf ----------
fn shelf_item(app: &AppHandle, path: &str, n: usize) -> Value {
    let id = format!("{}-{n}", clip::now_ms());
    let name = std::path::Path::new(path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
    let png = win::file_icon_png(path);
    // the drag image has to be a file on disk
    let icon_path = png.as_ref().and_then(|bytes| {
        let dir = app.path().app_cache_dir().ok()?.join("shelf-icons");
        std::fs::create_dir_all(&dir).ok()?;
        let p = dir.join(format!("{id}.png"));
        std::fs::write(&p, bytes).ok()?;
        Some(p.to_string_lossy().to_string())
    });
    json!({
        "id": id, "path": path, "name": name,
        "icon": png.map(|b| format!("data:image/png;base64,{}", B64.encode(b))).unwrap_or_default(),
        "iconPath": icon_path,
    })
}

fn add_to_shelf(app: &AppHandle, paths: &[String]) {
    let state = app.state::<App>();
    let mut shelf = state.shelf.lock().unwrap();
    for (n, p) in paths.iter().enumerate() {
        if shelf.iter().any(|s| s["path"] == p.as_str()) || !std::path::Path::new(p).exists() {
            continue;
        }
        shelf.push(shelf_item(app, p, n));
    }
    let len = shelf.len();
    if len > 24 {
        shelf.drain(..len - 24);
    }
    persist_shelf(app, &shelf);
}

fn persist_shelf(app: &AppHandle, shelf: &[Value]) {
    let state = app.state::<App>();
    let mut store = state.store.lock().unwrap();
    store.config["shelf"] = json!(shelf.iter().map(|s| s["path"].clone()).collect::<Vec<_>>());
    store.save();
    let _ = app.emit("shelf", shelf.to_vec());
}

// ---------- commands ----------
#[tauri::command]
fn init(app: AppHandle, s: State<App>) -> Value {
    let cfg = s.store.lock().unwrap().config.clone();
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    json!({
        "media": *s.media.lock().unwrap(), "art": *s.art.lock().unwrap(), "volume": *s.volume.lock().unwrap(),
        "clips": *s.clips.lock().unwrap(), "shelf": *s.shelf.lock().unwrap(), "msgs": *s.msgs.lock().unwrap(),
        "notifyAccess": *s.notify_access.lock().unwrap(), "slim": *s.slim.lock().unwrap(), "tasks": cfg["tasks"], "displays": island::list_displays(&app),
        "agent": s.agents.lock().unwrap().as_ref().map(|a| a.get()).unwrap_or(json!({})),
        "settings": {
            "agent": cfg["agent"], "notifyFrom": cfg["notifyFrom"], "autostart": autostart,
            "city": cfg["city"]["name"], "cityObj": cfg["city"], "cursorHooks": agents::cursor_hooks(),
        },
    })
}

#[tauri::command]
fn rect(s: State<App>, w: f64, h: f64) {
    *s.island_rect.lock().unwrap() = (w.min(island::WIN_W), h.min(island::WIN_H));
}

#[tauri::command]
fn media_cmd(app: AppHandle, cmd: String) {
    if ["toggle", "next", "prev"].contains(&cmd.as_str()) {
        bridge::media_write(&app, &cmd);
    }
}

#[tauri::command]
fn set_volume(app: AppHandle, level: f64) {
    if level.is_finite() {
        bridge::media_write(&app, &format!("vol {:.2}", level.clamp(0.0, 100.0) / 100.0));
    }
}

#[tauri::command]
fn toggle_mute(app: AppHandle) {
    bridge::media_write(&app, "mute");
}

/// Plain HTTPS GET for the calendar and weather (the page itself can't: CORS).
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("bad url".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Ostrov/2.0 desktop island (Windows)")
            .timeout(Duration::from_secs(15))
            .build().map_err(|e| e.to_string())?;
        let res = client.get(&url).send().map_err(|_| "offline".to_string())?;
        let status = res.status().as_u16();
        if status >= 400 {
            return Err(format!("status {status}"));
        }
        res.text().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_secret(s: State<App>, key: String) -> Option<String> {
    (key == "calLink").then(|| s.store.lock().unwrap().get_secret(&key)).flatten().filter(|v| !v.is_empty())
}

#[tauri::command]
fn set_secret(s: State<App>, key: String, value: Option<String>) {
    if key == "calLink" {
        s.store.lock().unwrap().set_secret(&key, value.as_deref());
    }
}

/// Settings the page owns. Changing the agent, the monitor or the message source
/// also tells the parts that depend on them.
#[tauri::command]
fn set_config(app: AppHandle, s: State<App>, patch: Value) {
    let Value::Object(map) = patch else { return };
    {
        let mut store = s.store.lock().unwrap();
        for (k, v) in &map {
            if ["agent", "notifyFrom", "city", "tasks", "display"].contains(&k.as_str()) {
                store.config[k] = v.clone();
            }
        }
        store.save();
    }
    if let Some(a) = map.get("agent").and_then(|v| v.as_str()) {
        if let Some(w) = s.agents.lock().unwrap().as_ref() {
            w.set_agent(a);
        }
    }
    if map.contains_key("display") {
        island::place(&app);
    }
    if map.contains_key("notifyFrom") {
        s.msgs.lock().unwrap().clear();
        let _ = app.emit("msgs", Vec::<Value>::new());
        bridge::restart_notify(&app); // re-reads the notification centre with the new filter
    }
}

#[tauri::command]
fn clip_copy(app: AppHandle, id: u64) { clip::copy(&app, id); }

#[tauri::command]
fn clip_clear(app: AppHandle, s: State<App>) {
    let keep: Vec<Value> = s.clips.lock().unwrap().iter().filter(|c| c["pinned"] == true).cloned().collect();
    clip::set(&app, keep);
}

#[tauri::command]
fn clip_pin(app: AppHandle, s: State<App>, id: u64) {
    let next: Vec<Value> = s.clips.lock().unwrap().iter().map(|c| {
        let mut c = c.clone();
        if c["id"].as_u64() == Some(id) {
            c["pinned"] = json!(c["pinned"] != true);
        }
        c
    }).collect();
    clip::set(&app, next);
}

#[tauri::command]
fn clip_remove(app: AppHandle, s: State<App>, id: u64) {
    let next: Vec<Value> = s.clips.lock().unwrap().iter().filter(|c| c["id"].as_u64() != Some(id)).cloned().collect();
    clip::set(&app, next);
}

#[tauri::command]
fn shelf_add(app: AppHandle, paths: Vec<String>) { add_to_shelf(&app, &paths); }

#[tauri::command]
fn shelf_remove(app: AppHandle, s: State<App>, id: String) {
    let mut shelf = s.shelf.lock().unwrap();
    shelf.retain(|x| x["id"] != id.as_str());
    persist_shelf(&app, &shelf);
}

#[tauri::command]
fn shelf_clear(app: AppHandle, s: State<App>) {
    let mut shelf = s.shelf.lock().unwrap();
    shelf.clear();
    persist_shelf(&app, &shelf);
}

fn shelf_path(s: &State<App>, id: &str) -> Option<String> {
    s.shelf.lock().unwrap().iter().find(|x| x["id"] == id).and_then(|x| x["path"].as_str().map(str::to_string))
}

#[tauri::command]
fn shelf_open(app: AppHandle, s: State<App>, id: String) {
    if let Some(p) = shelf_path(&s, &id) { let _ = app.opener().open_path(p, None::<&str>); }
}

#[tauri::command]
fn shelf_reveal(app: AppHandle, s: State<App>, id: String) {
    if let Some(p) = shelf_path(&s, &id) { let _ = app.opener().reveal_item_in_dir(p); }
}

#[tauri::command]
fn msgs_clear(app: AppHandle, s: State<App>) {
    s.msgs.lock().unwrap().clear();
    let _ = app.emit("msgs", Vec::<Value>::new());
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) {
    let a = app.autolaunch();
    let _ = if on { a.enable() } else { a.disable() };
}

#[tauri::command]
fn copy_text(text: String) {
    if let Ok(mut b) = arboard::Clipboard::new() { let _ = b.set_text(text); }
}

#[tauri::command]
fn show_notification(app: AppHandle, title: String, body: String) { notify(&app, &title, &body); }

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    if url.starts_with("https://") { let _ = app.opener().open_url(url, None::<&str>); }
}

#[tauri::command]
fn quit(app: AppHandle) { app.exit(0); }

/// Page errors, printed to the console of a debug build.
#[tauri::command]
fn log(message: String) { eprintln!("[ui] {message}"); }

#[tauri::command]
fn win_focus(app: AppHandle) { island::focus(&app); }

#[tauri::command]
fn win_blur(app: AppHandle) { island::blur(&app); }

// ---------- system load ----------
fn watch_system(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = sysinfo::System::new();
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let cpu = sys.global_cpu_info().cpu_usage().round();
            let mem = if sys.total_memory() > 0 { (sys.used_memory() as f64 / sys.total_memory() as f64 * 100.0).round() } else { 0.0 };
            let _ = app.emit("sys", json!({ "cpu": cpu, "mem": mem }));
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть остров", true, Some("Ctrl+Alt+Space"))?;
    let hide = MenuItem::with_id(app, "hide", "Скрыть с экрана", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &hide, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("ostrov").tooltip("Остров").menu(&menu)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => island::summon(app),
            "hide" => { app.state::<App>().hidden.lock().unwrap().1 = true; island::apply_visibility(app); }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| island::summon(app)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(move |app, sc, ev| {
            if sc == &hotkey && ev.state() == ShortcutState::Pressed {
                island::summon(app);
            }
        }).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            init, rect, media_cmd, set_volume, toggle_mute, http_get, get_secret, set_secret, set_config,
            clip_copy, clip_clear, clip_pin, clip_remove, shelf_add, shelf_remove, shelf_clear, shelf_open, shelf_reveal,
            msgs_clear, set_autostart, copy_text, show_notification, open_url, quit, win_focus, win_blur, log
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let dir = app.path().app_data_dir()?;
            app.manage(App {
                store: Mutex::new(store::Store::open(dir)),
                clips: Mutex::new(vec![]), clip_images: Mutex::new(HashMap::new()), last_clip: Mutex::new(String::new()),
                shelf: Mutex::new(vec![]), media: Mutex::new(json!({ "has": false })), art: Mutex::new(json!({ "key": "", "data": null })),
                volume: Mutex::new(json!({ "level": 0, "muted": false })), msgs: Mutex::new(vec![]),
                notify_access: Mutex::new(json!({ "access": "Unknown", "toasts": null })),
                island_rect: Mutex::new((208.0, 36.0)), media_stdin: Mutex::new(None), notify_child: Mutex::new(None),
                hidden: Mutex::new((false, false)), slim: Mutex::new(false), prev_foreground: Mutex::new(0), agents: Mutex::new(None),
            });

            clip::load(&handle);
            let paths: Vec<String> = handle.state::<App>().store.lock().unwrap().config["shelf"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            add_to_shelf(&handle, &paths);

            let h = handle.clone();
            let watcher = agents::Watcher::new(move |now, prev| {
                let _ = h.emit("agent", now.clone());
                let agent = now["agent"].as_str().unwrap_or("");
                if now["status"] == "done" && prev["status"] == "working" {
                    notify(&h, &format!("{} закончил работу", agent_name(agent)), "Можно возвращаться к задаче.");
                }
                if now["status"] == "waiting" && (prev["status"] != "waiting" || prev["detail"] != now["detail"]) {
                    let body = [now["detail"].as_str().unwrap_or(""), now["project"].as_str().unwrap_or("")]
                        .iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
                    notify(&h, waiting_title(now["ask"].as_str().unwrap_or("")), if body.is_empty() { "Вернитесь к сессии, чтобы продолжить." } else { &body });
                }
            });
            let agent = handle.state::<App>().store.lock().unwrap().config["agent"].as_str().unwrap_or("claude").to_string();
            watcher.set_agent(&agent);
            *handle.state::<App>().agents.lock().unwrap() = Some(watcher);

            let w = island::window(&handle).expect("island window");
            drop::install(&w, handle.clone());
            island::place(&handle);
            let _ = w.show();

            tray(&handle)?;
            // another app (or an island still closing) may hold the hotkey: keep trying
            let h = handle.clone();
            std::thread::spawn(move || {
                for _ in 0..30 {
                    if h.global_shortcut().register(hotkey).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
            island::watch_cursor(handle.clone());
            island::watch_displays(handle.clone());
            island::watch_under(handle.clone());
            bridge::start_media(handle.clone());
            bridge::start_notify(handle.clone());
            clip::watch(handle.clone());
            watch_system(handle.clone());

            // debug builds: test the "is there something under it" check on given areas
            #[cfg(debug_assertions)]
            if let Ok(spec) = std::env::var("OSTROV_PROBE_AREA") {
                // after the island has hidden itself from screen capture
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    for area in spec.split(';') {
                        let v: Vec<i32> = area.split(',').filter_map(|n| n.trim().parse().ok()).collect();
                        if v.len() == 4 {
                            eprintln!("[area] {area} busy={}", win::area_busy(v[0], v[1], v[2], v[3]));
                        }
                    }
                });
            }
            // debug builds: run a bit of script in the page for testing (OSTROV_EVAL)
            #[cfg(debug_assertions)]
            if let Ok(js) = std::env::var("OSTROV_EVAL") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(4));
                    if let Some(w) = island::window(&h) {
                        let _ = w.eval(&js);
                    }
                });
            }
            // design screenshots: OSTROV_VIEW=home:demo
            if let Ok(view) = std::env::var("OSTROV_VIEW") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(3500));
                    let _ = h.emit("debug", view);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Остров не запустился");
}
