//! The server group engine: the one place that decides when to start the server's group, ask to join it, add and
//! remove people, catch up with the log and send a message, for the server chat. It is the call engine's sibling:
//! the same group (`hv_crypto`) under the context [`SERVER_CONTEXT`], the same commit queue, but the group lives on
//! disk ([`ChatStore`]) and goes on for as long as the person is a member of the server.
//!
//! The server keeps the log of the group (commits and messages, by number) and relays it without reading it. Every
//! leaf must be someone the signed journal lets in ([`admit_by`]). Whatever goes wrong with the group — a commit that
//! does not apply, being removed, another group on the server — the group is dropped and joined anew; the history
//! that was read stays on disk.

use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hv_crypto::group::{self, CallGroup, Joiner, Outgoing, SERVER_CONTEXT};
use hv_roster::keys::{decode_b64, decode_b64_vec, encode_b64, random_bytes, sha256};
use hv_roster::{Identity, UserId};
use serde::Serialize;
use serde_json::{Value, json};

use crate::call::{Admit, Committed, Created, Journal};
use crate::call_plan::{Changes, STEP, changes, commit_delay};
use crate::chat_store::{ChatStore, HistoryRecord, Snapshot};
use crate::session::{Link, ServerError, Session, error_from, unix_now};

/// The server's answer (404) when it has no group, or another one than named.
const NO_GROUP: &str = "Группы нет";
pub const NOT_READY: &str = "Шифрование чата ещё подключается — подожди немного";
const NOT_SENT: &str = "Сообщение не отправилось: группа всё время меняется — попробуй ещё раз";
const FAILED: &str = "Не удалось зашифровать сообщение";
/// KeyPackages kept waiting, at most: a server cannot make us hoard them.
const MAX_PENDING: usize = 64;
/// Steps one call of the engine may take: begin, join, catch up, commit, catch up again.
const ROUNDS: usize = 8;
/// Pages of the log one catch-up reads before the others get a turn.
const PAGES: usize = 200;
/// 409s in a row one message may meet before the person is told.
const MAX_CONFLICTS: usize = 3;
/// How often a joiner asks the server for its welcome (in case the event was lost) and who is online.
const POLL: Duration = Duration::from_secs(10);
/// A joiner that waited this long while members were online asks again with a new KeyPackage.
const REASK: Duration = Duration::from_secs(60);
/// `since` after the end of the log: no entries, only the state of the group.
const LATEST: u64 = u64::MAX;
/// A request that would put a new leaf in place of a member's waits this much longer, and is looked up again before
/// it goes in: it may be one left from that member's earlier run, which they take back once they see it.
pub const REPLACE_GRACE: Duration = Duration::from_secs(5);

/// The server's answer to a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    Done { seq: u64, at: u64 },
    /// The group is in another epoch by now.
    Conflict,
}

/// One entry of the server's log. A pruned message has no `data`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEntry {
    pub seq: u64,
    pub commit: bool,
    /// The epoch it was made in.
    pub epoch: u64,
    pub sender: UserId,
    pub data: Vec<u8>,
    pub at: u64,
}

impl GroupEntry {
    /// An entry as the server sends it, in `GET /api/group` and in the `group_entry` event.
    pub fn from_json(value: &Value) -> Option<GroupEntry> {
        let data = value["data"].as_str()?;
        Some(GroupEntry {
            seq: value["seq"].as_u64()?,
            commit: match value["kind"].as_str()? {
                "commit" => true,
                "message" => false,
                _ => return None,
            },
            epoch: value["epoch"].as_u64()?,
            sender: UserId(value["sender"].as_str()?.to_string()),
            data: if data.is_empty() { Vec::new() } else { decode_b64_vec(data)? },
            at: value["at"].as_u64()?,
        })
    }
}

/// The server's group as one member sees it: the log after a number, a page at a time, who asks to join, and the
/// welcome made for us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupBacklog {
    pub group: [u8; 16],
    pub epoch: u64,
    pub members: Vec<UserId>,
    /// The members with the app open now.
    pub online: Vec<UserId>,
    pub entries: Vec<GroupEntry>,
    /// There are entries after these.
    pub more: bool,
    pub pending: Vec<(UserId, Vec<u8>)>,
    /// (the epoch it brings us into, the welcome).
    pub welcome: Option<(u64, Vec<u8>)>,
}

/// What the chat shows about its keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupStatus {
    Ready,
    Joining,
    /// Nobody of the group is online to add us.
    Waiting,
    /// The server did not answer; the engine keeps trying.
    Failed,
}

/// The way to the server's group routes (in the app, signed requests through the session; in tests, the same code
/// against a server in the process).
pub trait GroupTransport: Send + Sync {
    fn create(&self, group: [u8; 16]) -> impl Future<Output = Result<Created, ServerError>> + Send;
    /// Asks into `group`; [`NO_GROUP`] when the server's group is another one by now.
    fn join(&self, group: [u8; 16], key_package: &[u8]) -> impl Future<Output = Result<(), ServerError>> + Send;
    /// `added`: the SHA-256 (hex) of each KeyPackage the commit adds, whose requests it fulfils.
    fn commit(&self, group: [u8; 16], out: &Outgoing, added: &[String]) -> impl Future<Output = Result<Committed, ServerError>> + Send;
    fn message(&self, group: [u8; 16], epoch: u64, message: &[u8]) -> impl Future<Output = Result<Sent, ServerError>> + Send;
    fn since(&self, seq: u64) -> impl Future<Output = Result<GroupBacklog, ServerError>> + Send;
    /// The owner starts the group over as `group`.
    fn reset(&self, group: [u8; 16]) -> impl Future<Output = Result<(), ServerError>> + Send;
    /// Puts the blob of a file: its SHA-256 (hex).
    fn upload(&self, blob: &[u8]) -> impl Future<Output = Result<String, ServerError>> + Send;
    /// The blob under `sha`; [`NO_FILE`] when the server has none.
    fn download(&self, sha: &str) -> impl Future<Output = Result<Vec<u8>, ServerError>> + Send;
    /// Takes our own request to join back (one left from an earlier run, now that we are in).
    fn withdraw(&self, group: [u8; 16]) -> impl Future<Output = Result<(), ServerError>> + Send;
    /// A signal for the members online, which the server does not keep.
    fn signal(&self, group: [u8; 16], epoch: u64, message: &[u8]) -> impl Future<Output = Result<(), ServerError>> + Send;
}

/// A signal sealed with the epoch's signal key; the sender's id is bound in, so the server can't pass it off as
/// someone else's.
fn seal_signal(key: &[u8; 32], sender: &UserId, body: &[u8]) -> Option<Vec<u8>> {
    let nonce = random_bytes::<24>().ok()?;
    let sealed = XChaCha20Poly1305::new(key.into()).encrypt(&XNonce::from(nonce), Payload { msg: body, aad: sender.0.as_bytes() }).ok()?;
    Some([&nonce[..], &sealed].concat())
}

fn open_signal(key: &[u8; 32], sender: &UserId, sealed: &[u8]) -> Option<Vec<u8>> {
    let nonce: [u8; 24] = sealed.get(..24)?.try_into().ok()?;
    XChaCha20Poly1305::new(key.into()).decrypt(&XNonce::from(nonce), Payload { msg: &sealed[24..], aad: sender.0.as_bytes() }).ok()
}

/// The server's answer (404) when it has no such blob (gone after 90 days, or never put).
pub const NO_FILE: &str = "Файл не найден";

fn no_group(error: &ServerError) -> bool {
    matches!(error, ServerError::Refused(text) if text == NO_GROUP)
}

fn odd_answer() -> ServerError {
    ServerError::Refused("Непонятный ответ сервера".into())
}

fn refusal(status: u16, body: &Value) -> ServerError {
    if status == 404 { ServerError::Refused(NO_GROUP.into()) } else { error_from(status, body, unix_now()) }
}

fn bytes(value: &Value) -> Option<Vec<u8>> {
    value.as_str().and_then(decode_b64_vec).filter(|bytes| !bytes.is_empty())
}

fn users(value: &Value) -> Option<Vec<UserId>> {
    value.as_array()?.iter().map(|user| Some(UserId(user.as_str()?.to_string()))).collect()
}

/// The group routes over the session's own pinned client, with a [`Link`] of its own (as the call's transport), for
/// the server's group or one room of it (a closed channel's, direct messages').
pub struct SessionGroupTransport {
    link: Link,
    id: Identity,
    room: Option<String>,
}

impl fmt::Debug for SessionGroupTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionGroupTransport").field("address", &self.link.address).finish_non_exhaustive()
    }
}

impl SessionGroupTransport {
    /// Takes what it needs from `session`, which may be let go of right after.
    pub fn new(session: &Session, id: &Identity) -> Self {
        Self { link: session.link(), id: Identity::from_seed(id.seed()), room: None }
    }

    /// The same way to the server, for the room `room`.
    pub fn for_room(&self, room: &str) -> Self {
        Self { link: self.link.clone(), id: Identity::from_seed(self.id.seed()), room: Some(room.to_string()) }
    }

    /// Every request names the room it is for; the server's group goes without one, as it always has.
    async fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), ServerError> {
        let body = match (body, &self.room) {
            (Some(mut body), Some(room)) => {
                body["room"] = Value::String(room.clone());
                Some(body)
            }
            (body, _) => body,
        };
        let path = match &self.room {
            Some(room) if method == "GET" => format!("{path}{}room={room}", if path.contains('?') { '&' } else { '?' }),
            _ => path.to_string(),
        };
        self.link.request_raw(&self.id, method, &path, body.as_ref()).await
    }

    /// The rooms of direct messages we are in on this server.
    pub async fn rooms(&self) -> Result<Vec<String>, ServerError> {
        let (status, body) = self.link.request_raw(&self.id, "GET", "/api/rooms", None).await?;
        if status != 200 {
            return Err(error_from(status, &body, unix_now()));
        }
        Ok(body["rooms"].as_array().map(|rooms| rooms.iter().filter_map(|r| r.as_str().map(str::to_string)).collect()).unwrap_or_default())
    }
}

impl GroupTransport for SessionGroupTransport {
    async fn create(&self, group: [u8; 16]) -> Result<Created, ServerError> {
        let (status, body) = self.send("POST", "/api/group/create", Some(json!({ "group_id": encode_b64(&group) }))).await?;
        match status {
            200 => Ok(Created::Started),
            409 if body["exists"] == true => {
                let group = body["group_id"].as_str().and_then(decode_b64::<16>).ok_or_else(odd_answer)?;
                Ok(Created::Exists { group })
            }
            _ => Err(refusal(status, &body)),
        }
    }

    async fn join(&self, group: [u8; 16], key_package: &[u8]) -> Result<(), ServerError> {
        let body = json!({ "group_id": encode_b64(&group), "key_package": encode_b64(key_package) });
        let (status, body) = self.send("POST", "/api/group/join", Some(body)).await?;
        if status == 200 { Ok(()) } else { Err(refusal(status, &body)) }
    }

    async fn commit(&self, group: [u8; 16], out: &Outgoing, added: &[String]) -> Result<Committed, ServerError> {
        let welcome = out.welcome.as_ref().map(|message| json!({ "to": out.welcome_to, "message": encode_b64(message) }));
        let body = json!({ "group_id": encode_b64(&group), "epoch": out.epoch, "commit": encode_b64(&out.commit), "members": out.members, "welcome": welcome, "added": added });
        let (status, body) = self.send("POST", "/api/group/commit", Some(body)).await?;
        match status {
            200 => Ok(Committed::Accepted),
            409 if body["conflict"] == true => Ok(Committed::Conflict),
            _ => Err(refusal(status, &body)),
        }
    }

    async fn message(&self, group: [u8; 16], epoch: u64, message: &[u8]) -> Result<Sent, ServerError> {
        let body = json!({ "group_id": encode_b64(&group), "epoch": epoch, "message": encode_b64(message) });
        let (status, body) = self.send("POST", "/api/group/message", Some(body)).await?;
        match status {
            200 => Ok(Sent::Done { seq: body["seq"].as_u64().ok_or_else(odd_answer)?, at: body["at"].as_u64().ok_or_else(odd_answer)? }),
            409 if body["conflict"] == true => Ok(Sent::Conflict),
            _ => Err(refusal(status, &body)),
        }
    }

    async fn since(&self, seq: u64) -> Result<GroupBacklog, ServerError> {
        let (status, body) = self.send("GET", &format!("/api/group?since={seq}"), None).await?;
        if status != 200 {
            return Err(refusal(status, &body));
        }
        let entries = body["entries"].as_array().ok_or_else(odd_answer)?.iter().map(GroupEntry::from_json).collect::<Option<Vec<_>>>();
        let pending = body["pending"]
            .as_array()
            .ok_or_else(odd_answer)?
            .iter()
            .map(|request| Some((UserId(request["user"].as_str()?.to_string()), bytes(&request["key_package"])?)))
            .collect::<Option<Vec<_>>>();
        let welcome = match &body["welcome"] {
            Value::Null => Some(None),
            welcome => welcome["epoch"].as_u64().zip(bytes(&welcome["message"])).map(Some),
        };
        Ok(GroupBacklog {
            group: body["group_id"].as_str().and_then(decode_b64::<16>).ok_or_else(odd_answer)?,
            epoch: body["epoch"].as_u64().ok_or_else(odd_answer)?,
            members: users(&body["members"]).ok_or_else(odd_answer)?,
            online: users(&body["online"]).ok_or_else(odd_answer)?,
            entries: entries.ok_or_else(odd_answer)?,
            more: body["more"].as_bool().ok_or_else(odd_answer)?,
            pending: pending.ok_or_else(odd_answer)?,
            welcome: welcome.ok_or_else(odd_answer)?,
        })
    }

    async fn reset(&self, group: [u8; 16]) -> Result<(), ServerError> {
        let (status, body) = self.send("POST", "/api/group/reset", Some(json!({ "group_id": encode_b64(&group) }))).await?;
        if status == 200 { Ok(()) } else { Err(refusal(status, &body)) }
    }

    async fn upload(&self, blob: &[u8]) -> Result<String, ServerError> {
        let (status, body) = self.link.exchange_bytes(&self.id, "POST", "/api/chat-media", blob.to_vec(), ANSWER_LIMIT).await?;
        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status != 200 {
            return Err(error_from(status, &body, unix_now()));
        }
        body["sha256"].as_str().map(str::to_string).ok_or_else(odd_answer)
    }

    async fn withdraw(&self, group: [u8; 16]) -> Result<(), ServerError> {
        let (status, body) = self.send("POST", "/api/group/withdraw", Some(json!({ "group_id": encode_b64(&group) }))).await?;
        if status == 200 { Ok(()) } else { Err(refusal(status, &body)) }
    }

    async fn signal(&self, group: [u8; 16], epoch: u64, message: &[u8]) -> Result<(), ServerError> {
        let body = json!({ "group_id": encode_b64(&group), "epoch": epoch, "message": encode_b64(message) });
        let (status, body) = self.send("POST", "/api/group/signal", Some(body)).await?;
        if status == 200 { Ok(()) } else { Err(refusal(status, &body)) }
    }

    async fn download(&self, sha: &str) -> Result<Vec<u8>, ServerError> {
        let path = format!("/api/chat-media/{sha}");
        let (status, body) = self.link.exchange_bytes(&self.id, "GET", &path, Vec::new(), crate::chat_files::MAX_BLOB).await?;
        match status {
            200 => Ok(body),
            404 => Err(ServerError::Refused(NO_FILE.into())),
            _ => Err(error_from(status, &serde_json::from_slice(&body).unwrap_or(Value::Null), unix_now())),
        }
    }
}

/// An answer that is not a file: a few lines of JSON.
const ANSWER_LIMIT: usize = 64 * 1024;

/// The journal lets `user` into the server group: a member, not banned now.
pub fn admit_by(journal: Journal) -> Admit {
    std::sync::Arc::new(move |user| {
        let roster = journal.read().unwrap_or_else(|e| e.into_inner());
        roster.member(user).is_some() && !roster.is_banned_at(user, unix_now())
    })
}

enum Phase {
    /// Neither in the group nor waiting for a welcome: starts over with `create` at the next chance.
    Outside,
    /// Asked to join; waits for the welcome.
    Joining { joiner: Box<Joiner>, group: [u8; 16], asked: Instant, polled: Option<Instant> },
    InGroup(Box<CallGroup>),
}

/// One person's side of one server's group.
pub struct GroupEngine<T: GroupTransport> {
    transport: T,
    id: Identity,
    /// What every leaf's credential is bound to: the server's group or one room (`@ch.staff`), so a leaf of one can't
    /// be passed off in another.
    context: String,
    me: UserId,
    store: ChatStore,
    admit: Admit,
    phase: Phase,
    /// The number of the last entry of the log the group has taken in.
    last: u64,
    /// The group's members the server last said were online; `None` until it has said.
    online: Option<Vec<UserId>>,
    /// Requests to join, in order of arrival; never our own.
    pending: Vec<(UserId, Vec<u8>)>,
    /// KeyPackages (by hash) already in the group or refused: none is added twice.
    spent: HashSet<[u8; 32]>,
    /// Since when the group has needed a change: the commit queue counts from here.
    needed_since: Option<Instant>,
    /// The server has entries we have not taken in.
    behind: bool,
    /// After a failed request, nothing goes to the server before this.
    quiet_until: Option<Instant>,
    /// While joining: the commits that went by, as (epoch made in, number). Reading starts after the one that
    /// brought us in.
    commits_seen: Vec<(u64, u64)>,
    welcome_failures: u32,
    /// The last request to the server failed.
    failed: bool,
    /// Signals that came, opened, until they are taken: (sender, body).
    signals: Vec<(UserId, Vec<u8>)>,
    /// A request of ours turned up while we are in the group: one left from an earlier run, to take back.
    stale_request: bool,
    /// Whom our commits put in (newcomers, or a member with a new leaf), until it is asked.
    added: Vec<UserId>,
}

impl<T: GroupTransport> fmt::Debug for GroupEngine<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GroupEngine").field("me", &self.me).field("status", &self.status()).field("last", &self.last).finish_non_exhaustive()
    }
}

impl<T: GroupTransport> GroupEngine<T> {
    /// Resumes the group saved in `store`, or starts the server's group, or asks to join it. The records are what was
    /// read on the way, already in the history.
    pub async fn start(transport: T, id: &Identity, store: ChatStore, admit: Admit, now: Instant) -> (Self, Vec<HistoryRecord>) {
        Self::start_in(transport, id, store, admit, SERVER_CONTEXT, now).await
    }

    /// As [`start`](Self::start), for the group of `context` (a room's: `@ch.<id>`, `@dm.<a>.<b>`).
    pub async fn start_in(transport: T, id: &Identity, store: ChatStore, admit: Admit, context: &str, now: Instant) -> (Self, Vec<HistoryRecord>) {
        let me = id.public().user_id();
        let mut engine = Self {
            transport,
            id: Identity::from_seed(id.seed()),
            context: context.to_string(),
            me: me.clone(),
            store,
            admit,
            phase: Phase::Outside,
            last: 0,
            online: None,
            pending: Vec::new(),
            spent: HashSet::new(),
            needed_since: None,
            behind: false,
            quiet_until: None,
            commits_seen: Vec::new(),
            welcome_failures: 0,
            failed: false,
            signals: Vec::new(),
            stale_request: false,
            added: Vec::new(),
        };
        if let Some(snapshot) = engine.store.load_snapshot() {
            match CallGroup::restore(&snapshot.group) {
                // Another identity's group (a `.hvid` imported since) is no use to us.
                Ok(group) if group.channel() == engine.context && group.me() == me && group.is_member() => {
                    engine.enter(group, snapshot.seq, true);
                }
                _ => engine.store.forget_group(),
            }
        }
        #[cfg(debug_assertions)]
        eprintln!("server group of {}: engine started ({})", engine.me, if matches!(engine.phase, Phase::InGroup(_)) { "from disk" } else { "anew" });
        let records = engine.settle(now).await;
        (engine, records)
    }

    #[cfg(test)]
    pub fn store(&self) -> &ChatStore {
        &self.store
    }

    pub fn status(&self) -> GroupStatus {
        match &self.phase {
            Phase::InGroup(_) => GroupStatus::Ready,
            _ if self.failed => GroupStatus::Failed,
            Phase::Joining { .. } if self.online.as_ref().is_some_and(Vec::is_empty) => GroupStatus::Waiting,
            _ => GroupStatus::Joining,
        }
    }

    /// The group we are in, or asked to join.
    fn group(&self) -> Option<[u8; 16]> {
        match &self.phase {
            Phase::InGroup(group) => Some(group.group_id()),
            Phase::Joining { group, .. } => Some(*group),
            Phase::Outside => None,
        }
    }

    /// An event from the server's stream: `group_entry`, `group_join`, `group_welcome`, `group_reset`, and `resync`
    /// after the stream was down. The records are the messages it brought, already in the history.
    pub async fn on_event(&mut self, event: &Value, now: Instant) -> Vec<HistoryRecord> {
        let group = event["group_id"].as_str().and_then(decode_b64::<16>);
        let ours = group.is_some() && group == self.group();
        let mut records = Vec::new();
        match event["type"].as_str().unwrap_or_default() {
            "resync" => self.resync(),
            "group_entry" if ours => {
                if let Some(entry) = GroupEntry::from_json(&event["entry"]) {
                    records = self.on_entry(entry, now);
                }
            }
            "group_join" if ours => self.on_join(event),
            // Nothing to settle: a signal changes no state.
            "group_signal" if ours => {
                self.on_signal(event);
                return records;
            }
            "group_welcome" if ours => {
                if let Some(message) = bytes(&event["message"]) {
                    self.welcome(&message, now);
                }
            }
            // The owner started over: everyone in another group joins the new one. Our own reset is not news.
            "group_reset" if group.is_some() && !ours => self.start_over("the owner reset the group"),
            _ => return records,
        }
        records.extend(self.settle(now).await);
        records
    }

    /// Time passes: our turn in the commit queue may have come, a joiner looks for its welcome.
    pub async fn tick(&mut self, now: Instant) -> Vec<HistoryRecord> {
        self.settle(now).await
    }

    /// The journal changed: whoever it no longer lets in is removed, and requests it now allows are added, in turn.
    pub async fn journal_changed(&mut self, now: Instant) -> Vec<HistoryRecord> {
        self.needed_since = None;
        self.settle(now).await
    }

    /// Sends one message to the group. The records are what came in on the way and, last, our own message under
    /// the number the server gave it, all in the history already.
    pub async fn send(&mut self, body: Vec<u8>, now: Instant) -> Result<Vec<HistoryRecord>, String> {
        let mut records = Vec::new();
        let mut conflicts = 0;
        loop {
            if self.behind {
                records.extend(self.catch_up(now).await);
            }
            let Phase::InGroup(group) = &mut self.phase else { return Err(NOT_READY.into()) };
            let (group_id, epoch) = (group.group_id(), group.epoch());
            let message = group.encrypt(&body).map_err(|_| FAILED.to_string())?;
            // The key of this message is used up: a restart must not find it unused.
            self.save();
            match self.transport.message(group_id, epoch, &message).await {
                Ok(Sent::Done { seq, at }) => {
                    let record = HistoryRecord { seq, at, sender: self.me.clone(), body };
                    self.store.append_history(std::slice::from_ref(&record))?;
                    if seq == self.last + 1 {
                        self.last = seq;
                        self.save();
                    } else {
                        // Someone's came in between: fetched next time, ours passed over.
                        self.behind = true;
                    }
                    records.push(record);
                    return Ok(records);
                }
                Ok(Sent::Conflict) => {
                    conflicts += 1;
                    if conflicts > MAX_CONFLICTS {
                        return Err(NOT_SENT.into());
                    }
                    self.behind = true;
                }
                Err(error) => {
                    // Not in the group, as far as the server knows: we may have missed the commit that removed us.
                    self.behind |= !matches!(error, ServerError::Unreachable(_));
                    return Err(error.message());
                }
            }
        }
    }

    /// Sends a signal to the members online («печатает…»). One that does not get through is not tried again.
    pub async fn signal(&mut self, body: &[u8]) -> Result<(), String> {
        let Phase::InGroup(group) = &self.phase else { return Err(NOT_READY.into()) };
        let key = group.signal_key().map_err(|_| FAILED.to_string())?;
        let sealed = seal_signal(&key, &self.me, body).ok_or(FAILED)?;
        let _ = self.transport.signal(group.group_id(), group.epoch(), &sealed).await;
        Ok(())
    }

    /// Whom our commits the server took put in, since this was last asked: they are owed the history.
    pub fn take_added(&mut self) -> Vec<UserId> {
        std::mem::take(&mut self.added)
    }

    /// The signals that came since this was last asked.
    pub fn take_signals(&mut self) -> Vec<(UserId, Vec<u8>)> {
        std::mem::take(&mut self.signals)
    }

    /// A signal of our epoch from someone else; one that does not open (another epoch, another sender) is dropped.
    fn on_signal(&mut self, event: &Value) {
        let Phase::InGroup(group) = &self.phase else { return };
        let (Some(sender), Some(sealed)) = (event["sender"].as_str(), bytes(&event["message"])) else { return };
        let sender = UserId(sender.to_string());
        if sender == self.me {
            return;
        }
        let Ok(key) = group.signal_key() else { return };
        if let Some(body) = open_signal(&key, &sender, &sealed) {
            self.signals.push((sender, body));
            if self.signals.len() > MAX_PENDING {
                self.signals.remove(0);
            }
        }
    }

    /// The owner starts the group over, alone in a new one: everyone else joins it anew.
    pub async fn reset(&mut self, now: Instant) -> Result<(), String> {
        let group_id = random_bytes::<16>()?;
        let group = group::create(&self.id, group_id, &self.context).map_err(|_| FAILED.to_string())?;
        self.transport.reset(group_id).await.map_err(|e| e.message())?;
        self.pending.clear();
        self.enter(group, 0, false);
        self.save();
        self.settle(now).await;
        Ok(())
    }

    /// Does whatever is due now, a bounded number of steps.
    async fn settle(&mut self, now: Instant) -> Vec<HistoryRecord> {
        let mut records = Vec::new();
        for _ in 0..ROUNDS {
            if self.quiet_until.is_some_and(|until| now < until) {
                break;
            }
            match &self.phase {
                Phase::Outside => self.begin(now).await,
                Phase::Joining { asked, polled, .. } => {
                    let someone_online = self.online.as_ref().is_some_and(|online| !online.is_empty());
                    if someone_online && now >= *asked + REASK {
                        self.phase = Phase::Outside;
                        continue;
                    }
                    if polled.is_some_and(|at| now < at + POLL) {
                        break;
                    }
                    self.poll(now).await;
                    if matches!(self.phase, Phase::Joining { .. }) {
                        break;
                    }
                }
                Phase::InGroup(_) if self.behind => records.extend(self.catch_up(now).await),
                Phase::InGroup(group) if self.stale_request => {
                    let group = group.group_id();
                    self.stale_request = false;
                    if self.transport.withdraw(group).await.is_err() {
                        self.back_off(now);
                    }
                }
                Phase::InGroup(_) => {
                    if !self.step(now).await {
                        break;
                    }
                }
            }
        }
        records
    }

    fn back_off(&mut self, now: Instant) {
        self.back_off_for(now, STEP);
    }

    fn back_off_for(&mut self, now: Instant, wait: Duration) {
        let until = now + wait;
        self.quiet_until = Some(self.quiet_until.filter(|current| *current > until).unwrap_or(until));
    }

    fn resync(&mut self) {
        match &mut self.phase {
            Phase::InGroup(_) => self.behind = true,
            Phase::Joining { polled, .. } => *polled = None,
            Phase::Outside => {}
        }
        self.quiet_until = None;
    }

    /// The group is lost: the snapshot goes (the history stays) and the next step joins anew.
    fn start_over(&mut self, _why: &str) {
        #[cfg(debug_assertions)]
        eprintln!("server group of {}: starting over: {_why}", self.me);
        self.store.forget_group();
        self.phase = Phase::Outside;
        self.last = 0;
        self.behind = false;
        self.needed_since = None;
        self.quiet_until = None;
        self.commits_seen.clear();
    }

    fn enter(&mut self, group: CallGroup, last: u64, catch_up: bool) {
        self.phase = Phase::InGroup(Box::new(group));
        self.last = last;
        self.behind = catch_up;
        self.failed = false;
        self.welcome_failures = 0;
        self.needed_since = None;
        self.commits_seen.clear();
        self.forget_members_requests();
    }

    /// Writes the group down as it is now, with the last entry it took in.
    fn save(&self) {
        let Phase::InGroup(group) = &self.phase else { return };
        let saved = group.snapshot().map_err(|e| e.to_string()).and_then(|group| self.store.save_snapshot(&Snapshot { group, seq: self.last }));
        if let Err(_why) = saved {
            #[cfg(debug_assertions)]
            eprintln!("server group not saved: {_why}");
        }
    }

    /// The history first, then the group: a crash in between reads the same entries again, never skips one.
    fn persist(&self, records: &[HistoryRecord]) {
        if !records.is_empty()
            && let Err(_why) = self.store.append_history(records)
        {
            #[cfg(debug_assertions)]
            eprintln!("chat history not saved: {_why}");
        }
        self.save();
    }

    /// Starts the server's group, or, when someone was first, asks to join theirs.
    async fn begin(&mut self, now: Instant) {
        let Ok(group_id) = random_bytes::<16>() else { return self.back_off(now) };
        // Made before the server hears of it: the server never knows of a group that nobody holds.
        let Ok(group) = group::create(&self.id, group_id, &self.context) else { return self.back_off(now) };
        match self.transport.create(group_id).await {
            Ok(Created::Started) => {
                self.enter(group, 0, false);
                self.save();
            }
            Ok(Created::Exists { group }) => self.ask_to_join(group, now).await,
            Err(_) => {
                self.failed = true;
                self.back_off(now);
            }
        }
    }

    async fn ask_to_join(&mut self, group: [u8; 16], now: Instant) {
        let Ok((joiner, key_package)) = group::prepare_join(&self.id, group, &self.context) else { return self.back_off(now) };
        #[cfg(debug_assertions)]
        eprintln!("server group of {}: asking to join", self.me);
        match self.transport.join(group, &key_package).await {
            Ok(()) => {
                self.failed = false;
                self.commits_seen.clear();
                self.phase = Phase::Joining { joiner: Box::new(joiner), group, asked: now, polled: None };
            }
            // Started over between our two requests: the next step asks into the new one.
            Err(error) if no_group(&error) => {}
            Err(_) => {
                self.failed = true;
                self.back_off(now);
            }
        }
    }

    /// Asks the server for our welcome and who of the group is online.
    async fn poll(&mut self, now: Instant) {
        let Phase::Joining { group, polled, .. } = &mut self.phase else { return };
        *polled = Some(now);
        let group = *group;
        match self.transport.since(LATEST).await {
            Ok(backlog) => {
                self.failed = false;
                if backlog.group != group {
                    self.phase = Phase::Outside;
                    return;
                }
                self.online = Some(backlog.online);
                if let Some((_, message)) = backlog.welcome {
                    self.welcome(&message, now);
                }
            }
            Err(error) if no_group(&error) => self.phase = Phase::Outside,
            Err(_) => {
                self.failed = true;
                self.back_off(now);
            }
        }
    }

    fn welcome(&mut self, message: &[u8], now: Instant) {
        // The server keeps the welcome for a KeyPackage we sent before until a new one replaces it.
        if !matches!(&self.phase, Phase::Joining { joiner, .. } if joiner.fits(message)) {
            return;
        }
        let Phase::Joining { joiner, .. } = std::mem::replace(&mut self.phase, Phase::Outside) else { return };
        match joiner.welcome(message, &*self.admit) {
            Ok(group) => {
                #[cfg(debug_assertions)]
                eprintln!("server group of {}: joined in epoch {}", self.me, group.epoch());
                // Reading starts after the commit that brought us in; from the start of the log when it went by
                // unseen (older entries are passed over by their epoch).
                let from = self.commits_seen.iter().find(|(epoch, _)| epoch + 1 == group.epoch()).map_or(0, |(_, seq)| *seq);
                self.enter(group, from, true);
                self.save();
            }
            // Ours, and yet it does not apply (someone in it the journal does not let in): we ask again after a
            // pause that grows while this repeats.
            Err(_) => {
                self.start_over("the welcome did not apply");
                self.welcome_failures = self.welcome_failures.saturating_add(1);
                self.back_off_for(now, STEP * (1 << (self.welcome_failures - 1).min(2)));
            }
        }
    }

    fn on_join(&mut self, event: &Value) {
        if let Some(online) = users(&event["online"]) {
            self.online = Some(online);
        }
        let (Some(user), Some(key_package)) = (event["user"].as_str(), bytes(&event["key_package"])) else { return };
        self.queue(UserId(user.to_string()), key_package);
    }

    fn queue(&mut self, user: UserId, key_package: Vec<u8>) {
        if user == self.me {
            // We are in: no engine of ours waits for this request's welcome.
            self.stale_request |= matches!(self.phase, Phase::InGroup(_));
            return;
        }
        if self.spent.contains(&sha256(&key_package)) || self.pending.iter().any(|(_, kp)| *kp == key_package) {
            return;
        }
        // Already added (its commit came first): its leaf must not be replaced with itself.
        if let Phase::InGroup(group) = &self.phase
            && group.holds(&key_package)
        {
            self.spent.insert(sha256(&key_package));
            return;
        }
        self.pending.push((user, key_package));
        if self.pending.len() > MAX_PENDING {
            self.pending.remove(0);
        }
    }

    /// Requests whose KeyPackage the group now holds are done with, and so are the ones the same person made before.
    fn forget_members_requests(&mut self) {
        let Phase::InGroup(group) = &self.phase else { return };
        let mut done = vec![false; self.pending.len()];
        for (added, (user, key_package)) in self.pending.iter().enumerate() {
            if group.holds(key_package) {
                for (earlier, (asker, _)) in self.pending[..=added].iter().enumerate() {
                    done[earlier] |= asker == user;
                }
            }
        }
        let mut done = done.into_iter();
        let spent = &mut self.spent;
        self.pending.retain(|(_, key_package)| {
            let done = done.next().unwrap_or(false);
            if done {
                spent.insert(sha256(key_package));
            }
            !done
        });
    }

    /// An entry from the stream: taken in when it is the next one, otherwise the gap is fetched.
    fn on_entry(&mut self, entry: GroupEntry, now: Instant) -> Vec<HistoryRecord> {
        let mut records = Vec::new();
        match &self.phase {
            Phase::Joining { .. } => {
                if entry.commit {
                    self.commits_seen.push((entry.epoch, entry.seq));
                }
            }
            Phase::InGroup(_) if entry.seq <= self.last => {}
            Phase::InGroup(_) if entry.seq != self.last + 1 => self.behind = true,
            Phase::InGroup(_) => {
                self.take(entry, &mut records, now);
                self.persist(&records);
            }
            Phase::Outside => {}
        }
        records
    }

    /// Takes in one entry of the log, in order: a commit moves the group on, a message is read. False when the group
    /// was lost on it.
    fn take(&mut self, entry: GroupEntry, records: &mut Vec<HistoryRecord>, _now: Instant) -> bool {
        let Phase::InGroup(group) = &mut self.phase else { return false };
        let current = group.epoch();
        self.last = entry.seq;
        // Pruned, or of an epoch we are past (before we joined, or our own commit).
        if entry.data.is_empty() || entry.epoch < current {
            return true;
        }
        if entry.epoch > current {
            // A commit we never got: there is no way on from here.
            self.start_over("a commit of an epoch we never got");
            return false;
        }
        if entry.commit {
            // Our own commit we never confirmed (its answer was lost): the group is past us.
            if entry.sender == self.me || group.process(&entry.data, &*self.admit).is_err() || !group.is_member() {
                self.start_over("a commit did not apply or removed us");
                return false;
            }
            self.forget_members_requests();
            return true;
        }
        // Ours: the history has it since we sent it, and we could not read it anyway.
        if entry.sender == self.me {
            return true;
        }
        match group.decrypt(&entry.data) {
            Ok((sender, body)) => records.push(HistoryRecord { seq: entry.seq, at: entry.at, sender, body }),
            Err(_why) => {
                #[cfg(debug_assertions)]
                eprintln!("group message {} not read: {_why:?}", entry.seq);
            }
        }
        true
    }

    /// Reads the log after the last entry we took in, page after page. If the server has another group, or no
    /// longer has what we need, we join anew.
    async fn catch_up(&mut self, now: Instant) -> Vec<HistoryRecord> {
        let mut records = Vec::new();
        for _ in 0..PAGES {
            let Phase::InGroup(group) = &self.phase else { break };
            let group_id = group.group_id();
            let backlog = match self.transport.since(self.last).await {
                Ok(backlog) => backlog,
                Err(error) if no_group(&error) => {
                    self.start_over("the server has no group");
                    break;
                }
                Err(_) => {
                    self.back_off(now);
                    break;
                }
            };
            if backlog.group != group_id {
                self.start_over("the server has another group");
                break;
            }
            self.online = Some(backlog.online);
            for (user, key_package) in backlog.pending {
                self.queue(user, key_package);
            }
            let read = records.len();
            let mut kept = true;
            for entry in backlog.entries {
                if entry.seq <= self.last {
                    continue;
                }
                if !self.take(entry, &mut records, now) {
                    kept = false;
                    break;
                }
            }
            self.persist(&records[read..]);
            if !kept {
                break;
            }
            if !backlog.more {
                self.behind = false;
                if let Phase::InGroup(group) = &self.phase
                    && group.epoch() < backlog.epoch
                {
                    self.start_over("the server is past our epoch");
                }
                break;
            }
        }
        records
    }

    /// Who the group needs: the requests the journal allows (their latest KeyPackage each), and whoever it no longer
    /// lets in removed.
    fn plan(&self, members: &[UserId]) -> Option<Changes> {
        let pending: Vec<(UserId, Vec<u8>)> = self
            .pending
            .iter()
            .filter(|(user, key_package)| (self.admit)(user) && !self.spent.contains(&sha256(key_package)))
            .cloned()
            .collect();
        let mut admitted: HashSet<UserId> = members.iter().chain(pending.iter().map(|(user, _)| user)).filter(|user| (self.admit)(user)).cloned().collect();
        admitted.insert(self.me.clone());
        let plan = changes(members, &self.me, &admitted, &pending);
        (!plan.adds.is_empty() || !plan.removes.is_empty()).then_some(plan)
    }

    /// Commits what the group needs once our turn has come. True when something changed and there may be more.
    async fn step(&mut self, now: Instant) -> bool {
        let Phase::InGroup(group) = &self.phase else { return false };
        let members = group.members();
        let Some(plan) = self.plan(&members) else {
            self.needed_since = None;
            return false;
        };
        let since = *self.needed_since.get_or_insert(now);
        let mut online: HashSet<UserId> = self.online.iter().flatten().cloned().collect();
        online.insert(self.me.clone());
        let Some(delay) = commit_delay(&members, &self.me, &online) else { return false };
        let replacing = plan.adds.iter().any(|(user, _)| members.contains(user));
        if now < since + delay + if replacing { REPLACE_GRACE } else { Duration::ZERO } {
            return false;
        }
        let plan = if replacing {
            match self.still_asked(plan, now).await {
                Some(plan) => plan,
                None => return true,
            }
        } else {
            plan
        };
        self.commit(plan, now).await;
        true
    }

    /// The plan without the replacements whose requests are gone from the server (taken back); `None` when nothing
    /// is left to do, or the server did not answer.
    async fn still_asked(&mut self, mut plan: Changes, now: Instant) -> Option<Changes> {
        let backlog = match self.transport.since(LATEST).await {
            Ok(backlog) => backlog,
            Err(_) => {
                self.back_off(now);
                return None;
            }
        };
        let Phase::InGroup(group) = &self.phase else { return None };
        let members = group.members();
        let asked = |request: &(UserId, Vec<u8>)| !members.contains(&request.0) || backlog.pending.contains(request);
        self.pending.retain(|request| asked(request));
        plan.adds.retain(|request| asked(request));
        if plan.adds.is_empty() && plan.removes.is_empty() {
            self.needed_since = None;
            return None;
        }
        Some(plan)
    }

    async fn commit(&mut self, plan: Changes, now: Instant) {
        let Phase::InGroup(group) = &mut self.phase else { return };
        let adds: Vec<Vec<u8>> = plan.adds.iter().map(|(_, key_package)| key_package.clone()).collect();
        let _ = group.discard();
        let out = match group.commit(&adds, &plan.removes, &*self.admit) {
            Ok(out) => out,
            Err(_) => return self.refused(&adds),
        };
        // Each KeyPackage must be the person the server said it is.
        let named: Vec<UserId> = plan.adds.iter().map(|(user, _)| user.clone()).collect();
        #[cfg(debug_assertions)]
        eprintln!("server group of {}: committing in epoch {}: add {:?}, remove {:?}", self.me, out.epoch, named, plan.removes);
        if out.welcome_to != named {
            let _ = group.discard();
            self.pending.retain(|request| !plan.adds.contains(request));
            return;
        }
        let added: Vec<String> = adds.iter().map(|key_package| crate::chat_files::blob_hash(key_package)).collect();
        let answer = self.transport.commit(group.group_id(), &out, &added).await;
        let Phase::InGroup(group) = &mut self.phase else { return };
        match answer {
            Ok(Committed::Accepted) => {
                if group.confirm().is_err() {
                    return self.start_over("our accepted commit did not merge");
                }
                self.spent.extend(adds.iter().map(|key_package| sha256(key_package)));
                for user in named {
                    if !self.added.contains(&user) {
                        self.added.push(user);
                    }
                }
                self.forget_members_requests();
                self.needed_since = None;
                // Our commit's number comes with the log: it is passed over by its epoch.
                self.behind = true;
                self.save();
            }
            // Someone was first in this epoch: take theirs in, then see whether ours is still needed.
            Ok(Committed::Conflict) => {
                let _ = group.discard();
                self.behind = true;
            }
            Err(error) => {
                let _ = group.discard();
                if no_group(&error) {
                    return self.start_over("the server has no group (commit)");
                }
                self.behind |= !matches!(error, ServerError::Unreachable(_));
                self.back_off(now);
            }
        }
    }

    /// Our commit could not be made. The KeyPackages that are to blame (tried one by one) are never tried again; if
    /// none is, the group itself is broken and is joined anew.
    fn refused(&mut self, adds: &[Vec<u8>]) {
        let Phase::InGroup(group) = &mut self.phase else { return };
        let admit = &*self.admit;
        let bad: Vec<Vec<u8>> = adds
            .iter()
            .filter(|key_package| match group.commit(std::slice::from_ref(*key_package), &[], admit) {
                Ok(_) => {
                    let _ = group.discard();
                    false
                }
                Err(_) => true,
            })
            .cloned()
            .collect();
        if bad.is_empty() {
            return self.start_over("our commit cannot be made");
        }
        self.spent.extend(bad.iter().map(|key_package| sha256(key_package)));
        self.pending.retain(|(_, key_package)| !bad.contains(key_package));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, RwLock};

    use hv_roster::{Body, InviteLink};
    use tokio::sync::{Notify, mpsc};
    use tokio::task::JoinHandle;

    use super::*;
    use crate::session::unix_now;
    use crate::testkit::{folder, id, serve, stream, user};
    /// No event for this long: whatever was on its way has arrived.
    const QUIET: Duration = Duration::from_millis(300);
    /// A pump that is still busy after this is looping: it stops, and the test's assertions say so.
    const PUMP_LIMIT: Duration = Duration::from_secs(20);

    fn texts(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// A server with people `1..=count` (1 owns it), each with an empty chat folder.
    struct World {
        test: &'static str,
        sessions: HashMap<u8, Session>,
    }

    async fn world(test: &'static str, count: u8) -> World {
        World { test, sessions: serve(count).await }
    }

    impl World {
        fn take(&mut self, n: u8) -> Session {
            self.sessions.remove(&n).expect("each person connects once")
        }

        async fn enter(&mut self, n: u8) -> Person {
            Person::open(self.test, n, self.take(n)).await
        }

        /// Two people in one group.
        async fn pair(&mut self) -> (Person, Person) {
            let mut a = self.enter(1).await;
            let mut b = self.enter(2).await;
            pump(&mut [&mut a, &mut b]).await;
            assert_eq!((a.engine.status(), b.engine.status()), (GroupStatus::Ready, GroupStatus::Ready));
            (a, b)
        }
    }

    /// What a test can do to a person's requests: write them down, cut pages short, hold a message back.
    #[derive(Default)]
    struct Knobs {
        log: Mutex<Vec<&'static str>>,
        page: Mutex<Option<usize>>,
        gate: Mutex<Option<Arc<Notify>>>,
        commit_gate: Mutex<Option<Arc<Notify>>>,
    }

    struct TestTransport {
        inner: SessionGroupTransport,
        knobs: Arc<Knobs>,
    }

    impl TestTransport {
        fn note(&self, route: &'static str) {
            self.knobs.log.lock().unwrap().push(route);
        }
    }

    impl GroupTransport for TestTransport {
        async fn create(&self, group: [u8; 16]) -> Result<Created, ServerError> {
            self.note("create");
            self.inner.create(group).await
        }

        async fn join(&self, group: [u8; 16], key_package: &[u8]) -> Result<(), ServerError> {
            self.note("join");
            self.inner.join(group, key_package).await
        }

        async fn commit(&self, group: [u8; 16], out: &Outgoing, added: &[String]) -> Result<Committed, ServerError> {
            self.note("commit");
            let gate = self.knobs.commit_gate.lock().unwrap().take();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            self.inner.commit(group, out, added).await
        }

        async fn message(&self, group: [u8; 16], epoch: u64, message: &[u8]) -> Result<Sent, ServerError> {
            self.note("message");
            let gate = self.knobs.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            self.inner.message(group, epoch, message).await
        }

        async fn since(&self, seq: u64) -> Result<GroupBacklog, ServerError> {
            self.note("since");
            let mut backlog = self.inner.since(seq).await?;
            let page = *self.knobs.page.lock().unwrap();
            if let Some(page) = page
                && backlog.entries.len() > page
            {
                backlog.entries.truncate(page);
                backlog.more = true;
            }
            Ok(backlog)
        }

        async fn reset(&self, group: [u8; 16]) -> Result<(), ServerError> {
            self.note("reset");
            self.inner.reset(group).await
        }

        async fn upload(&self, blob: &[u8]) -> Result<String, ServerError> {
            self.note("upload");
            self.inner.upload(blob).await
        }

        async fn download(&self, sha: &str) -> Result<Vec<u8>, ServerError> {
            self.note("download");
            self.inner.download(sha).await
        }

        async fn withdraw(&self, group: [u8; 16]) -> Result<(), ServerError> {
            self.note("withdraw");
            self.inner.withdraw(group).await
        }

        async fn signal(&self, group: [u8; 16], epoch: u64, message: &[u8]) -> Result<(), ServerError> {
            self.note("signal");
            self.inner.signal(group, epoch, message).await
        }
    }

    struct Person {
        n: u8,
        base: PathBuf,
        session: Session,
        journal: Journal,
        knobs: Arc<Knobs>,
        engine: GroupEngine<TestTransport>,
        events: mpsc::UnboundedReceiver<Value>,
        stream: Option<JoinHandle<()>>,
        /// Every record the engine gave since it started, in order.
        got: Vec<HistoryRecord>,
    }

    impl Person {
        /// Opens the app: the event stream, then the engine on the person's chat folder.
        async fn open(test: &str, n: u8, session: Session) -> Person {
            let (events, stream) = stream(&session.address, session.server_key, n).await;
            let journal: Journal = Arc::new(RwLock::new(session.roster().clone()));
            let knobs = Arc::new(Knobs::default());
            let base = folder(&format!("group-{test}"), n);
            let (engine, got) = Self::engine(&base, n, &session, &journal, &knobs).await;
            Person { n, base, session, journal, knobs, engine, events, stream: Some(stream), got }
        }

        async fn engine(base: &Path, n: u8, session: &Session, journal: &Journal, knobs: &Arc<Knobs>) -> (GroupEngine<TestTransport>, Vec<HistoryRecord>) {
            let store = ChatStore::open(base, &session.server_key).unwrap();
            let transport = TestTransport { inner: SessionGroupTransport::new(session, &id(n)), knobs: knobs.clone() };
            GroupEngine::start(transport, &id(n), store, admit_by(journal.clone()), Instant::now()).await
        }

        /// The app was closed and opened again: a new engine on the same folder, nothing of what was on its way.
        async fn restart(&mut self) {
            while self.events.try_recv().is_ok() {}
            let (engine, got) = Self::engine(&self.base, self.n, &self.session, &self.journal, &self.knobs).await;
            self.engine = engine;
            self.got = got;
        }

        async fn offline(&mut self) {
            if let Some(stream) = self.stream.take() {
                stream.abort();
            }
            // The server notices the stream is gone.
            tokio::time::sleep(QUIET * 2).await;
            while self.events.try_recv().is_ok() {}
        }

        async fn online(&mut self) {
            let (events, stream) = stream(&self.session.address, self.session.server_key, self.n).await;
            self.events = events;
            self.stream = Some(stream);
        }

        async fn send(&mut self, text: &str) -> HistoryRecord {
            let records = self.engine.send(text.as_bytes().to_vec(), Instant::now()).await.unwrap();
            let own = records.last().cloned().expect("our own message comes last");
            assert_eq!((own.sender.clone(), own.body.as_slice()), (user(self.n), text.as_bytes()));
            self.got.extend(records);
            own
        }

        /// What `from` said, as this person read it.
        fn heard(&self, from: u8) -> Vec<String> {
            self.got.iter().filter(|r| r.sender == user(from)).map(|r| String::from_utf8(r.body.clone()).unwrap()).collect()
        }

        /// The history on disk, by number (it is written in the order things came).
        fn history(&self) -> Vec<String> {
            let mut records = self.engine.store().load_history();
            records.sort_by_key(|r| r.seq);
            records.into_iter().map(|r| String::from_utf8(r.body).unwrap()).collect()
        }

        fn group(&self) -> Option<[u8; 16]> {
            self.engine.group()
        }

        fn members(&self) -> Vec<UserId> {
            match &self.engine.phase {
                Phase::InGroup(group) => group.members(),
                _ => Vec::new(),
            }
        }

        fn epoch(&self) -> u64 {
            match &self.engine.phase {
                Phase::InGroup(group) => group.epoch(),
                _ => panic!("not in the group"),
            }
        }

        fn requests(&self) -> Vec<&'static str> {
            self.knobs.log.lock().unwrap().clone()
        }

        async fn sync_journal(&mut self) {
            self.session.sync(&id(self.n)).await.unwrap();
            *self.journal.write().unwrap() = self.session.roster().clone();
        }

        /// The number of the server's last log entry.
        async fn last_seq(&self) -> u64 {
            self.engine.transport.since(0).await.unwrap().entries.last().map_or(0, |e| e.seq)
        }
    }

    /// Time passes beyond the wait of a request that replaces a member's leaf; then the events are handed out.
    async fn wait_out_grace(people: &mut [&mut Person]) {
        let later = Instant::now() + REPLACE_GRACE * 2;
        for person in people.iter_mut() {
            let records = person.engine.tick(later).await;
            person.got.extend(records);
        }
        pump(people).await;
    }

    /// Hands everyone the events that reach them, until none have come for a while.
    async fn pump(people: &mut [&mut Person]) {
        let limit = Instant::now() + PUMP_LIMIT;
        while Instant::now() < limit {
            let mut moved = false;
            for person in people.iter_mut() {
                while let Ok(event) = person.events.try_recv() {
                    let records = person.engine.on_event(&event, Instant::now()).await;
                    person.got.extend(records);
                    moved = true;
                }
            }
            if !moved {
                tokio::time::sleep(QUIET).await;
                if people.iter().all(|person| person.events.is_empty()) {
                    return;
                }
            }
        }
    }

    #[tokio::test]
    async fn the_first_member_creates_the_group() {
        let mut w = world("first", 1).await;
        let a = w.enter(1).await;
        assert_eq!(a.engine.status(), GroupStatus::Ready);
        assert_eq!(a.requests(), ["create"]);
        assert_eq!(a.members(), [user(1)]);
        let saved = a.engine.store().load_snapshot().expect("the group is on disk");
        assert_eq!(saved.seq, 0);
        let backlog = a.engine.transport.since(0).await.unwrap();
        assert_eq!((Some(backlog.group), backlog.members), (a.group(), vec![user(1)]));
    }

    #[tokio::test]
    async fn two_creators_end_in_one_group() {
        let mut w = world("two-creators", 2).await;
        let (sa, sb) = (w.take(1), w.take(2));
        let (mut a, mut b) = tokio::join!(Person::open("two-creators", 1, sa), Person::open("two-creators", 2, sb));
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!((a.engine.status(), b.engine.status()), (GroupStatus::Ready, GroupStatus::Ready));
        assert_eq!(a.group(), b.group());
        assert_eq!(a.members(), b.members());
        assert_eq!(a.members().len(), 2);
        a.send("привет").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.heard(1), texts(&["привет"]));
    }

    #[tokio::test]
    async fn a_newcomer_is_added_and_both_read_each_other() {
        let mut w = world("newcomer", 2).await;
        let mut a = w.enter(1).await;
        let mut b = w.enter(2).await;
        assert_eq!(b.engine.status(), GroupStatus::Joining, "someone is online to add us");
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!((a.engine.status(), b.engine.status()), (GroupStatus::Ready, GroupStatus::Ready));
        assert_eq!(a.members(), [user(1), user(2)]);
        a.send("привет").await;
        b.send("и тебе").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!((b.heard(1), a.heard(2)), (texts(&["привет"]), texts(&["и тебе"])));
        assert_eq!(b.history(), texts(&["привет", "и тебе"]));
    }

    #[tokio::test]
    async fn an_offline_newcomer_is_added_when_someone_comes_online() {
        let mut w = world("offline-newcomer", 2).await;
        let mut a = w.enter(1).await;
        a.offline().await;
        let mut b = w.enter(2).await;
        assert_eq!(b.engine.status(), GroupStatus::Waiting);
        pump(&mut [&mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Waiting);
        // A opens the app again: the request waits on the server.
        a.online().await;
        a.restart().await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert_eq!(a.members(), [user(1), user(2)]);
        b.send("наконец").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(a.heard(2), texts(&["наконец"]));
    }

    #[tokio::test]
    async fn a_kicked_member_is_removed_and_reads_nothing_after() {
        let mut w = world("kicked", 3).await;
        let mut a = w.enter(1).await;
        let mut b = w.enter(2).await;
        let mut c = w.enter(3).await;
        pump(&mut [&mut a, &mut b, &mut c]).await;
        assert_eq!(a.members(), [user(1), user(2), user(3)]);
        let before = a.last_seq().await;
        a.session.append(&id(1), Body::Kick { user: user(3), reason: "Спам".into(), media: None }).await.unwrap();
        c.offline().await;
        a.sync_journal().await;
        b.sync_journal().await;
        let records = a.engine.journal_changed(Instant::now()).await;
        a.got.extend(records);
        let records = b.engine.journal_changed(Instant::now()).await;
        b.got.extend(records);
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(a.members(), [user(1), user(2)]);
        assert_eq!(b.members(), [user(1), user(2)]);
        a.send("без него").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.heard(1), texts(&["без него"]));
        // Everything the server logged since, handed to the one who was kicked: nothing of it reads.
        let group = a.group().unwrap();
        let backlog = a.engine.transport.since(before).await.unwrap();
        assert_eq!(backlog.entries.len(), 2, "the commit and the message");
        for entry in backlog.entries {
            let event = json!({
                "type": "group_entry",
                "group_id": encode_b64(&group),
                "entry": {
                    "seq": entry.seq, "kind": if entry.commit { "commit" } else { "message" }, "epoch": entry.epoch,
                    "sender": entry.sender, "data": encode_b64(&entry.data), "at": entry.at,
                },
            });
            assert!(c.engine.on_event(&event, Instant::now()).await.is_empty());
        }
        assert_ne!(c.engine.status(), GroupStatus::Ready);
    }

    #[tokio::test]
    async fn a_request_replaced_while_a_commit_is_on_its_way_is_not_lost() {
        // A takes B's request in and commits; before the server has the commit, B starts over with a new KeyPackage,
        // and A, off the event stream, never hears of it. The commit puts B's old KeyPackage in; the new request must
        // stay on the server for A to find.
        let mut w = world("replaced-request", 2).await;
        let mut a = w.enter(1).await;
        let gate = Arc::new(Notify::new());
        *a.knobs.commit_gate.lock().unwrap() = Some(gate.clone());
        let mut b = w.enter(2).await;
        let asked = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), a.events.recv()).await.expect("B asks").unwrap();
            if event["type"] == "group_join" {
                break event;
            }
        };
        a.offline().await;
        let (records, ()) = tokio::join!(a.engine.on_event(&asked, Instant::now()), async {
            tokio::time::sleep(QUIET).await;
            b.restart().await;
            gate.notify_one();
        });
        a.got.extend(records);
        a.online().await;
        let records = a.engine.tick(Instant::now()).await;
        a.got.extend(records);
        pump(&mut [&mut a, &mut b]).await;
        wait_out_grace(&mut [&mut a, &mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert_eq!(a.members(), [user(1), user(2)]);
        assert!(a.engine.transport.since(u64::MAX).await.unwrap().pending.is_empty(), "every request it fulfilled is gone");
        b.send("дошёл").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(a.heard(2), texts(&["дошёл"]));
    }

    #[tokio::test]
    async fn the_committer_learns_whom_it_added() {
        let mut w = world("added", 2).await;
        let (mut a, mut b) = w.pair().await;
        assert_eq!(a.engine.take_added(), [user(2)], "A's commit put B in");
        assert!(b.engine.take_added().is_empty(), "B added nobody");
        assert!(a.engine.take_added().is_empty(), "told once");
        a.send("после").await;
        pump(&mut [&mut a, &mut b]).await;
        assert!(a.engine.take_added().is_empty());
    }

    #[tokio::test]
    async fn a_commit_that_lost_its_epoch_adds_nobody() {
        // A and B both commit Carol in the same epoch; A's is held on its way, B's gets there first.
        let mut w = world("added-race", 3).await;
        let (mut a, mut b) = w.pair().await;
        let _ = a.engine.take_added();
        let mut c = w.enter(3).await;
        let epoch = a.epoch();
        let gate = Arc::new(Notify::new());
        *a.knobs.commit_gate.lock().unwrap() = Some(gate.clone());
        let later = Instant::now() + Duration::from_secs(3600);
        let (records, ()) = tokio::join!(a.engine.tick(later), async {
            tokio::time::sleep(QUIET).await;
            // B hears Carol ask, and commits her once its turn has come.
            let asked = loop {
                let event = tokio::time::timeout(Duration::from_secs(5), b.events.recv()).await.expect("Carol asks").unwrap();
                if event["type"] == "group_join" {
                    break event;
                }
            };
            let records = b.engine.on_event(&asked, later).await;
            b.got.extend(records);
            let records = b.engine.tick(later + Duration::from_secs(3600)).await;
            b.got.extend(records);
            gate.notify_one();
        });
        a.got.extend(records);
        pump(&mut [&mut a, &mut b, &mut c]).await;
        assert_eq!(c.engine.status(), GroupStatus::Ready);
        assert_eq!(a.epoch(), epoch + 1, "one commit went in");
        assert!(a.engine.take_added().is_empty(), "A's commit came too late: A {:?} B {:?}", a.requests(), b.requests());
        assert_eq!(b.engine.take_added(), [user(3)]);
    }

    #[tokio::test]
    async fn a_request_left_from_an_earlier_run_does_not_push_a_member_out() {
        // B is in the group; a request of B's that no engine of B can take a welcome for (left from an earlier run)
        // turns up. B takes it back, and A, who would have put it in place of B's working leaf, waits and sees.
        let mut w = world("stale-request", 2).await;
        let (mut a, mut b) = w.pair().await;
        let epoch = a.epoch();
        let group = a.group().unwrap();
        let (_gone, stale) = group::prepare_join(&id(2), group, SERVER_CONTEXT).unwrap();
        b.engine.transport.join(group, &stale).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        for step in 1..=4 {
            let later = Instant::now() + REPLACE_GRACE * step;
            let records = a.engine.tick(later).await;
            a.got.extend(records);
            let records = b.engine.tick(later).await;
            b.got.extend(records);
            pump(&mut [&mut a, &mut b]).await;
        }
        assert_eq!(a.epoch(), epoch, "nobody committed: {:?}", a.requests());
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert!(a.engine.transport.since(u64::MAX).await.unwrap().pending.is_empty(), "B took it back");
        a.send("всё ещё вместе").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.heard(1), texts(&["всё ещё вместе"]));
    }

    #[tokio::test]
    async fn a_member_kicked_and_invited_back_rejoins_once() {
        let mut w = world("kicked-back", 2).await;
        let (mut a, mut b) = w.pair().await;
        a.send("до кика").await;
        pump(&mut [&mut a, &mut b]).await;
        // B goes, keeping the group's snapshot from before the kick on disk.
        b.offline().await;
        a.session.append(&id(1), Body::Kick { user: user(2), reason: "проверка".into(), media: None }).await.unwrap();
        a.sync_journal().await;
        let records = a.engine.journal_changed(Instant::now()).await;
        a.got.extend(records);
        pump(&mut [&mut a]).await;
        assert_eq!(a.members(), [user(1)]);
        // Invited back: a new session, the same folder.
        let link = InviteLink::parse(&a.session.create_invite(&id(1), &a.session.address.clone(), vec![], None, None).await.unwrap()).unwrap();
        b.session = Session::join(&link, &id(2), unix_now()).await.unwrap();
        b.session.sync(&id(2)).await.unwrap();
        *b.journal.write().unwrap() = b.session.roster().clone();
        a.sync_journal().await;
        let records = a.engine.journal_changed(Instant::now()).await;
        a.got.extend(records);
        b.online().await;
        b.restart().await;
        pump(&mut [&mut a, &mut b]).await;
        let epoch = a.epoch();
        // Time goes by: nobody should commit again.
        for _ in 0..4 {
            let later = Instant::now() + STEP * 3;
            let records = a.engine.tick(later).await;
            a.got.extend(records);
            let records = b.engine.tick(later).await;
            b.got.extend(records);
            pump(&mut [&mut a, &mut b]).await;
        }
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert_eq!(a.epoch(), epoch, "{:?}", a.requests());
        assert_eq!(a.members(), [user(1), user(2)]);
        a.send("снова вместе").await;
        pump(&mut [&mut a, &mut b]).await;
        assert!(b.heard(1).contains(&"снова вместе".to_string()));
    }

    #[tokio::test]
    async fn a_restart_resumes_from_disk() {
        let mut w = world("restart", 2).await;
        let (mut a, mut b) = w.pair().await;
        a.send("раз").await;
        pump(&mut [&mut a, &mut b]).await;
        let asked = b.requests().len();
        b.restart().await;
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert!(b.requests()[asked..].iter().all(|r| *r == "since"), "{:?}", &b.requests()[asked..]);
        a.send("два").await;
        b.send("три").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!((b.heard(1), a.heard(2)), (texts(&["два"]), texts(&["три"])));
        assert_eq!(b.history(), texts(&["раз", "два", "три"]));
    }

    #[tokio::test]
    async fn a_restart_without_a_snapshot_rejoins() {
        let mut w = world("no-snapshot", 2).await;
        let (mut a, mut b) = w.pair().await;
        let epoch = a.epoch();
        b.engine.store().forget_group();
        b.restart().await;
        assert_eq!(b.engine.status(), GroupStatus::Joining);
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Joining, "a new leaf in place of a member's waits a moment");
        wait_out_grace(&mut [&mut a, &mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert_eq!(a.epoch(), epoch + 1, "one commit put the new leaf in place of the old");
        assert_eq!(a.members(), [user(1), user(2)]);
        a.send("снова вместе").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.heard(1), texts(&["снова вместе"]));
    }

    #[tokio::test]
    async fn a_long_absence_reads_page_after_page() {
        let mut w = world("absence", 2).await;
        let (mut a, mut b) = w.pair().await;
        b.offline().await;
        // The server takes 30 messages in 10 seconds from one person; pages are cut to 10 to read several of them.
        let said: Vec<String> = (0..25).map(|n| format!("сообщение {n}")).collect();
        for text in &said {
            a.send(text).await;
        }
        b.online().await;
        *b.knobs.page.lock().unwrap() = Some(10);
        let asked = b.requests().len();
        b.restart().await;
        assert_eq!(b.heard(1), said);
        assert!(b.got.windows(2).all(|w| w[0].seq < w[1].seq));
        assert!(b.requests()[asked..].iter().filter(|r| **r == "since").count() >= 3);
    }

    #[tokio::test]
    async fn a_message_racing_a_commit_is_sent_once() {
        let mut w = world("race", 3).await;
        let (mut a, mut b) = w.pair().await;
        let gate = Arc::new(Notify::new());
        *b.knobs.gate.lock().unwrap() = Some(gate.clone());
        let session = w.take(3);
        // B's message is on its way while C joins and A commits.
        let (sent, mut c) = tokio::join!(b.engine.send("гонка".as_bytes().to_vec(), Instant::now()), async {
            let mut c = Person::open("race", 3, session).await;
            pump(&mut [&mut a, &mut c]).await;
            gate.notify_one();
            c
        });
        let records = sent.unwrap();
        assert_eq!(records.last().unwrap().body, "гонка".as_bytes());
        b.got.extend(records);
        assert_eq!(b.requests().iter().filter(|r| **r == "message").count(), 2, "refused once, then sent");
        pump(&mut [&mut a, &mut b, &mut c]).await;
        assert_eq!(c.engine.status(), GroupStatus::Ready);
        assert_eq!((a.heard(2), c.heard(2)), (texts(&["гонка"]), texts(&["гонка"])));
    }

    #[tokio::test]
    async fn a_reset_starts_a_new_group() {
        let mut w = world("reset", 2).await;
        let (mut a, mut b) = w.pair().await;
        a.send("до сброса").await;
        pump(&mut [&mut a, &mut b]).await;
        let old = a.group();
        a.engine.reset(Instant::now()).await.unwrap();
        assert_ne!(a.group(), old);
        assert_eq!(a.members(), [user(1)]);
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        assert_eq!(b.group(), a.group());
        a.send("после").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.heard(1), texts(&["до сброса", "после"]));
        assert_eq!(b.history(), texts(&["до сброса", "после"]));
    }

    #[tokio::test]
    async fn a_broken_snapshot_rejoins() {
        let mut w = world("broken", 2).await;
        let (mut a, mut b) = w.pair().await;
        let chats = b.base.join(crate::chat_store::CHAT_DIR);
        let folder = std::fs::read_dir(chats).unwrap().flatten().map(|e| e.path()).find(|p| p.is_dir()).unwrap();
        let file = folder.join("group.bin");
        let mut bytes = std::fs::read(&file).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xff;
        std::fs::write(&file, bytes).unwrap();
        b.restart().await;
        assert_eq!(b.engine.status(), GroupStatus::Joining);
        pump(&mut [&mut a, &mut b]).await;
        wait_out_grace(&mut [&mut a, &mut b]).await;
        assert_eq!(b.engine.status(), GroupStatus::Ready);
        b.send("живой").await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(a.heard(2), texts(&["живой"]));
    }
}
