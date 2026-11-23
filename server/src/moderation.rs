//! Moderation the server enforces through LiveKit: server mutes (with a timer, kept in
//! `mutes.json`), moving and throwing people out of calls, and the consequences of journal
//! changes (kicks, bans, lost rights) for whoever is in a call right now.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use hv_roster::{Body, Permission, UserId};
use serde::{Deserialize, Serialize};

use crate::api::{MAX_BODY, signed};
use crate::audit::AuditEntry;
use crate::auth::{error, member_only, unix_now};
use crate::events::Event;
use crate::{AppState, livekit_admin};

pub const MUTES_FILE: &str = "mutes.json";
/// The durations offered in the mute dialog; `None` means until lifted.
pub const MUTE_MINUTES: [u32; 4] = [5, 15, 60, 1440];
const MAX_REASON_CHARS: usize = 200;
const EXPIRY_CHECK: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Command {
    Mute {
        user: UserId,
        minutes: Option<u32>,
        #[serde(default)]
        reason: String,
    },
    Unmute { user: UserId },
    Move { user: UserId, channel: String },
    Disconnect { user: UserId },
}

impl Command {
    fn target(&self) -> &UserId {
        match self {
            Command::Mute { user, .. } | Command::Unmute { user } | Command::Move { user, .. } | Command::Disconnect { user } => user,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Command::Mute { .. } => "mute",
            Command::Unmute { .. } => "unmute",
            Command::Move { .. } => "move",
            Command::Disconnect { .. } => "disconnect",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MuteInfo {
    pub by: UserId,
    pub at: u64,
    pub until: Option<u64>,
    pub reason: String,
}

pub struct MuteStore {
    file: Option<PathBuf>,
    mutes: RwLock<HashMap<UserId, MuteInfo>>,
}

impl MuteStore {
    pub fn open(dir: Option<&Path>) -> Self {
        let file = dir.map(|d| d.join(MUTES_FILE));
        let mutes = file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { file, mutes: RwLock::new(mutes) }
    }

    fn save(&self, mutes: &HashMap<UserId, MuteInfo>) {
        let Some(file) = &self.file else { return };
        if let Ok(json) = serde_json::to_vec_pretty(mutes) {
            let temp = file.with_extension("json.tmp");
            if std::fs::write(&temp, json).is_ok() {
                let _ = std::fs::rename(&temp, file);
            }
        }
    }

    pub fn set(&self, user: UserId, info: MuteInfo) {
        let mut mutes = self.mutes.write().unwrap_or_else(|e| e.into_inner());
        mutes.insert(user, info);
        self.save(&mutes);
    }

    pub fn remove(&self, user: &UserId) -> bool {
        let mut mutes = self.mutes.write().unwrap_or_else(|e| e.into_inner());
        let removed = mutes.remove(user).is_some();
        self.save(&mutes);
        removed
    }

    pub fn is_muted(&self, user: &UserId, now: u64) -> bool {
        self.get(user, now).is_some()
    }

    pub fn get(&self, user: &UserId, now: u64) -> Option<MuteInfo> {
        let mutes = self.mutes.read().unwrap_or_else(|e| e.into_inner());
        mutes.get(user).filter(|m| m.until.is_none_or(|until| now < until)).cloned()
    }

    /// Current mutes (ended ones are left out).
    pub fn list(&self, now: u64) -> HashMap<UserId, MuteInfo> {
        let mutes = self.mutes.read().unwrap_or_else(|e| e.into_inner());
        mutes.iter().filter(|(_, m)| m.until.is_none_or(|until| now < until)).map(|(u, m)| (u.clone(), m.clone())).collect()
    }

    /// Removes mutes whose time is up and returns who they were on.
    pub fn expire(&self, now: u64) -> Vec<UserId> {
        let mut mutes = self.mutes.write().unwrap_or_else(|e| e.into_inner());
        let ended: Vec<UserId> = mutes.iter().filter(|(_, m)| m.until.is_some_and(|u| now >= u)).map(|(u, _)| u.clone()).collect();
        for user in &ended {
            mutes.remove(user);
        }
        if !ended.is_empty() {
            self.save(&mutes);
        }
        ended
    }
}

/// Whether `user` may speak in `room` right now: the channel's rights and no server mute.
pub(crate) fn may_speak(state: &AppState, user: &UserId, room: &str) -> bool {
    let speak = state.roster.read(|r| r.access(user, room).is_some_and(|a| a.speak));
    speak && !state.mutes.is_muted(user, unix_now())
}

async fn set_speaking(state: &AppState, user: &UserId, rooms: &[String]) {
    for room in rooms {
        let allowed = may_speak(state, user, room);
        if let Err(e) = livekit_admin::update_can_publish(&state.livekit, room, &user.0, allowed).await {
            tracing::warn!("{e}");
        }
        if !allowed && let Err(e) = livekit_admin::mute_tracks(&state.livekit, room, &user.0).await {
            tracing::warn!("{e}");
        }
    }
}

async fn throw_out(state: &AppState, user: &UserId, rooms: &[String]) {
    for room in rooms {
        if let Err(e) = livekit_admin::remove_participant(&state.livekit, room, &user.0).await {
            tracing::warn!("{e}");
        }
    }
}

/// `POST /api/moderation`: a signed command, checked against rights and rank, carried out
/// through LiveKit and written to the audit log with its signature.
pub async fn moderate(State(state): State<AppState>, request: Request) -> Response {
    let auth_header = request.headers().get("authorization").and_then(|v| v.to_str().ok()).map(String::from);
    let (_, bytes, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    let Ok(command) = serde_json::from_slice::<Command>(&bytes) else {
        return error(StatusCode::BAD_REQUEST, "Неизвестная команда");
    };
    let target = command.target().clone();
    let right = match command {
        Command::Mute { .. } | Command::Unmute { .. } => Permission::MuteMembers,
        Command::Move { .. } | Command::Disconnect { .. } => Permission::MoveMembers,
    };
    let (allowed, outranks) = state.roster.read(|r| (r.permissions_of(&who.user).has(right), r.outranks(&who.user, &target)));
    if !allowed {
        return error(StatusCode::FORBIDDEN, "Нет права на это действие");
    }
    if !outranks {
        return error(StatusCode::FORBIDDEN, "Его роль не ниже твоей");
    }

    let now = unix_now();
    let rooms = livekit_admin::rooms_of(&state.livekit, &target.0).await;
    match &command {
        Command::Mute { minutes, reason, .. } => {
            if minutes.is_some_and(|m| !MUTE_MINUTES.contains(&m)) {
                return error(StatusCode::BAD_REQUEST, "Срок мута: 5 мин, 15 мин, 1 ч, 1 день или до снятия");
            }
            if reason.trim().chars().count() > MAX_REASON_CHARS {
                return error(StatusCode::BAD_REQUEST, "Причина — не длиннее 200 символов");
            }
            let until = minutes.map(|m| now + u64::from(m) * 60);
            let info = MuteInfo { by: who.user.clone(), at: now, until, reason: reason.trim().to_string() };
            state.mutes.set(target.clone(), info);
            set_speaking(&state, &target, &rooms).await;
            let event = Event::Mute { user: target.clone(), until, by: who.user.clone(), reason: reason.trim().into() };
            state.events.broadcast(event);
        }
        Command::Unmute { .. } => {
            state.mutes.remove(&target);
            set_speaking(&state, &target, &rooms).await;
            state.events.broadcast(Event::Unmute { user: target.clone() });
        }
        Command::Move { channel, .. } => {
            let access = state.roster.read(|r| {
                r.channels().iter().any(|c| &c.id == channel).then(|| r.access(&target, channel).is_some_and(|a| a.connect))
            });
            match access {
                None => return error(StatusCode::NOT_FOUND, "Такого канала нет"),
                Some(false) => return error(StatusCode::BAD_REQUEST, "У него нет доступа к этому каналу"),
                Some(true) => {}
            }
            // Only someone in a call can be moved: otherwise their client would open the mic on its own.
            if rooms.is_empty() {
                return error(StatusCode::BAD_REQUEST, "Он сейчас не в голосовом канале");
            }
            let leaving: Vec<String> = rooms.into_iter().filter(|r| r != channel).collect();
            throw_out(&state, &target, &leaving).await;
            state.events.to_user(&target, Event::Moved { channel: channel.clone(), by: who.user.clone() });
        }
        Command::Disconnect { .. } => {
            throw_out(&state, &target, &rooms).await;
            state.events.to_user(&target, Event::Disconnected { by: who.user.clone() });
        }
    }

    state.audit.record(AuditEntry {
        at: now,
        actor: who.user,
        kind: command.kind().into(),
        target: Some(target),
        detail: serde_json::to_value(&command).unwrap_or_default(),
        auth: auth_header,
        request_body: String::from_utf8(bytes.to_vec()).ok(),
        signature: None,
    });
    StatusCode::NO_CONTENT.into_response()
}

/// After a journal entry: throw out those who lost the server, re-check everyone in a call
/// when rights changed.
pub async fn enforce_after(state: &AppState, body: &Body, author: &UserId) {
    match body {
        Body::Kick { user, .. } | Body::Ban { user, .. } => {
            let rooms = livekit_admin::rooms_of(&state.livekit, &user.0).await;
            throw_out(state, user, &rooms).await;
        }
        Body::Leave => {
            let rooms = livekit_admin::rooms_of(&state.livekit, &author.0).await;
            throw_out(state, author, &rooms).await;
        }
        Body::MemberRoles { .. }
        | Body::RoleUpdate(_)
        | Body::RoleDelete { .. }
        | Body::RoleOrder { .. }
        | Body::ChannelUpdate(_)
        | Body::ChannelDelete { .. }
        | Body::OwnerTransfer { .. } => recheck_calls(state).await,
        _ => {}
    }
}

/// Everyone in a room loses what the journal no longer allows them.
async fn recheck_calls(state: &AppState) {
    for (room, people) in crate::occupancy::occupancy(&state.livekit).await {
        for person in people {
            let user = UserId(person.identity);
            let connect = state.roster.read(|r| r.access(&user, &room).is_some_and(|a| a.connect));
            if connect {
                set_speaking(state, &user, std::slice::from_ref(&room)).await;
            } else {
                throw_out(state, &user, std::slice::from_ref(&room)).await;
            }
        }
    }
}

/// Brings every room in line with the journal, whatever the clients do: someone who is no longer
/// a member, is banned or may not enter is thrown out (again); someone who may not speak but can
/// still publish loses that. Runs with every LiveKit poll.
pub async fn enforce_rooms(state: &AppState, rooms: &std::collections::HashMap<String, Vec<crate::occupancy::Occupant>>) {
    for (room, people) in rooms {
        for person in people {
            let user = UserId(person.identity.clone());
            let connect = state.roster.read(|r| r.access(&user, room).is_some_and(|a| a.connect));
            if !connect {
                throw_out(state, &user, std::slice::from_ref(room)).await;
            } else if person.permission.as_ref().is_some_and(|p| p.can_publish) && !may_speak(state, &user, room) {
                set_speaking(state, &user, std::slice::from_ref(room)).await;
            }
        }
    }
}

/// Lifts timed mutes when their time is up (every 10 seconds).
pub fn spawn_expiry(state: AppState) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(EXPIRY_CHECK).await;
            for user in state.mutes.expire(unix_now()) {
                let rooms = livekit_admin::rooms_of(&state.livekit, &user.0).await;
                set_speaking(&state, &user, &rooms).await;
                state.events.broadcast(Event::Unmute { user });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(until: Option<u64>) -> MuteInfo {
        MuteInfo { by: UserId("mod".into()), at: 100, until, reason: String::new() }
    }

    #[test]
    fn timed_mutes_end_on_their_own() {
        let store = MuteStore::open(None);
        let user = UserId("u".into());
        store.set(user.clone(), info(Some(1000)));
        assert!(store.is_muted(&user, 999));
        assert!(!store.is_muted(&user, 1000), "ended at its time even before the sweep");
        assert_eq!(store.expire(999), Vec::<UserId>::new());
        assert_eq!(store.expire(1000), vec![user.clone()]);
        assert!(store.list(0).is_empty(), "swept away");
    }

    #[test]
    fn a_mute_without_an_end_stays() {
        let store = MuteStore::open(None);
        let user = UserId("u".into());
        store.set(user.clone(), info(None));
        assert!(store.is_muted(&user, u64::MAX));
        assert!(store.expire(u64::MAX).is_empty());
        assert!(store.remove(&user));
        assert!(!store.is_muted(&user, 0));
    }

    #[test]
    fn mutes_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("hv-mutes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let user = UserId("u".into());
        MuteStore::open(Some(&dir)).set(user.clone(), info(None));
        assert!(MuteStore::open(Some(&dir)).is_muted(&user, 5));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
