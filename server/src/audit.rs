//! The audit log: moderation commands with the signed request that ordered them
//! (`audit.jsonl`), shown together with the signed journal entries.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use hv_roster::{Entry, UserId};
use serde::{Deserialize, Serialize};

pub const AUDIT_FILE: &str = "audit.jsonl";
const PAGE: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub at: u64,
    pub actor: UserId,
    pub kind: String,
    pub target: Option<UserId>,
    pub detail: serde_json::Value,
    /// The `HV1` header of the request: proof the actor really ordered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// For commands: the exact body that header signed, so anyone can check the signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body: Option<String>,
    /// For journal entries: the author's signature (the entry itself is in the journal).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

pub struct AuditLog {
    file: Option<PathBuf>,
    commands: RwLock<Vec<AuditEntry>>,
}

impl AuditLog {
    pub fn open(dir: Option<&Path>) -> Self {
        let file = dir.map(|d| d.join(AUDIT_FILE));
        let commands = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|text| text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
            .unwrap_or_default();
        Self { file, commands: RwLock::new(commands) }
    }

    pub fn record(&self, entry: AuditEntry) {
        if let Some(path) = &self.file {
            let written = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut f| writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default()));
            if let Err(e) = written {
                tracing::warn!("audit log not written: {e}");
            }
        }
        self.commands.write().unwrap_or_else(|e| e.into_inner()).push(entry);
    }

    /// Commands and journal entries, newest first, filtered by person (actor or target) and kind.
    pub fn query(&self, journal: &[Entry], user: Option<&str>, kind: Option<&str>, before: Option<u64>) -> Vec<AuditEntry> {
        let from_journal = journal.iter().map(journal_entry);
        let commands = self.commands.read().unwrap_or_else(|e| e.into_inner()).clone();
        let mut all: Vec<AuditEntry> = from_journal
            .chain(commands)
            .filter(|e| user.is_none_or(|u| e.actor.0 == u || e.target.as_ref().is_some_and(|t| t.0 == u)))
            .filter(|e| kind.is_none_or(|k| e.kind == k))
            .filter(|e| before.is_none_or(|b| e.at < b))
            .collect();
        all.sort_by(|a, b| b.at.cmp(&a.at));
        all.truncate(PAGE);
        all
    }
}

fn journal_entry(entry: &Entry) -> AuditEntry {
    let detail = serde_json::to_value(&entry.body).unwrap_or_default();
    let kind = detail["type"].as_str().unwrap_or("entry").to_string();
    use hv_roster::Body;
    let target = match &entry.body {
        Body::Join { user, .. } => Some(user.user_id()),
        Body::MemberRoles { user, .. } | Body::Kick { user, .. } | Body::Ban { user, .. } | Body::Unban { user } => Some(user.clone()),
        Body::OwnerTransfer { to } => Some(to.clone()),
        _ => None,
    };
    AuditEntry {
        at: entry.at,
        actor: entry.author.user_id(),
        kind,
        target,
        detail,
        auth: None,
        request_body: None,
        signature: Some(hv_roster::keys::encode_b64(&entry.signature.0)),
    }
}
