//! Proxies LiveKit signaling (`/rtc…`) through this server's port, so friends need to reach
//! only one TCP port for signaling and LiveKit's own HTTP port stays on localhost.


use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpstreamCloseFrame;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use hv_roster::UserId;
use livekit_api::access_token::TokenVerifier;

use crate::AppState;

type Upstream = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn upstream_url(internal: &str, path_and_query: &str, websocket: bool) -> String {
    let base = internal.trim_end_matches('/');
    let base = if websocket {
        base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1)
    } else {
        base.to_string()
    };
    format!("{base}{path_and_query}")
}

fn bad_gateway(error: impl std::fmt::Display) -> Response {
    tracing::warn!("LiveKit proxy: {error}");
    (StatusCode::BAD_GATEWAY, "LiveKit недоступен").into_response()
}

/// Checks the LiveKit pass against the journal before LiveKit sees it: a pass issued before a
/// kick, a ban, a lost right to enter or a mute (one that still lets them speak) is turned away.
fn admit(state: &AppState, query: &str) -> Result<(), Response> {
    let refused = || (StatusCode::FORBIDDEN, "Этот пропуск больше не действует").into_response();
    let token = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("access_token="))
        .ok_or_else(refused)?;
    let claims = TokenVerifier::with_api_key(&state.livekit.api_key, &state.livekit.api_secret)
        .verify(token)
        .map_err(|_| refused())?;
    let (user, room) = (UserId(claims.sub.clone()), claims.video.room.clone());
    if !state.roster.read(|r| r.access(&user, &room).is_some_and(|a| a.connect)) {
        return Err(refused());
    }
    if claims.video.can_publish() && !crate::moderation::may_speak(state, &user, &room) {
        return Err(refused());
    }
    Ok(())
}

pub async fn proxy(State(state): State<AppState>, request: Request) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/rtc".into());
    if let Err(refused) = admit(&state, request.uri().query().unwrap_or("")) {
        return refused;
    }
    let livekit = state.livekit.clone();
    let is_websocket = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));

    if !is_websocket {
        return forward_http(&upstream_url(&livekit.internal_url, &path_and_query, false)).await;
    }

    let (mut parts, _body) = request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    // Connect upstream first, so a dead LiveKit is a clear 502 instead of a dropped socket.
    let upstream = match connect_async(upstream_url(&livekit.internal_url, &path_and_query, true)).await {
        Ok((upstream, _)) => upstream,
        Err(e) => return bad_gateway(e),
    };
    upgrade.on_upgrade(move |client| pump(client, upstream))
}

async fn forward_http(url: &str) -> Response {
    let response = match reqwest::get(url).await {
        Ok(response) => response,
        Err(e) => return bad_gateway(e),
    };
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).cloned();
    let body = match response.bytes().await {
        Ok(body) => body,
        Err(e) => return bad_gateway(e),
    };
    let mut out = Response::builder().status(status);
    if let Some(content_type) = content_type {
        out = out.header(header::CONTENT_TYPE, content_type.as_bytes());
    }
    out.body(Body::from(body)).unwrap_or_else(|e| bad_gateway(e))
}

async fn pump(client: WebSocket, upstream: Upstream) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let to_upstream = async {
        while let Some(Ok(message)) = client_rx.next().await {
            if upstream_tx.send(to_upstream_message(message)).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let to_client = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let Some(message) = to_client_message(message) else { continue };
            if client_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    // Either side closing ends the session for both.
    tokio::select! {
        _ = to_upstream => {}
        _ = to_client => {}
    }
}

fn to_upstream_message(message: Message) -> UpstreamMessage {
    match message {
        Message::Text(text) => UpstreamMessage::Text(text.as_str().into()),
        Message::Binary(data) => UpstreamMessage::Binary(data),
        Message::Ping(data) => UpstreamMessage::Ping(data),
        Message::Pong(data) => UpstreamMessage::Pong(data),
        Message::Close(frame) => UpstreamMessage::Close(frame.map(|f| UpstreamCloseFrame {
            code: f.code.into(),
            reason: f.reason.as_str().into(),
        })),
    }
}

fn to_client_message(message: UpstreamMessage) -> Option<Message> {
    Some(match message {
        UpstreamMessage::Text(text) => Message::Text(text.as_str().into()),
        UpstreamMessage::Binary(data) => Message::Binary(data),
        UpstreamMessage::Ping(data) => Message::Ping(data),
        UpstreamMessage::Pong(data) => Message::Pong(data),
        UpstreamMessage::Close(frame) => Message::Close(frame.map(|f| CloseFrame {
            code: f.code.into(),
            reason: f.reason.as_str().into(),
        })),
        UpstreamMessage::Frame(_) => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_url_switches_scheme_only_for_websockets() {
        assert_eq!(upstream_url("http://127.0.0.1:7880/", "/rtc?t=1", true), "ws://127.0.0.1:7880/rtc?t=1");
        assert_eq!(upstream_url("https://lk.example", "/rtc/v1", true), "wss://lk.example/rtc/v1");
        assert_eq!(
            upstream_url("http://127.0.0.1:7880", "/rtc/validate?t=1", false),
            "http://127.0.0.1:7880/rtc/validate?t=1"
        );
    }
}
