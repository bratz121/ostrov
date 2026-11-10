// Settings on disk, plus a one-time move of everything the Electron build saved.
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::win;

pub struct Store {
    pub dir: PathBuf,
    pub config: Value,
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        let _ = fs::create_dir_all(&dir);
        let mut store = Store { dir, config: json!({}) };
        if !store.config_path().exists() {
            store.migrate_from_electron();
        }
        if let Ok(text) = fs::read_to_string(store.config_path()) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                store.config = v;
            }
        }
        let defaults = json!({ "agent": "claude", "notifyFrom": "yandex", "tasks": [], "shelf": [], "city": null, "display": null });
        for (k, v) in defaults.as_object().unwrap() {
            if store.config.get(k).is_none() {
                store.config[k] = v.clone();
            }
        }
        store
    }

    fn config_path(&self) -> PathBuf {
        self.dir.join("config.json")
    }

    pub fn save(&self) {
        let _ = fs::write(self.config_path(), serde_json::to_string_pretty(&self.config).unwrap_or_default());
    }

    pub fn get_secret(&self, key: &str) -> Option<String> {
        let raw = B64.decode(self.config.get(key)?.as_str()?).ok()?;
        String::from_utf8(win::unprotect(&raw)?).ok()
    }

    pub fn set_secret(&mut self, key: &str, value: Option<&str>) {
        self.config[key] = match value.and_then(|v| win::protect(v.as_bytes())) {
            Some(enc) => Value::String(B64.encode(enc)),
            None => Value::String(String::new()),
        };
        self.save();
    }

    pub fn clips_file(&self) -> PathBuf {
        self.dir.join("clips.bin")
    }

    pub fn clip_image_file(&self, id: u64) -> PathBuf {
        self.dir.join("clips").join(format!("{id}.bin"))
    }

    /// The Electron build kept settings in %APPDATA%\Ostrov and encrypted secrets with
    /// Chromium's os_crypt key (AES-256-GCM, the key itself DPAPI-protected).
    fn migrate_from_electron(&mut self) {
        let Some(old) = std::env::var_os("APPDATA").map(|a| Path::new(&a).join("Ostrov")) else { return };
        let Ok(text) = fs::read_to_string(old.join("config.json")) else { return };
        let Ok(mut cfg) = serde_json::from_str::<Value>(&text) else { return };
        let key = chromium_key(&old);

        let link = cfg.get("calLink").and_then(|v| v.as_str()).and_then(|s| B64.decode(s).ok())
            .and_then(|b| key.as_ref().and_then(|k| chromium_decrypt(k, &b)));
        cfg["calLink"] = Value::String(String::new());
        cfg["display"] = Value::Null; // Electron display ids mean nothing here
        self.config = cfg;
        if let Some(link) = link.and_then(|b| String::from_utf8(b).ok()) {
            self.set_secret("calLink", Some(&link));
        }

        if let Some(k) = key.as_ref() {
            if let Some(list) = fs::read(old.join("clips.bin")).ok().and_then(|b| chromium_decrypt(k, &b)) {
                if let Some(enc) = win::protect(&list) {
                    let _ = fs::write(self.clips_file(), enc);
                }
                if let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&list) {
                    let _ = fs::create_dir_all(self.dir.join("clips"));
                    for it in items.iter().filter(|c| c["kind"] == "image") {
                        let Some(id) = it["id"].as_u64() else { continue };
                        let png = fs::read(old.join("clips").join(format!("{id}.bin"))).ok()
                            .and_then(|b| chromium_decrypt(k, &b))
                            .and_then(|b64| B64.decode(b64).ok());
                        if let Some(enc) = png.and_then(|p| win::protect(&p)) {
                            let _ = fs::write(self.clip_image_file(id), enc);
                        }
                    }
                }
            }
        }
        self.save();
    }
}

fn chromium_key(dir: &Path) -> Option<Vec<u8>> {
    let state: Value = serde_json::from_str(&fs::read_to_string(dir.join("Local State")).ok()?).ok()?;
    let enc = B64.decode(state["os_crypt"]["encrypted_key"].as_str()?).ok()?;
    win::unprotect(enc.strip_prefix(b"DPAPI")?)
}

fn chromium_decrypt(key: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let body = data.strip_prefix(b"v10")?;
    if body.len() < 12 + 16 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    cipher.decrypt(Nonce::from_slice(&body[..12]), &body[12..]).ok()
}
