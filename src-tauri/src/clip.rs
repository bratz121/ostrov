// Clipboard history: links, text and screenshots. The list and every full image are
// stored DPAPI-encrypted; pinned entries are kept out of the limits and "Очистить".
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::{win, App};

const MAX_CLIPS: usize = 40;
const MAX_IMAGES: usize = 12;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_link(s: &str) -> bool {
    let t = s.trim();
    (t.starts_with("http://") || t.starts_with("https://")) && !t.contains(char::is_whitespace)
}

pub fn load(app: &AppHandle) {
    let state = app.state::<App>();
    let store = state.store.lock().unwrap();
    let list: Vec<Value> = fs::read(store.clips_file()).ok()
        .and_then(|b| win::unprotect(&b))
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if let Some(sig) = list.first().and_then(|c| c["sig"].as_str()) {
        *state.last_clip.lock().unwrap() = sig.to_string();
    }
    *state.clips.lock().unwrap() = list;
}

fn save(app: &AppHandle) {
    let state = app.state::<App>();
    let list = state.clips.lock().unwrap().clone();
    let store = state.store.lock().unwrap();
    if let Some(enc) = serde_json::to_vec(&list).ok().and_then(|b| win::protect(&b)) {
        let _ = fs::write(store.clips_file(), enc);
    }
}

pub fn set(app: &AppHandle, next: Vec<Value>) {
    let state = app.state::<App>();
    {
        let old = state.clips.lock().unwrap();
        let store = state.store.lock().unwrap();
        for c in old.iter().filter(|c| c["kind"] == "image") {
            if !next.iter().any(|n| n["id"] == c["id"]) {
                if let Some(id) = c["id"].as_u64() {
                    let _ = fs::remove_file(store.clip_image_file(id));
                    state.clip_images.lock().unwrap().remove(&id);
                }
            }
        }
    }
    *state.clips.lock().unwrap() = next.clone();
    let _ = app.emit("clips", next);
    save(app);
}

fn add(app: &AppHandle, mut entry: Value) {
    let list = app.state::<App>().clips.lock().unwrap().clone();
    if list.iter().any(|c| c["sig"] == entry["sig"] && c["pinned"] == true) {
        entry["pinned"] = json!(true); // copying a pinned entry again keeps the pin
    }
    let mut next = vec![entry.clone()];
    next.extend(list.into_iter().filter(|c| c["sig"] != entry["sig"]));
    // limits count only unpinned entries
    let (mut loose, mut images) = (0, 0);
    next.retain(|c| {
        if c["pinned"] == true {
            return true;
        }
        loose += 1;
        if c["kind"] == "image" {
            images += 1;
        }
        loose <= MAX_CLIPS && (c["kind"] != "image" || images <= MAX_IMAGES)
    });
    set(app, next);
}

/// A 12×12 sample of the pixels plus the size: enough to tell screenshots apart.
fn signature(w: usize, h: usize, rgba: &[u8]) -> String {
    let mut hash: u32 = 0;
    for gy in 0..12 {
        for gx in 0..12 {
            let i = ((gy * h / 12) * w + gx * w / 12) * 4;
            for b in &rgba[i..i + 4] {
                hash = hash.wrapping_mul(31).wrapping_add(*b as u32);
            }
        }
    }
    format!("img:{w}x{h}:{hash}")
}

fn png(img: &image::RgbaImage) -> Option<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn poll(app: &AppHandle, board: &mut arboard::Clipboard) {
    let state = app.state::<App>();
    let text = board.get_text().unwrap_or_default();
    if text.trim().is_empty() {
        let Ok(img) = board.get_image() else { return };
        let (w, h) = (img.width, img.height);
        if w == 0 || h == 0 {
            return;
        }
        let sig = signature(w, h, &img.bytes);
        if *state.last_clip.lock().unwrap() == sig {
            return;
        }
        *state.last_clip.lock().unwrap() = sig.clone();
        let Some(full) = image::RgbaImage::from_raw(w as u32, h as u32, img.bytes.into_owned()) else { return };
        let tw = (w as u32).min(400);
        let th = ((h as u32) * tw / (w as u32)).max(1);
        let thumb = image::imageops::resize(&full, tw, th, image::imageops::FilterType::Triangle);
        let id = now_ms();
        if let Some(bytes) = png(&full) {
            let store = state.store.lock().unwrap();
            let _ = fs::create_dir_all(store.dir.join("clips"));
            if let Some(enc) = win::protect(&bytes) {
                let _ = fs::write(store.clip_image_file(id), enc);
            }
            state.clip_images.lock().unwrap().insert(id, bytes);
        }
        let thumb_url = png(&thumb).map(|b| format!("data:image/png;base64,{}", B64.encode(b))).unwrap_or_default();
        add(app, json!({ "id": id, "kind": "image", "sig": sig, "width": w, "height": h, "thumb": thumb_url, "at": id }));
        return;
    }
    let sig = format!("txt:{text}");
    if *state.last_clip.lock().unwrap() == sig {
        return;
    }
    *state.last_clip.lock().unwrap() = sig.clone();
    let kind = if is_link(&text) { "link" } else { "text" };
    let short: String = text.chars().take(4000).collect();
    add(app, json!({ "id": now_ms(), "kind": kind, "sig": sig, "text": short, "at": now_ms() }));
}

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut seq = 0;
        let mut board = arboard::Clipboard::new().ok();
        loop {
            let now = win::clipboard_seq();
            if now != seq {
                seq = now;
                // the app that just copied may still hold the clipboard open
                std::thread::sleep(Duration::from_millis(120));
                if board.is_none() {
                    board = arboard::Clipboard::new().ok();
                }
                if let Some(b) = board.as_mut() {
                    poll(&app, b);
                }
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    });
}

fn image_png(app: &AppHandle, id: u64) -> Option<Vec<u8>> {
    let state = app.state::<App>();
    if let Some(b) = state.clip_images.lock().unwrap().get(&id) {
        return Some(b.clone());
    }
    let path = state.store.lock().unwrap().clip_image_file(id);
    let bytes = win::unprotect(&fs::read(path).ok()?)?;
    state.clip_images.lock().unwrap().insert(id, bytes.clone());
    Some(bytes)
}

pub fn copy(app: &AppHandle, id: u64) {
    let state = app.state::<App>();
    let Some(item) = state.clips.lock().unwrap().iter().find(|c| c["id"].as_u64() == Some(id)).cloned() else { return };
    // copying an entry back must not add it again
    *state.last_clip.lock().unwrap() = item["sig"].as_str().unwrap_or_default().to_string();
    let Ok(mut board) = arboard::Clipboard::new() else { return };
    if item["kind"] == "image" {
        let Some(img) = image_png(app, id).and_then(|b| image::load_from_memory(&b).ok()) else { return };
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let _ = board.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: Cow::Owned(rgba.into_raw()) });
    } else if let Some(t) = item["text"].as_str() {
        let _ = board.set_text(t.to_string());
    }
}
