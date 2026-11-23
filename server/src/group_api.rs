//! The routes of the server's group (`/api/group/…`): a member asks in, commits, sends messages and catches up. The
//! server checks who may take part by the journal and passes on ciphertext it cannot read.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use hv_roster::UserId;
use hv_roster::keys::{decode_b64, decode_b64_vec};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::api::{MAX_BODY, signed};
use crate::auth::{error, member_only, unix_now};
use crate::events::Event;
use crate::group::{Accepted, GroupCommit, GroupError, GroupStore};
use crate::rooms::Room;

/// A KeyPackage is a few KB.
pub const JOIN_BODY: usize = 16 * 1024;
/// Commits and welcomes grow with the group.
pub const COMMIT_BODY: usize = 256 * 1024;
/// A signal is small: «печатает…» and the like.
pub const SIGNAL_BODY: usize = 2 * 1024;
/// Signals one person may send in [`SIGNAL_WINDOW`]; more are dropped without a word. A burst of a few goes
/// through («hello», a game and «typing» at once), a flood does not.
pub const SIGNAL_BURST: usize = 5;
pub const SIGNAL_WINDOW: Duration = Duration::from_secs(5);
/// One page of the log.
pub const PAGE: usize = 500;
/// Messages one person may send in [`RATE_WINDOW`].
pub const RATE_LIMIT: usize = 30;
pub const RATE_WINDOW: Duration = Duration::from_secs(10);

/// How many requests of one kind each person made lately: at most `limit` in `window`.
pub struct RateLimit {
    limit: usize,
    window: Duration,
    sent: Mutex<HashMap<UserId, VecDeque<Instant>>>,
}

/// Messages: [`RATE_LIMIT`] in [`RATE_WINDOW`].
impl Default for RateLimit {
    fn default() -> Self {
        Self::per(RATE_LIMIT, RATE_WINDOW)
    }
}

impl RateLimit {
    pub fn per(limit: usize, window: Duration) -> Self {
        Self { limit, window, sent: Mutex::default() }
    }

    /// Counts one more from `user`, unless they already made `limit` in the window.
    pub fn allow(&self, user: &UserId, now: Instant) -> bool {
        let mut sent = self.sent.lock().unwrap_or_else(|e| e.into_inner());
        let times = sent.entry(user.clone()).or_default();
        while times.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            times.pop_front();
        }
        if times.len() >= self.limit {
            return false;
        }
        times.push_back(now);
        true
    }
}

fn no_group() -> Response {
    error(StatusCode::NOT_FOUND, "Группы нет")
}

fn not_member() -> Response {
    error(StatusCode::FORBIDDEN, "Ты не в группе сервера")
}

fn malformed() -> Response {
    error(StatusCode::BAD_REQUEST, "Неверный формат запроса")
}

fn conflict(epoch: u64) -> Response {
    (StatusCode::CONFLICT, Json(json!({ "conflict": true, "epoch": epoch }))).into_response()
}

fn refusal(error: GroupError) -> Response {
    match error {
        GroupError::NoGroup => no_group(),
        GroupError::NotMember => not_member(),
        GroupError::Conflict { epoch } => conflict(epoch),
    }
}

fn is_group(text: &str) -> bool {
    decode_b64::<16>(text).is_some()
}

/// Non-empty base64url, the way MLS messages travel.
fn is_bytes(text: &str) -> bool {
    decode_b64_vec(text).is_some_and(|bytes| !bytes.is_empty())
}

/// Signed by a member of the journal.
async fn admit(state: &AppState, request: Request, limit: usize) -> Result<(Parts, Bytes, UserId), Response> {
    let (parts, bytes, who) = signed(state, request, limit).await?;
    member_only(state, &who)?;
    Ok((parts, bytes, who.user))
}

/// Of `users`, each once, those the journal has as members.
fn journal_members(state: &AppState, users: Vec<UserId>) -> Vec<UserId> {
    let mut seen = HashSet::new();
    let users: Vec<UserId> = users.into_iter().filter(|user| seen.insert(user.clone())).collect();
    state.roster.read(|r| users.into_iter().filter(|user| r.member(user).is_some()).collect())
}

/// The room a request names, if the journal lets `user` in now; and its store.
fn enter(state: &AppState, name: Option<&str>, user: &UserId) -> Result<(Room, std::sync::Arc<GroupStore>), Response> {
    let room = Room::parse(name).ok_or_else(malformed)?;
    if !state.roster.read(|r| room.may_enter(r, user, unix_now())) {
        return Err(error(StatusCode::FORBIDDEN, "Нет доступа к этой комнате"));
    }
    let store = state.rooms.store(&room);
    Ok((room, store))
}

/// Of `users`, each once, those the journal lets into `room` now.
fn room_members(state: &AppState, room: &Room, users: Vec<UserId>) -> Vec<UserId> {
    let now = unix_now();
    let users = journal_members(state, users);
    state.roster.read(|r| users.into_iter().filter(|user| room.may_enter(r, user, now)).collect())
}

/// The group's members who have an event stream open now.
fn online(state: &AppState, members: &[UserId]) -> Vec<UserId> {
    let connected = state.events.online();
    members.iter().filter(|member| connected.contains(member)).cloned().collect()
}

#[derive(Deserialize)]
struct GroupIdBody {
    group_id: String,
    #[serde(default)]
    room: Option<String>,
}

/// `POST /api/group/create`: the first one starts the server's group.
pub async fn create(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<GroupIdBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) {
        return error(StatusCode::BAD_REQUEST, "group_id: 16 байт в base64url");
    }
    let (room, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    match store.create(body.group_id, user.clone()) {
        Ok(()) => {
            // The other one of direct messages hears of the room and comes in.
            if let Some(peer) = room.peer(&user) {
                state.events.to_user(peer, Event::RoomOpened { room: room.name() });
            }
            Json(json!({ "epoch": 0 })).into_response()
        }
        Err(exists) => {
            let body = json!({ "exists": true, "group_id": exists.group_id, "epoch": exists.epoch });
            (StatusCode::CONFLICT, Json(body)).into_response()
        }
    }
}

#[derive(Deserialize)]
struct JoinBody {
    group_id: String,
    key_package: String,
    #[serde(default)]
    room: Option<String>,
}

/// `POST /api/group/join`: a KeyPackage for the members to add.
pub async fn join(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, JOIN_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<JoinBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) || !is_bytes(&body.key_package) {
        return malformed();
    }
    let (room, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    let Some(members) = store.join(&body.group_id, &user, body.key_package.clone()) else { return no_group() };
    let online = online(&state, &members);
    for member in room_members(&state, &room, members) {
        let event = Event::GroupJoin {
            group_id: body.group_id.clone(),
            user: user.clone(),
            key_package: body.key_package.clone(),
            online: online.clone(),
            room: room.tag(),
        };
        state.events.to_user(&member, event);
    }
    Json(json!({})).into_response()
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
    /// SHA-256 (hex) of each KeyPackage the commit adds.
    #[serde(default)]
    added: Vec<String>,
    #[serde(default)]
    room: Option<String>,
}

/// `POST /api/group/commit`: one commit per epoch; the first to arrive wins.
pub async fn commit(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, COMMIT_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<CommitBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) || !is_bytes(&body.commit) || body.welcome.as_ref().is_some_and(|w| !is_bytes(&w.message)) {
        return malformed();
    }
    if body.members.len() > state.roster.read(|r| r.members().count()) {
        return error(StatusCode::BAD_REQUEST, "Слишком много участников");
    }
    let (room, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    let members = room_members(&state, &room, body.members);
    let welcome = body.welcome.map(|w| (room_members(&state, &room, w.to), w.message));
    if body.added.len() > members.len() || body.added.iter().any(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())) {
        return malformed();
    }
    let commit = GroupCommit {
        group_id: body.group_id.clone(),
        epoch: body.epoch,
        data: body.commit,
        members: members.clone(),
        welcome: welcome.clone(),
        added: body.added,
    };
    let Accepted { epoch, seq, before, entry } = match store.commit(commit, &user, unix_now()) {
        Ok(accepted) => accepted,
        Err(refused) => return refusal(refused),
    };
    // The group before and after: whoever the commit removed learns that it was removed (even one who may no longer
    // enter the room).
    let told = journal_members(&state, before.into_iter().chain(members).collect());
    for member in told.into_iter().filter(|member| *member != user) {
        state.events.to_user(&member, Event::GroupEntry { group_id: body.group_id.clone(), entry: entry.clone(), room: room.tag() });
    }
    if let Some((to, message)) = welcome {
        for addressee in to {
            let event = Event::GroupWelcome { group_id: body.group_id.clone(), epoch, message: message.clone(), room: room.tag() };
            state.events.to_user(&addressee, event);
        }
    }
    Json(json!({ "epoch": epoch, "seq": seq })).into_response()
}

#[derive(Deserialize)]
struct MessageBody {
    group_id: String,
    epoch: u64,
    message: String,
    #[serde(default)]
    room: Option<String>,
}

/// `POST /api/group/message`: a message of the current epoch, for the group.
pub async fn message(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<MessageBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) || !is_bytes(&body.message) {
        return malformed();
    }
    let (room, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    if !state.group_rate.allow(&user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много сообщений — подожди немного");
    }
    let (entry, members) = match store.message(&body.group_id, &user, body.epoch, body.message, unix_now()) {
        Ok(sent) => sent,
        Err(refused) => return refusal(refused),
    };
    let (seq, at) = (entry.seq, entry.at);
    for member in room_members(&state, &room, members).into_iter().filter(|member| *member != user) {
        state.events.to_user(&member, Event::GroupEntry { group_id: body.group_id.clone(), entry: entry.clone(), room: room.tag() });
    }
    Json(json!({ "seq": seq, "at": at })).into_response()
}

/// `POST /api/group/withdraw`: the sender's request to join is taken back (one left from an earlier run while they
/// are in the group by now).
pub async fn withdraw(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<GroupIdBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) {
        return malformed();
    }
    let (_, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    if !store.withdraw(&body.group_id, &user) {
        return no_group();
    }
    Json(json!({})).into_response()
}

/// `POST /api/group/signal`: passed to the group's members online, not kept, at most [`SIGNAL_BURST`] in
/// [`SIGNAL_WINDOW`] from a person.
pub async fn signal(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, SIGNAL_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<MessageBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) || !is_bytes(&body.message) {
        return malformed();
    }
    let (room, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    let members = match store.signal(&body.group_id, &user, body.epoch) {
        Ok(members) => members,
        Err(refused) => return refusal(refused),
    };
    if state.signal_rate.allow(&user, Instant::now()) {
        for member in room_members(&state, &room, members).into_iter().filter(|member| *member != user) {
            let event = Event::GroupSignal { group_id: body.group_id.clone(), sender: user.clone(), message: body.message.clone(), room: room.tag() };
            state.events.to_user(&member, event);
        }
    }
    Json(json!({})).into_response()
}

#[derive(Deserialize, Default)]
struct SinceQuery {
    #[serde(default)]
    since: u64,
    #[serde(default)]
    room: Option<String>,
}

/// `GET /api/group?since=N`: the log after `N` (a page at a time), who asks to join, and our welcome.
pub async fn fetch(State(state): State<AppState>, request: Request) -> Response {
    let (parts, _, user) = match admit(&state, request, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let query = Query::<SinceQuery>::try_from_uri(&parts.uri).map(|q| q.0).unwrap_or_default();
    let (_, store) = match enter(&state, query.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    let Some(backlog) = store.since(&user, query.since, PAGE, unix_now()) else { return no_group() };
    let pending: Vec<_> = backlog.pending.iter().map(|(user, key_package)| json!({ "user": user, "key_package": key_package })).collect();
    let welcome = backlog.welcome.map(|(epoch, message)| json!({ "epoch": epoch, "message": message }));
    Json(json!({
        "group_id": backlog.group_id,
        "epoch": backlog.epoch,
        "online": online(&state, &backlog.members),
        "members": backlog.members,
        "entries": backlog.entries,
        "more": backlog.more,
        "pending": pending,
        "welcome": welcome,
    }))
    .into_response()
}

/// `POST /api/group/reset`: the owner starts the group over, when nobody holds its keys any more.
pub async fn reset(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, user) = match admit(&state, request, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<GroupIdBody>(&bytes) else { return malformed() };
    if !is_group(&body.group_id) {
        return malformed();
    }
    let (room, store) = match enter(&state, body.room.as_deref(), &user) {
        Ok(entered) => entered,
        Err(response) => return response,
    };
    // The server's group and a closed channel's: the owner; direct messages: either of the two.
    let owner = state.roster.read(|r| r.owner().map(|owner| owner.user_id())) == Some(user.clone());
    if !owner && !matches!(room, Room::Dm(..)) {
        return error(StatusCode::FORBIDDEN, "Пересоздать группу может только владелец");
    }
    store.reset(body.group_id.clone(), user);
    let event = Event::GroupReset { group_id: body.group_id, room: room.tag() };
    let roster = state.roster.clone();
    state.events.broadcast_filtered(event, move |member| roster.read(|r| room.may_enter(r, member, unix_now())));
    Json(json!({})).into_response()
}

/// `GET /api/rooms`: the rooms of direct messages we are in, so a client that was away finds them.
pub async fn rooms(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, user) = match admit(&state, request, MAX_BODY).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let now = unix_now();
    let rooms: Vec<String> = state
        .rooms
        .dms_of(&user)
        .into_iter()
        .filter(|room| state.roster.read(|r| room.may_enter(r, &user, now)))
        .map(|room| room.name())
        .collect();
    Json(json!({ "rooms": rooms })).into_response()
}

/// Prunes old messages now and then once a day.
pub fn spawn_prune(state: AppState) {
    tokio::spawn(async move {
        loop {
            state.rooms.prune(unix_now());
            tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        }
    });
}
