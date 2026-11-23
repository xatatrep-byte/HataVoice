//! The relay for call groups. A call is encrypted end to end with an MLS group of its own and the
//! server opens nothing: it keeps, in memory only, who is in each call's group and the last few
//! commits, puts commits in order (one per epoch) and passes the opaque messages on over the event
//! stream. It turns away anyone who is not in the journal with the right to connect to the channel
//! or is not really in its LiveKit room.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use hv_roster::UserId;
use hv_roster::keys::{decode_b64, decode_b64_vec};
use serde::Deserialize;

use crate::AppState;
use crate::api::{MAX_BODY, signed};
use crate::auth::{error, member_only};
use crate::events::Event;
use crate::occupancy::in_room;

/// Key packages, commits and welcomes grow with the group; ordinary requests are too small for them.
pub const CALL_BODY: usize = 256 * 1024;
/// A key package is a few KB, and anyone in the room may join: far less than a commit may carry.
pub const JOIN_BODY: usize = 16 * 1024;
/// How far back someone whose event stream broke can catch up; further than that they join afresh.
pub const KEPT_COMMITS: usize = 64;
/// A call is not forgotten sooner than this after its last change: whoever a commit just added
/// may not show in LiveKit's list yet.
pub const PRUNE_GRACE: Duration = Duration::from_secs(5);

struct Call {
    /// base64url, as the creator sent it.
    group_id: String,
    epoch: u64,
    /// Who the last commit said is in the group; the server believes it only to route events.
    members: Vec<UserId>,
    /// Asked to join and not yet in a commit.
    pending: Vec<UserId>,
    /// (epoch the commit was made in, base64url commit), oldest first.
    commits: VecDeque<(u64, String)>,
    /// When the group last changed: at the creation and at every accepted commit.
    changed: Instant,
}

#[derive(Default)]
pub struct CallStore {
    calls: Mutex<HashMap<String, Call>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Created {
    Started,
    Exists { group_id: String, epoch: u64 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Joined {
    /// The request waits for the next commit; `tell` are the people of the group who are to hear of it.
    Queued { tell: Vec<UserId> },
    /// The joiner was the last one the group was known to have: nobody holds it any more, so the call is
    /// forgotten. `waiting` (the others who asked to join) start over.
    Forgotten { waiting: Vec<UserId> },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Left {
    Stays,
    /// That was the last member: the call is forgotten, and `waiting` start over.
    Forgotten { waiting: Vec<UserId> },
}

pub struct Commit {
    /// base64url, the group the commit is for.
    pub group: String,
    /// The epoch the committer was in.
    pub epoch: u64,
    pub data: String,
    /// The whole group after the commit, the committer included.
    pub members: Vec<UserId>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Accepted {
    /// The epoch the call is in now.
    pub epoch: u64,
    /// The group as it was before the commit: whoever it removed is to hear of that too.
    pub before: Vec<UserId>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CommitError {
    NoCall,
    /// The committer is not in the group, or left itself out of the new list.
    NotInCall,
    /// Someone committed in this epoch first.
    Conflict { epoch: u64 },
}

#[derive(Debug)]
pub struct Backlog {
    pub group_id: String,
    pub epoch: u64,
    pub commits: Vec<(u64, String)>,
}

impl CallStore {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Call>> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The first caller starts the call at epoch 0; later ones are told which group to join.
    pub fn create(&self, channel: &str, group_id: String, creator: UserId, now: Instant) -> Created {
        let mut calls = self.lock();
        if let Some(call) = calls.get(channel) {
            return Created::Exists { group_id: call.group_id.clone(), epoch: call.epoch };
        }
        let call = Call { group_id, epoch: 0, members: vec![creator], pending: Vec::new(), commits: VecDeque::new(), changed: now };
        calls.insert(channel.into(), call);
        Created::Started
    }

    /// Queues `user` for the next commit of `group`. Someone the group lists who asks to join says they
    /// no longer hold it (they restarted, or dropped it), so they are taken off the list first; a commit
    /// that adds them puts them back. None when the channel has no call, or another group than `group`:
    /// a request made for an earlier call must not touch the next one.
    /// Joining does not count as a change of the call: a dead call must not outlive its grace
    /// because someone keeps knocking.
    pub fn join(&self, channel: &str, user: &UserId, group: &str) -> Option<Joined> {
        let mut calls = self.lock();
        let call = calls.get_mut(channel).filter(|call| call.group_id == group)?;
        call.members.retain(|member| member != user);
        if call.members.is_empty() {
            let waiting = forget(&mut calls, channel, user);
            return Some(Joined::Forgotten { waiting });
        }
        if !call.pending.contains(user) {
            call.pending.push(user.clone());
        }
        Some(Joined::Queued { tell: call.members.clone() })
    }

    /// `user` no longer holds `group`, or no longer wants in: off the list and out of the queue. A leave
    /// of an earlier group (it may arrive late, after its sender came back) leaves the call as it is.
    /// None when the channel has no call.
    pub fn leave(&self, channel: &str, user: &UserId, group: &str) -> Option<Left> {
        let mut calls = self.lock();
        let call = calls.get_mut(channel)?;
        if call.group_id != group {
            return Some(Left::Stays);
        }
        call.members.retain(|member| member != user);
        call.pending.retain(|waiting| waiting != user);
        if call.members.is_empty() {
            let waiting = forget(&mut calls, channel, user);
            return Some(Left::Forgotten { waiting });
        }
        Some(Left::Stays)
    }

    /// Accepts the commit if it is for the call's group, `sender` is in it and no one was first in this epoch.
    pub fn commit(&self, channel: &str, sender: &UserId, commit: Commit, now: Instant) -> Result<Accepted, CommitError> {
        let mut calls = self.lock();
        let call = calls.get_mut(channel).filter(|call| call.group_id == commit.group).ok_or(CommitError::NoCall)?;
        if !call.members.contains(sender) || !commit.members.contains(sender) {
            return Err(CommitError::NotInCall);
        }
        if commit.epoch != call.epoch {
            return Err(CommitError::Conflict { epoch: call.epoch });
        }
        call.commits.push_back((call.epoch, commit.data));
        while call.commits.len() > KEPT_COMMITS {
            call.commits.pop_front();
        }
        call.epoch += 1;
        call.pending.retain(|user| !commit.members.contains(user));
        let before = std::mem::replace(&mut call.members, commit.members);
        call.changed = now;
        Ok(Accepted { epoch: call.epoch, before })
    }

    /// In the group or waiting to join it.
    pub fn takes_part(&self, channel: &str, user: &UserId) -> bool {
        self.lock().get(channel).is_some_and(|call| call.members.contains(user) || call.pending.contains(user))
    }

    /// The group and the commits made in epoch `since` or later.
    pub fn since(&self, channel: &str, since: u64) -> Option<Backlog> {
        let calls = self.lock();
        let call = calls.get(channel)?;
        let commits = call.commits.iter().filter(|(epoch, _)| *epoch >= since).cloned().collect();
        Some(Backlog { group_id: call.group_id.clone(), epoch: call.epoch, commits })
    }

    /// Calls whose room (`rooms`: channel → LiveKit identities) holds no one of the group and which
    /// have not changed for [`PRUNE_GRACE`]. They are forgotten; returns each with the people to
    /// tell — the group and those waiting to join.
    pub fn prune(&self, rooms: &HashMap<String, Vec<String>>, now: Instant) -> Vec<(String, String, Vec<UserId>)> {
        let mut calls = self.lock();
        let empty: Vec<String> = calls
            .iter()
            .filter(|(channel, call)| {
                let inside = rooms.get(*channel).map(Vec::as_slice).unwrap_or_default();
                let anyone = call.members.iter().any(|member| inside.contains(&member.0));
                !anyone && now.saturating_duration_since(call.changed) >= PRUNE_GRACE
            })
            .map(|(channel, _)| channel.clone())
            .collect();
        let mut forgotten: Vec<(String, String, Vec<UserId>)> = empty
            .into_iter()
            .filter_map(|channel| {
                let call = calls.remove(&channel)?;
                let mut people = call.members;
                for waiting in call.pending {
                    if !people.contains(&waiting) {
                        people.push(waiting);
                    }
                }
                Some((channel, call.group_id, people))
            })
            .collect();
        forgotten.sort_by(|a, b| a.0.cmp(&b.0));
        forgotten
    }
}

/// Removes the call of `channel`; returns who was waiting to join it, but `asking`, who gets the answer directly.
fn forget(calls: &mut HashMap<String, Call>, channel: &str, asking: &UserId) -> Vec<UserId> {
    let call = calls.remove(channel);
    call.map(|call| call.pending.into_iter().filter(|waiting| waiting != asking).collect()).unwrap_or_default()
}

fn refused() -> Response {
    error(StatusCode::FORBIDDEN, "Ты не в этом звонке")
}

fn no_call() -> Response {
    error(StatusCode::NOT_FOUND, "Звонка нет")
}

fn malformed() -> Response {
    error(StatusCode::BAD_REQUEST, "Неверный формат запроса")
}

/// Signed, a current member and allowed to connect to the channel: what every call route needs
/// before it looks at the LiveKit room. A channel that does not exist gets the same answer.
async fn admit(state: &AppState, request: Request, channel: &str, limit: usize) -> Result<(Parts, Bytes, UserId), Response> {
    let (parts, bytes, who) = signed(state, request, limit).await?;
    member_only(state, &who)?;
    if !state.roster.read(|r| r.access(&who.user, channel).is_some_and(|a| a.connect)) {
        return Err(refused());
    }
    Ok((parts, bytes, who.user))
}

/// A group id: 16 bytes in base64url, as `create` takes it and every later request names it.
fn is_group(text: &str) -> bool {
    decode_b64::<16>(text).is_some()
}

/// Non-empty base64url, the way MLS messages travel.
fn is_bytes(text: &str) -> bool {
    decode_b64_vec(text).is_some_and(|bytes| !bytes.is_empty())
}

/// Of `users`, each once, those in the journal who may connect to `channel`. The committer's lists
/// decide who is sent what, so they are held to the journal: nobody else may be pushed a call's
/// messages, nor learn the channel's id from them.
fn with_access(state: &AppState, channel: &str, users: Vec<UserId>) -> Vec<UserId> {
    let mut seen = HashSet::new();
    let users: Vec<UserId> = users.into_iter().filter(|user| seen.insert(user.clone())).collect();
    state.roster.read(|r| users.into_iter().filter(|user| r.access(user, channel).is_some_and(|a| a.connect)).collect())
}

#[derive(Deserialize)]
struct CreateBody {
    group_id: String,
}

/// `POST /api/call/{channel}/create`: the first one into a channel starts its call.
pub async fn create(State(state): State<AppState>, Path(channel): Path<String>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, &channel, CALL_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    if !in_room(&state.livekit, &channel, &user.0).await {
        return refused();
    }
    let Ok(body) = serde_json::from_slice::<CreateBody>(&bytes) else {
        return malformed();
    };
    if !is_group(&body.group_id) {
        return error(StatusCode::BAD_REQUEST, "group_id: 16 байт в base64url");
    }
    match state.calls.create(&channel, body.group_id, user, Instant::now()) {
        Created::Started => Json(serde_json::json!({ "epoch": 0 })).into_response(),
        Created::Exists { group_id, epoch } => {
            let body = serde_json::json!({ "exists": true, "group_id": group_id, "epoch": epoch });
            (StatusCode::CONFLICT, Json(body)).into_response()
        }
    }
}

#[derive(Deserialize)]
struct JoinBody {
    group_id: String,
    key_package: String,
}

/// `POST /api/call/{channel}/join`: a newcomer's key package goes to the people of the call, if `group_id` is
/// still the call's group.
pub async fn join(State(state): State<AppState>, Path(channel): Path<String>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, &channel, JOIN_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    if !in_room(&state.livekit, &channel, &user.0).await {
        return refused();
    }
    let Ok(body) = serde_json::from_slice::<JoinBody>(&bytes) else {
        return malformed();
    };
    if !is_group(&body.group_id) || !is_bytes(&body.key_package) {
        return malformed();
    }
    match state.calls.join(&channel, &user, &body.group_id) {
        None => no_call(),
        Some(Joined::Queued { tell }) => {
            for member in tell {
                let event = Event::CallJoin {
                    channel: channel.clone(),
                    group_id: body.group_id.clone(),
                    user: user.clone(),
                    key_package: body.key_package.clone(),
                };
                state.events.to_user(&member, event);
            }
            Json(serde_json::json!({})).into_response()
        }
        // Nobody holds the group any more: the joiner starts it anew, and so does everyone waiting.
        Some(Joined::Forgotten { waiting }) => {
            reset(&state, &channel, &body.group_id, waiting);
            no_call()
        }
    }
}

fn reset(state: &AppState, channel: &str, group: &str, people: Vec<UserId>) {
    for user in people {
        state.events.to_user(&user, Event::CallReset { channel: channel.to_string(), group_id: group.to_string() });
    }
}

#[derive(Deserialize)]
struct LeaveBody {
    group_id: String,
}

/// `POST /api/call/{channel}/leave`: the requester no longer holds `group_id` (left the channel, or dropped the
/// group to join anew). Not required to be in the LiveKit room: it may have dropped them already. A leave of an
/// earlier group changes nothing.
pub async fn leave(State(state): State<AppState>, Path(channel): Path<String>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, &channel, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<LeaveBody>(&bytes) else {
        return malformed();
    };
    if !is_group(&body.group_id) {
        return malformed();
    }
    match state.calls.leave(&channel, &user, &body.group_id) {
        None => no_call(),
        Some(Left::Stays) => Json(serde_json::json!({})).into_response(),
        Some(Left::Forgotten { waiting }) => {
            reset(&state, &channel, &body.group_id, waiting);
            Json(serde_json::json!({})).into_response()
        }
    }
}

#[derive(Deserialize)]
struct WelcomeBody {
    to: Vec<UserId>,
    message: String,
}

#[derive(Deserialize)]
struct CommitBody {
    group_id: String,
    epoch: u64,
    commit: String,
    members: Vec<UserId>,
    #[serde(default)]
    welcome: Option<WelcomeBody>,
}

/// `POST /api/call/{channel}/commit`: one commit per epoch of the call's group; the first to arrive wins.
pub async fn commit(State(state): State<AppState>, Path(channel): Path<String>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, &channel, CALL_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    if !in_room(&state.livekit, &channel, &user.0).await {
        return refused();
    }
    let Ok(body) = serde_json::from_slice::<CommitBody>(&bytes) else {
        return malformed();
    };
    if !is_group(&body.group_id) || !is_bytes(&body.commit) || body.welcome.as_ref().is_some_and(|w| !is_bytes(&w.message)) {
        return malformed();
    }
    if body.members.len() > state.roster.read(|r| r.members().count()) {
        return error(StatusCode::BAD_REQUEST, "Слишком много участников");
    }
    // Not required to be in the LiveKit room: whoever this commit adds may not show there yet.
    // The committer must stay in the list, or the store refuses it.
    let members = with_access(&state, &channel, body.members);
    let accepted = Commit { group: body.group_id.clone(), epoch: body.epoch, data: body.commit.clone(), members: members.clone() };
    match state.calls.commit(&channel, &user, accepted, Instant::now()) {
        Ok(Accepted { epoch, before }) => {
            // The group before and after: as in MLS, whoever the commit removed learns that it was removed,
            // and joins anew instead of keeping keys nobody uses. The committer applies its own after our 200.
            let told = with_access(&state, &channel, before.into_iter().chain(members).collect());
            for member in told.into_iter().filter(|member| *member != user) {
                let event = Event::CallCommit {
                    channel: channel.clone(),
                    group_id: body.group_id.clone(),
                    epoch: body.epoch,
                    commit: body.commit.clone(),
                };
                state.events.to_user(&member, event);
            }
            if let Some(welcome) = body.welcome {
                for addressee in with_access(&state, &channel, welcome.to) {
                    let event = Event::CallWelcome { channel: channel.clone(), welcome: welcome.message.clone() };
                    state.events.to_user(&addressee, event);
                }
            }
            Json(serde_json::json!({ "epoch": epoch })).into_response()
        }
        Err(CommitError::NoCall) => no_call(),
        Err(CommitError::NotInCall) => refused(),
        Err(CommitError::Conflict { epoch }) => {
            (StatusCode::CONFLICT, Json(serde_json::json!({ "conflict": true, "epoch": epoch }))).into_response()
        }
    }
}

#[derive(Deserialize, Default)]
struct SinceQuery {
    #[serde(default)]
    since: u64,
}

/// `GET /api/call/{channel}?since={epoch}`: the group and the commits from that epoch on, for
/// catching up after a gap in the event stream. People of the call may ask even while LiveKit is
/// reconnecting them.
pub async fn fetch(State(state): State<AppState>, Path(channel): Path<String>, request: Request) -> Response {
    let (parts, _, user) = match admit(&state, request, &channel, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    if !state.calls.takes_part(&channel, &user) && !in_room(&state.livekit, &channel, &user.0).await {
        return refused();
    }
    let since = Query::<SinceQuery>::try_from_uri(&parts.uri).map(|q| q.0).unwrap_or_default().since;
    let Some(backlog) = state.calls.since(&channel, since) else {
        return no_call();
    };
    let commits: Vec<_> = backlog.commits.iter().map(|(epoch, commit)| serde_json::json!({ "epoch": epoch, "commit": commit })).collect();
    Json(serde_json::json!({ "group_id": backlog.group_id, "epoch": backlog.epoch, "commits": commits })).into_response()
}
