//! The A1 API: hello, the signed journal, invite info, and the host's old channel list.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use hv_roster::request::hello_message;
use hv_roster::{Body, Entry, PublicKey};
use serde::Deserialize;

use crate::auth::{Authed, authenticate, error, member_only, unix_now};
use crate::events::Event;
use crate::roster_store::AppendError;
use crate::{AppState, host};

/// Limit for ordinary JSON request bodies.
pub const MAX_BODY: usize = 64 * 1024;
const MAX_NONCE_LEN: usize = 64;

/// Reads the body (up to `limit`) and checks the request signature.
pub async fn signed(state: &AppState, request: Request, limit: usize) -> Result<(Parts, Bytes, Authed), Response> {
    let (parts, body) = request.into_parts();
    // Only members send big bodies (file uploads): strangers are turned away before reading.
    if limit > MAX_BODY {
        crate::auth::precheck_member(state, &parts.headers)?;
    }
    let bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|_| error(StatusCode::PAYLOAD_TOO_LARGE, "Слишком большой запрос"))?;
    let who = authenticate(state, &parts, &bytes)?;
    Ok((parts, bytes, who))
}

#[derive(Deserialize)]
pub struct HelloQuery {
    nonce: String,
}

/// Unsigned: anyone may ask who this server is; the answer is signed with the server key.
pub async fn hello(State(state): State<AppState>, Query(query): Query<HelloQuery>) -> Response {
    if query.nonce.is_empty() || query.nonce.len() > MAX_NONCE_LEN {
        return error(StatusCode::BAD_REQUEST, "nonce: от 1 до 64 символов");
    }
    let (len, head, owner, name) = state.roster.read(|r| (r.len(), r.head(), r.owner(), r.server_name().to_string()));
    let name = if name.is_empty() {
        state.host.as_ref().map(|h| h.config.name.clone()).unwrap_or_default()
    } else {
        name
    };
    let proof = state.roster.server_identity().sign(&hello_message(&query.nonce, &head));
    Json(serde_json::json!({
        "server_key": state.roster.server_key(),
        "owner": owner,
        "name": name,
        "roster_len": len,
        "roster_head": head,
        "proof": proof,
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
struct FromQuery {
    #[serde(default)]
    from: u64,
}

pub async fn get_roster(State(state): State<AppState>, request: Request) -> Response {
    let (parts, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    let from = Query::<FromQuery>::try_from_uri(&parts.uri).map(|q| q.0).unwrap_or_default().from;
    Json(serde_json::json!({ "entries": state.roster.entries_from(from) })).into_response()
}

pub async fn post_roster(State(state): State<AppState>, request: Request) -> Response {
    let local_admin = host::is_local_admin(&request);
    let (_, bytes, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    let Ok(entry) = serde_json::from_slice::<Entry>(&bytes) else {
        return error(StatusCode::BAD_REQUEST, "Неверный формат записи");
    };
    if entry.author != who.key {
        return error(StatusCode::FORBIDDEN, "Запись подписана не тобой");
    }
    match entry.body {
        Body::Genesis { .. } if !local_admin => {
            return error(StatusCode::FORBIDDEN, "Создать журнал можно только с ПК, где работает сервер");
        }
        Body::Genesis { .. } | Body::Join { .. } => {}
        _ => {
            if let Err(response) = member_only(&state, &who) {
                return response;
            }
        }
    }
    let body = entry.body.clone();
    // Who shares a voice channel with the punished person, measured before they are thrown out.
    let neighbours = match &body {
        Body::Kick { user, .. } | Body::Ban { user, .. } => neighbours_of(&state, user).await,
        _ => Vec::new(),
    };
    match state.roster.append(entry, unix_now()) {
        Ok(seq) => {
            // Kicks, bans and lost rights take effect in calls before we answer.
            crate::moderation::enforce_after(&state, &body, &who.user).await;
            state.events.broadcast(Event::Roster { seq });
            announce_punishment(&state, &body, &who.user, &neighbours);
            // Someone who left is no member: no more events for them.
            if let Body::Leave = body {
                state.events.close_user(&who.user, "Ты покинул сервер");
            }
            Json(serde_json::json!({ "seq": seq })).into_response()
        }
        Err(AppendError::Conflict(message)) => {
            let body = serde_json::json!({ "error": message, "conflict": true });
            (StatusCode::CONFLICT, Json(body)).into_response()
        }
        Err(AppendError::Claimed) => error(StatusCode::CONFLICT, "Сервер уже принадлежит другой личности"),
        Err(AppendError::Rejected(message)) => error(StatusCode::BAD_REQUEST, &message),
        Err(AppendError::Storage(message)) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn neighbours_of(state: &AppState, user: &hv_roster::UserId) -> Vec<hv_roster::UserId> {
    crate::occupancy::occupancy(&state.livekit)
        .await
        .into_values()
        .filter(|people| people.iter().any(|p| p.identity == user.0))
        .flatten()
        .filter(|p| p.identity != user.0)
        .map(|p| hv_roster::UserId(p.identity))
        .collect()
}

/// The kicked or banned person learns who and why (then their stream ends); their channel
/// neighbours get a notice with the same reason and GIF.
fn announce_punishment(state: &AppState, body: &Body, by: &hv_roster::UserId, neighbours: &[hv_roster::UserId]) {
    let (user, event, kind, reason, media) = match body {
        Body::Kick { user, reason, media } => {
            let event = Event::Kicked { by: by.clone(), reason: reason.trim().into(), media: media.clone() };
            (user, event, "kick", reason, media)
        }
        Body::Ban { user, until, reason, media } => {
            let event = Event::Banned { by: by.clone(), until: *until, reason: reason.trim().into(), media: media.clone() };
            (user, event, "ban", reason, media)
        }
        _ => return,
    };
    state.events.to_user(user, event);
    let notice = Event::ModerationNotice { user: user.clone(), kind: kind.into(), reason: reason.trim().into(), media: media.clone() };
    state.events.broadcast_filtered(notice, |viewer| neighbours.contains(viewer));
    state.events.close_user(user, if kind == "kick" { "Тебя кикнули" } else { "Тебя забанили" });
}

#[derive(Deserialize)]
pub struct InviteQuery {
    key: String,
}

/// Unsigned: what a newcomer sees before joining — the server and who invited them.
/// Only someone holding the link can know the invite's key.
pub async fn invite_info(State(state): State<AppState>, Query(query): Query<InviteQuery>) -> Response {
    let Some(key) = hv_roster::keys::decode_b64::<32>(&query.key).map(PublicKey) else {
        return error(StatusCode::BAD_REQUEST, "Испорчен ключ приглашения");
    };
    let now = unix_now();
    let info = state.roster.read(|r| {
        let invite = r.invite(&key)?;
        let inviter = r.entries().iter().find_map(|e| match &e.body {
            Body::InviteCreate { invite, .. } if *invite == key => Some(e.author.user_id()),
            _ => None,
        })?;
        let valid = !invite.revoked
            && invite.expires_at.is_none_or(|expires| now < expires)
            && invite.max_uses.is_none_or(|max| invite.uses < max);
        let profile = r.profile().clone();
        Some(serde_json::json!({
            "server_name": profile.name,
            "description": profile.description,
            "welcome": profile.welcome,
            "icon": profile.icon,
            "inviter": inviter,
            "roles": invite.roles,
            "valid": valid,
        }))
    });
    match info {
        Some(info) => Json(info).into_response(),
        None => error(StatusCode::NOT_FOUND, "Приглашение не найдено"),
    }
}

/// Signed and members only: everything live about the server — who is online, who sits where (only channels
/// this member may see) and the server clock.
pub async fn state(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    let rooms = crate::occupancy::occupancy(&state.livekit).await;
    let occupancy: serde_json::Map<String, serde_json::Value> = state.roster.read(|r| {
        rooms
            .into_iter()
            .filter(|(room, _)| r.access(&who.user, room).is_some_and(|a| a.view))
            .map(|(room, people)| (room, people.into_iter().map(|p| p.identity).collect::<Vec<_>>().into()))
            .collect()
    });
    let mut online: Vec<String> = state.events.online().into_iter().map(|user| user.0).collect();
    online.sort();
    Json(serde_json::json!({
        "online": online,
        "occupancy": occupancy,
        "mutes": state.mutes.list(unix_now()).into_iter().map(|(u, m)| (u.0, m)).collect::<std::collections::HashMap<_, _>>(),
        "server_time": unix_now(),
        "tunnel": state.host.as_ref().and_then(|host| host.p2p_address.clone()),
    }))
    .into_response()
}

/// `PUT /api/profile`, `PUT /api/presence`: nicknames and games go through the server group now.
pub async fn gone() -> Response {
    error(StatusCode::GONE, "Обнови ХатаВойс")
}

#[derive(Deserialize)]
struct TokenBody {
    channel: String,
}

/// A LiveKit pass for one channel, with exactly the rights the journal gives this member.
pub async fn voice_token(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Some(until) = state.roster.read(|r| r.is_banned_at(&who.user, unix_now()).then(|| r.ban(&who.user).and_then(|b| b.until))) {
        let body = serde_json::json!({ "error": "Ты забанен на этом сервере", "banned": true, "until": until });
        return (StatusCode::FORBIDDEN, Json(body)).into_response();
    }
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    let Ok(body) = serde_json::from_slice::<TokenBody>(&bytes) else {
        return error(StatusCode::BAD_REQUEST, "Неверный формат запроса");
    };
    let checked = state.roster.read(|r| {
        let channel = r.channels().iter().find(|c| c.id == body.channel)?.clone();
        let access = r.access(&who.user, &body.channel)?;
        let permissions = r.permissions_of(&who.user);
        Some((channel, access, permissions.has(hv_roster::Permission::MoveMembers), permissions.has(hv_roster::Permission::Stream)))
    });
    let Some((channel, access, movers, streams)) = checked else {
        return error(StatusCode::NOT_FOUND, "Такого канала нет");
    };
    if !access.connect {
        return error(StatusCode::FORBIDDEN, "Нет доступа к каналу");
    }
    if channel.user_limit > 0 && !movers {
        let rooms = crate::occupancy::occupancy(&state.livekit).await;
        let inside = rooms.get(&channel.id).map(Vec::as_slice).unwrap_or_default();
        let already_there = inside.iter().any(|p| p.identity == who.user.0);
        if inside.len() >= channel.user_limit as usize && !already_there {
            return error(StatusCode::FORBIDDEN, &format!("Канал заполнен ({}/{})", inside.len(), channel.user_limit));
        }
    }
    let can_publish = access.speak && !state.mutes.is_muted(&who.user, unix_now());
    let request = crate::TokenRequest { room: channel.id, identity: who.user.0.clone(), can_publish, can_share_screen: streams };
    match crate::issue_token(&state.livekit, &request) {
        Ok(token) => Json(token).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}

#[derive(Deserialize, Default)]
struct AuditQuery {
    user: Option<String>,
    kind: Option<String>,
    before: Option<u64>,
}

/// Who did what to whom and when — for members with `view_audit_log`.
pub async fn audit(State(state): State<AppState>, request: Request) -> Response {
    let (parts, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if !state.roster.read(|r| r.permissions_of(&who.user).has(hv_roster::Permission::ViewAuditLog)) {
        return error(StatusCode::FORBIDDEN, "Нет права смотреть журнал действий");
    }
    let query = Query::<AuditQuery>::try_from_uri(&parts.uri).map(|q| q.0).unwrap_or_default();
    let journal = state.roster.entries_from(0);
    let entries = state.audit.query(&journal, query.user.as_deref(), query.kind.as_deref(), query.before);
    Json(serde_json::json!({ "entries": entries })).into_response()
}

/// The host's channels from before the journal, so its client can carry them over (§8).
pub async fn legacy_channels(State(state): State<AppState>, request: Request) -> Response {
    if !host::is_local_admin(&request) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let channels: Vec<_> = state
        .channels
        .list()
        .into_iter()
        .map(|c| serde_json::json!({ "id": c.id, "name": c.name }))
        .collect();
    Json(serde_json::json!({ "channels": channels })).into_response()
}
