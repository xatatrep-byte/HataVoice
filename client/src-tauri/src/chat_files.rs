//! Files of the chat: each is sealed with a key of its own before it leaves this PC (the key travels inside the
//! group, the server keeps only the blob) and opened again when it is shown or saved. The type of a file is told by
//! its first bytes, never by its name; its name is checked so it can't be taken for a path.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hv_roster::keys::{random_bytes, sha256};

/// A file of the chat, before it is sealed.
pub const MAX_FILE: usize = 25 * 1024 * 1024;
const NONCE: usize = 24;
const TAG: usize = 16;
/// A sealed file: the nonce in front, the tag behind.
pub const MAX_BLOB: usize = MAX_FILE + NONCE + TAG;
pub const MAX_NAME: usize = 200;
/// A bigger file goes in parts of this much, each sealed on its own with the file's key; a sealed list of the parts'
/// names is the blob the message names.
pub const PART: usize = 16 * 1024 * 1024;
/// The biggest file a message carries (in parts).
pub const MAX_BIG_FILE: u64 = 2 * 1024 * 1024 * 1024;
/// What a list of parts starts with, so nothing else is taken for one.
const PARTS_MAGIC: &[u8; 4] = b"HVP1";
/// Characters Windows does not take in a file name.
const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
/// Characters that turn the text around them («фото», U+202E, «gnp.exe» reads «фотоexe.png»).
const TURNING: &[char] = &['\u{61C}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}'];
/// Names Windows keeps for devices, with or without an extension.
const DEVICES: &[&str] = &["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileError {
    /// The server has no such blob (gone after 90 days, or never put).
    Missing,
    /// The blob is not what the message names, or does not open with its key.
    Damaged,
}

impl FileError {
    pub fn text(self) -> &'static str {
        match self {
            FileError::Missing => "Файл недоступен",
            FileError::Damaged => "Файл повреждён",
        }
    }
}

/// The SHA-256 of a blob, in hex: its name on the server.
pub fn blob_hash(blob: &[u8]) -> String {
    sha256(blob).iter().map(|b| format!("{b:02x}")).collect()
}

/// Seals `plain` with a new key: the blob (nonce ‖ ciphertext) and the key.
pub fn seal_file(plain: &[u8]) -> Result<(Vec<u8>, [u8; 32]), String> {
    let key = random_bytes::<32>()?;
    Ok((seal_with(plain, &key)?, key))
}

/// Seals `plain` with this key.
pub fn seal_with(plain: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if plain.len() > MAX_FILE {
        return Err("Файл больше 25 МБ".into());
    }
    let nonce = random_bytes::<NONCE>()?;
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(&XNonce::from(nonce), plain)
        .map_err(|_| "Не удалось зашифровать файл".to_string())?;
    Ok([&nonce[..], &sealed].concat())
}

pub fn open_file(blob: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, FileError> {
    if blob.len() < NONCE + TAG || blob.len() > MAX_BLOB {
        return Err(FileError::Damaged);
    }
    let (nonce, sealed) = blob.split_at(NONCE);
    let nonce: [u8; NONCE] = nonce.try_into().map_err(|_| FileError::Damaged)?;
    XChaCha20Poly1305::new(key.into()).decrypt(&XNonce::from(nonce), sealed).map_err(|_| FileError::Damaged)
}

/// A new key for a file.
pub fn new_key() -> Result<[u8; 32], String> {
    random_bytes::<32>()
}

/// How many parts a file of `size` bytes goes in.
pub fn parts_for(size: u64) -> u32 {
    size.div_ceil(PART as u64).max(1) as u32
}

/// The list of a big file's parts (their blobs' SHA-256, in order), sealed with the file's key.
pub fn seal_parts(hashes: &[String], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let mut plain = PARTS_MAGIC.to_vec();
    for hash in hashes {
        let bytes = (0..hash.len()).step_by(2).map(|i| u8::from_str_radix(hash.get(i..i + 2).unwrap_or("zz"), 16));
        let bytes = bytes.collect::<Result<Vec<u8>, _>>().map_err(|_| "Испорчен список частей файла".to_string())?;
        if bytes.len() != 32 {
            return Err("Испорчен список частей файла".into());
        }
        plain.extend(bytes);
    }
    seal_with(&plain, key)
}

/// The parts of a big file, from their sealed list: exactly as many as the message says.
pub fn open_parts(blob: &[u8], key: &[u8; 32], parts: u32) -> Result<Vec<String>, FileError> {
    let plain = open_file(blob, key)?;
    let hashes = plain.strip_prefix(&PARTS_MAGIC[..]).ok_or(FileError::Damaged)?;
    if hashes.len() != parts as usize * 32 {
        return Err(FileError::Damaged);
    }
    Ok(hashes.chunks(32).map(|hash| hash.iter().map(|b| format!("{b:02x}")).collect()).collect())
}

/// The type of a file shown in the chat, by its first bytes; anything else is a file to save.
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

/// A character that never goes in a name: a control one, one Windows would take for a path, or one that turns text.
fn unfit(c: char) -> bool {
    c.is_control() || FORBIDDEN.contains(&c) || TURNING.contains(&c)
}

/// A name as it came in a message, if it can only ever be a file name: 1–200 characters, none Windows would take
/// for a path, a drive or a device.
pub fn safe_name(name: &str) -> Option<String> {
    let count = name.chars().count();
    if count == 0 || count > MAX_NAME || name.trim() != name || name.ends_with('.') {
        return None;
    }
    if name.chars().any(unfit) || name.chars().all(|c| c == '.') {
        return None;
    }
    let stem = name.split('.').next().unwrap_or_default().trim_end();
    if DEVICES.iter().any(|device| stem.eq_ignore_ascii_case(device)) {
        return None;
    }
    Some(name.to_string())
}

/// A name for a file about to be sent, from whatever the PC called it: the bad characters become `_`, a device name
/// gets a `_` in front, and nothing usable is «файл».
pub fn clean_name(name: &str) -> String {
    let replaced: String = name.chars().map(|c| if unfit(c) { '_' } else { c }).take(MAX_NAME).collect();
    let trimmed = replaced.trim().trim_end_matches('.').trim_end().to_string();
    let named = if trimmed.chars().all(|c| c == '.' || c == '_') { "файл".to_string() } else { trimmed };
    match safe_name(&named) {
        Some(name) => name,
        None => safe_name(&format!("_{named}")).unwrap_or_else(|| "файл".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_opens_with_its_key_only() {
        let plain = b"a picture, say".repeat(1000);
        let (blob, key) = seal_file(&plain).unwrap();
        assert_eq!(blob.len(), plain.len() + NONCE + TAG);
        assert!(!blob.windows(14).any(|w| w == b"a picture, say"), "the blob shows nothing of the file");
        assert_eq!(open_file(&blob, &key).unwrap(), plain);
        let (_, other) = seal_file(b"x").unwrap();
        assert_eq!(open_file(&blob, &other), Err(FileError::Damaged));
        let (again, _) = seal_file(&plain).unwrap();
        assert_ne!(again, blob, "a new key and nonce every time");
    }

    #[test]
    fn a_changed_byte_is_damage() {
        let (mut blob, key) = seal_file(b"hello").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert_eq!(open_file(&blob, &key), Err(FileError::Damaged));
        assert_eq!(open_file(&blob[..10], &key), Err(FileError::Damaged), "shorter than a nonce and a tag");
        assert!(seal_file(&vec![0; MAX_FILE + 1]).is_err());
        assert_eq!(FileError::Missing.text(), "Файл недоступен");
    }

    #[test]
    fn a_big_file_goes_in_parts_named_by_a_sealed_list() {
        assert_eq!(parts_for(MAX_FILE as u64 + 1), 2);
        assert_eq!(parts_for(PART as u64 * 3), 3);
        assert_eq!(parts_for(PART as u64 * 3 + 1), 4);
        assert_eq!(parts_for(MAX_BIG_FILE), 128);
        let hashes = vec!["ab".repeat(32), "cd".repeat(32)];
        let key = [7u8; 32];
        let list = seal_parts(&hashes, &key).unwrap();
        assert!(!list.windows(32).any(|w| w == [0xab; 32]), "the list shows nothing of the parts");
        assert_eq!(open_parts(&list, &key, 2).unwrap(), hashes);
        assert_eq!(open_parts(&list, &key, 3), Err(FileError::Damaged), "not as many as the message says");
        assert_eq!(open_parts(&list, &[8; 32], 2), Err(FileError::Damaged), "another key");
        let (plain_blob, _) = seal_file(b"just a file").unwrap();
        assert_eq!(open_parts(&plain_blob, &key, 1), Err(FileError::Damaged));
    }

    #[test]
    fn names_lose_what_windows_would_take_as_a_path() {
        for good in ["фото.png", "отчёт 2026.pdf", "a", ".gitignore", "concert.txt"] {
            assert_eq!(safe_name(good).as_deref(), Some(good), "{good}");
        }
        for bad in ["", "..", "...", "..\\x", "a/b", "C:x", "a\u{7}b", "con", "CON.txt", "con.txt.bak2", "Lpt1.log", "name.", " lead", "trail ", &"я".repeat(201)] {
            assert_eq!(safe_name(bad), None, "{bad:?}");
        }
        assert_eq!(clean_name("..\\..\\Windows\\win.ini"), ".._.._Windows_win.ini", "no separator left");
        assert_eq!(clean_name("a/b:c?.txt"), "a_b_c_.txt");
        assert_eq!(clean_name("CON.txt"), "_CON.txt");
        assert_eq!(clean_name("..."), "файл");
        assert_eq!(clean_name("снимок экрана.png"), "снимок экрана.png");
        assert_eq!(clean_name(&"я".repeat(300)).chars().count(), MAX_NAME);
    }

    #[test]
    fn a_name_can_not_hide_its_extension() {
        // «фото», U+202E, «gnp.exe» reads «фотоexe.png»: characters that turn text around never come in a name.
        for bad in ["фото\u{202E}gnp.exe", "a\u{202D}b.txt", "a\u{2066}b.txt", "a\u{2069}.txt", "a\u{200F}.txt", "a\u{200E}.txt", "a\u{61C}.txt"] {
            assert_eq!(safe_name(bad), None, "{bad:?}");
        }
        assert_eq!(clean_name("фото\u{202E}gnp.exe"), "фото_gnp.exe");
        assert_eq!(safe_name("שלום.txt").as_deref(), Some("שלום.txt"), "right-to-left letters themselves are fine");
    }

    #[test]
    fn types_come_from_the_first_bytes() {
        assert_eq!(sniff(b"GIF89a..."), Some("image/gif"));
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]), Some("image/png"));
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b"<svg onload=alert(1)>"), None, "no SVG: it could run script");
        assert_eq!(blob_hash(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}

#[cfg(all(test, windows))]
mod transport {
    use std::time::Instant;

    use crate::chat_store::ChatStore;
    use crate::server_group::{GroupTransport, NO_FILE, SessionGroupTransport};
    use crate::session::ServerError;
    use crate::testkit::{folder, id, serve};

    use super::*;

    #[tokio::test]
    async fn a_blob_round_trips_through_the_server() {
        let sessions = serve(2).await;
        let (one, two) = (SessionGroupTransport::new(&sessions[&1], &id(1)), SessionGroupTransport::new(&sessions[&2], &id(2)));
        let plain = b"GIF89a".iter().copied().chain(std::iter::repeat_n(7u8, 300_000)).collect::<Vec<u8>>();
        let (blob, key) = seal_file(&plain).unwrap();
        let sha = one.upload(&blob).await.unwrap();
        assert_eq!(sha, blob_hash(&blob));
        let fetched = two.download(&sha).await.unwrap();
        assert_eq!(open_file(&fetched, &key).unwrap(), plain);
        assert_eq!(sniff(&plain), Some("image/gif"));
        let missing = two.download(&"0".repeat(64)).await.unwrap_err();
        assert!(matches!(missing, ServerError::Refused(text) if text == NO_FILE));
        let started = Instant::now();
        assert!(one.upload(&[]).await.is_err());
        assert!(started.elapsed().as_secs() < 10);
    }

    #[test]
    fn a_cached_blob_that_does_not_match_its_hash_is_dropped() {
        let base = folder("chat-files-cache", 1);
        let store = ChatStore::open(&base, &id(100).public()).unwrap();
        let (blob, _) = seal_file(b"kept").unwrap();
        let sha = blob_hash(&blob);
        store.put_blob(&sha, &blob).unwrap();
        assert_eq!(store.blob(&sha), Some(blob.clone()));
        let other = blob_hash(b"other");
        store.put_blob(&other, &blob).unwrap();
        assert_eq!(store.blob(&other), None, "the bytes are not the ones named");
        assert_eq!(store.blob(&other), None, "and they are gone");
        assert_eq!(store.blob("../../key.bin"), None);
    }
}
