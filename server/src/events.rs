//! The live event stream (`GET /api/events`, a WebSocket): journal changes, profiles, presence,
//! who sits where, and the moderation addressed to a person. Replaces polling.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, Uri};
use axum::response::{IntoResponse, Response};
use hv_roster::{MediaRef, UserId};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::AppState;
use crate::auth::{authenticate_head, member_only};

const OCCUPANCY_POLL: Duration = Duration::from_secs(2);
/// How often an idle event stream is pinged.
const PING_EVERY: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Roster { seq: u64 },
    /// `user` opened their first event stream, or closed their last.
    Online { user: UserId, online: bool },
    Occupancy { channel: String, people: Vec<String> },
    Mute { user: UserId, until: Option<u64>, by: UserId, reason: String },
    Unmute { user: UserId },
    Moved { channel: String, by: UserId },
    Disconnected { by: UserId },
    Kicked { by: UserId, reason: String, media: Option<MediaRef> },
    Banned { by: UserId, until: Option<u64>, reason: String, media: Option<MediaRef> },
    /// To everyone in the punished person's voice channel.
    ModerationNotice { user: UserId, kind: String, reason: String, media: Option<MediaRef> },
    /// The next four go only to the people of one call. The bytes are opaque MLS messages
    /// (base64url) that the server passes on without looking inside; `group_id` names the call's
    /// group, so an event of an earlier call in the channel is not taken for one of the next.
    CallJoin { channel: String, group_id: String, user: UserId, key_package: String },
    /// `epoch` is the one the commit was made in (before it).
    CallCommit { channel: String, group_id: String, epoch: u64, commit: String },
    CallWelcome { channel: String, welcome: String },
    /// The server forgot the call: whoever was in it or waiting to join starts over.
    CallReset { channel: String, group_id: String },
    /// The server's group: an entry of its log (to the group; a commit also to whoever it removed), someone asking
    /// to join (to the group, with who of it is online), a welcome (to its addressee), and the owner's start over
    /// (to every member).
    /// `room` names the group when it is not the server's own (a closed channel's, direct messages').
    GroupEntry {
        group_id: String,
        entry: crate::group::Entry,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    GroupJoin {
        group_id: String,
        user: UserId,
        key_package: String,
        online: Vec<UserId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    GroupWelcome {
        group_id: String,
        epoch: u64,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    GroupReset {
        group_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    /// A signal of the group («печатает…»): passed to the members online, never kept.
    GroupSignal {
        group_id: String,
        sender: UserId,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        room: Option<String>,
    },
    /// Someone started a room of direct messages with us: our client joins it.
    RoomOpened { room: String },
}

enum Outgoing {
    Event(Event),
    Close(String),
}

struct Subscriber {
    user: UserId,
    tx: mpsc::UnboundedSender<Outgoing>,
}

#[derive(Default)]
pub struct EventHub {
    next_id: AtomicU64,
    subscribers: Mutex<HashMap<u64, Subscriber>>,
    /// The last occupancy the watcher saw: channel → LiveKit identities.
    occupancy: Mutex<HashMap<String, Vec<String>>>,
}

impl EventHub {
    /// A new stream of `user`; true when it is their first open one.
    fn subscribe(&self, user: UserId) -> (u64, mpsc::UnboundedReceiver<Outgoing>, bool) {
        let (tx, rx) = mpsc::unbounded_channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        let first = !subscribers.values().any(|s| s.user == user);
        subscribers.insert(id, Subscriber { user, tx });
        (id, rx, first)
    }

    /// Drops a subscriber; true when that was the user's last open stream.
    fn unsubscribe(&self, id: u64) -> bool {
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        let Some(gone) = subscribers.remove(&id) else { return false };
        !subscribers.values().any(|s| s.user == gone.user)
    }

    fn send_where(&self, event: &Event, wanted: impl Fn(&UserId) -> bool) {
        let subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        for sub in subscribers.values().filter(|s| wanted(&s.user)) {
            let _ = sub.tx.send(Outgoing::Event(event.clone()));
        }
    }

    pub fn broadcast(&self, event: Event) {
        self.send_where(&event, |_| true);
    }

    pub fn broadcast_filtered(&self, event: Event, wanted: impl Fn(&UserId) -> bool) {
        self.send_where(&event, wanted);
    }

    pub fn to_user(&self, user: &UserId, event: Event) {
        self.send_where(&event, |u| u == user);
    }

    /// Everyone with an event stream open now.
    pub fn online(&self) -> HashSet<UserId> {
        self.subscribers.lock().unwrap_or_else(|e| e.into_inner()).values().map(|s| s.user.clone()).collect()
    }

    /// Ends every stream of `user` (after their last event), e.g. after a kick.
    pub fn close_user(&self, user: &UserId, reason: &str) {
        let subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        for sub in subscribers.values().filter(|s| &s.user == user) {
            let _ = sub.tx.send(Outgoing::Close(reason.into()));
        }
    }
}

/// `GET /api/events`: a signed WebSocket upgrade for members.
pub async fn events(State(state): State<AppState>, method: Method, uri: Uri, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let who = match authenticate_head(&state, &method, &uri, &headers, b"") {
        Ok(who) => who,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    ws.on_upgrade(move |socket| serve(socket, state, who.user)).into_response()
}

async fn serve(mut socket: WebSocket, state: AppState, user: UserId) {
    let (id, mut rx, first) = state.events.subscribe(user.clone());
    if first {
        state.events.broadcast(Event::Online { user: user.clone(), online: true });
    }
    // Who sits where right now, so a fresh client doesn't wait for the next change.
    let snapshot = state.events.occupancy.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for (channel, people) in snapshot {
        if state.roster.read(|r| r.access(&user, &channel).is_some_and(|a| a.view)) {
            let Ok(text) = serde_json::to_string(&Event::Occupancy { channel, people }) else { continue };
            if socket.send(Message::Text(text.into())).await.is_err() {
                gone(&state, id, user);
                return;
            }
        }
    }
    // Keeps a quiet stream visibly alive: clients drop one that says nothing for a minute.
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            outgoing = rx.recv() => match outgoing {
                Some(Outgoing::Event(event)) => {
                    let Ok(text) = serde_json::to_string(&event) else { continue };
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Some(Outgoing::Close(reason)) => {
                    let frame = CloseFrame { code: 4000, reason: reason.into() };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                    break;
                }
                None => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    gone(&state, id, user);
}

/// The stream `id` of `user` is over: the others hear they went once it was their last.
fn gone(state: &AppState, id: u64, user: UserId) {
    if state.events.unsubscribe(id) {
        state.events.broadcast(Event::Online { user, online: false });
    }
}

/// Polls LiveKit and tells members about channels whose occupants changed, each only
/// about channels they may see.
pub fn spawn_occupancy_watch(state: AppState) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    tokio::spawn(async move {
        let mut last: HashMap<String, Vec<String>> = HashMap::new();
        loop {
            // The clock of this poll, not of the moment we get to pruning: enforce_rooms below can take
            // seconds, and a call made meanwhile is newer than the snapshot, which cannot show its people.
            let polled = Instant::now();
            let snapshot = crate::occupancy::snapshot(&state.livekit).await;
            let complete = snapshot.complete;
            let rooms = snapshot.rooms;
            // A punished person's client may come back with an old pass: the journal decides, not it.
            crate::moderation::enforce_rooms(&state, &rooms).await;
            let now: HashMap<String, Vec<String>> = rooms
                .into_iter()
                .map(|(room, people)| (room, people.into_iter().map(|p| p.identity).collect()))
                .collect();
            // A LiveKit that failed to answer shows rooms as empty; resetting calls on that would
            // throw everyone out of their encryption over one slow reply.
            if complete {
                for (channel, group_id, people) in state.calls.prune(&now, polled) {
                    for user in people {
                        state.events.to_user(&user, Event::CallReset { channel: channel.clone(), group_id: group_id.clone() });
                    }
                }
            }
            let rooms: Vec<&String> = now.keys().chain(last.keys()).collect();
            let mut changed: Vec<String> = rooms.into_iter().filter(|r| now.get(*r) != last.get(*r)).cloned().collect();
            changed.sort();
            changed.dedup();
            for room in changed {
                let people = now.get(&room).cloned().unwrap_or_default();
                let event = Event::Occupancy { channel: room.clone(), people };
                state.events.broadcast_filtered(event, |viewer| state.roster.read(|r| r.access(viewer, &room).is_some_and(|a| a.view)));
            }
            *state.events.occupancy.lock().unwrap_or_else(|e| e.into_inner()) = now.clone();
            last = now;
            tokio::time::sleep(OCCUPANCY_POLL).await;
        }
    });
}
