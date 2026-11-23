//! The call engine: the one place that decides when to start a call's group, ask to join it, add and remove
//! people and catch up after a gap, and the only source of the frame keys and the lock the window shows.
//!
//! The group (`hv_crypto`) lives in memory only and goes with the engine. The server merely relays opaque
//! messages and puts commits in order, so it is trusted with nothing: every leaf must carry a valid call
//! credential (`hv_crypto` checks it) of someone the signed journal lets connect to the channel ([`admit_by`]).
//! Whatever goes wrong — a commit or welcome that does not apply, a gap the server can no longer fill, being
//! removed — the group is dropped and the call joined anew. There is no unencrypted fallback.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use hv_crypto::group::{self, CallGroup, Joiner, Outgoing};
use hv_roster::keys::{decode_b64, decode_b64_vec, encode_b64, random_bytes, sha256};
use hv_roster::{Identity, Roster, UserId};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Emitter, Manager};

use crate::call_plan::{Changes, KEYS_TIMEOUT, STEP, changes, commit_delay};
use crate::commands::{AppIdentity, Sessions};
use crate::session::{Link, ServerError, Session, error_from, unix_now};

/// What the window shows when the keys did not come.
pub const FAILED: &str = "Не удалось зашифровать звонок";
/// The relay's answer (404) when the channel has no call, or no longer has one.
const NO_CALL: &str = "Звонка нет";
const NOT_OPEN: &str = "Сервер ещё не открыт — выбери его в списке";
/// How often the app's timer looks at the call.
const TICK: Duration = Duration::from_millis(250);
/// KeyPackages kept waiting, at most: a server cannot make us hoard them.
const MAX_PENDING: usize = 64;
/// Steps one call of the engine may take: start over, catch up, commit, apply the winner, commit again.
const ROUNDS: usize = 8;
/// How long leaving the channel waits for the relay to hear of it.
const LEAVE_WAIT: Duration = Duration::from_secs(2);
/// A channel id as one path segment: unreserved characters stay, the rest (`.` and `/` included) is encoded.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'~');

/// The relay's answer to `create`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Created {
    Started,
    /// Someone was first: this is the group to join.
    Exists { group: [u8; 16] },
}

/// The relay's answer to a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Committed {
    Accepted,
    /// Someone else committed in this epoch first.
    Conflict,
}

/// The call's group and the commits from the epoch asked for on, as the relay keeps them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backlog {
    pub group: [u8; 16],
    /// The epoch the call is in now.
    pub epoch: u64,
    /// (the epoch each commit was made in, the commit), oldest first.
    pub commits: Vec<(u64, Vec<u8>)>,
}

/// The way to the relay (in the app, signed requests through the session; in tests, the same code against a
/// server in the process).
pub trait CallTransport: Send + Sync {
    fn create(&self, channel: &str, group: [u8; 16]) -> impl Future<Output = Result<Created, ServerError>> + Send;
    /// Asks into `group`; the relay says there is no call when the channel's call is another group by now.
    fn join(&self, channel: &str, group: [u8; 16], key_package: &[u8]) -> impl Future<Output = Result<(), ServerError>> + Send;
    fn commit(&self, channel: &str, group: [u8; 16], out: &Outgoing) -> impl Future<Output = Result<Committed, ServerError>> + Send;
    fn since(&self, channel: &str, epoch: u64) -> impl Future<Output = Result<Backlog, ServerError>> + Send;
    /// We no longer hold `group`: off the relay's list (a call nobody is left in is forgotten at once). Naming the
    /// group keeps a leave that arrives late from taking us off the next call in the channel.
    fn leave(&self, channel: &str, group: [u8; 16]) -> impl Future<Output = Result<(), ServerError>> + Send;
}

fn no_call(error: &ServerError) -> bool {
    matches!(error, ServerError::Refused(text) if text == NO_CALL)
}

fn odd_answer() -> ServerError {
    ServerError::Refused("Непонятный ответ сервера".into())
}

/// The app's open sessions by address (`Sessions.0`).
pub type SharedSessions = Arc<tokio::sync::Mutex<HashMap<String, Session>>>;

/// The relay's routes, called with signed requests over the session's own pinned client. The transport keeps its
/// own [`Link`] to the server: the app's open sessions are never held while a request of the call is under way, so
/// a slow request elsewhere (a big upload, a server that is offline, a journal sync) cannot hold up the keys.
pub struct SessionTransport {
    link: Link,
    id: Identity,
}

impl fmt::Debug for SessionTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionTransport").field("address", &self.link.address).finish_non_exhaustive()
    }
}

impl SessionTransport {
    /// Takes what it needs from `session`, which may be let go of right after.
    pub fn new(session: &Session, id: &Identity) -> Self {
        Self { link: session.link(), id: Identity::from_seed(id.seed()) }
    }

    async fn send(&self, method: &str, path: String, body: Option<Value>) -> Result<(u16, Value), ServerError> {
        self.link.request_raw(&self.id, method, &path, body.as_ref()).await
    }
}

fn route(channel: &str, tail: &str) -> String {
    format!("/api/call/{}{tail}", utf8_percent_encode(channel, SEGMENT))
}

/// Any answer the engine has no use for, named the way the rest of the app names it.
fn refusal(status: u16, body: &Value) -> ServerError {
    if status == 404 { ServerError::Refused(NO_CALL.into()) } else { error_from(status, body, unix_now()) }
}

impl CallTransport for SessionTransport {
    async fn create(&self, channel: &str, group: [u8; 16]) -> Result<Created, ServerError> {
        let body = json!({ "group_id": encode_b64(&group) });
        let (status, body) = self.send("POST", route(channel, "/create"), Some(body)).await?;
        match status {
            200 => Ok(Created::Started),
            409 if body["exists"] == true => {
                let group = body["group_id"].as_str().and_then(decode_b64::<16>).ok_or_else(odd_answer)?;
                Ok(Created::Exists { group })
            }
            _ => Err(refusal(status, &body)),
        }
    }

    async fn join(&self, channel: &str, group: [u8; 16], key_package: &[u8]) -> Result<(), ServerError> {
        let body = json!({ "group_id": encode_b64(&group), "key_package": encode_b64(key_package) });
        let (status, body) = self.send("POST", route(channel, "/join"), Some(body)).await?;
        if status == 200 { Ok(()) } else { Err(refusal(status, &body)) }
    }

    async fn commit(&self, channel: &str, group: [u8; 16], out: &Outgoing) -> Result<Committed, ServerError> {
        let welcome = out.welcome.as_ref().map(|message| json!({ "to": out.welcome_to, "message": encode_b64(message) }));
        let body = json!({ "group_id": encode_b64(&group), "epoch": out.epoch, "commit": encode_b64(&out.commit), "members": out.members, "welcome": welcome });
        let (status, body) = self.send("POST", route(channel, "/commit"), Some(body)).await?;
        match status {
            200 => Ok(Committed::Accepted),
            409 if body["conflict"] == true => Ok(Committed::Conflict),
            _ => Err(refusal(status, &body)),
        }
    }

    async fn since(&self, channel: &str, epoch: u64) -> Result<Backlog, ServerError> {
        let (status, body) = self.send("GET", route(channel, &format!("?since={epoch}")), None).await?;
        if status != 200 {
            return Err(refusal(status, &body));
        }
        let group = body["group_id"].as_str().and_then(decode_b64::<16>).ok_or_else(odd_answer)?;
        let epoch = body["epoch"].as_u64().ok_or_else(odd_answer)?;
        let commits = body["commits"]
            .as_array()
            .ok_or_else(odd_answer)?
            .iter()
            .map(|commit| Some((commit["epoch"].as_u64()?, commit["commit"].as_str().and_then(decode_b64_vec)?)))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(odd_answer)?;
        Ok(Backlog { group, epoch, commits })
    }

    async fn leave(&self, channel: &str, group: [u8; 16]) -> Result<(), ServerError> {
        let (status, body) = self.send("POST", route(channel, "/leave"), Some(json!({ "group_id": encode_b64(&group) }))).await?;
        if status == 200 { Ok(()) } else { Err(refusal(status, &body)) }
    }
}

/// Decides whether a person may be in the call.
pub type Admit = Arc<dyn Fn(&UserId) -> bool + Send + Sync>;
/// The signed journal a call checks people against; the app refreshes it whenever the session re-reads it.
pub type Journal = Arc<RwLock<Roster>>;

/// The journal lets `user` into a call in `channel`: a member, not banned now, allowed to connect there.
pub fn admitted(roster: &Roster, user: &UserId, channel: &str, now: u64) -> bool {
    roster.member(user).is_some()
        && !roster.is_banned_at(user, now)
        && roster.access(user, channel).is_some_and(|access| access.connect)
}

pub fn admit_by(journal: Journal, channel: &str) -> Admit {
    let channel = channel.to_string();
    Arc::new(move |user| admitted(&journal.read().unwrap_or_else(|e| e.into_inner()), user, &channel, unix_now()))
}

/// The lock the window shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lock {
    /// Waiting for the keys.
    Pending,
    Secure,
    /// The keys did not come in time; the engine keeps trying.
    Failed,
}

/// One sender's frame key, for the window's key provider.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct KeyView {
    /// The sender's LiveKit identity (its user id).
    pub identity: String,
    pub index: u8,
    /// base64url, no padding.
    pub key: String,
}

// The key must not end up in a log by accident.
impl fmt::Debug for KeyView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyView").field("identity", &self.identity).field("index", &self.index).finish_non_exhaustive()
    }
}

/// `call-keys`: everyone's frame keys in the epoch the group has just reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CallKeysEvent {
    pub address: String,
    pub channel: String,
    pub epoch: u64,
    pub keys: Vec<KeyView>,
}

/// `call-state`: the lock, the code to compare out loud and who is in the group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CallStateEvent {
    pub address: String,
    pub channel: String,
    pub state: Lock,
    pub code: Option<String>,
    /// By leaf.
    pub members: Vec<String>,
    pub error: Option<String>,
}

/// What the window is told: the lock (`call-state`), and the keys of an epoch the group has just reached
/// (`call-keys`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shown {
    State(CallStateEvent),
    Keys(CallKeysEvent),
}

/// Where the engine tells the window what changed, as soon as it has changed.
pub type Show = Box<dyn Fn(Shown) + Send + Sync>;

enum Phase {
    /// Neither in the group nor waiting for a welcome: starts over with `create` at the next chance.
    Outside,
    /// Asked to join the group; waits for the welcome.
    Joining(Box<Joiner>, [u8; 16]),
    InCall(Box<CallGroup>),
}

/// One person's side of one call.
pub struct CallEngine<T: CallTransport> {
    transport: T,
    id: Identity,
    me: UserId,
    address: String,
    channel: String,
    admit: Admit,
    phase: Phase,
    /// Who the room shows. Until the window has told us, nobody is added or removed.
    present: Option<HashSet<UserId>>,
    /// Requests to join, in order of arrival; never our own.
    pending: Vec<(UserId, Vec<u8>)>,
    /// KeyPackages (by hash) already in the group or refused: none is added twice, so a replayed old
    /// KeyPackage cannot take the place of a live leaf.
    spent: HashSet<[u8; 32]>,
    /// Since when the group has needed a change: the commit queue counts from here.
    needed_since: Option<Instant>,
    /// Since when we have had no keys (or since the last attempt after a failure).
    keyless_since: Instant,
    failed: bool,
    /// The relay has commits we have not applied.
    behind: bool,
    /// After a failed request, nothing goes to the relay before this.
    quiet_until: Option<Instant>,
    /// When the KeyPackage we wait with is given up on and a new one is sent; until then a welcome for it is
    /// still taken.
    reask_at: Option<Instant>,
    /// Welcomes that failed in a row since we were last in the group.
    welcome_failures: u32,
    /// We dropped a group the relay still counts us in: it is told so before we start over.
    owes_leave: Option<[u8; 16]>,
    /// Out of the channel: nothing more goes to the relay.
    left: bool,
    /// While we wait for the welcome: the newest epoch a commit was made in, of those that came and were passed
    /// over, and whether the stream was down. The welcome's group catches up only if one may be newer than it.
    seen_while_joining: Option<u64>,
    gap_while_joining: bool,
    show: Option<Show>,
    /// What the window was last told.
    shown_state: Option<CallStateEvent>,
    shown_keys: Option<CallKeysEvent>,
}

impl<T: CallTransport> fmt::Debug for CallEngine<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallEngine")
            .field("address", &self.address)
            .field("channel", &self.channel)
            .field("me", &self.me)
            .field("lock", &self.lock())
            .finish_non_exhaustive()
    }
}

fn bytes(value: &Value) -> Option<Vec<u8>> {
    value.as_str().and_then(decode_b64_vec).filter(|bytes| !bytes.is_empty())
}

impl<T: CallTransport> CallEngine<T> {
    /// [`start_showing`](Self::start_showing) with nobody watching.
    #[cfg(test)]
    pub async fn start(transport: T, id: &Identity, address: &str, channel: &str, admit: Admit, now: Instant) -> Self {
        Self::start_showing(transport, id, address, channel, admit, None, now).await
    }

    /// Enters the call in `channel`: starts its group, or asks to join the one someone else started. `show` hears
    /// of every change of the lock and the keys the moment it happens.
    pub async fn start_showing(
        transport: T,
        id: &Identity,
        address: &str,
        channel: &str,
        admit: Admit,
        show: Option<Show>,
        now: Instant,
    ) -> Self {
        let mut engine = Self {
            transport,
            id: Identity::from_seed(id.seed()),
            me: id.public().user_id(),
            address: address.to_string(),
            channel: channel.to_string(),
            admit,
            phase: Phase::Outside,
            present: None,
            pending: Vec::new(),
            spent: HashSet::new(),
            needed_since: None,
            keyless_since: now,
            failed: false,
            behind: false,
            quiet_until: None,
            reask_at: None,
            welcome_failures: 0,
            owes_leave: None,
            left: false,
            seen_while_joining: None,
            gap_while_joining: false,
            show,
            shown_state: None,
            shown_keys: None,
        };
        engine.settle(now).await;
        engine.report();
        engine
    }

    /// Tells the window what changed since it was last told: the lock, code or members, and the keys of a new
    /// epoch.
    fn report(&mut self) {
        if self.show.is_none() {
            return;
        }
        let (state, keys) = (self.state(), self.keys());
        let state = (self.shown_state.as_ref() != Some(&state)).then_some(state);
        let keys = keys.filter(|keys| self.shown_keys.as_ref() != Some(keys));
        let Some(show) = &self.show else { return };
        if let Some(state) = state {
            show(Shown::State(state.clone()));
            self.shown_state = Some(state);
        }
        if let Some(keys) = keys {
            show(Shown::Keys(keys.clone()));
            self.shown_keys = Some(keys);
        }
    }

    /// Out of the channel: the relay is told we no longer hold the group (a call we were the last one in is
    /// forgotten at once, so whoever comes next starts a new one), and the group and its keys go.
    pub async fn leave(&mut self, now: Instant) {
        self.left = true;
        if let Some(group) = self.group().or(self.owes_leave.take()) {
            let _ = self.transport.leave(&self.channel, group).await;
        }
        self.erase(now);
    }

    /// The group we are in, or asked to join.
    fn group(&self) -> Option<[u8; 16]> {
        match &self.phase {
            Phase::InCall(group) => Some(group.group_id()),
            Phase::Joining(_, group) => Some(*group),
            Phase::Outside => None,
        }
    }

    /// An event about `group` is ours: the group we are in or asked into, or any while we are in none. One of an
    /// earlier call in the channel (it may come late) is not news of ours.
    fn concerns(&self, group: Option<[u8; 16]>) -> bool {
        group.is_some_and(|group| self.group().is_none_or(|ours| ours == group))
    }

    /// An event from the server's stream: `call_join`, `call_commit`, `call_welcome`, `call_reset` of our
    /// channel, and `resync` after the stream was down.
    pub async fn on_event(&mut self, event: &Value, now: Instant) {
        let kind = event["type"].as_str().unwrap_or_default();
        if kind == "resync" {
            self.resync(now);
        } else if event["channel"].as_str() == Some(self.channel.as_str()) {
            let group = event["group_id"].as_str().and_then(decode_b64::<16>);
            match kind {
                "call_join" if self.concerns(group) => self.queue(event),
                "call_commit" if self.concerns(group) => self.apply(event, now),
                "call_welcome" => self.welcome(event, now),
                // The server forgot the call: everyone in it starts over.
                "call_reset" if group.is_some() && group == self.group() => self.erase(now),
                _ => return,
            }
        } else {
            return;
        }
        self.settle(now).await;
        self.report();
    }

    /// Who the channel's LiveKit room shows now.
    pub async fn on_presence(&mut self, present: HashSet<UserId>, now: Instant) {
        self.present = Some(present);
        self.settle(now).await;
        self.report();
    }

    /// Time passes: our turn in the commit queue may have come, and keys that took too long are a failure.
    pub async fn tick(&mut self, now: Instant) {
        if !matches!(self.phase, Phase::InCall(_)) && now.saturating_duration_since(self.keyless_since) >= KEYS_TIMEOUT {
            self.failed = true;
            self.keyless_since = now;
            // Ask again with a new KeyPackage, as the last one may never have reached anyone who could add us;
            // but not at once, and taking a welcome for the old one meanwhile.
            if matches!(self.phase, Phase::Joining(..)) {
                self.reask_at = Some(now + STEP);
            }
        }
        self.settle(now).await;
        self.report();
    }

    /// Every member's frame key in the current epoch; none while we are not in the group.
    pub fn keys(&self) -> Option<CallKeysEvent> {
        let Phase::InCall(group) = &self.phase else { return None };
        let keys: Vec<KeyView> = group
            .media_keys()
            .into_iter()
            .map(|key| KeyView { identity: key.user.0, index: key.index, key: encode_b64(&key.key) })
            .collect();
        if keys.is_empty() {
            return None;
        }
        Some(CallKeysEvent { address: self.address.clone(), channel: self.channel.clone(), epoch: group.epoch(), keys })
    }

    pub fn state(&self) -> CallStateEvent {
        let (code, members) = match &self.phase {
            Phase::InCall(group) => (Some(group.code()), group.members().into_iter().map(|user| user.0).collect()),
            _ => (None, Vec::new()),
        };
        let state = self.lock();
        CallStateEvent {
            address: self.address.clone(),
            channel: self.channel.clone(),
            state,
            code,
            members,
            error: (state == Lock::Failed).then(|| FAILED.to_string()),
        }
    }

    fn lock(&self) -> Lock {
        match self.phase {
            Phase::InCall(_) => Lock::Secure,
            _ if self.failed => Lock::Failed,
            _ => Lock::Pending,
        }
    }

    /// Does whatever is due now, a bounded number of steps.
    async fn settle(&mut self, now: Instant) {
        for _ in 0..ROUNDS {
            if self.left || self.quiet_until.is_some_and(|until| now < until) {
                return;
            }
            match self.phase {
                Phase::Outside => {
                    // Whatever the answer: a relay that did not hear it takes us off its list when we ask to join.
                    if let Some(group) = self.owes_leave.take() {
                        let _ = self.transport.leave(&self.channel, group).await;
                    }
                    self.begin(now).await
                }
                Phase::Joining(..) => {
                    if !self.reask_at.is_some_and(|at| now >= at) {
                        return;
                    }
                    self.phase = Phase::Outside;
                    self.reask_at = None;
                }
                Phase::InCall(_) if self.behind => self.catch_up(now).await,
                Phase::InCall(_) => {
                    if !self.step(now).await {
                        return;
                    }
                }
            }
        }
    }

    fn back_off(&mut self, now: Instant) {
        self.back_off_for(now, STEP);
    }

    /// Nothing goes to the relay for `wait` (or longer, if a longer pause is already on).
    fn back_off_for(&mut self, now: Instant, wait: Duration) {
        let until = now + wait;
        self.quiet_until = Some(self.quiet_until.filter(|current| *current > until).unwrap_or(until));
    }

    /// The group is lost (a commit that does not apply, removed, a gap that cannot be filled) while we stay in the
    /// channel: as [`erase`](Self::erase), and the relay is told before we ask again, so it does not go on counting
    /// us in a group we no longer hold.
    fn start_over(&mut self, now: Instant) {
        if let Phase::InCall(group) = &self.phase {
            self.owes_leave = Some(group.group_id());
        }
        self.erase(now);
    }

    /// Drops the group with its keys, or the pending join: the next step starts over with `create`.
    fn erase(&mut self, now: Instant) {
        if matches!(self.phase, Phase::InCall(_)) {
            self.keyless_since = now;
        }
        self.phase = Phase::Outside;
        self.behind = false;
        self.needed_since = None;
        self.quiet_until = None;
        self.reask_at = None;
        self.seen_while_joining = None;
        self.gap_while_joining = false;
    }

    fn resync(&mut self, now: Instant) {
        match self.phase {
            Phase::InCall(_) => self.behind = true,
            // The welcome may have been sent while the stream was down; if it is still to come, it is taken
            // until a new KeyPackage goes out. Commits after it may have been lost too.
            Phase::Joining(..) => {
                self.reask_at = Some(self.reask_at.map_or(now + STEP, |at| at.min(now + STEP)));
                self.gap_while_joining = true;
            }
            Phase::Outside => {}
        }
        self.quiet_until = None;
    }

    /// Starts the call's group, or, when someone was first, asks to join theirs.
    async fn begin(&mut self, now: Instant) {
        let Ok(group_id) = random_bytes::<16>() else { return self.back_off(now) };
        // Made before the relay hears of it: the relay never knows of a group that nobody holds.
        let Ok(group) = group::create(&self.id, group_id, &self.channel) else { return self.back_off(now) };
        match self.transport.create(&self.channel, group_id).await {
            Ok(Created::Started) => self.enter(group, false),
            Ok(Created::Exists { group }) => self.ask_to_join(group, now).await,
            Err(_) => self.back_off(now),
        }
    }

    async fn ask_to_join(&mut self, group: [u8; 16], now: Instant) {
        let Ok((joiner, key_package)) = group::prepare_join(&self.id, group, &self.channel) else {
            return self.back_off(now);
        };
        match self.transport.join(&self.channel, group, &key_package).await {
            Ok(()) => self.phase = Phase::Joining(Box::new(joiner), group),
            // Gone between our two requests: the next step starts it.
            Err(error) if no_call(&error) => {}
            Err(_) => self.back_off(now),
        }
    }

    fn enter(&mut self, group: CallGroup, catch_up: bool) {
        self.phase = Phase::InCall(Box::new(group));
        self.failed = false;
        self.welcome_failures = 0;
        self.reask_at = None;
        self.needed_since = None;
        self.behind = catch_up;
        self.seen_while_joining = None;
        self.gap_while_joining = false;
        self.forget_members_requests();
    }

    /// Requests whose KeyPackage the group now holds are done with: someone added them. So are the requests the
    /// same person made before that one (they started over after them). A member's request that is not in the group
    /// is a new start (they restarted while their old leaf is still in) and stays, whatever else was committed.
    fn forget_members_requests(&mut self) {
        let Phase::InCall(group) = &self.phase else { return };
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

    fn queue(&mut self, event: &Value) {
        let (Some(user), Some(key_package)) = (event["user"].as_str(), bytes(&event["key_package"])) else { return };
        let user = UserId(user.to_string());
        if user == self.me || self.spent.contains(&sha256(&key_package)) {
            return;
        }
        // Already added (its commit came first): its leaf must not be replaced with itself.
        if let Phase::InCall(group) = &self.phase
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

    fn apply(&mut self, event: &Value, now: Instant) {
        let (Some(epoch), Some(commit)) = (event["epoch"].as_u64(), bytes(&event["commit"])) else { return };
        let group = match &self.phase {
            Phase::InCall(group) => group,
            // A joiner's group comes with the welcome; a commit made in its epoch or later is fetched after it.
            Phase::Joining(..) => {
                self.seen_while_joining = Some(self.seen_while_joining.map_or(epoch, |seen| seen.max(epoch)));
                return;
            }
            Phase::Outside => return,
        };
        let current = group.epoch();
        if epoch > current {
            // We missed one; `since` fills the gap.
            self.behind = true;
        } else if epoch == current {
            self.process(&commit, now);
        }
        // Older: one we made or applied already.
    }

    /// Applies another member's commit. One that does not apply leaves the group unusable, and being removed
    /// leaves us outside: either way the call is joined anew. False when that happened.
    fn process(&mut self, commit: &[u8], now: Instant) -> bool {
        let Phase::InCall(group) = &mut self.phase else { return false };
        if group.process(commit, &*self.admit).is_ok() && group.is_member() {
            self.forget_members_requests();
            return true;
        }
        self.start_over(now);
        false
    }

    fn welcome(&mut self, event: &Value, now: Instant) {
        let Some(message) = bytes(&event["welcome"]) else { return };
        if !matches!(self.phase, Phase::Joining(..)) {
            return;
        }
        let Phase::Joining(joiner, _) = std::mem::replace(&mut self.phase, Phase::Outside) else { return };
        match joiner.welcome(&message, &*self.admit) {
            Ok(group) => {
                // Only a commit made in the welcome's epoch or later, passed over while we waited, or a gap in the
                // stream, is worth a look at the relay: otherwise the welcome is all there is.
                let behind = self.gap_while_joining || self.seen_while_joining.is_some_and(|seen| seen >= group.epoch());
                self.enter(group, behind);
                // The keys go to the window now, before anything else is asked of the relay.
                self.report();
            }
            // Most likely the welcome for a KeyPackage we had already given up on, and it used up the joiner.
            // Asking again at once would put us one KeyPackage behind the welcomes for good: until the pause is
            // over we hold no joiner, so the other late welcomes are passed over, and only the next KeyPackage
            // can win. The pause grows while this repeats, to outlast a slow adder.
            Err(_) => {
                self.erase(now);
                self.welcome_failures = self.welcome_failures.saturating_add(1);
                self.back_off_for(now, STEP * (1 << (self.welcome_failures - 1).min(2)));
            }
        }
    }

    /// Applies the commits the relay has from our epoch on. If it no longer has the ones we need, or has
    /// another group, we join anew.
    async fn catch_up(&mut self, now: Instant) {
        let Phase::InCall(group) = &self.phase else { return };
        let (group_id, from) = (group.group_id(), group.epoch());
        let backlog = match self.transport.since(&self.channel, from).await {
            Ok(backlog) => backlog,
            Err(error) if no_call(&error) => return self.erase(now),
            Err(_) => return self.back_off(now),
        };
        self.behind = false;
        if backlog.group != group_id {
            return self.erase(now);
        }
        let mut commits = backlog.commits;
        commits.sort_by_key(|(epoch, _)| *epoch);
        for (epoch, commit) in commits {
            let Phase::InCall(group) = &self.phase else { return };
            let current = group.epoch();
            if epoch > current {
                break;
            }
            if epoch == current && !self.process(&commit, now) {
                return;
            }
        }
        if let Phase::InCall(group) = &self.phase
            && group.epoch() < backlog.epoch
        {
            self.start_over(now);
        }
    }

    /// Who the room shows and the journal admits, and we ourselves.
    fn present_admitted(&self) -> Option<HashSet<UserId>> {
        let mut present: HashSet<UserId> = self.present.as_ref()?.iter().filter(|user| (self.admit)(user)).cloned().collect();
        present.insert(self.me.clone());
        Some(present)
    }

    /// What the group needs: people to add and remove. Someone the journal no longer admits counts as gone,
    /// whatever the room shows, so the list we post holds only people the server can accept.
    fn plan(&self, group: &CallGroup, present: &HashSet<UserId>) -> Option<Changes> {
        let pending: Vec<(UserId, Vec<u8>)> = self
            .pending
            .iter()
            .filter(|(user, key_package)| (self.admit)(user) && !self.spent.contains(&sha256(key_package)))
            .cloned()
            .collect();
        let plan = changes(&group.members(), &self.me, present, &pending);
        (!plan.adds.is_empty() || !plan.removes.is_empty()).then_some(plan)
    }

    /// Commits what the group needs once our turn has come. True when something changed and there may be more.
    async fn step(&mut self, now: Instant) -> bool {
        let Phase::InCall(group) = &self.phase else { return false };
        let Some(present) = self.present_admitted() else { return false };
        let Some(plan) = self.plan(group, &present) else {
            self.needed_since = None;
            return false;
        };
        let since = *self.needed_since.get_or_insert(now);
        let Some(delay) = commit_delay(&group.members(), &self.me, &present) else { return false };
        if now < since + delay {
            return false;
        }
        self.commit(plan, now).await;
        true
    }

    async fn commit(&mut self, plan: Changes, now: Instant) {
        let Phase::InCall(group) = &mut self.phase else { return };
        let adds: Vec<Vec<u8>> = plan.adds.iter().map(|(_, key_package)| key_package.clone()).collect();
        // A round dropped while it waited for the relay leaves its commit staged, and nothing waits for it
        // any more; it would block every commit after it.
        let _ = group.discard();
        let out = match group.commit(&adds, &plan.removes, &*self.admit) {
            Ok(out) => out,
            Err(_) => return self.refused(&adds, now),
        };
        // Each KeyPackage must be the person the server said it is.
        let named: Vec<UserId> = plan.adds.iter().map(|(user, _)| user.clone()).collect();
        if out.welcome_to != named {
            let _ = group.discard();
            // Only the misnamed requests go: the same KeyPackage under its owner's name is still good.
            let misnamed: Vec<(UserId, Vec<u8>)> = if out.welcome_to.len() == named.len() {
                let pairs = plan.adds.iter().zip(&out.welcome_to);
                pairs.filter(|((named, _), real)| named != *real).map(|(add, _)| add.clone()).collect()
            } else {
                plan.adds.clone()
            };
            self.pending.retain(|request| !misnamed.contains(request));
            return;
        }
        let group_id = group.group_id();
        let answer = self.transport.commit(&self.channel, group_id, &out).await;
        let Phase::InCall(group) = &mut self.phase else { return };
        match answer {
            Ok(Committed::Accepted) => {
                if group.confirm().is_err() {
                    return self.start_over(now);
                }
                self.spent.extend(adds.iter().map(|key_package| sha256(key_package)));
                // A request that came while the commit was on its way is a newer start: it stays.
                self.forget_members_requests();
                self.needed_since = None;
            }
            // Someone was first in this epoch: apply theirs, then see whether ours is still needed.
            Ok(Committed::Conflict) => {
                let _ = group.discard();
                self.behind = true;
            }
            Err(error) => {
                let _ = group.discard();
                if no_call(&error) {
                    return self.erase(now);
                }
                // A refusal (not in the call, as far as the relay knows) may mean we missed the commit that removed
                // us: after the pause, look at what the relay has before trying again. A relay that did not answer
                // is just tried again.
                self.behind |= !matches!(error, ServerError::Unreachable(_));
                self.back_off(now);
            }
        }
    }

    /// Our commit could not be made. The KeyPackages that are to blame (tried one by one) are never tried again;
    /// if none is, the group itself is broken and the call is joined anew.
    fn refused(&mut self, adds: &[Vec<u8>], now: Instant) {
        let Phase::InCall(group) = &mut self.phase else { return };
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
            return self.start_over(now);
        }
        self.never_again(&bad);
    }

    fn never_again(&mut self, key_packages: &[Vec<u8>]) {
        self.spent.extend(key_packages.iter().map(|key_package| sha256(key_package)));
        self.pending.retain(|(_, key_package)| !key_packages.contains(key_package));
    }
}

/// The app's one call: a person is in one call at a time.
#[derive(Default)]
pub struct Calls {
    active: tokio::sync::Mutex<Option<Active>>,
    /// The journal the active call checks people against, by server address; refreshed after every sync.
    journal: std::sync::Mutex<Option<(String, Journal)>>,
    generation: AtomicU64,
}

struct Active {
    generation: u64,
    engine: CallEngine<SessionTransport>,
    timer: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for Active {
    fn drop(&mut self) {
        if let Some(timer) = &self.timer {
            timer.abort();
        }
    }
}

impl Active {
    /// Out of the channel. A relay that does not answer soon is not waited for: the next call must not wait on an
    /// unreachable server, and the relay takes us off its list anyway when we next ask to join.
    async fn leave(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
        let _ = tokio::time::timeout(LEAVE_WAIT, self.engine.leave(Instant::now())).await;
    }
}

/// The window hears of the call through `call-state` and `call-keys`.
fn to_window(app: tauri::AppHandle) -> Show {
    Box::new(move |shown| {
        let _ = match shown {
            Shown::State(state) => app.emit("call-state", &state),
            Shown::Keys(keys) => app.emit("call-keys", &keys),
        };
    })
}

impl Calls {
    /// Enters the call of `channel` on `address` in place of the active one; `show` hears of its lock and keys.
    /// The guard is handed back so the caller can start its timer.
    async fn replace(
        &self,
        sessions: &SharedSessions,
        id: &Identity,
        address: &str,
        channel: &str,
        show: Option<Show>,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<Active>>, String> {
        // The slot is set under the active call's lock: whichever call ends up active, the slot is its own.
        let mut active = self.active.lock().await;
        let (journal, transport) = {
            let open = sessions.lock().await;
            let session = open.get(address).ok_or(NOT_OPEN)?;
            let journal: Journal = Arc::new(RwLock::new(session.roster().clone()));
            // Set while the sessions are locked, so no journal read in between is missed.
            *self.journal.lock().unwrap_or_else(|e| e.into_inner()) = Some((address.to_string(), journal.clone()));
            (journal, SessionTransport::new(session, id))
        };
        // The previous call's group and keys go now.
        if let Some(mut previous) = active.take() {
            previous.leave().await;
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let admit = admit_by(journal, channel);
        let engine = CallEngine::start_showing(transport, id, address, channel, admit, show, Instant::now()).await;
        *active = Some(Active { generation, engine, timer: None });
        Ok(active)
    }

    /// Drops the active call: its group and keys go, and the relay hears of it.
    async fn leave(&self) {
        let mut active = self.active.lock().await;
        if let Some(mut call) = active.take() {
            // Still under the lock: a call entered after this must not be overtaken by its leave.
            call.leave().await;
        }
        self.journal.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// The session of `address` has re-read its journal: a call there checks people against the new one.
    pub fn journal_read(&self, address: &str, roster: &Roster) {
        let slot = self.journal.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((watched, journal)) = slot.as_ref()
            && watched == address
        {
            *journal.write().unwrap_or_else(|e| e.into_inner()) = roster.clone();
        }
    }
}

fn spawn_timer(app: tauri::AppHandle, generation: u64) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            let calls = app.state::<Calls>();
            let mut active = calls.active.lock().await;
            match active.as_mut() {
                Some(call) if call.generation == generation => {
                    call.engine.tick(Instant::now()).await;
                }
                _ => return,
            }
        }
    })
}

/// Enters the call of `channel` on the server at `address`, in place of any call we were in.
#[tauri::command]
pub async fn call_join(
    app: tauri::AppHandle,
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    calls: tauri::State<'_, Calls>,
    address: String,
    channel: String,
) -> Result<(), String> {
    let mut active = calls.replace(&sessions.0, &identity.get(), &address, &channel, Some(to_window(app.clone()))).await?;
    if let Some(call) = active.as_mut() {
        call.timer = Some(spawn_timer(app.clone(), call.generation));
    }
    Ok(())
}

/// Who LiveKit shows in the call's room (identities are user ids).
#[tauri::command]
pub async fn call_presence(
    calls: tauri::State<'_, Calls>,
    address: String,
    channel: String,
    identities: Vec<String>,
) -> Result<(), String> {
    let mut active = calls.active.lock().await;
    let Some(call) = active.as_mut() else { return Ok(()) };
    if call.engine.address != address || call.engine.channel != channel {
        return Ok(());
    }
    call.engine.on_presence(identities.into_iter().map(UserId).collect(), Instant::now()).await;
    Ok(())
}

/// Leaves the call: its group and keys are dropped.
#[tauri::command]
pub async fn call_leave(calls: tauri::State<'_, Calls>) -> Result<(), String> {
    calls.leave().await;
    Ok(())
}

/// A call event (or a `resync`) from the stream of `address`, for the active call.
pub async fn on_server_event(app: &tauri::AppHandle, address: &str, event: &Value) {
    let calls = app.state::<Calls>();
    let mut active = calls.active.lock().await;
    let Some(call) = active.as_mut() else { return };
    if call.engine.address != address {
        return;
    }
    call.engine.on_event(event, Instant::now()).await;
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, RwLock};
    use std::time::{Duration, Instant};

    use hv_crypto::group;
    use hv_roster::keys::{decode_b64_vec, encode_b64};
    use hv_roster::{Body, ChannelDef, ChannelOverride, Identity, InviteLink, Permissions, PublicKey, RoleDef, RoleId, Tri, UserId};
    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::*;
    use crate::call_plan::{KEYS_TIMEOUT, STEP};
    use crate::events::run_events;
    use crate::session::{Session, unix_now};
    use crate::tls::test_server;

    const CHANNEL: &str = "general";
    /// A member who sits in the channel's room but has no right to connect to it.
    const STRANGER: u8 = 9;
    /// No event for this long: whatever was on its way has arrived.
    const QUIET: Duration = Duration::from_millis(300);
    /// A pump that is still busy after this is looping: it stops, and the test's assertions say so.
    const PUMP_LIMIT: Duration = Duration::from_secs(10);

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn user(n: u8) -> UserId {
        id(n).public().user_id()
    }

    fn names(people: &[u8]) -> Vec<String> {
        people.iter().map(|n| user(*n).0).collect()
    }

    fn room(people: &[u8]) -> HashSet<UserId> {
        people.iter().map(|n| user(*n)).collect()
    }

    /// A server with people `1..=count` (1 owns it) and the stranger, all of them in the channel's LiveKit room.
    struct World {
        address: String,
        sessions: HashMap<u8, Session>,
    }

    async fn world(count: u8) -> World {
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let mut in_room: Vec<String> = (1..=count).map(|n| user(n).0).collect();
        in_room.push(user(STRANGER).0);
        let (livekit, _) = hatavoice_server::testing::fake_livekit(vec![(CHANNEL, in_room)]).await;
        let channels = Arc::new(hatavoice_server::channels::ChannelStore::open(None).unwrap());
        let app = hatavoice_server::host_app(livekit, None, channels, store.clone());
        let address = test_server::serve_app(app, store.server_identity()).await.to_string();

        let mut owner = Session::claim(&address, &id(1), "Хата", &[(CHANNEL.into(), "Общий".into())]).await.unwrap();
        let outcast = RoleId::parse("outcast").unwrap();
        let role = RoleDef { id: outcast.clone(), name: "Чужой".into(), color: None, permissions: Permissions::default() };
        owner.append(&id(1), Body::RoleCreate(role)).await.unwrap();
        let barred = ChannelOverride { role: outcast.clone(), view: Tri::Inherit, connect: Tri::Deny, speak: Tri::Inherit };
        let channel = ChannelDef { id: CHANNEL.into(), name: "Общий".into(), user_limit: 0, overrides: vec![barred], kind: Default::default() };
        owner.append(&id(1), Body::ChannelUpdate(channel)).await.unwrap();
        let link = InviteLink::parse(&owner.create_invite(&id(1), &address, vec![], None, None).await.unwrap()).unwrap();
        let outcast_link =
            InviteLink::parse(&owner.create_invite(&id(1), &address, vec![outcast], None, None).await.unwrap()).unwrap();

        let mut sessions = HashMap::new();
        for n in 2..=count {
            sessions.insert(n, Session::join(&link, &id(n), unix_now()).await.unwrap());
        }
        sessions.insert(STRANGER, Session::join(&outcast_link, &id(STRANGER), unix_now()).await.unwrap());
        sessions.insert(1, owner);
        for (n, session) in sessions.iter_mut() {
            session.sync(&id(*n)).await.unwrap();
        }
        World { address, sessions }
    }

    /// Person `n`'s transport, taken from their open sessions as the app takes it.
    async fn transport(sessions: &SharedSessions, address: &str, n: u8) -> SessionTransport {
        SessionTransport::new(sessions.lock().await.get(address).expect("the server is open"), &id(n))
    }

    /// Someone connected to the server, about to enter the call.
    struct Ready {
        n: u8,
        address: String,
        sessions: SharedSessions,
        transport: SessionTransport,
        journal: Journal,
        events: mpsc::UnboundedReceiver<Value>,
    }

    impl Ready {
        async fn start(self, now: Instant) -> Person {
            let admit = admit_by(self.journal.clone(), CHANNEL);
            let engine = CallEngine::start(self.transport, &id(self.n), &self.address, CHANNEL, admit, now).await;
            Person { n: self.n, engine, events: self.events, sessions: self.sessions, journal: self.journal }
        }

        /// The app as a whole, with its one call.
        fn app(self) -> App {
            App { n: self.n, address: self.address, sessions: self.sessions, calls: Calls::default(), events: self.events }
        }
    }

    struct Person<T: CallTransport = SessionTransport> {
        n: u8,
        engine: CallEngine<T>,
        events: mpsc::UnboundedReceiver<Value>,
        sessions: SharedSessions,
        journal: Journal,
    }

    impl<T: CallTransport> Person<T> {
        /// The app went away without a word (it crashed) and was started again: a new engine, and nothing of
        /// what was on its way to the old one.
        async fn restart(mut self, now: Instant) -> Person {
            let address = self.engine.address.clone();
            drop(self.engine);
            while self.events.try_recv().is_ok() {}
            let transport = transport(&self.sessions, &address, self.n).await;
            let admit = admit_by(self.journal.clone(), CHANNEL);
            let engine = CallEngine::start(transport, &id(self.n), &address, CHANNEL, admit, now).await;
            Person { n: self.n, engine, events: self.events, sessions: self.sessions, journal: self.journal }
        }
    }

    /// One person's app: its sessions, its one call ([`Calls`]) and its event stream.
    struct App {
        n: u8,
        address: String,
        sessions: SharedSessions,
        calls: Calls,
        events: mpsc::UnboundedReceiver<Value>,
    }

    impl App {
        async fn enter(&self) {
            drop(self.calls.replace(&self.sessions, &id(self.n), &self.address, CHANNEL, None).await.unwrap());
        }

        async fn leave(&self) {
            self.calls.leave().await;
        }

        async fn see(&self, present: &HashSet<UserId>) {
            if let Some(call) = self.calls.active.lock().await.as_mut() {
                call.engine.on_presence(present.clone(), Instant::now()).await;
            }
        }

        fn state(&self) -> (CallStateEvent, Option<CallKeysEvent>) {
            let active = self.calls.active.try_lock().expect("nothing else holds the call");
            let engine = &active.as_ref().expect("in a call").engine;
            (engine.state(), engine.keys())
        }
    }

    /// `pump` for whole apps: the events go to whichever call each app has now.
    async fn pump_apps(apps: &mut [&mut App]) {
        let limit = Instant::now() + PUMP_LIMIT;
        while Instant::now() < limit {
            let mut moved = false;
            for app in apps.iter_mut() {
                while let Ok(event) = app.events.try_recv() {
                    if let Some(call) = app.calls.active.lock().await.as_mut() {
                        call.engine.on_event(&event, Instant::now()).await;
                    }
                    moved = true;
                }
            }
            if !moved {
                tokio::time::sleep(QUIET).await;
                if apps.iter().all(|app| app.events.is_empty()) {
                    return;
                }
            }
        }
    }

    /// Requests to the relay (and, if asked, what the window was told), in order.
    type Log = Arc<std::sync::Mutex<Vec<String>>>;

    /// The relay's routes, counted on the way through.
    struct Counting<T: CallTransport> {
        inner: T,
        calls: Log,
    }

    impl<T: CallTransport> Counting<T> {
        fn note(&self, route: &str) {
            self.calls.lock().unwrap().push(route.to_string());
        }
    }

    impl<T: CallTransport> CallTransport for Counting<T> {
        async fn create(&self, channel: &str, group: [u8; 16]) -> Result<Created, ServerError> {
            self.note("create");
            self.inner.create(channel, group).await
        }

        async fn join(&self, channel: &str, group: [u8; 16], key_package: &[u8]) -> Result<(), ServerError> {
            self.note("join");
            self.inner.join(channel, group, key_package).await
        }

        async fn commit(&self, channel: &str, group: [u8; 16], out: &Outgoing) -> Result<Committed, ServerError> {
            self.note("commit");
            self.inner.commit(channel, group, out).await
        }

        async fn since(&self, channel: &str, epoch: u64) -> Result<Backlog, ServerError> {
            self.note("since");
            self.inner.since(channel, epoch).await
        }

        async fn leave(&self, channel: &str, group: [u8; 16]) -> Result<(), ServerError> {
            self.note("leave");
            self.inner.leave(channel, group).await
        }
    }

    impl Ready {
        /// Like `start`, with every request to the relay written down in `calls`.
        async fn start_counted(self, now: Instant) -> (Person<Counting<SessionTransport>>, Log) {
            self.start_logged(false, now).await
        }

        /// Like `start_counted`, and what the window is told goes in the same log, in order.
        async fn start_watched(self, now: Instant) -> (Person<Counting<SessionTransport>>, Log) {
            self.start_logged(true, now).await
        }

        async fn start_logged(self, watched: bool, now: Instant) -> (Person<Counting<SessionTransport>>, Log) {
            let log: Log = Arc::default();
            let transport = Counting { inner: self.transport, calls: log.clone() };
            let admit = admit_by(self.journal.clone(), CHANNEL);
            let show: Option<Show> = watched.then(|| {
                let log = log.clone();
                Box::new(move |shown: Shown| {
                    let line = match shown {
                        Shown::State(state) => format!("state:{}", serde_json::to_value(state.state).unwrap().as_str().unwrap()),
                        Shown::Keys(keys) => format!("keys:{}", keys.epoch),
                    };
                    log.lock().unwrap().push(line);
                }) as Show
            });
            let engine = CallEngine::start_showing(transport, &id(self.n), &self.address, CHANNEL, admit, show, now).await;
            (Person { n: self.n, engine, events: self.events, sessions: self.sessions, journal: self.journal }, log)
        }
    }

    /// The session's transport, whose commits can be made to hang (a relay that never answers).
    struct Gate {
        inner: SessionTransport,
        stalled: Arc<AtomicBool>,
    }

    impl CallTransport for Gate {
        async fn create(&self, channel: &str, group: [u8; 16]) -> Result<Created, ServerError> {
            self.inner.create(channel, group).await
        }

        async fn join(&self, channel: &str, group: [u8; 16], key_package: &[u8]) -> Result<(), ServerError> {
            self.inner.join(channel, group, key_package).await
        }

        async fn commit(&self, channel: &str, group: [u8; 16], out: &Outgoing) -> Result<Committed, ServerError> {
            if self.stalled.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            self.inner.commit(channel, group, out).await
        }

        async fn since(&self, channel: &str, epoch: u64) -> Result<Backlog, ServerError> {
            self.inner.since(channel, epoch).await
        }

        async fn leave(&self, channel: &str, group: [u8; 16]) -> Result<(), ServerError> {
            self.inner.leave(channel, group).await
        }
    }

    impl World {
        /// Person `n`'s transport, journal and event stream (open by the time this returns).
        async fn ready(&mut self, n: u8) -> Ready {
            let session = self.sessions.remove(&n).expect("each person connects once");
            let events = stream(&self.address, session.server_key, n).await;
            let journal: Journal = Arc::new(RwLock::new(session.roster().clone()));
            let sessions: SharedSessions = Arc::new(tokio::sync::Mutex::new(HashMap::from([(self.address.clone(), session)])));
            let transport = transport(&sessions, &self.address, n).await;
            Ready { n, address: self.address.clone(), sessions, transport, journal, events }
        }

        async fn app(&mut self, n: u8) -> App {
            self.ready(n).await.app()
        }

        async fn enter(&mut self, n: u8, now: Instant) -> Person {
            self.ready(n).await.start(now).await
        }
    }

    /// The person's events, as the app gets them.
    async fn stream(address: &str, server_key: PublicKey, n: u8) -> mpsc::UnboundedReceiver<Value> {
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let on_event = move |event: Value| {
            let _ = tx.send(event);
            async {}
        };
        tokio::spawn(run_events(address.to_string(), server_key, id(n).seed(), on_event, || async {}));
        // The server subscribes the stream before it says who sits where: after that no call event is missed.
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("the stream opens").unwrap();
            if event["type"] == "occupancy" {
                return rx;
            }
        }
    }

    /// Hands everyone the events that reach them, until none have come for a while.
    async fn pump(people: &mut [&mut Person], now: Instant) {
        let limit = Instant::now() + PUMP_LIMIT;
        while Instant::now() < limit {
            let mut moved = false;
            for person in people.iter_mut() {
                while let Ok(event) = person.events.try_recv() {
                    person.engine.on_event(&event, now).await;
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

    /// Like `pump` for one person, but only the events `keep` picks reach them; the others are lost.
    async fn deliver<T: CallTransport>(person: &mut Person<T>, now: Instant, keep: impl Fn(&Value) -> bool) {
        while let Ok(Some(event)) = tokio::time::timeout(QUIET, person.events.recv()).await {
            if keep(&event) {
                person.engine.on_event(&event, now).await;
            }
        }
    }

    async fn see(people: &mut [&mut Person], present: &HashSet<UserId>, now: Instant) {
        for person in people.iter_mut() {
            person.engine.on_presence(present.clone(), now).await;
        }
    }

    /// `n`'s request to join.
    fn asks(event: &Value, n: u8) -> bool {
        event["type"] == "call_join" && event["user"] == user(n).0.as_str()
    }

    /// The next event of this kind that reaches the person; the ones before it are lost.
    async fn next_of<T: CallTransport>(person: &mut Person<T>, kind: &str) -> Value {
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), person.events.recv()).await.expect("an event").unwrap();
            if event["type"] == kind {
                return event;
            }
        }
    }

    fn epoch<T: CallTransport>(person: &Person<T>) -> u64 {
        person.engine.keys().expect("in the call").epoch
    }

    fn code<T: CallTransport>(person: &Person<T>) -> String {
        person.engine.state().code.expect("in the call")
    }

    fn key_list(keys: &CallKeysEvent) -> Vec<(String, u8, String)> {
        keys.keys.iter().map(|key| (key.identity.clone(), key.index, key.key.clone())).collect()
    }

    /// Everyone is in the call, with the same members, code and keys.
    fn agree(people: &[&Person], members: &[u8]) {
        let first = people[0].engine.keys().expect("keys");
        for person in people {
            let state = person.engine.state();
            assert_eq!(state.state, Lock::Secure, "person {}", person.n);
            assert_eq!(state.error, None);
            assert_eq!(state.members, names(members), "person {}", person.n);
            assert_eq!(state.code, people[0].engine.state().code, "person {}", person.n);
            let keys = person.engine.keys().expect("keys");
            assert_eq!(keys.epoch, first.epoch, "person {}", person.n);
            assert_eq!(key_list(&keys), key_list(&first), "person {}", person.n);
        }
    }

    fn group_of<T: CallTransport>(person: &Person<T>) -> [u8; 16] {
        match &person.engine.phase {
            Phase::InCall(group) => group.group_id(),
            _ => panic!("person {} is not in the call", person.n),
        }
    }

    #[tokio::test]
    async fn first_in_channel_is_secure_at_once() {
        let mut world = world(1).await;
        let a = world.enter(1, Instant::now()).await;

        let state = a.engine.state();
        assert_eq!(state.state, Lock::Secure);
        assert_eq!((state.address.as_str(), state.channel.as_str()), (world.address.as_str(), CHANNEL));
        assert_eq!(state.members, names(&[1]));
        assert!(state.code.as_ref().is_some_and(|code| code.len() == 35), "{:?}", state.code);
        assert_eq!(state.error, None);
        let keys = a.engine.keys().expect("keys at once");
        assert_eq!((keys.address.as_str(), keys.channel.as_str(), keys.epoch), (world.address.as_str(), CHANNEL, 0));
        assert_eq!(keys.keys.len(), 1);
        assert_eq!((keys.keys[0].identity.as_str(), keys.keys[0].index), (user(1).0.as_str(), 0));
        assert_eq!(decode_b64_vec(&keys.keys[0].key).map(|key| key.len()), Some(32));
        assert!(!format!("{keys:?}").contains(&keys.keys[0].key), "the key stays out of logs");
        assert_eq!(serde_json::to_value(&state).unwrap()["state"], "secure");
    }

    #[tokio::test]
    async fn second_person_is_added_and_both_agree() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        assert_eq!(b.engine.state().state, Lock::Pending);
        assert!(b.engine.keys().is_none());
        assert_eq!(serde_json::to_value(b.engine.state()).unwrap()["state"], "pending");

        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;

        agree(&[&a, &b], &[1, 2]);
        assert_eq!(epoch(&a), 1);
        let keys = a.engine.keys().unwrap();
        assert_eq!(keys.keys.iter().map(|key| key.index).collect::<Vec<_>>(), vec![1, 1]);
        assert_ne!(keys.keys[0].key, keys.keys[1].key, "every sender has a key of its own");
    }

    #[tokio::test]
    async fn simultaneous_creators_end_in_one_group() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let (ready_a, ready_b) = (world.ready(1).await, world.ready(2).await);
        let (mut a, mut b) = tokio::join!(ready_a.start(t0), ready_b.start(t0));
        let locks = [a.engine.state().state, b.engine.state().state];
        assert!(locks.contains(&Lock::Secure) && locks.contains(&Lock::Pending), "one created the call: {locks:?}");

        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;

        let creator = if locks[0] == Lock::Secure { 1 } else { 2 };
        let joiner = 3 - creator;
        agree(&[&a, &b], &[creator, joiner]);
    }

    #[tokio::test]
    async fn next_member_adds_when_the_first_is_silent() {
        let mut world = world(3).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;

        // A hangs: it no longer reads its events, while LiveKit still shows it.
        let mut c = world.enter(3, t0).await;
        see(&mut [&mut b, &mut c], &room(&[1, 2, 3]), t0).await;
        pump(&mut [&mut b, &mut c], t0).await;
        b.engine.tick(t0 + STEP / 2).await;
        pump(&mut [&mut b, &mut c], t0 + STEP / 2).await;
        assert_eq!(c.engine.state().state, Lock::Pending, "B waits its turn while A may still act");

        b.engine.tick(t0 + STEP).await;
        pump(&mut [&mut b, &mut c], t0 + STEP).await;
        agree(&[&b, &c], &[1, 2, 3]);
        assert_eq!(epoch(&a), 1, "A took no part");
    }

    #[tokio::test]
    async fn removed_member_cannot_follow_the_next_epoch() {
        let mut world = world(3).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        let mut c = world.enter(3, t0).await;
        see(&mut [&mut a, &mut b, &mut c], &room(&[1, 2, 3]), t0).await;
        pump(&mut [&mut a, &mut b, &mut c], t0).await;
        agree(&[&a, &b, &c], &[1, 2, 3]);
        let (last_code, last_keys) = (code(&b), b.engine.keys().unwrap());

        // B leaves the room (or is moved out): the others change the keys without it.
        see(&mut [&mut a, &mut c], &room(&[1, 3]), t0).await;
        pump(&mut [&mut a, &mut b, &mut c], t0).await;

        agree(&[&a, &c], &[1, 3]);
        assert_ne!(code(&a), last_code);
        // All B learns is that it was removed: it drops the old group and its keys and asks to join again, and
        // nobody lets it in, as nobody sees it in the room.
        assert_eq!(b.engine.state().state, Lock::Pending);
        assert!(b.engine.keys().is_none());
        let new_keys = a.engine.keys().unwrap();
        for key in &new_keys.keys {
            assert!(last_keys.keys.iter().all(|old| old.key != key.key), "B held a key of the new epoch");
        }
    }

    #[tokio::test]
    async fn a_member_removed_while_in_the_room_rejoins() {
        let mut world = world(3).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        let mut c = world.enter(3, t0).await;
        see(&mut [&mut a, &mut b, &mut c], &room(&[1, 2, 3]), t0).await;
        pump(&mut [&mut a, &mut b, &mut c], t0).await;
        agree(&[&a, &b, &c], &[1, 2, 3]);
        let before = epoch(&a);

        // For a moment A and C do not see B (LiveKit reconnected it, say): A removes B, who is still there.
        see(&mut [&mut a, &mut c], &room(&[1, 3]), t0).await;
        pump(&mut [&mut a, &mut b, &mut c], t0).await;
        assert_eq!(b.engine.state().state, Lock::Pending, "B knows it is out and asks again");

        // B shows again and is let back in with its new KeyPackage.
        see(&mut [&mut a, &mut c], &room(&[1, 2, 3]), t0).await;
        pump(&mut [&mut a, &mut b, &mut c], t0).await;
        agree(&[&a, &b, &c], &[1, 2, 3]);
        assert_eq!(epoch(&a), before + 2, "removed, then added");
    }

    #[tokio::test]
    async fn a_member_whose_commit_is_refused_checks_whether_it_is_still_in() {
        let mut world = world(3).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let (mut b, calls) = world.ready(2).await.start_counted(t0).await;
        let mut c = world.enter(3, t0).await;
        b.engine.on_presence(room(&[1, 2, 3]), t0).await;
        see(&mut [&mut a, &mut c], &room(&[1, 2, 3]), t0).await;
        pump(&mut [&mut a, &mut c], t0).await;
        deliver(&mut b, t0, |_| true).await;
        assert_eq!(code(&b), code(&a));

        // A removes B, and B's stream loses that commit.
        see(&mut [&mut a, &mut c], &room(&[1, 3]), t0).await;
        pump(&mut [&mut a, &mut c], t0).await;
        deliver(&mut b, t0, |event| event["type"] != "call_commit").await;
        assert_eq!(b.engine.state().state, Lock::Secure, "B has not heard");

        // B no longer sees A and wants to remove it: the relay refuses, as B is not in the call any more.
        calls.lock().unwrap().clear();
        b.engine.on_presence(room(&[2, 3]), t0).await;
        assert_eq!(*calls.lock().unwrap(), ["commit"]);
        // After the pause B looks at what it missed instead of trying again, finds itself removed and asks back in.
        b.engine.tick(t0 + STEP).await;
        assert_eq!(*calls.lock().unwrap(), ["commit", "since", "leave", "create", "join"]);
        assert_eq!(b.engine.state().state, Lock::Pending);
        assert!(b.engine.keys().is_none());

        // Seen again, B is let in.
        b.engine.on_presence(room(&[1, 2, 3]), t0 + STEP).await;
        see(&mut [&mut a, &mut c], &room(&[1, 2, 3]), t0 + STEP).await;
        pump(&mut [&mut a, &mut c], t0 + STEP).await;
        deliver(&mut b, t0 + STEP, |_| true).await;
        pump(&mut [&mut a, &mut c], t0 + STEP).await;
        agree(&[&a, &c], &[1, 2, 3]);
        assert_eq!(code(&b), code(&a));
    }

    #[tokio::test]
    async fn missed_commits_are_fetched_after_a_gap() {
        let mut world = world(3).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut c = world.enter(2, t0).await;
        see(&mut [&mut a, &mut c], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut c], t0).await;

        let mut d = world.enter(3, t0).await;
        see(&mut [&mut a, &mut c, &mut d], &room(&[1, 2, 3]), t0).await;
        pump(&mut [&mut a, &mut d], t0).await;
        // C's stream drops the commit that added D.
        deliver(&mut c, t0, |event| event["type"] != "call_commit").await;
        assert_eq!((epoch(&a), epoch(&c)), (2, 1));

        // D leaves; C hears of this commit, finds the gap and fetches what it missed.
        see(&mut [&mut a, &mut c], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut c, &mut d], t0).await;

        agree(&[&a, &c], &[1, 2]);
        assert_eq!(epoch(&c), 3);
    }

    #[tokio::test]
    async fn a_losing_commit_is_retried_after_applying_the_winner() {
        let mut world = world(4).await;
        let t0 = Instant::now();
        let everyone = room(&[1, 2, 3, 4]);
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &everyone, t0).await;
        pump(&mut [&mut a, &mut b], t0).await;
        let mut c = world.enter(3, t0).await;
        let mut d = world.enter(4, t0).await;
        see(&mut [&mut c, &mut d], &everyone, t0).await;

        // A hears only of C and adds C at once; B hears only of D and, second in line, waits its turn.
        deliver(&mut a, t0, |event| asks(event, 3)).await;
        deliver(&mut b, t0, |event| asks(event, 4)).await;
        assert_eq!((epoch(&a), epoch(&b)), (2, 1));

        // B commits in epoch 1, loses to A's commit, applies it and adds D on top of it.
        b.engine.tick(t0 + STEP).await;
        assert_eq!(epoch(&b), 3);
        assert_eq!(b.engine.state().members, names(&[1, 2, 3, 4]));

        pump(&mut [&mut a, &mut b, &mut c, &mut d], t0 + STEP).await;
        agree(&[&a, &b, &c, &d], &[1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn no_keys_in_ten_seconds_is_a_failure() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let _a = world.enter(1, t0).await;
        // A never answers.
        let mut b = world.enter(2, t0).await;
        b.engine.on_presence(room(&[1, 2]), t0).await;

        b.engine.tick(t0 + KEYS_TIMEOUT - Duration::from_secs(1)).await;
        assert_eq!(b.engine.state().state, Lock::Pending);
        assert_eq!(b.engine.state().error, None);

        b.engine.tick(t0 + KEYS_TIMEOUT).await;
        let state = b.engine.state();
        assert_eq!(state.state, Lock::Failed);
        assert_eq!(state.error.as_deref(), Some("Не удалось зашифровать звонок"));
        assert_eq!((state.code, state.members), (None, vec![]));
        assert!(b.engine.keys().is_none());
        assert_eq!(serde_json::to_value(b.engine.state()).unwrap()["state"], "failed");
    }

    #[tokio::test]
    async fn a_stranger_in_the_room_is_never_added() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        a.engine.on_presence(room(&[1, 2, STRANGER]), t0).await;
        let stranger = world.ready(STRANGER).await;
        let (_joiner, key_package) = group::prepare_join(&id(STRANGER), group_of(&a), CHANNEL).unwrap();
        assert!(stranger.transport.join(CHANNEL, group_of(&a), &key_package).await.is_err(), "the server turns the stranger away");

        // A server that passes the stranger's KeyPackage on anyway, under the stranger's name and under B's.
        for name in [user(STRANGER), user(2)] {
            let event = json!({
                "type": "call_join",
                "channel": CHANNEL,
                "group_id": encode_b64(&group_of(&a)),
                "user": name,
                "key_package": encode_b64(&key_package),
            });
            a.engine.on_event(&event, t0).await;
        }
        a.engine.tick(t0 + KEYS_TIMEOUT).await;
        assert_eq!(a.engine.state().members, names(&[1]));
        assert_eq!(epoch(&a), 0);

        // Nothing is stuck: B, who may connect, still gets in.
        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &room(&[1, 2, STRANGER]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;
        agree(&[&a, &b], &[1, 2]);
    }

    #[tokio::test]
    async fn a_stale_welcome_settles_without_a_loop() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;

        // A sits on B's request; B gives up waiting and asks again with a new KeyPackage.
        b.engine.tick(t0 + KEYS_TIMEOUT).await;
        b.engine.tick(t0 + KEYS_TIMEOUT + STEP).await;
        let (first, second) = (next_of(&mut a, "call_join").await, next_of(&mut a, "call_join").await);
        assert!(asks(&first, 2) && asks(&second, 2));
        assert_ne!(first["key_package"], second["key_package"], "B has two KeyPackages out");

        // A adds the older one first: its welcome reaches B, who by now holds the newer one.
        let later = t0 + KEYS_TIMEOUT + STEP;
        a.engine.on_event(&first, later).await;
        a.engine.on_event(&second, later).await;
        pump(&mut [&mut a, &mut b], later).await;
        b.engine.tick(later + 2 * STEP).await;
        pump(&mut [&mut a, &mut b], later + 2 * STEP).await;

        agree(&[&a, &b], &[1, 2]);
        let commits = a.engine.transport.since(CHANNEL, 0).await.unwrap().commits.len();
        assert!(commits <= 3, "{commits} commits to add one person");
    }

    #[tokio::test]
    async fn a_commit_left_staged_by_a_cancelled_round_does_not_block_the_next() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let ready = world.ready(1).await;
        let stalled = Arc::new(AtomicBool::new(false));
        let transport = Gate { inner: ready.transport, stalled: stalled.clone() };
        let admit = admit_by(ready.journal.clone(), CHANNEL);
        let engine = CallEngine::start(transport, &id(1), &ready.address, CHANNEL, admit, t0).await;
        let mut a = Person { n: 1, engine, events: ready.events, sessions: ready.sessions, journal: ready.journal };
        let mut b = world.enter(2, t0).await;
        a.engine.on_presence(room(&[1, 2]), t0).await;
        b.engine.on_presence(room(&[1, 2]), t0).await;

        // The round that commits B is dropped while it waits for the relay (the app aborts a stream's task
        // when it opens the server again): the commit stays staged in A's group.
        let join = next_of(&mut a, "call_join").await;
        stalled.store(true, Ordering::SeqCst);
        assert!(tokio::time::timeout(QUIET, a.engine.on_event(&join, t0)).await.is_err(), "the relay never answers");
        stalled.store(false, Ordering::SeqCst);
        assert_eq!(epoch(&a), 0);

        a.engine.tick(t0).await;
        deliver(&mut b, t0, |_| true).await;
        deliver(&mut a, t0, |_| true).await;
        assert_eq!(b.engine.state().state, Lock::Secure, "B was still added");
        assert_eq!(a.engine.state().members, names(&[1, 2]));
        assert_eq!(code(&a), code(&b));
        assert_eq!(key_list(&a.engine.keys().unwrap()), key_list(&b.engine.keys().unwrap()));
    }

    /// Both apps are in one call: the same lock, code, members and keys.
    fn apps_agree(apps: &[&App], members: &[u8]) {
        let (first_state, first_keys) = apps[0].state();
        for app in apps {
            let (state, keys) = app.state();
            assert_eq!(state.state, Lock::Secure, "app {}", app.n);
            assert_eq!(state.members, names(members), "app {}", app.n);
            assert_eq!(state.code, first_state.code, "app {}", app.n);
            let (keys, first) = (keys.expect("keys"), first_keys.clone().expect("keys"));
            assert_eq!((keys.epoch, key_list(&keys)), (first.epoch, key_list(&first)), "app {}", app.n);
        }
    }

    #[tokio::test]
    async fn the_only_member_who_comes_back_starts_afresh() {
        let mut world = world(2).await;
        let mut a = world.app(1).await;
        a.enter().await;
        assert_eq!(a.state().0.state, Lock::Secure);
        let first_code = a.state().0.code;

        // A leaves the channel and comes straight back, long before the server would forget an empty call.
        a.leave().await;
        a.enter().await;
        let (state, keys) = a.state();
        assert_eq!(state.state, Lock::Secure, "A must not wait for a group that nobody holds");
        assert_ne!(state.code, first_code, "a new group");
        assert_eq!(keys.map(|keys| keys.epoch), Some(0));

        // And the call is a working one: the next person gets in.
        let mut b = world.app(2).await;
        b.enter().await;
        for app in [&a, &b] {
            app.see(&room(&[1, 2])).await;
        }
        pump_apps(&mut [&mut a, &mut b]).await;
        apps_agree(&[&a, &b], &[1, 2]);
    }

    #[tokio::test]
    async fn two_members_who_both_come_back_end_in_one_group() {
        let mut world = world(2).await;
        let (mut a, mut b) = (world.app(1).await, world.app(2).await);
        a.enter().await;
        b.enter().await;
        for app in [&a, &b] {
            app.see(&room(&[1, 2])).await;
        }
        pump_apps(&mut [&mut a, &mut b]).await;
        apps_agree(&[&a, &b], &[1, 2]);

        // Both step out (to another channel, say) and come back together.
        a.leave().await;
        b.leave().await;
        tokio::join!(a.enter(), b.enter());
        for app in [&a, &b] {
            app.see(&room(&[1, 2])).await;
        }
        pump_apps(&mut [&mut a, &mut b]).await;

        let creator = if a.state().0.members.first() == Some(&user(1).0) { 1 } else { 2 };
        apps_agree(&[&a, &b], &[creator, 3 - creator]);
    }

    #[tokio::test]
    async fn a_crashed_member_restarting_quickly_is_not_stuck() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let a = world.enter(1, t0).await;
        let first = group_of(&a);

        // A's app dies without a word and is started again at once: the server still counts A in the call.
        let mut a = a.restart(t0).await;
        assert_eq!(a.engine.state().state, Lock::Secure, "A starts a new call instead of waiting to be let in");
        assert_ne!(group_of(&a), first);

        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;
        agree(&[&a, &b], &[1, 2]);
    }

    #[tokio::test]
    async fn a_member_whose_group_breaks_tells_the_relay_before_starting_over() {
        let mut world = world(1).await;
        let t0 = Instant::now();
        let (mut a, calls) = world.ready(1).await.start_counted(t0).await;
        let first = group_of(&a);
        calls.lock().unwrap().clear();

        // A commit in A's epoch that does not apply: the group is lost while A stays in the channel.
        let broken = json!({ "type": "call_commit", "channel": CHANNEL, "group_id": encode_b64(&first), "epoch": 0, "commit": encode_b64(b"not a commit") });
        a.engine.on_event(&broken, t0).await;

        assert_eq!(*calls.lock().unwrap(), ["leave", "create"], "off the relay's list first, then straight into a new call");
        assert_eq!(a.engine.state().state, Lock::Secure);
        assert_ne!(group_of(&a), first);
    }

    #[tokio::test]
    async fn a_reset_or_commit_of_another_group_is_passed_over() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;
        let (group, before) = (group_of(&a), code(&a));

        // Late news of an earlier call in the channel: its reset, and a commit that would break this group.
        let earlier = encode_b64(&[0xEE; 16]);
        let reset = json!({ "type": "call_reset", "channel": CHANNEL, "group_id": earlier });
        let commit = json!({ "type": "call_commit", "channel": CHANNEL, "group_id": earlier, "epoch": epoch(&a), "commit": encode_b64(b"not a commit") });
        for event in [reset, commit] {
            a.engine.on_event(&event, t0).await;
            assert_eq!(a.engine.state().state, Lock::Secure, "{event}");
            assert_eq!((group_of(&a), code(&a)), (group, before.clone()), "{event}");
        }

        // The call's own reset still sends A back to the start.
        let reset = json!({ "type": "call_reset", "channel": CHANNEL, "group_id": encode_b64(&group) });
        a.engine.on_event(&reset, t0).await;
        assert_ne!(a.engine.state().state, Lock::Secure);
    }

    #[tokio::test]
    async fn a_late_leave_of_the_previous_call_leaves_the_next_one_alone() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let ready = world.ready(1).await;
        let late = transport(&ready.sessions, &ready.address, 1).await;
        let mut a = ready.start(t0).await;
        let first = group_of(&a);
        a.engine.leave(t0).await;
        let mut a = a.restart(t0).await;
        let next = group_of(&a);
        assert_ne!(first, next, "the first call went with its last member");

        // The leave of the first call reaches the relay once more, only now: it was on its way when A came back.
        late.leave(CHANNEL, first).await.unwrap();

        // B comes in and finds A's call.
        let mut b = world.enter(2, t0).await;
        see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
        pump(&mut [&mut a, &mut b], t0).await;
        agree(&[&a, &b], &[1, 2]);
        assert_eq!(group_of(&b), next);
    }

    #[tokio::test]
    async fn a_joiner_gets_keys_without_an_extra_round_trip() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let (mut b, calls) = world.ready(2).await.start_counted(t0).await;
        a.engine.on_presence(room(&[1, 2]), t0).await;
        b.engine.on_presence(room(&[1, 2]), t0).await;
        deliver(&mut a, t0, |_| true).await;
        deliver(&mut b, t0, |_| true).await;

        assert_eq!(code(&b), code(&a));
        assert_eq!(*calls.lock().unwrap(), ["create", "join"], "the welcome is all B needs");
    }

    #[tokio::test]
    async fn a_joiner_shows_its_keys_before_fetching_a_commit_that_overtook_the_welcome() {
        let mut world = world(3).await;
        let t0 = Instant::now();
        let mut a = world.enter(1, t0).await;
        let (mut b, log) = world.ready(2).await.start_watched(t0).await;
        assert_eq!(*log.lock().unwrap(), ["create", "join", "state:pending"]);
        a.engine.on_presence(room(&[1, 2, 3]), t0).await;
        b.engine.on_presence(room(&[1, 2, 3]), t0).await;
        // A adds B, then C: B, in the group by then, is sent the second commit too.
        deliver(&mut a, t0, |_| true).await;
        let mut c = world.enter(3, t0).await;
        deliver(&mut a, t0, |_| true).await;
        deliver(&mut c, t0, |_| true).await;

        // Events are sent after the relay's lock is let go: the commit that added C overtakes B's welcome.
        let mut events = Vec::new();
        while let Ok(Some(event)) = tokio::time::timeout(QUIET, b.events.recv()).await {
            events.push(event);
        }
        let welcome = events.iter().position(|e| e["type"] == "call_welcome").expect("a welcome");
        let newer = events.iter().position(|e| e["type"] == "call_commit" && e["epoch"] == 1).expect("the second commit");
        let overtaking = events.remove(newer);
        events.insert(welcome, overtaking);
        log.lock().unwrap().clear();
        for event in &events {
            b.engine.on_event(event, t0).await;
        }

        // The keys of the welcome's epoch are shown at once; then B fetches what it passed over.
        assert_eq!(*log.lock().unwrap(), ["state:secure", "keys:1", "since", "state:secure", "keys:2"]);
        assert_eq!((code(&b), code(&c)), (code(&a), code(&a)));
    }

    #[tokio::test]
    async fn a_rejoin_request_survives_an_unrelated_commit() {
        let mut world = world(4).await;
        let t0 = Instant::now();
        let everyone = room(&[1, 2, 3, 4]);
        let mut a = world.enter(1, t0).await;
        let mut b = world.enter(2, t0).await;
        let mut c = world.enter(3, t0).await;
        see(&mut [&mut a, &mut b, &mut c], &everyone, t0).await;
        pump(&mut [&mut a, &mut b, &mut c], t0).await;
        agree(&[&a, &b, &c], &[1, 2, 3]);

        // C restarts and asks to join again, while its old leaf is still in the group; D asks to join too.
        let mut c = c.restart(t0).await;
        c.engine.on_presence(everyone.clone(), t0).await;
        let mut d = world.enter(4, t0).await;
        d.engine.on_presence(everyone.clone(), t0).await;
        // A hears only of D and adds D at once. B hears only of C and, second in line, waits its turn.
        deliver(&mut a, t0, |event| asks(event, 4)).await;
        deliver(&mut b, t0, |event| asks(event, 3)).await;
        // B applies A's commit, which has nothing to do with C's request.
        deliver(&mut b, t0, |_| true).await;
        deliver(&mut d, t0, |_| true).await;

        // B's turn: C's request is still there, and C gets in with it.
        b.engine.tick(t0 + STEP).await;
        pump(&mut [&mut a, &mut b, &mut c, &mut d], t0 + STEP).await;
        agree(&[&a, &b, &c, &d], &[1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn a_slow_request_to_another_server_does_not_delay_the_call() {
        let mut world = world(2).await;
        let t0 = Instant::now();
        let ready = world.ready(1).await;
        let sessions = ready.sessions.clone();
        let mut a = ready.start(t0).await;
        let mut b = world.enter(2, t0).await;

        // Meanwhile the app's open sessions are held by something slow: an 8 MB upload, a request to another
        // server that is offline, a journal sync.
        let held = sessions.lock().await;
        let joined = tokio::time::timeout(Duration::from_secs(5), async {
            see(&mut [&mut a, &mut b], &room(&[1, 2]), t0).await;
            pump(&mut [&mut a, &mut b], t0).await;
        });
        assert!(joined.await.is_ok(), "the call waited for an unrelated request");
        drop(held);
        agree(&[&a, &b], &[1, 2]);
    }

    #[tokio::test]
    async fn the_journal_slot_belongs_to_the_active_call() {
        let mut world = world(1).await;
        let address = world.address.clone();
        let session = world.sessions.remove(&1).unwrap();
        let sessions: SharedSessions = Arc::new(tokio::sync::Mutex::new(HashMap::from([(address.clone(), session)])));
        let calls = Arc::new(Calls::default());
        drop(calls.replace(&sessions, &id(1), &address, CHANNEL, None).await.unwrap());

        // Leaving and entering again overlap (switching channels), the leave first in line.
        let held = calls.active.lock().await;
        let leave = tokio::spawn({
            let calls = calls.clone();
            async move { calls.leave().await }
        });
        tokio::task::yield_now().await;
        let enter = tokio::spawn({
            let (calls, sessions, address) = (calls.clone(), sessions.clone(), address.clone());
            async move { calls.replace(&sessions, &id(1), &address, CHANNEL, None).await.map(drop) }
        });
        tokio::task::yield_now().await;
        drop(held);
        leave.await.unwrap();
        enter.await.unwrap().unwrap();

        let active = calls.active.lock().await;
        let call = active.as_ref().expect("the second call is the active one");
        let slot = calls.journal.lock().unwrap().as_ref().map(|(watched, _)| watched.clone());
        assert_eq!(slot.as_deref(), Some(call.engine.address.as_str()), "kicks and bans would no longer reach the call");
    }
}
