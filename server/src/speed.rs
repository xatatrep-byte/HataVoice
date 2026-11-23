//! «Проверка скорости» to this server: a member measures the way here both ways, through the same pinned, signed
//! channel the program uses for everything else. Nothing of the test is kept; the bytes are of no meaning.

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::api::{MAX_BODY, signed};
use crate::auth::{error, member_only};
use crate::group_api::RateLimit;

/// The biggest piece one test moves either way.
pub const MAX_TEST_BYTES: usize = 32 * 1024 * 1024;
/// Pieces one member may move a minute (a test is a few): this PC's line is its owner's.
pub const TESTS_PER_MINUTE: usize = 12;

pub fn test_limit() -> RateLimit {
    RateLimit::per(TESTS_PER_MINUTE, Duration::from_secs(60))
}

#[derive(Deserialize)]
pub struct DownQuery {
    bytes: usize,
}

/// Bytes no link can squeeze (a run of zeros would be measured as a much faster line than it is).
fn noise(len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15 ^ len as u64;
    for chunk in out.chunks_mut(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let bytes = x.to_le_bytes();
        chunk.copy_from_slice(&bytes[..chunk.len()]);
    }
    out
}

/// `GET /api/speed/ping` (members only): an empty answer, its time is the measure.
pub async fn ping(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(json!({}))).into_response()
}

/// `GET /api/speed/down?bytes=N` (members only): N bytes for the download half of the test.
pub async fn down(State(state): State<AppState>, Query(query): Query<DownQuery>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if query.bytes == 0 || query.bytes > MAX_TEST_BYTES {
        return error(StatusCode::BAD_REQUEST, "Слишком большой кусок для проверки");
    }
    if !state.speed_rate.allow(&who.user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много проверок — подожди минуту");
    }
    ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], noise(query.bytes)).into_response()
}

/// `POST /api/speed/up` (members only): takes the upload half of the test and says how much came.
pub async fn up(State(state): State<AppState>, request: Request) -> Response {
    let (_, bytes, who) = match signed(&state, request, MAX_TEST_BYTES).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if !state.speed_rate.allow(&who.user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много проверок — подожди минуту");
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "bytes": bytes.len() }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_noise_is_as_long_as_asked_and_not_a_run_of_one_byte() {
        let bytes = noise(1001);
        assert_eq!(bytes.len(), 1001);
        assert!(bytes.iter().any(|&b| b != bytes[0]));
    }
}
