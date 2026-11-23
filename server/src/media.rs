//! Uploaded files: moderation GIFs and videos, the server icon. Stored by their SHA-256 in
//! `media/`, typed by their first bytes (never by a name or a header the client sends).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path as UrlPath, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use hv_roster::MediaRef;
use serde::Deserialize;

use crate::AppState;
use crate::api::signed;
use crate::auth::{error, member_only};

pub const MEDIA_DIR: &str = "media";
pub const MAX_MODERATION_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ICON_BYTES: usize = 1024 * 1024;
/// Bodies are read whole up to this, so an oversized file still gets a readable answer.
const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
/// All moderation GIFs and icons together, at most: a member cannot fill the disk of the PC the server runs on.
pub const MAX_STORED: u64 = 2 * 1024 * 1024 * 1024;
/// Uploads one member may make in a minute: a kick's GIF or a new icon now and then, never a stream of them.
pub const UPLOADS_PER_MINUTE: usize = 6;

pub fn upload_limit() -> crate::group_api::RateLimit {
    crate::group_api::RateLimit::per(UPLOADS_PER_MINUTE, Duration::from_secs(60))
}

/// The file type from its signature bytes, among the types we accept.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let starts = |prefix: &[u8]| bytes.starts_with(prefix);
    if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("image/gif")
    } else if starts(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if starts(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if starts(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        Some("video/mp4")
    } else if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("video/webm")
    } else {
        None
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Files on disk in the data folder, or in memory for a server without one.
pub struct MediaStore {
    dir: Option<PathBuf>,
    memory: RwLock<HashMap<String, Vec<u8>>>,
    cap: u64,
    /// How much the files kept take.
    used: Mutex<u64>,
}

/// The size of the files in `dir`.
fn stored(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.flatten().filter(|e| is_hash(&e.file_name().to_string_lossy())).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
}

pub const FULL: &str = "На сервере кончилось место для гифок и иконок";

impl MediaStore {
    pub fn open(data_dir: Option<&Path>) -> Self {
        Self::with_cap(data_dir, MAX_STORED)
    }

    pub fn with_cap(data_dir: Option<&Path>, cap: u64) -> Self {
        let dir = data_dir.map(|d| d.join(MEDIA_DIR));
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

    fn put(&self, sha: &str, bytes: &[u8]) -> Result<(), String> {
        let size = bytes.len() as u64;
        let Some(dir) = &self.dir else {
            let mut memory = self.memory.write().unwrap_or_else(|e| e.into_inner());
            if memory.contains_key(sha) {
                return Ok(());
            }
            if !self.reserve(size) {
                return Err(FULL.into());
            }
            memory.insert(sha.into(), bytes.to_vec());
            return Ok(());
        };
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join(sha);
        if path.exists() {
            return Ok(());
        }
        if !self.reserve(size) {
            return Err(FULL.into());
        }
        let temp = dir.join(format!("{sha}.part"));
        std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, &path)).map_err(|e| {
            *self.used.lock().unwrap_or_else(|e| e.into_inner()) -= size;
            e.to_string()
        })
    }

    fn get(&self, sha: &str) -> Option<Vec<u8>> {
        match &self.dir {
            Some(dir) => std::fs::read(dir.join(sha)).ok(),
            None => self.memory.read().unwrap_or_else(|e| e.into_inner()).get(sha).cloned(),
        }
    }
}

#[derive(Deserialize)]
pub struct UploadQuery {
    purpose: String,
}

/// `POST /api/media?purpose=moderation|icon` with the file as the body (members only).
pub async fn upload(State(state): State<AppState>, Query(query): Query<UploadQuery>, request: Request) -> Response {
    let (_, bytes, who) = match signed(&state, request, MAX_READ_BYTES).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    let (limit, allowed, too_big, wrong_type): (usize, &[&str], &str, &str) = match query.purpose.as_str() {
        "moderation" => (MAX_MODERATION_BYTES, &["image/gif", "video/mp4", "video/webm"], "Файл больше 8 МБ", "Для модерации — GIF, MP4 или WebM"),
        "icon" => (MAX_ICON_BYTES, &["image/png", "image/jpeg", "image/gif", "image/webp"], "Иконка — до 1 МБ", "Иконка — PNG, JPEG, GIF или WebP"),
        _ => return error(StatusCode::BAD_REQUEST, "Неизвестное назначение файла"),
    };
    if bytes.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Пустой файл");
    }
    if bytes.len() > limit {
        return error(StatusCode::BAD_REQUEST, too_big);
    }
    let Some(mime) = sniff(&bytes) else {
        return error(StatusCode::BAD_REQUEST, "Такой тип файла не поддерживается");
    };
    if !allowed.contains(&mime) {
        return error(StatusCode::BAD_REQUEST, wrong_type);
    }
    // Counted once the file is one to keep: a refused one takes no room.
    if !state.media_rate.allow(&who.user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много файлов — подожди минуту");
    }
    let sha = hex(&hv_roster::keys::sha256(&bytes));
    if let Err(e) = state.media.put(&sha, &bytes) {
        let status = if e == FULL { StatusCode::INSUFFICIENT_STORAGE } else { StatusCode::INTERNAL_SERVER_ERROR };
        return error(status, &format!("Файл не сохранился: {e}"));
    }
    Json(MediaRef { sha256: sha, mime: mime.into(), size: bytes.len() as u64 }).into_response()
}

/// `GET /api/media/{sha256}`: unsigned, so a kicked person still sees the GIF they got.
pub async fn download(State(state): State<AppState>, UrlPath(sha): UrlPath<String>) -> Response {
    if !is_hash(&sha) {
        return error(StatusCode::BAD_REQUEST, "Испорчена ссылка на файл");
    }
    match state.media.get(&sha) {
        Some(bytes) => {
            let mime = sniff(&bytes).unwrap_or("application/octet-stream");
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")], bytes).into_response()
        }
        None => error(StatusCode::NOT_FOUND, "Файл не найден"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_takes_no_more_than_its_cap_and_the_same_file_twice_costs_nothing() {
        let store = MediaStore::with_cap(None, 10);
        assert_eq!(store.put(&"a".repeat(64), &[1; 6]), Ok(()));
        assert_eq!(store.put(&"a".repeat(64), &[1; 6]), Ok(()), "the same file again");
        assert_eq!(store.put(&"b".repeat(64), &[2; 6]), Err(FULL.to_string()));
        assert_eq!(store.put(&"c".repeat(64), &[3; 4]), Ok(()));
        assert!(store.get(&"b".repeat(64)).is_none());
    }
}
