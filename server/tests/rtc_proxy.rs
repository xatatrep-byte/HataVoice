mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use hatavoice_server::LiveKitConfig;
use hv_roster::{Body, ChannelDef};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

/// Fake LiveKit: echoes WebSocket messages and records the request path of each connection.
async fn fake_livekit() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let paths = Arc::new(Mutex::new(Vec::new()));
    let seen = paths.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                let callback = |req: &Request, resp: Response| {
                    seen.lock().unwrap().push(req.uri().to_string());
                    Ok(resp)
                };
                let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
                while let Some(Ok(msg)) = ws.next().await {
                    if msg.is_binary() || msg.is_text() {
                        ws.send(msg).await.unwrap();
                    }
                }
            });
        }
    });
    (addr, paths)
}

/// The server, and a member's pass for its `general` channel: the proxy only lets those through.
async fn spawn_app(internal_url: String) -> (SocketAddr, String) {
    let server = common::spawn_with(LiveKitConfig { internal_url, ..LiveKitConfig::dev() }).await;
    let pass = {
        let owner = server.client(1);
        common::claim(&server, &owner).await;
        let general = ChannelDef { id: "general".into(), name: "Общий".into(), user_limit: 0, overrides: vec![], kind: Default::default() };
        owner.act(Body::ChannelCreate(general)).await;
        let (_, token) = owner.post("/api/voice/token", &serde_json::json!({ "channel": "general" })).await;
        token["token"].as_str().unwrap().to_string()
    };
    (server.addr, pass)
}

#[tokio::test]
async fn websocket_is_proxied_both_ways_with_path_and_query() {
    let (livekit, paths) = fake_livekit().await;
    let (app, pass) = spawn_app(format!("http://{livekit}")).await;

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{app}/rtc/v1?access_token={pass}&auto_subscribe=1"))
        .await
        .unwrap();
    ws.send(Message::Binary(vec![1u8, 2, 3].into())).await.unwrap();
    let echoed = ws.next().await.unwrap().unwrap();
    assert_eq!(echoed, Message::Binary(vec![1u8, 2, 3].into()));
    ws.send(Message::Text("привет".into())).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap(), Message::Text("привет".into()));

    assert_eq!(paths.lock().unwrap().as_slice(), [format!("/rtc/v1?access_token={pass}&auto_subscribe=1")]);
}

#[tokio::test]
async fn plain_http_validate_requests_pass_through_with_status_and_body() {
    let upstream = axum::Router::new().route(
        "/rtc/validate",
        axum::routing::get(|| async { (axum::http::StatusCode::UNAUTHORIZED, "invalid token") }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let livekit = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let (app, pass) = spawn_app(format!("http://{livekit}")).await;

    let response = reqwest::get(format!("http://{app}/rtc/validate?access_token={pass}")).await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(response.text().await.unwrap(), "invalid token");
}

#[tokio::test]
async fn unreachable_livekit_gives_bad_gateway() {
    // Grab a free port and close it, so nothing listens there.
    let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let (app, pass) = spawn_app(format!("http://{free}")).await;

    let err = tokio_tungstenite::connect_async(format!("ws://{app}/rtc?access_token={pass}")).await.unwrap_err();
    match err {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 502),
        other => panic!("expected HTTP 502, got {other:?}"),
    }
}
