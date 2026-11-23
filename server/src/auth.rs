//! Checks the `Authorization: HV1 …` signature of a request and who is asking.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use hv_roster::request::{AuthError, parse_auth_header, request_message};
use hv_roster::{PublicKey, UserId};

use crate::AppState;

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Who signed the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authed {
    pub key: PublicKey,
    pub user: UserId,
}

pub fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn unauthorized(body: serde_json::Value) -> Response {
    (StatusCode::UNAUTHORIZED, Json(body)).into_response()
}

/// Verifies the request signature over its method, path, `body` and this server's key.
pub fn authenticate(state: &AppState, parts: &Parts, body: &[u8]) -> Result<Authed, Response> {
    authenticate_head(state, &parts.method, &parts.uri, &parts.headers, body)
}

/// `authenticate` for handlers that only have the request head (WebSocket upgrades).
pub fn authenticate_head(state: &AppState, method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> Result<Authed, Response> {
    let header = headers.get("authorization").and_then(|v| v.to_str().ok());
    let Some(auth) = header.and_then(|h| parse_auth_header(h).ok()) else {
        return Err(unauthorized(serde_json::json!({ "error": "Обнови ХатаВойс: этот сервер требует новую версию" })));
    };
    let path = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let message = request_message(&state.roster.server_key(), method.as_str(), path, auth.at, &auth.nonce, body);
    let verdict = state.nonces.lock().unwrap_or_else(|e| e.into_inner()).verify(&auth, &message, unix_now());
    match verdict {
        Ok(()) => Ok(Authed { key: auth.user, user: auth.user.user_id() }),
        Err(AuthError::ClockSkew { server_now }) => Err(unauthorized(serde_json::json!({
            "error": "Часы на этом ПК расходятся с сервером",
            "clock_skew": true,
            "server_time": server_now,
        }))),
        Err(AuthError::Replayed) => Err(unauthorized(serde_json::json!({ "error": "Этот запрос уже был отправлен" }))),
        Err(AuthError::BadSignature | AuthError::Malformed) => {
            Err(unauthorized(serde_json::json!({ "error": "Неверная подпись запроса" })))
        }
    }
}

/// Before a large body is read: the header must parse, its time must be near ours and it must
/// name a member. A stranger can't make the server take in megabytes; the signature itself is
/// checked once the body is there.
pub fn precheck_member(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let header = headers.get("authorization").and_then(|v| v.to_str().ok());
    let Some(auth) = header.and_then(|h| parse_auth_header(h).ok()) else {
        return Err(unauthorized(serde_json::json!({ "error": "Обнови ХатаВойс: этот сервер требует новую версию" })));
    };
    let now = unix_now();
    if auth.at.abs_diff(now) > hv_roster::request::MAX_SKEW_SECS {
        return Err(unauthorized(serde_json::json!({
            "error": "Часы на этом ПК расходятся с сервером",
            "clock_skew": true,
            "server_time": now,
        })));
    }
    member_only(state, &Authed { key: auth.user, user: auth.user.user_id() })
}

/// The signer must be a current member; strangers learn they need an invite.
pub fn member_only(state: &AppState, who: &Authed) -> Result<(), Response> {
    let (claimed, member) = state.roster.read(|r| (!r.is_empty(), r.member(&who.user).is_some()));
    if !claimed {
        let body = serde_json::json!({ "error": "Сервер ещё не настроен владельцем", "unclaimed": true });
        return Err((StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response());
    }
    if !member {
        let body = serde_json::json!({
            "error": "Ты не участник этого сервера — нужна ссылка-приглашение",
            "join_needed": true,
        });
        return Err((StatusCode::FORBIDDEN, Json(body)).into_response());
    }
    Ok(())
}
