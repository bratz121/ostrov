// The island window: which monitor it sits on, letting clicks through everywhere
// except over the island, hiding for full-screen apps, and keyboard focus.
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewWindow};

use crate::{win, App};

pub const WIN_W: f64 = 880.0;
pub const WIN_H: f64 = 330.0;

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("island")
}

fn monitors(app: &AppHandle) -> Vec<Monitor> {
    window(app).and_then(|w| w.available_monitors().ok()).unwrap_or_default()
}

fn primary(app: &AppHandle) -> Option<Monitor> {
    window(app).and_then(|w| w.primary_monitor().ok().flatten())
}

fn id_of(m: &Monitor) -> String {
    m.name().cloned().unwrap_or_default()
}

/// The monitor chosen in settings, or the primary one.
pub fn island_monitor(app: &AppHandle) -> Option<Monitor> {
    let chosen = app.state::<App>().store.lock().unwrap().config["display"].as_str().map(str::to_string);
    chosen.and_then(|id| monitors(app).into_iter().find(|m| id_of(m) == id)).or_else(|| primary(app))
}

pub fn list_displays(app: &AppHandle) -> Value {
    let primary_id = primary(app).map(|m| id_of(&m)).unwrap_or_default();
    let mut list = monitors(app);
    list.sort_by_key(|m| (id_of(m) != primary_id, m.position().x));
    let mut n = 1;
    let items: Vec<Value> = list.iter().map(|m| {
        let name = if id_of(m) == primary_id { "Основной".to_string() } else { n += 1; format!("Экран {n}") };
        json!({ "id": id_of(m), "name": name, "label": "", "size": format!("{}×{}", m.size().width, m.size().height) })
    }).collect();
    json!({ "list": items, "current": island_monitor(app).map(|m| id_of(&m)) })
}

pub fn place(app: &AppHandle) {
    let (Some(w), Some(m)) = (window(app), island_monitor(app)) else { return };
    let scale = m.scale_factor();
    let _ = w.set_size(LogicalSize::new(WIN_W, WIN_H));
    let x = m.position().x + ((m.size().width as f64 - WIN_W * scale) / 2.0).round() as i32;
    let _ = w.set_position(PhysicalPosition::new(x, m.position().y));
}

/// Click-through except while the cursor is over the island. Polling the cursor
/// (rather than mouse events, which a click-through window never gets) also
/// catches files dragged onto it.
pub fn watch_cursor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut inside = false;
        #[cfg(debug_assertions)]
        if std::env::var("OSTROV_NO_CLICKTHROUGH").is_ok() {
            return;
        }
        let _ = window(&app).map(|w| w.set_ignore_cursor_events(true));
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let Some(w) = window(&app) else { continue };
            if !w.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else { continue };
            let (mut rw, mut rh) = *app.state::<App>().island_rect.lock().unwrap();
            // something is being dragged: catch it over the whole compact island,
            // even while the island is folded to a thin strip
            if win::mouse_down() {
                rw = rw.max(240.0);
                rh = rh.max(40.0);
            }
            let (cx, cy) = win::cursor();
            let center = pos.x as f64 + size.width as f64 / 2.0;
            let now = ((cx as f64) - center).abs() <= rw * scale / 2.0 + 2.0
                && cy >= pos.y && (cy as f64) <= pos.y as f64 + rh * scale + 2.0;
            if now != inside {
                inside = now;
                #[cfg(debug_assertions)]
                eprintln!("[cursor] inside={inside} at {cx},{cy} rect {rw}x{rh}");
                let _ = w.set_ignore_cursor_events(!inside);
            }
        }
    });
}

/// The idle island folds to a thin strip only when it would cover something: an app
/// window lies under it (a maximized browser, active or not) and the spot the
/// compact island takes holds text, tabs or a picture, not a flat empty colour.
pub fn watch_under(app: AppHandle) {
    std::thread::spawn(move || {
        let mut votes = 0i32; // a couple of agreeing looks before switching, so it doesn't flicker
        let mut excluded = false;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let (Some(w), Some(m)) = (window(&app), island_monitor(&app)) else { continue };
            let own = w.hwnd().map(|h| h.0 as isize).unwrap_or(0);
            if !excluded && own != 0 {
                win::exclude_from_capture(own);
                excluded = true;
            }
            let scale = m.scale_factor();
            let cx = m.position().x + m.size().width as i32 / 2;
            let top = m.position().y;
            // the compact island with its ears: 208×36 plus 16 each side
            let (aw, ah) = ((240.0 * scale) as i32, (36.0 * scale) as i32);
            let app_under = win::app_window_at(cx, top + (8.0 * scale) as i32, own);
            let busy = app_under && win::area_busy(cx - aw / 2, top, aw, ah);
            #[cfg(debug_assertions)]
            if std::env::var("OSTROV_TRACE_SLIM").is_ok() {
                eprintln!("[under] app={app_under} busy={busy}");
            }
            let want = busy;
            let state = app.state::<App>();
            let now = *state.slim.lock().unwrap();
            votes = if want != now { votes + 1 } else { 0 };
            if votes < 2 {
                continue;
            }
            votes = 0;
            #[cfg(debug_assertions)]
            eprintln!("[slim] {want}");
            *state.slim.lock().unwrap() = want;
            let _ = app.emit("slim", want);
        }
    });
}

/// Monitors coming and going: put the island back and refresh the settings list.
pub fn watch_displays(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let now = list_displays(&app).to_string();
            if now != last {
                if !last.is_empty() {
                    place(&app);
                    let _ = app.emit("displays", list_displays(&app));
                }
                last = now;
            }
        }
    });
}

pub fn apply_visibility(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    let (fullscreen, by_user) = *app.state::<App>().hidden.lock().unwrap();
    let show = !fullscreen && !by_user;
    let visible = w.is_visible().unwrap_or(false);
    if show && !visible {
        let _ = w.show();
    }
    if !show && visible {
        let _ = app.emit("hidden", ());
        let _ = w.hide();
    }
}

/// media.ps1 reports the foreground window covering its monitor, in physical pixels.
pub fn on_fullscreen(app: &AppHandle, msg: &Value) {
    // is the foreground window's monitor the island's monitor?
    let here = island_monitor(app).is_some_and(|m| {
        let cx = msg["x"].as_i64().unwrap_or(0) + msg["w"].as_i64().unwrap_or(0) / 2;
        let cy = msg["y"].as_i64().unwrap_or(0) + msg["h"].as_i64().unwrap_or(0) / 2;
        let (p, s) = (m.position(), m.size());
        cx >= p.x as i64 && cx < p.x as i64 + s.width as i64 && cy >= p.y as i64 && cy < p.y as i64 + s.height as i64
    });
    let full = here && msg["full"] == true;
    let state = app.state::<App>();
    {
        let mut h = state.hidden.lock().unwrap();
        if h.0 == full {
            return;
        }
        h.0 = full;
    }
    apply_visibility(app);
}

/// The hotkey and the tray bring the island back even over a full-screen app;
/// the page decides whether to open or close.
pub fn summon(app: &AppHandle) {
    app.state::<App>().hidden.lock().unwrap().1 = false;
    if let Some(w) = window(app) {
        if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
        }
    }
    let _ = app.emit("toggle", ());
}

pub fn focus(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    let fg = win::foreground();
    let own = w.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    if fg != own {
        *app.state::<App>().prev_foreground.lock().unwrap() = fg;
    }
    let _ = w.set_focus();
}

/// Hand focus back to the window the person was in before the hotkey.
pub fn blur(app: &AppHandle) {
    let prev = std::mem::take(&mut *app.state::<App>().prev_foreground.lock().unwrap());
    win::set_foreground(prev);
}
