//! Where the server chat lives on this PC: the server group's snapshot and the history of what was said, each in a
//! folder of its own per server, every byte encrypted with one key that only this Windows account can read (DPAPI).
//!
//! A file is a run of sealed records: `u32 BE length` ‖ `nonce (24)` ‖ XChaCha20-Poly1305 of the record, with the
//! file's name as associated data. The snapshot is one record, written through a temporary file; the history gets
//! one record per entry, appended. Something that does not open is set aside, never read half-way.

use std::io::Write;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hv_roster::keys::{decode_b64_vec, encode_b64, random_bytes, sha256};
use hv_roster::{PublicKey, UserId};
use serde::{Deserialize, Serialize};

pub const CHAT_DIR: &str = "chat";
const KEY_FILE: &str = "key.bin";
const GROUP_FILE: &str = "group.bin";
const HISTORY_FILE: &str = "history.bin";
/// Blobs of files, as the server keeps them (sealed, each with a key of its own).
const FILES_DIR: &str = "files";
const NONCE_LEN: usize = 24;
/// No record is anywhere near this; a bigger length is a broken file.
const MAX_RECORD: usize = 64 * 1024 * 1024;

/// The server group as it was last saved, and the last log entry it took in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub group: Vec<u8>,
    pub seq: u64,
}

/// One entry of the history: a message someone sent (the plaintext of the group message), under the number the
/// server gave it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryRecord {
    pub seq: u64,
    pub at: u64,
    pub sender: UserId,
    #[serde(with = "b64")]
    pub body: Vec<u8>,
}

mod b64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hv_roster::keys::encode_b64(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        hv_roster::keys::decode_b64_vec(&text).ok_or_else(|| serde::de::Error::custom("not base64url"))
    }
}

#[derive(Serialize, Deserialize)]
struct SnapshotFile {
    group: String,
    seq: u64,
}

/// The chat of one server on this PC.
#[derive(Clone)]
pub struct ChatStore {
    dir: PathBuf,
    key: [u8; 32],
}

fn stamp() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path)).map_err(|e| format!("Не записывается {}: {e}", path.display()))
}

/// The key every chat on this PC is encrypted with. One that DPAPI no longer opens (Windows reinstalled, the
/// account's password reset) is kept aside and a new one starts: what it locked can't be read any more.
fn chat_key(base: &Path) -> Result<[u8; 32], String> {
    let dir = base.join(CHAT_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не создаётся {}: {e}", dir.display()))?;
    let path = dir.join(KEY_FILE);
    if let Ok(sealed) = std::fs::read(&path) {
        if let Some(key) = hv_host::protect::unprotect(&sealed).ok().and_then(|bytes| bytes.try_into().ok()) {
            return Ok(key);
        }
        let _ = std::fs::rename(&path, dir.join(format!("key.unreadable-{}.bin", stamp())));
    }
    let key = random_bytes::<32>()?;
    write_atomic(&path, &hv_host::protect::protect(&key)?)?;
    Ok(key)
}

fn folder_of(server_key: &PublicKey) -> String {
    sha256(&server_key.0)[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Where the first version of the chat kept a server's folder: named by its address and its key.
fn legacy_folder(base: &Path, address: &str, server_key: &PublicKey) -> PathBuf {
    let mut name = address.as_bytes().to_vec();
    name.push(0);
    name.extend_from_slice(&server_key.0);
    let folder: String = sha256(&name)[..16].iter().map(|b| format!("{b:02x}")).collect();
    base.join(CHAT_DIR).join(folder)
}

/// A folder the first version made for the server at `address` becomes the server's own, unless the server already
/// has one: its history and its group's snapshot go on.
pub fn adopt_legacy(base: &Path, address: &str, server_key: &PublicKey) {
    let legacy = legacy_folder(base, address, server_key);
    let current = base.join(CHAT_DIR).join(folder_of(server_key));
    if legacy.is_dir() && !current.exists() {
        let _ = std::fs::rename(legacy, current);
    }
}

/// The server with `server_key` is gone for good (its owner deleted it): its chat, rooms and files leave this PC. The
/// other servers' folders and the shared key stay.
pub fn forget_server(base: &Path, server_key: &PublicKey) -> Result<(), String> {
    let dir = base.join(CHAT_DIR).join(folder_of(server_key));
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Не удаляется {}: {e}", dir.display())),
        _ => Ok(()),
    }
}

/// The records of a file that open, and how many bytes they take; `broken` when something after them did not.
struct Opened {
    records: Vec<Vec<u8>>,
    whole: usize,
    broken: bool,
}

impl ChatStore {
    /// The folder of the server with `server_key` under `base/chat/` (whatever address it is reached by), and the key
    /// all chats share. Run [`adopt_legacy`] first when the address is known.
    /// Files the key no longer opens are set aside here, so nothing new is ever written after them.
    pub fn open(base: &Path, server_key: &PublicKey) -> Result<ChatStore, String> {
        Self::open_dir(base, base.join(CHAT_DIR).join(folder_of(server_key)))
    }

    /// The store of one room of the server (a closed channel's, direct messages'), in a folder of its own.
    pub fn open_room(base: &Path, server_key: &PublicKey, room: &str) -> Result<ChatStore, String> {
        if !room.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-') {
            return Err("Неверное имя комнаты".into());
        }
        Self::open_dir(base, base.join(CHAT_DIR).join(folder_of(server_key)).join("rooms").join(room))
    }

    fn open_dir(base: &Path, dir: PathBuf) -> Result<ChatStore, String> {
        let key = chat_key(base)?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("Не создаётся {}: {e}", dir.display()))?;
        let store = ChatStore { dir, key };
        for file in [GROUP_FILE, HISTORY_FILE] {
            if let Ok(bytes) = std::fs::read(store.dir.join(file)) {
                let opened = store.open_records(file, &bytes);
                if opened.records.is_empty() && opened.broken {
                    store.set_aside(file);
                }
            }
        }
        Ok(store)
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(&self.key.into())
    }

    fn seal(&self, file: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
        let nonce = random_bytes::<NONCE_LEN>()?;
        let sealed = self
            .cipher()
            .encrypt(&XNonce::from(nonce), Payload { msg: plain, aad: file.as_bytes() })
            .map_err(|_| "Не удалось зашифровать чат".to_string())?;
        let len = u32::try_from(NONCE_LEN + sealed.len()).map_err(|_| "Слишком большая запись чата".to_string())?;
        Ok([&len.to_be_bytes()[..], &nonce, &sealed].concat())
    }

    fn open_records(&self, file: &str, bytes: &[u8]) -> Opened {
        let mut opened = Opened { records: Vec::new(), whole: 0, broken: false };
        let mut rest = bytes;
        while !rest.is_empty() {
            let record = rest.get(..4).and_then(|head| {
                let len = u32::from_be_bytes(head.try_into().ok()?) as usize;
                if !(NONCE_LEN..=MAX_RECORD).contains(&len) {
                    return None;
                }
                let body = rest.get(4..4 + len)?;
                let nonce: [u8; NONCE_LEN] = body[..NONCE_LEN].try_into().ok()?;
                let plain = self.cipher().decrypt(&XNonce::from(nonce), Payload { msg: &body[NONCE_LEN..], aad: file.as_bytes() }).ok()?;
                Some((plain, 4 + len))
            });
            let Some((plain, taken)) = record else {
                opened.broken = true;
                break;
            };
            opened.records.push(plain);
            opened.whole += taken;
            rest = &rest[taken..];
        }
        opened
    }

    fn set_aside(&self, file: &str) {
        let stem = file.trim_end_matches(".bin");
        let _ = std::fs::rename(self.dir.join(file), self.dir.join(format!("{stem}.broken-{}.bin", stamp())));
    }

    pub fn load_snapshot(&self) -> Option<Snapshot> {
        let bytes = std::fs::read(self.dir.join(GROUP_FILE)).ok()?;
        let opened = self.open_records(GROUP_FILE, &bytes);
        let snapshot = match opened.records.as_slice() {
            [one] if !opened.broken => serde_json::from_slice::<SnapshotFile>(one)
                .ok()
                .and_then(|file| Some(Snapshot { group: decode_b64_vec(&file.group)?, seq: file.seq })),
            _ => None,
        };
        if snapshot.is_none() {
            self.set_aside(GROUP_FILE);
        }
        snapshot
    }

    pub fn save_snapshot(&self, snapshot: &Snapshot) -> Result<(), String> {
        let file = SnapshotFile { group: encode_b64(&snapshot.group), seq: snapshot.seq };
        let plain = serde_json::to_vec(&file).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join(GROUP_FILE), &self.seal(GROUP_FILE, &plain)?)
    }

    /// A small thing the chat remembers, sealed in a file of its own (`*.bin`): one record, written whole.
    pub fn save_note(&self, file: &str, plain: &[u8]) -> Result<(), String> {
        write_atomic(&self.dir.join(file), &self.seal(file, plain)?)
    }

    /// The note in `file`; `None` when there is none or it does not open.
    pub fn note(&self, file: &str) -> Option<Vec<u8>> {
        let bytes = std::fs::read(self.dir.join(file)).ok()?;
        let opened = self.open_records(file, &bytes);
        match opened.records.as_slice() {
            [one] if !opened.broken => Some(one.clone()),
            _ => None,
        }
    }

    /// The group is gone (removed, reset): its snapshot goes, the history stays.
    pub fn forget_group(&self) {
        let _ = std::fs::remove_file(self.dir.join(GROUP_FILE));
    }

    pub fn append_history(&self, records: &[HistoryRecord]) -> Result<(), String> {
        let mut bytes = Vec::new();
        for record in records {
            let plain = serde_json::to_vec(record).map_err(|e| e.to_string())?;
            bytes.extend_from_slice(&self.seal(HISTORY_FILE, &plain)?);
        }
        let path = self.dir.join(HISTORY_FILE);
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|e| format!("Не записывается {}: {e}", path.display()))
    }

    /// Keeps the blob of a file under its SHA-256 (hex).
    pub fn put_blob(&self, sha: &str, blob: &[u8]) -> Result<(), String> {
        let dir = self.dir.join(FILES_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Не создаётся {}: {e}", dir.display()))?;
        write_atomic(&dir.join(sha), blob)
    }

    /// The blob kept under `sha`, if its bytes still have that hash; one that does not is dropped.
    pub fn blob(&self, sha: &str) -> Option<Vec<u8>> {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let path = self.dir.join(FILES_DIR).join(sha);
        let blob = std::fs::read(&path).ok()?;
        let hash: String = sha256(&blob).iter().map(|b| format!("{b:02x}")).collect();
        if hash != sha {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Some(blob)
    }

    /// Every whole record, in order. A broken tail (a crash while writing it) is cut off, so what is appended
    /// later is read again.
    pub fn load_history(&self) -> Vec<HistoryRecord> {
        let path = self.dir.join(HISTORY_FILE);
        let Ok(bytes) = std::fs::read(&path) else { return Vec::new() };
        let opened = self.open_records(HISTORY_FILE, &bytes);
        if opened.broken {
            if opened.records.is_empty() {
                self.set_aside(HISTORY_FILE);
            } else if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) {
                let _ = file.set_len(opened.whole as u64);
            }
        }
        opened.records.iter().filter_map(|plain| serde_json::from_slice(plain).ok()).collect()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hv-chat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn key(n: u8) -> PublicKey {
        hv_roster::Identity::from_seed([n; 32]).public()
    }

    fn record(seq: u64, body: &str) -> HistoryRecord {
        HistoryRecord { seq, at: 1000 + seq, sender: UserId(format!("user{seq}")), body: body.as_bytes().to_vec() }
    }

    fn folder(store: &ChatStore) -> &Path {
        &store.dir
    }

    #[test]
    fn a_snapshot_round_trips() {
        let base = temp("snapshot");
        let store = ChatStore::open(&base, &key(1)).unwrap();
        assert_eq!(store.load_snapshot(), None);
        let snapshot = Snapshot { group: b"group state".to_vec(), seq: 42 };
        store.save_snapshot(&snapshot).unwrap();
        let again = ChatStore::open(&base, &key(1)).unwrap();
        assert_eq!(again.load_snapshot(), Some(snapshot));
        again.forget_group();
        assert_eq!(again.load_snapshot(), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn history_appends_and_loads_in_order() {
        let base = temp("history");
        let store = ChatStore::open(&base, &key(1)).unwrap();
        assert!(store.load_history().is_empty());
        store.append_history(&[record(1, "one"), record(2, "two")]).unwrap();
        store.append_history(&[record(3, "three")]).unwrap();
        let again = ChatStore::open(&base, &key(1)).unwrap();
        assert_eq!(again.load_history(), vec![record(1, "one"), record(2, "two"), record(3, "three")]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn files_are_encrypted() {
        let base = temp("encrypted");
        let store = ChatStore::open(&base, &key(1)).unwrap();
        let beacon = "маячок-7f3a9c";
        store.save_snapshot(&Snapshot { group: beacon.as_bytes().to_vec(), seq: 1 }).unwrap();
        store.append_history(&[record(1, beacon)]).unwrap();
        for file in [GROUP_FILE, HISTORY_FILE] {
            let bytes = std::fs::read(folder(&store).join(file)).unwrap();
            assert!(!bytes.windows(beacon.len()).any(|w| w == beacon.as_bytes()), "{file}");
            assert!(!bytes.windows(4).any(|w| w == b"user"), "{file}: nor the sender");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn two_servers_have_separate_folders() {
        let base = temp("separate");
        let one = ChatStore::open(&base, &key(1)).unwrap();
        let other = ChatStore::open(&base, &key(2)).unwrap();
        one.append_history(&[record(1, "one")]).unwrap();
        assert!(other.load_history().is_empty());
        assert_ne!(folder(&one), folder(&other));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_deleted_server_takes_its_chat_and_nothing_else() {
        let base = temp("forget");
        let gone = ChatStore::open(&base, &key(1)).unwrap();
        let kept = ChatStore::open(&base, &key(2)).unwrap();
        gone.append_history(&[record(1, "one")]).unwrap();
        ChatStore::open_room(&base, &key(1), "dm-a").unwrap().append_history(&[record(2, "two")]).unwrap();
        kept.append_history(&[record(1, "stays")]).unwrap();
        forget_server(&base, &key(1)).unwrap();
        assert!(!folder(&gone).exists(), "its folder with the rooms in it");
        assert_eq!(kept.load_history().len(), 1);
        assert!(base.join(CHAT_DIR).join(KEY_FILE).exists(), "the shared key stays");
        // Twice, or a server that never had a chat here: nothing to do.
        forget_server(&base, &key(1)).unwrap();
        forget_server(&base, &key(3)).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_folder_of_an_earlier_version_moves_to_the_server_key() {
        // Before, a chat's folder was named by the address and the key; the chat of such a folder is the same chat.
        let base = temp("legacy");
        let legacy = legacy_folder(&base, "127.0.0.1:7350", &key(1));
        std::fs::create_dir_all(&legacy).unwrap();
        let old = ChatStore { dir: legacy.clone(), key: chat_key(&base).unwrap() };
        old.append_history(&[record(1, "из старой папки")]).unwrap();
        adopt_legacy(&base, "127.0.0.1:7350", &key(1));
        let store = ChatStore::open(&base, &key(1)).unwrap();
        assert_eq!(store.load_history()[0].body, "из старой папки".as_bytes());
        assert!(!legacy.exists());
        // A folder of the key already there is never overwritten.
        std::fs::create_dir_all(&legacy).unwrap();
        adopt_legacy(&base, "127.0.0.1:7350", &key(1));
        assert!(legacy.exists(), "left where it is");
        assert_eq!(store.load_history().len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_broken_snapshot_is_set_aside() {
        let base = temp("broken-snapshot");
        let store = ChatStore::open(&base, &key(1)).unwrap();
        store.save_snapshot(&Snapshot { group: b"state".to_vec(), seq: 7 }).unwrap();
        let path = folder(&store).join(GROUP_FILE);
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(store.load_snapshot(), None);
        assert!(!path.exists());
        let aside = std::fs::read_dir(folder(&store)).unwrap().filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().starts_with("group.broken-"));
        assert!(aside, "kept aside");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_broken_history_record_ends_the_history_there() {
        let base = temp("broken-history");
        let store = ChatStore::open(&base, &key(1)).unwrap();
        store.append_history(&[record(1, "one"), record(2, "two")]).unwrap();
        let path = folder(&store).join(HISTORY_FILE);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(&[0, 0, 0, 40, 1, 2, 3]);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(store.load_history(), vec![record(1, "one"), record(2, "two")]);
        // What comes after is read again: the broken tail was cut off.
        store.append_history(&[record(3, "three")]).unwrap();
        assert_eq!(store.load_history().len(), 3);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unreadable_key_starts_over() {
        let base = temp("unreadable-key");
        let store = ChatStore::open(&base, &key(1)).unwrap();
        store.save_snapshot(&Snapshot { group: b"state".to_vec(), seq: 7 }).unwrap();
        store.append_history(&[record(1, "one")]).unwrap();
        std::fs::write(base.join(CHAT_DIR).join(KEY_FILE), b"not a DPAPI blob").unwrap();
        let again = ChatStore::open(&base, &key(1)).unwrap();
        assert_eq!(again.load_snapshot(), None);
        assert!(again.load_history().is_empty());
        again.append_history(&[record(2, "two")]).unwrap();
        assert_eq!(again.load_history(), vec![record(2, "two")], "the new history starts clean");
        let _ = std::fs::remove_dir_all(&base);
    }
}
