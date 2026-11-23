//! The server's own group: the MLS group every member is in, for the server's chat. The server keeps its log in
//! order (one commit per epoch, messages only in the current epoch) and hands it out by number, and keeps people's
//! requests to join and the welcomes made for them. Everything it holds is ciphertext it cannot read.
//!
//! On disk, in the data folder's `group/`: `meta.json` (the group's id and who started it), `log.jsonl` (the log,
//! one entry a line, appended) and `pending.json` (requests to join and welcomes). The log alone gives the epoch and
//! the members (every commit names them), so a crash between two files can't put them out of step.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use hv_roster::UserId;
use serde::{Deserialize, Serialize};

pub const GROUP_DIR: &str = "group";
/// How long the ciphertext of a message is kept.
pub const KEEP_MESSAGES: u64 = 90 * 24 * 3600;
/// How long a welcome waits for the person it was made for.
pub const KEEP_WELCOME: u64 = 7 * 24 * 3600;

const META_FILE: &str = "meta.json";
const LOG_FILE: &str = "log.jsonl";
const PENDING_FILE: &str = "pending.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Commit,
    Message,
}

/// One entry of the log. `epoch` is the one it was made in; a commit also names the whole group after it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub seq: u64,
    pub kind: EntryKind,
    pub epoch: u64,
    pub sender: UserId,
    /// base64url; empty once a message is pruned.
    pub data: String,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<UserId>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pruned: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Exists {
    pub group_id: String,
    pub epoch: u64,
}

/// A commit as a member sends it: the welcome is (who it is for, the message); `added` names the KeyPackages it adds
/// (SHA-256 in hex of each), whose requests it fulfils.
#[derive(Debug, Clone)]
pub struct GroupCommit {
    pub group_id: String,
    pub epoch: u64,
    pub data: String,
    pub members: Vec<UserId>,
    pub welcome: Option<(Vec<UserId>, String)>,
    pub added: Vec<String>,
}

/// The SHA-256 (hex) of a request's KeyPackage (base64url): how a commit names the requests it fulfils.
pub fn key_package_hash(key_package: &str) -> Option<String> {
    let bytes = hv_roster::keys::decode_b64_vec(key_package)?;
    Some(hv_roster::keys::sha256(&bytes).iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Debug, PartialEq, Eq)]
pub struct Accepted {
    /// The epoch the group is in now.
    pub epoch: u64,
    pub seq: u64,
    /// The group before the commit: whoever it removed is to hear of it too.
    pub before: Vec<UserId>,
    pub entry: Entry,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GroupError {
    /// No group, or another one than named.
    NoGroup,
    /// The sender is not in the group (or left itself out of the commit's members).
    NotMember,
    /// Someone was first in this epoch, or a message was made in another epoch.
    Conflict { epoch: u64 },
}

/// What a member catches up with.
#[derive(Debug, PartialEq, Eq)]
pub struct Backlog {
    pub group_id: String,
    pub epoch: u64,
    pub members: Vec<UserId>,
    pub entries: Vec<Entry>,
    /// There are entries after these.
    pub more: bool,
    pub pending: Vec<(UserId, String)>,
    /// The welcome made for whoever asked: (epoch it brings them into, message).
    pub welcome: Option<(u64, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Meta {
    group_id: String,
    creator: UserId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Welcome {
    user: UserId,
    epoch: u64,
    message: String,
    at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Pending {
    joins: Vec<(UserId, String)>,
    welcomes: Vec<Welcome>,
}

#[derive(Default)]
struct Inner {
    meta: Option<Meta>,
    log: Vec<Entry>,
    pending: Pending,
}

impl Inner {
    fn epoch(&self) -> u64 {
        self.log.iter().rev().find(|e| e.kind == EntryKind::Commit).map_or(0, |e| e.epoch + 1)
    }

    fn members(&self) -> Vec<UserId> {
        match self.log.iter().rev().find(|e| e.kind == EntryKind::Commit) {
            Some(commit) => commit.members.clone(),
            None => self.meta.iter().map(|m| m.creator.clone()).collect(),
        }
    }

    fn next_seq(&self) -> u64 {
        self.log.last().map_or(1, |e| e.seq + 1)
    }

    /// The group if it is the one named.
    fn named(&self, group_id: &str) -> Option<&Meta> {
        self.meta.as_ref().filter(|m| m.group_id == group_id)
    }
}

pub struct GroupStore {
    dir: Option<PathBuf>,
    inner: Mutex<Inner>,
}

impl GroupStore {
    /// `None` keeps everything in memory. Unreadable files start empty; a broken last line of the log (a crash
    /// while writing it) ends the log there.
    pub fn open(dir: Option<&Path>) -> GroupStore {
        Self::open_at(dir.map(|d| d.join(GROUP_DIR)))
    }

    /// A store kept right in `dir` (a room's folder).
    pub fn open_at(dir: Option<PathBuf>) -> GroupStore {
        let mut inner = Inner::default();
        if let Some(dir) = &dir {
            inner.meta = std::fs::read(dir.join(META_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok());
            if let Ok(text) = std::fs::read_to_string(dir.join(LOG_FILE)) {
                for line in text.lines() {
                    match serde_json::from_str::<Entry>(line) {
                        Ok(entry) if entry.seq == inner.next_seq() => inner.log.push(entry),
                        _ => break,
                    }
                }
            }
            inner.pending = std::fs::read(dir.join(PENDING_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        }
        GroupStore { dir, inner: Mutex::new(inner) }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The first one starts the group at epoch 0, alone in it; later ones are told which group to join.
    pub fn create(&self, group_id: String, creator: UserId) -> Result<(), Exists> {
        let mut inner = self.lock();
        if let Some(meta) = &inner.meta {
            return Err(Exists { group_id: meta.group_id.clone(), epoch: inner.epoch() });
        }
        inner.meta = Some(Meta { group_id, creator });
        self.save_meta(&inner);
        Ok(())
    }

    /// Keeps `user`'s request to join (the newest one only). The group's members are to hear of it; `None` when the
    /// group is not the one named.
    pub fn join(&self, group_id: &str, user: &UserId, key_package: String) -> Option<Vec<UserId>> {
        let mut inner = self.lock();
        inner.named(group_id)?;
        inner.pending.joins.retain(|(asker, _)| asker != user);
        inner.pending.joins.push((user.clone(), key_package));
        self.save_pending(&inner);
        Some(inner.members())
    }

    pub fn commit(&self, commit: GroupCommit, sender: &UserId, now: u64) -> Result<Accepted, GroupError> {
        let mut inner = self.lock();
        inner.named(&commit.group_id).ok_or(GroupError::NoGroup)?;
        let before = inner.members();
        if !before.contains(sender) || !commit.members.contains(sender) {
            return Err(GroupError::NotMember);
        }
        let epoch = inner.epoch();
        if commit.epoch != epoch {
            return Err(GroupError::Conflict { epoch });
        }
        let entry = Entry {
            seq: inner.next_seq(),
            kind: EntryKind::Commit,
            epoch,
            sender: sender.clone(),
            data: commit.data,
            at: now,
            members: commit.members,
            pruned: false,
        };
        self.append(&entry);
        inner.log.push(entry.clone());
        // Only the requests the commit fulfils go: someone who asked again meanwhile (a restart) keeps the newer one,
        // even though an older KeyPackage of theirs just went in.
        inner.pending.joins.retain(|(_, key_package)| key_package_hash(key_package).is_none_or(|hash| !commit.added.contains(&hash)));
        if let Some((to, message)) = commit.welcome {
            inner.pending.welcomes.retain(|w| !to.contains(&w.user));
            for user in to {
                inner.pending.welcomes.push(Welcome { user, epoch: epoch + 1, message: message.clone(), at: now });
            }
        }
        self.save_pending(&inner);
        Ok(Accepted { epoch: epoch + 1, seq: entry.seq, before, entry })
    }

    /// A message of the current epoch from a member; Ok is the entry and the members to send it to.
    pub fn message(&self, group_id: &str, sender: &UserId, epoch: u64, data: String, now: u64) -> Result<(Entry, Vec<UserId>), GroupError> {
        let mut inner = self.lock();
        inner.named(group_id).ok_or(GroupError::NoGroup)?;
        let members = inner.members();
        if !members.contains(sender) {
            return Err(GroupError::NotMember);
        }
        let current = inner.epoch();
        if epoch != current {
            return Err(GroupError::Conflict { epoch: current });
        }
        let entry = Entry {
            seq: inner.next_seq(),
            kind: EntryKind::Message,
            epoch,
            sender: sender.clone(),
            data,
            at: now,
            members: Vec::new(),
            pruned: false,
        };
        self.append(&entry);
        inner.log.push(entry.clone());
        Ok((entry, members))
    }

    /// `user` takes its request to join back; false when the group is not the one named.
    pub fn withdraw(&self, group_id: &str, user: &UserId) -> bool {
        let mut inner = self.lock();
        if inner.named(group_id).is_none() {
            return false;
        }
        let before = inner.pending.joins.len();
        inner.pending.joins.retain(|(asker, _)| asker != user);
        if inner.pending.joins.len() != before {
            self.save_pending(&inner);
        }
        true
    }

    /// A signal of the current epoch from a member, which is not kept: the members to pass it to.
    pub fn signal(&self, group_id: &str, sender: &UserId, epoch: u64) -> Result<Vec<UserId>, GroupError> {
        let inner = self.lock();
        inner.named(group_id).ok_or(GroupError::NoGroup)?;
        let members = inner.members();
        if !members.contains(sender) {
            return Err(GroupError::NotMember);
        }
        let current = inner.epoch();
        if epoch != current {
            return Err(GroupError::Conflict { epoch: current });
        }
        Ok(members)
    }

    /// Entries after `since` (at most `limit`), the requests to join, and the welcome made for `user`.
    pub fn since(&self, user: &UserId, since: u64, limit: usize, now: u64) -> Option<Backlog> {
        let inner = self.lock();
        let meta = inner.meta.as_ref()?;
        let after: Vec<&Entry> = inner.log.iter().filter(|e| e.seq > since).collect();
        let welcome = inner
            .pending
            .welcomes
            .iter()
            .find(|w| &w.user == user && now.saturating_sub(w.at) < KEEP_WELCOME)
            .map(|w| (w.epoch, w.message.clone()));
        Some(Backlog {
            group_id: meta.group_id.clone(),
            epoch: inner.epoch(),
            members: inner.members(),
            more: after.len() > limit,
            entries: after.into_iter().take(limit).cloned().collect(),
            pending: inner.pending.joins.clone(),
            welcome,
        })
    }

    /// The owner starts the group over: the old one, its log, requests and welcomes are forgotten, and the owner is
    /// the only member of the new one.
    pub fn reset(&self, group_id: String, creator: UserId) {
        let mut inner = self.lock();
        *inner = Inner { meta: Some(Meta { group_id, creator }), log: Vec::new(), pending: Pending::default() };
        self.save_meta(&inner);
        self.rewrite_log(&inner);
        self.save_pending(&inner);
    }

    /// Empties messages older than [`KEEP_MESSAGES`] (they keep their number) and drops welcomes older than
    /// [`KEEP_WELCOME`].
    pub fn prune(&self, now: u64) {
        let mut inner = self.lock();
        let mut changed = false;
        for entry in inner.log.iter_mut().filter(|e| e.kind == EntryKind::Message && !e.pruned) {
            if now.saturating_sub(entry.at) >= KEEP_MESSAGES {
                entry.data.clear();
                entry.pruned = true;
                changed = true;
            }
        }
        if changed {
            self.rewrite_log(&inner);
        }
        let before = inner.pending.welcomes.len();
        inner.pending.welcomes.retain(|w| now.saturating_sub(w.at) < KEEP_WELCOME);
        if inner.pending.welcomes.len() != before {
            self.save_pending(&inner);
        }
    }

    fn file(&self, name: &str) -> Option<PathBuf> {
        let dir = self.dir.as_ref()?;
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("group folder not created: {e}");
        }
        Some(dir.join(name))
    }

    /// Writes `value` to `name` through a temporary file, so a crash leaves the old file or the new one.
    fn write_atomic(&self, name: &str, value: &impl Serialize) {
        let Some(path) = self.file(name) else { return };
        let Ok(json) = serde_json::to_vec(value) else { return };
        let temp = path.with_extension("tmp");
        if let Err(e) = std::fs::write(&temp, json).and_then(|_| std::fs::rename(&temp, &path)) {
            tracing::warn!("{name} not written: {e}");
        }
    }

    fn save_meta(&self, inner: &Inner) {
        if let Some(meta) = &inner.meta {
            self.write_atomic(META_FILE, meta);
        }
    }

    fn save_pending(&self, inner: &Inner) {
        self.write_atomic(PENDING_FILE, &inner.pending);
    }

    fn append(&self, entry: &Entry) {
        use std::io::Write;
        let Some(path) = self.file(LOG_FILE) else { return };
        let Ok(mut line) = serde_json::to_vec(entry) else { return };
        line.push(b'\n');
        let written = std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(&line));
        if let Err(e) = written {
            tracing::warn!("group log not written: {e}");
        }
    }

    fn rewrite_log(&self, inner: &Inner) {
        let Some(path) = self.file(LOG_FILE) else { return };
        let mut text = Vec::new();
        for entry in &inner.log {
            if let Ok(line) = serde_json::to_vec(entry) {
                text.extend_from_slice(&line);
                text.push(b'\n');
            }
        }
        let temp = path.with_extension("tmp");
        if let Err(e) = std::fs::write(&temp, text).and_then(|_| std::fs::rename(&temp, &path)) {
            tracing::warn!("group log not rewritten: {e}");
        }
    }

    /// Someone started the group.
    pub fn exists(&self) -> bool {
        self.lock().meta.is_some()
    }

    /// The members of the group, by its last commit.
    pub fn members(&self) -> Vec<UserId> {
        self.lock().members()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: &str = "AAAAAAAAAAAAAAAAAAAAAA";
    const OTHER: &str = "BBBBBBBBBBBBBBBBBBBBBA";

    fn u(name: &str) -> UserId {
        UserId(name.into())
    }

    fn commit(epoch: u64, members: &[&str], welcome: Option<(&[&str], &str)>) -> GroupCommit {
        GroupCommit {
            group_id: G.into(),
            epoch,
            data: format!("commit {epoch}"),
            members: members.iter().map(|m| u(m)).collect(),
            welcome: welcome.map(|(to, message)| (to.iter().map(|m| u(m)).collect(), message.into())),
            added: Vec::new(),
        }
    }

    /// A request's KeyPackage, as it travels: `name` in base64url.
    fn kp(name: &str) -> String {
        hv_roster::keys::encode_b64(name.as_bytes())
    }

    fn adding(mut commit: GroupCommit, key_packages: &[&str]) -> GroupCommit {
        commit.added = key_packages.iter().map(|name| key_package_hash(&kp(name)).unwrap()).collect();
        commit
    }

    fn started() -> GroupStore {
        let store = GroupStore::open(None);
        store.create(G.into(), u("a")).unwrap();
        store
    }

    #[test]
    fn create_then_exists() {
        let store = started();
        assert_eq!(store.create(OTHER.into(), u("b")), Err(Exists { group_id: G.into(), epoch: 0 }));
        assert_eq!(store.members(), vec![u("a")]);
        let backlog = store.since(&u("a"), 0, 500, 10).unwrap();
        assert_eq!((backlog.group_id.as_str(), backlog.epoch, backlog.entries.len()), (G, 0, 0));
    }

    #[test]
    fn join_queues_until_a_commit_takes_it() {
        let store = started();
        assert_eq!(store.join(OTHER, &u("b"), kp("kp")), None, "another group");
        assert_eq!(store.join(G, &u("b"), kp("kp old")), Some(vec![u("a")]));
        assert_eq!(store.join(G, &u("b"), kp("kp")), Some(vec![u("a")]));
        assert_eq!(store.since(&u("a"), 0, 500, 10).unwrap().pending, vec![(u("b"), kp("kp"))], "the newest only");

        let accepted = store.commit(adding(commit(0, &["a", "b"], Some((&["b"], "welcome b"))), &["kp"]), &u("a"), 20).unwrap();
        assert_eq!((accepted.epoch, accepted.seq, accepted.before.clone()), (1, 1, vec![u("a")]));
        assert_eq!(accepted.entry.kind, EntryKind::Commit);
        let for_b = store.since(&u("b"), 0, 500, 30).unwrap();
        assert!(for_b.pending.is_empty());
        assert_eq!(for_b.welcome, Some((1, "welcome b".to_string())));
        assert_eq!(store.since(&u("a"), 0, 500, 30).unwrap().welcome, None, "for its addressee only");
        assert_eq!(store.members(), vec![u("a"), u("b")]);
    }

    #[test]
    fn one_commit_per_epoch() {
        let store = started();
        store.commit(commit(0, &["a"], None), &u("a"), 1).unwrap();
        assert_eq!(store.commit(commit(0, &["a"], None), &u("a"), 2), Err(GroupError::Conflict { epoch: 1 }));
        assert_eq!(store.commit(commit(1, &["a"], None), &u("x"), 2), Err(GroupError::NotMember));
        assert_eq!(store.commit(commit(1, &["b"], None), &u("a"), 2), Err(GroupError::NotMember), "left itself out");
        let mut other = commit(1, &["a"], None);
        other.group_id = OTHER.into();
        assert_eq!(store.commit(other, &u("a"), 2), Err(GroupError::NoGroup));
    }

    #[test]
    fn a_message_only_in_the_current_epoch() {
        let store = started();
        let (entry, to) = store.message(G, &u("a"), 0, "m".into(), 5).unwrap();
        assert_eq!((entry.seq, entry.kind, entry.epoch, entry.at, to), (1, EntryKind::Message, 0, 5, vec![u("a")]));
        store.commit(commit(0, &["a", "b"], None), &u("a"), 6).unwrap();
        assert_eq!(store.message(G, &u("b"), 0, "late".into(), 7), Err(GroupError::Conflict { epoch: 1 }));
        assert_eq!(store.message(G, &u("x"), 1, "x".into(), 7), Err(GroupError::NotMember));
        assert_eq!(store.message(OTHER, &u("a"), 1, "x".into(), 7), Err(GroupError::NoGroup));
        assert_eq!(store.message(G, &u("b"), 1, "ok".into(), 8).unwrap().0.seq, 3);
    }

    #[test]
    fn seq_runs_without_gaps_and_pages() {
        let store = started();
        for n in 0..1200 {
            store.message(G, &u("a"), 0, format!("m{n}"), n).unwrap();
        }
        let first = store.since(&u("a"), 0, 500, 0).unwrap();
        assert_eq!((first.entries.len(), first.entries[0].seq, first.entries[499].seq, first.more), (500, 1, 500, true));
        let second = store.since(&u("a"), 500, 500, 0).unwrap();
        assert_eq!((second.entries[0].seq, second.more), (501, true));
        let third = store.since(&u("a"), 1000, 500, 0).unwrap();
        assert_eq!((third.entries.len(), third.entries.last().unwrap().seq, third.more), (200, 1200, false));
    }

    #[test]
    fn the_log_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("hv-group-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        {
            let store = GroupStore::open(Some(&dir));
            store.create(G.into(), u("a")).unwrap();
            store.join(G, &u("b"), kp("kp b")).unwrap();
            store.join(G, &u("c"), kp("kp c")).unwrap();
            store.commit(adding(commit(0, &["a", "b"], Some((&["b"], "welcome b"))), &["kp b"]), &u("a"), 1).unwrap();
            store.message(G, &u("b"), 1, "hello".into(), 2).unwrap();
        }
        let store = GroupStore::open(Some(&dir));
        let backlog = store.since(&u("b"), 0, 500, 3).unwrap();
        assert_eq!((backlog.epoch, backlog.members.clone()), (1, vec![u("a"), u("b")]));
        assert_eq!(backlog.entries.iter().map(|e| e.data.as_str()).collect::<Vec<_>>(), ["commit 0", "hello"]);
        assert_eq!(backlog.pending, vec![(u("c"), kp("kp c"))]);
        assert_eq!(backlog.welcome, Some((1, "welcome b".to_string())));
        assert_eq!(store.message(G, &u("a"), 1, "again".into(), 4).unwrap().0.seq, 3);

        // A crash in the middle of a line: the log ends at the last whole entry.
        let log = dir.join(GROUP_DIR).join(LOG_FILE);
        let mut text = std::fs::read_to_string(&log).unwrap();
        text.push_str("{\"seq\":4,\"ki");
        std::fs::write(&log, text).unwrap();
        assert_eq!(GroupStore::open(Some(&dir)).since(&u("a"), 0, 500, 5).unwrap().entries.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_messages_are_pruned_but_keep_their_seq() {
        let store = started();
        store.message(G, &u("a"), 0, "old".into(), 100).unwrap();
        store.commit(commit(0, &["a"], None), &u("a"), 100).unwrap();
        store.message(G, &u("a"), 1, "new".into(), 100 + KEEP_MESSAGES).unwrap();
        store.prune(100 + KEEP_MESSAGES);
        let entries = store.since(&u("a"), 0, 500, 0).unwrap().entries;
        assert_eq!(entries.iter().map(|e| (e.seq, e.data.as_str(), e.pruned)).collect::<Vec<_>>(), [(1, "", true), (2, "commit 0", false), (3, "new", false)]);
    }

    #[test]
    fn a_welcome_waits_a_week() {
        let store = started();
        store.commit(commit(0, &["a", "b"], Some((&["b"], "w"))), &u("a"), 0).unwrap();
        assert!(store.since(&u("b"), 0, 500, KEEP_WELCOME - 1).unwrap().welcome.is_some());
        assert!(store.since(&u("b"), 0, 500, KEEP_WELCOME).unwrap().welcome.is_none());
    }

    #[test]
    fn reset_forgets_the_group() {
        let store = started();
        store.join(G, &u("b"), "kp".into()).unwrap();
        store.commit(commit(0, &["a", "b"], Some((&["b"], "w"))), &u("a"), 1).unwrap();
        store.reset(OTHER.into(), u("b"));
        let backlog = store.since(&u("a"), 0, 500, 2).unwrap();
        assert_eq!((backlog.group_id.as_str(), backlog.epoch, backlog.members.clone()), (OTHER, 0, vec![u("b")]));
        assert!(backlog.entries.is_empty() && backlog.pending.is_empty());
        assert_eq!(store.since(&u("b"), 0, 500, 2).unwrap().welcome, None);
        assert_eq!(store.join(G, &u("a"), "kp".into()), None, "the old group is gone");
    }
}
