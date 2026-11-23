//! The signed member journal on disk (`roster.jsonl`, one entry per line, append-only) and the
//! server's own key (`server_key.bin`, under DPAPI), which signs `hello` and the journal's genesis.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use hv_roster::{Body, Entry, Identity, PublicKey, Roster};

pub const ROSTER_FILE: &str = "roster.jsonl";
pub const SERVER_KEY_FILE: &str = "server_key.bin";
/// Entries are stamped by their author; one far off the server clock is refused.
pub const MAX_ENTRY_SKEW_SECS: u64 = 60;

/// Why an entry was refused, so the API can answer 400, 403 or 409.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendError {
    /// Out of order or not continuing the chain: someone else wrote first.
    Conflict(String),
    /// A genesis for a server that already has an owner.
    Claimed,
    Rejected(String),
    Storage(String),
}

pub struct RosterStore {
    file: Option<PathBuf>,
    server: Identity,
    roster: RwLock<Roster>,
    /// Appends are checked, written and published one at a time.
    writer: Mutex<()>,
}

/// The server key; a new one only for a server that has no journal yet — clients pin the key, so
/// a journal with a new key would look like a forged server to everyone.
fn load_server_key(dir: &Path, journal_exists: bool) -> Result<Identity, String> {
    let path = dir.join(SERVER_KEY_FILE);
    if path.exists() {
        let sealed = std::fs::read(&path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
        let seed: [u8; 32] = hv_host::protect::unprotect(&sealed)?
            .try_into()
            .map_err(|_| format!("Испорчен {}", path.display()))?;
        return Ok(Identity::from_seed(seed));
    }
    if journal_exists {
        return Err(format!(
            "Пропал ключ сервера {} — восстанови этот файл из копии папки данных: с новым ключом друзья увидят «сервер подменён»",
            path.display()
        ));
    }
    let identity = Identity::generate()?;
    let sealed = hv_host::protect::protect(&identity.seed())?;
    std::fs::write(&path, sealed).map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
    Ok(identity)
}

/// The journal's entries. A last line cut short by a crash or power cut (no newline, not valid
/// JSON) never made it: it is dropped from the file instead of keeping the server down.
fn load_entries(path: &Path) -> Result<Vec<Entry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut text = std::fs::read_to_string(path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
    if !text.is_empty() && !text.ends_with('\n') {
        let cut = text.rfind('\n').map_or(0, |i| i + 1);
        if serde_json::from_str::<Entry>(&text[cut..]).is_err() {
            tracing::warn!("dropping a torn last line of {}", path.display());
            text.truncate(cut);
            std::fs::write(path, &text).map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
        }
    }
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(i, line)| serde_json::from_str(line).map_err(|e| format!("Испорчена строка {} в {}: {e}", i + 1, path.display())))
        .collect()
}

impl RosterStore {
    /// `None` keeps everything in memory with a fresh server key (development and tests).
    pub fn open(dir: Option<&Path>) -> Result<Self, String> {
        let (file, server, entries) = match dir {
            Some(dir) => {
                let file = dir.join(ROSTER_FILE);
                let entries = load_entries(&file)?;
                let server = load_server_key(dir, !entries.is_empty())?;
                (Some(file), server, entries)
            }
            None => (None, Identity::generate()?, Vec::new()),
        };
        let roster = Roster::from_entries(entries).map_err(|e| format!("Журнал участников повреждён: {e}"))?;
        if roster.server_key().is_some_and(|key| key != server.public()) {
            return Err(format!("Ключ сервера в {SERVER_KEY_FILE} не тот, что в журнале — восстанови свой файл ключа из копии"));
        }
        Ok(Self { file, server, roster: RwLock::new(roster), writer: Mutex::new(()) })
    }

    /// The data folder, when the journal lives on disk.
    pub fn dir(&self) -> Option<&Path> {
        self.file.as_ref().and_then(|f| f.parent())
    }

    pub fn server_key(&self) -> PublicKey {
        self.server.public()
    }

    pub fn server_identity(&self) -> &Identity {
        &self.server
    }

    pub fn read<T>(&self, f: impl FnOnce(&Roster) -> T) -> T {
        f(&self.roster.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Checks `entry` against the journal and the clock, stores it and returns its number.
    /// A genesis gets the server's own signature here: only this process holds the server key.
    pub fn append(&self, mut entry: Entry, now: u64) -> Result<u64, AppendError> {
        let _writing = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = self.read(Roster::clone);
        if entry.at.abs_diff(now) > MAX_ENTRY_SKEW_SECS {
            return Err(AppendError::Rejected("Часы на этом ПК расходятся с сервером — запись не принята".into()));
        }
        if let Body::Genesis { .. } = entry.body {
            if !next.is_empty() {
                return Err(AppendError::Claimed);
            }
            entry.server_signature = Some(self.server.sign(&entry.signed_bytes()));
        }
        if entry.seq != next.len() || entry.prev != next.head() {
            return Err(AppendError::Conflict("Журнал уже изменился — обнови и повтори".into()));
        }
        let seq = entry.seq;
        let line = serde_json::to_string(&entry).map_err(|e| AppendError::Storage(e.to_string()))?;
        next.apply(entry).map_err(|e| AppendError::Rejected(e.0))?;
        if let Some(path) = &self.file {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| AppendError::Storage(format!("Не записывается {}: {e}", path.display())))?;
            writeln!(file, "{line}").and_then(|_| file.sync_data()).map_err(|e| AppendError::Storage(e.to_string()))?;
        }
        *self.roster.write().unwrap_or_else(|e| e.into_inner()) = next;
        Ok(seq)
    }

    pub fn entries_from(&self, seq: u64) -> Vec<Entry> {
        self.read(|r| r.entries().iter().skip(seq as usize).cloned().collect())
    }
}
