//! Files of the chat: blobs the members encrypted themselves, each with its own key that travels inside the group.
//! The server keeps them by their SHA-256 in `chat-media/`, knows neither their name nor their type, and lets only
//! members of the journal put or take them. A blob goes 90 days after it was put, like the messages.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path as UrlPath, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;
use crate::api::{MAX_BODY, signed};
use crate::auth::{error, member_only, unix_now};
use crate::group_api::RateLimit;

pub const CHAT_MEDIA_DIR: &str = "chat-media";
/// 25 MiB of a file, sealed: a 24-byte nonce in front and a 16-byte tag behind.
pub const MAX_BLOB: usize = 25 * 1024 * 1024 + 40;
/// A file over 25 MB goes in parts of 16 MB, each a blob of its own: a 2 GB one is 129 of them.
pub const UPLOADS_PER_MINUTE: usize = 200;
pub const KEEP_BLOBS: u64 = 90 * 24 * 3600;
/// All the blobs together, at most: nobody fills the disk of the PC the server runs on.
pub const MAX_STORED: u64 = 20 * 1024 * 1024 * 1024;

pub fn upload_limit() -> RateLimit {
    RateLimit::per(UPLOADS_PER_MINUTE, Duration::from_secs(60))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn unix(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutError {
    /// The blobs kept already take [`MAX_STORED`].
    Full,
    Disk(String),
}

/// Blobs on disk in the data folder (when they were put is the file's time), or in memory for a server without one.
pub struct ChatMediaStore {
    dir: Option<PathBuf>,
    memory: RwLock<HashMap<String, (Vec<u8>, u64)>>,
    cap: u64,
    /// How much the blobs kept take.
    used: Mutex<u64>,
}

/// The size of the blobs in `dir`.
fn stored(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let blobs = entries.flatten().filter(|entry| is_hash(&entry.file_name().to_string_lossy()));
    blobs.filter_map(|entry| entry.metadata().ok()).map(|m| m.len()).sum()
}

impl ChatMediaStore {
    pub fn open(data_dir: Option<&Path>) -> Self {
        Self::with_cap(data_dir, MAX_STORED)
    }

    pub fn with_cap(data_dir: Option<&Path>, cap: u64) -> Self {
        let dir = data_dir.map(|d| d.join(CHAT_MEDIA_DIR));
        let used = dir.as_deref().map(stored).unwrap_or(0);
        Self { dir, memory: RwLock::default(), cap, used: Mutex::new(used) }
    }

    /// Room for `size` more bytes, taken; false when it would go over the cap.
    fn reserve(&self, size: u64) -> bool {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        if *used + size > self.cap {
            return false;
        }
        *used += size;
        true
    }

    fn release(&self, size: u64) {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        *used = used.saturating_sub(size);
    }

    /// Keeps `bytes` under their SHA-256 (hex), put at `now`; the same blob again only renews its time.
    pub fn put(&self, bytes: &[u8], now: u64) -> Result<String, PutError> {
        let sha = hex(&hv_roster::keys::sha256(bytes));
        let size = bytes.len() as u64;
        let Some(dir) = &self.dir else {
            let mut memory = self.memory.write().unwrap_or_else(|e| e.into_inner());
            if let Some(kept) = memory.get_mut(&sha) {
                kept.1 = now;
                return Ok(sha);
            }
            if !self.reserve(size) {
                return Err(PutError::Full);
            }
            memory.insert(sha.clone(), (bytes.to_vec(), now));
            return Ok(sha);
        };
        let disk = |e: std::io::Error| PutError::Disk(e.to_string());
        std::fs::create_dir_all(dir).map_err(disk)?;
        let path = dir.join(&sha);
        if path.exists() {
            let renewed = std::fs::File::options().write(true).open(&path).and_then(|file| file.set_modified(SystemTime::now()));
            renewed.map_err(disk)?;
            return Ok(sha);
        }
        if !self.reserve(size) {
            return Err(PutError::Full);
        }
        let temp = dir.join(format!("{sha}.part"));
        if let Err(e) = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, &path)) {
            self.release(size);
            return Err(disk(e));
        }
        Ok(sha)
    }

    pub fn get(&self, sha: &str) -> Option<Vec<u8>> {
        if !is_hash(sha) {
            return None;
        }
        match &self.dir {
            Some(dir) => std::fs::read(dir.join(sha)).ok(),
            None => self.memory.read().unwrap_or_else(|e| e.into_inner()).get(sha).map(|(bytes, _)| bytes.clone()),
        }
    }

    /// Drops blobs put [`KEEP_BLOBS`] or longer before `now`, and leftovers of uploads that broke off.
    pub fn prune(&self, now: u64) {
        let old = |at: u64| now.saturating_sub(at) >= KEEP_BLOBS;
        let Some(dir) = &self.dir else {
            let mut memory = self.memory.write().unwrap_or_else(|e| e.into_inner());
            memory.retain(|_, (_, at)| !old(*at));
            *self.used.lock().unwrap_or_else(|e| e.into_inner()) = memory.values().map(|(bytes, _)| bytes.len() as u64).sum();
            return;
        };
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let at = entry.metadata().and_then(|m| m.modified()).map(unix).unwrap_or(0);
            let stale = if is_hash(&name) { old(at) } else { name.ends_with(".part") && now.saturating_sub(at) >= 3600 };
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        // Counted again from the disk: what went is free, and nothing counted twice stays so.
        *self.used.lock().unwrap_or_else(|e| e.into_inner()) = stored(dir);
    }
}

/// `POST /api/chat-media` with the blob as the body (members only) → `{"sha256", "size"}`.
pub async fn upload(State(state): State<AppState>, request: Request) -> Response {
    // Read one byte past the limit, so an oversized blob gets its own answer.
    let (_, bytes, who) = match signed(&state, request, MAX_BLOB + 1).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if bytes.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Пустой файл");
    }
    if bytes.len() > MAX_BLOB {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Файл больше 25 МБ");
    }
    if !state.chat_media_rate.allow(&who.user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много файлов — подожди минуту");
    }
    match state.chat_media.put(&bytes, unix_now()) {
        Ok(sha) => Json(json!({ "sha256": sha, "size": bytes.len() })).into_response(),
        Err(PutError::Full) => error(StatusCode::INSUFFICIENT_STORAGE, "На сервере кончилось место для файлов"),
        Err(PutError::Disk(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("Файл не сохранился: {e}")),
    }
}

/// `GET /api/chat-media/{sha256}` (members only): the blob as it was put.
pub async fn download(State(state): State<AppState>, UrlPath(sha): UrlPath<String>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if !is_hash(&sha) {
        return error(StatusCode::BAD_REQUEST, "Испорчена ссылка на файл");
    }
    match state.chat_media.get(&sha) {
        Some(bytes) => ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response(),
        None => error(StatusCode::NOT_FOUND, "Файл не найден"),
    }
}

/// Prunes old blobs now and then once a day.
pub fn spawn_prune(state: AppState) {
    tokio::spawn(async move {
        loop {
            state.chat_media.prune(unix_now());
            tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;

    #[test]
    fn blobs_go_after_ninety_days_in_memory() {
        let store = ChatMediaStore::open(None);
        let sha = store.put(b"sealed", T0).unwrap();
        store.prune(T0 + KEEP_BLOBS - 1);
        assert_eq!(store.get(&sha).as_deref(), Some(&b"sealed"[..]));
        store.prune(T0 + KEEP_BLOBS);
        assert_eq!(store.get(&sha), None);
    }

    #[test]
    fn blobs_on_disk_go_after_ninety_days_from_their_time() {
        let dir = std::env::temp_dir().join(format!("hv-chat-media-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = ChatMediaStore::open(Some(&dir));
        let sha = store.put(b"sealed", T0).unwrap();
        let now = unix(SystemTime::now());
        store.prune(now + KEEP_BLOBS - 60);
        assert!(store.get(&sha).is_some());
        std::fs::write(dir.join(CHAT_MEDIA_DIR).join("broken.part"), b"half").unwrap();
        store.prune(now + KEEP_BLOBS + 60);
        assert_eq!(store.get(&sha), None);
        assert!(!dir.join(CHAT_MEDIA_DIR).join("broken.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_blobs_take_no_more_room_than_the_cap() {
        let dir = std::env::temp_dir().join(format!("hv-chat-media-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = ChatMediaStore::with_cap(Some(&dir), 10);
        let first = store.put(b"123456", T0).unwrap();
        assert!(matches!(store.put(b"abcdef", T0), Err(PutError::Full)), "6 + 6 is over 10");
        assert_eq!(store.put(b"123456", T0).unwrap(), first, "the same blob again takes no more room");
        assert!(store.put(b"abcd", T0).is_ok(), "what fits still goes");
        let roomy = ChatMediaStore::with_cap(Some(&dir.join("roomy")), 20);
        roomy.put(b"123456", T0).unwrap();
        roomy.put(b"123456", T0).unwrap();
        roomy.put(b"123456", T0).unwrap();
        assert!(roomy.put(b"12345678", T0).is_ok(), "putting a blob again took no room: 6 + 8 fits in 20");
        let _ = std::fs::remove_dir_all(dir.join("roomy"));
        let reopened = ChatMediaStore::with_cap(Some(&dir), 10);
        assert!(matches!(reopened.put(b"x", T0), Err(PutError::Full)), "a restart counts what is on disk");
        reopened.prune(unix(SystemTime::now()) + KEEP_BLOBS + 60);
        assert!(reopened.put(b"abcdef", T0).is_ok(), "blobs that went free their room");
        let _ = std::fs::remove_dir_all(&dir);

        let memory = ChatMediaStore::with_cap(None, 10);
        memory.put(b"123456", T0).unwrap();
        assert!(matches!(memory.put(b"abcdef", T0), Err(PutError::Full)));
        memory.prune(T0 + KEEP_BLOBS);
        assert!(memory.put(b"abcdef", T0).is_ok());
        assert_eq!(MAX_STORED, 20 * 1024 * 1024 * 1024);
    }

    #[test]
    fn a_name_that_is_not_a_hash_is_never_read() {
        let store = ChatMediaStore::open(None);
        assert_eq!(store.get("../secrets.json"), None);
        assert_eq!(store.get(&"A".repeat(64)), None);
    }
}
