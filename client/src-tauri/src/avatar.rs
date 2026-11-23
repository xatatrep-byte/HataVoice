//! Models and motions of one's own. A file is sealed with its own key here and kept on the server like a file of the
//! chat: a blob named by its hash, that only members can take and nobody but those with the secret can read. The secret
//! travels in the signed profile through the encrypted group, so the server sees neither the model nor the secret.
//!
//! A profile holds 96 characters at most, and an older version throws away a whole profile that has more: the code carries
//! the hash and a 128-bit secret in base32, and the file's key is made from the secret.
//!
//! What was fetched stays on this PC sealed as it came, under its hash, and is opened only when the window asks.

use std::path::{Path, PathBuf};

use hv_roster::keys::{decode_b32, encode_b32, random_bytes, sha256};
use serde::Serialize;
use tauri::Manager;
use tauri::ipc::{InvokeBody, Request};

use crate::chat_files::{MAX_BLOB, blob_hash, open_file, seal_with};
use crate::commands::{AppIdentity, Sessions, link_of, text};

/// No more than this many bytes of friends' models on this PC: the oldest go first.
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;
const ANSWER_LIMIT: usize = 64 * 1024;
/// The address of nothing: only what is on this PC already.
const LOCAL: &str = "local";

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::data_dir(app)?.join("avatars");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The file's key from the secret in its code.
fn key_of(secret: &[u8; 16]) -> [u8; 32] {
    sha256(&[b"hatavoice-avatar-v1\0".as_slice(), secret.as_slice()].concat())
}

/// A file's hash as the code writes it, as the server and this folder name it.
fn hex_of(hash: &str) -> Option<String> {
    let bytes: [u8; 32] = decode_b32(hash)?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Keeps the folder under its limit: the files not touched for longest go.
fn prune(dir: &Path, limit: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), entry.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, size, path) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total -= size;
        }
    }
}

#[derive(Serialize)]
pub struct Sealed {
    pub sha: String,
    pub key: String,
}

/// Seals a file of ours and keeps it here. Its address on any server will be its hash, and its key is given back once.
#[tauri::command]
pub fn avatar_seal(app: tauri::AppHandle, request: Request<'_>) -> Result<Sealed, String> {
    let InvokeBody::Raw(plain) = request.body() else {
        return Err("Ожидались байты".into());
    };
    let secret = random_bytes::<16>()?;
    let blob = seal_with(plain, &key_of(&secret))?;
    let name = blob_hash(&blob);
    std::fs::write(cache_dir(&app)?.join(&name), &blob).map_err(|e| e.to_string())?;
    Ok(Sealed { sha: encode_b32(&sha256(&blob)), key: encode_b32(&secret) })
}

/// Puts a sealed file on a server, or renews its time there (it would go after 90 days).
#[tauri::command]
pub async fn avatar_publish(app: tauri::AppHandle, identity: tauri::State<'_, AppIdentity>, sessions: tauri::State<'_, Sessions>, address: String, sha: String) -> Result<(), String> {
    let name = hex_of(&sha).ok_or("Испорчена ссылка на файл")?;
    let blob = std::fs::read(cache_dir(&app)?.join(&name)).map_err(|_| "Этого файла нет на этом ПК".to_string())?;
    let id = identity.get();
    let link = link_of(&sessions.0, &address).await?;
    let (status, _) = link.exchange_bytes(&id, "POST", "/api/chat-media", blob, ANSWER_LIMIT).await.map_err(text)?;
    if status == 200 { Ok(()) } else { Err(format!("Сервер не принял файл: {status}")) }
}

/// `{percent(address)}/{hash}/{secret}`: the server, the file's name there, and its key.
fn parse_path(path: &str) -> Option<(String, String, [u8; 32])> {
    let rest = path.strip_prefix("/avatar/")?;
    let mut parts = rest.rsplitn(3, '/');
    let secret: [u8; 16] = decode_b32(parts.next()?)?;
    let name = hex_of(parts.next()?)?;
    let address = percent_encoding::percent_decode_str(parts.next()?).decode_utf8().ok()?;
    if address.is_empty() {
        return None;
    }
    Some((address.into_owned(), name, key_of(&secret)))
}

/// `hvmedia` `/avatar/{percent(address)}/{hash}/{secret}`: a file of a character, opened. Taken from the server the first
/// time, checked against its hash, and kept here sealed.
pub async fn media(app: &tauri::AppHandle, path: &str) -> Result<(Vec<u8>, String), (u16, String)> {
    let (address, sha, key) = parse_path(path).ok_or_else(|| (400, "Испорчена ссылка на файл".to_string()))?;
    let dir = cache_dir(app).map_err(|e| (500, e))?;
    let file = dir.join(&sha);
    let blob = match std::fs::read(&file) {
        Ok(blob) => blob,
        Err(_) if address == LOCAL => return Err((404, "Этого файла нет на этом ПК".to_string())),
        Err(_) => {
            let sessions = app.state::<Sessions>();
            let identity = app.state::<AppIdentity>();
            let link = link_of(&sessions.0, &address).await.map_err(|e| (503, e))?;
            let request = format!("/api/chat-media/{sha}");
            let (status, blob) = link.exchange_bytes(&identity.get(), "GET", &request, Vec::new(), MAX_BLOB).await.map_err(|e| (502, text(e)))?;
            if status != 200 {
                return Err((status, "Сервер не отдал файл".to_string()));
            }
            // The name is the hash: a server cannot give another file under it.
            if blob_hash(&blob) != sha {
                return Err((502, "Файл на сервере подменён".to_string()));
            }
            let _ = std::fs::write(&file, &blob);
            prune(&dir, CACHE_LIMIT);
            blob
        }
    };
    let plain = open_file(&blob, &key).map_err(|_| (422, "Файл не открывается этим ключом".to_string()))?;
    Ok((plain, "application/octet-stream".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_names_a_server_a_file_and_its_key() {
        let hash = encode_b32(&[0xab; 32]);
        let secret = encode_b32(&[7; 16]);
        let (address, name, key) = parse_path(&format!("/avatar/127.0.0.1%3A7350/{hash}/{secret}")).unwrap();
        assert_eq!((address.as_str(), name), ("127.0.0.1:7350", "ab".repeat(32)));
        assert_eq!(key, key_of(&[7; 16]));
    }

    #[test]
    fn what_goes_in_a_profile_is_what_a_profile_accepts() {
        // The rule of `SignedProfile::verify`, which older versions apply to the whole profile.
        let code = format!("p1.{}.{}", encode_b32(&[0xff; 32]), encode_b32(&[0xff; 16]));
        assert!(code.len() <= hv_roster::request::MAX_CHARACTER_CHARS, "{} characters", code.len());
        assert!(code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.'));
    }

    #[test]
    fn a_sealed_file_opens_by_its_secret_alone() {
        let blob = seal_with(b"a model", &key_of(&[1; 16])).unwrap();
        assert_eq!(open_file(&blob, &key_of(&[1; 16])).unwrap(), b"a model");
        assert!(open_file(&blob, &key_of(&[2; 16])).is_err());
    }

    #[test]
    fn a_bad_link_is_refused_before_anything_is_touched() {
        let hash = encode_b32(&[0xab; 32]);
        let secret = encode_b32(&[7; 16]);
        assert!(parse_path(&format!("/avatar/a/../../{secret}")).is_none(), "a path out of the folder");
        assert!(parse_path(&format!("/avatar/a/{hash}/short")).is_none(), "a short secret");
        assert!(parse_path(&format!("/avatar//{hash}/{secret}")).is_none(), "no server");
        assert!(parse_path(&format!("/chat/a/{hash}/{secret}")).is_none());
    }

    #[test]
    fn the_oldest_files_go_first() {
        let dir = std::env::temp_dir().join(format!("hv-avatars-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, age) in [("old", 100), ("new", 0)] {
            let path = dir.join(name);
            std::fs::write(&path, vec![0; 100]).unwrap();
            let time = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(time).unwrap();
        }
        prune(&dir, 150);
        assert!(!dir.join("old").exists());
        assert!(dir.join("new").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
