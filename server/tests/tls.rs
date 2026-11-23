mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use common::{id, now};
use futures_util::StreamExt;
use hatavoice_server::channels::ChannelStore;
use hatavoice_server::host::HostRuntime;
use hatavoice_server::network::NetworkReport;
use hatavoice_server::roster_store::RosterStore;
use hatavoice_server::supervisor::LiveKitState;
use hatavoice_server::tls::{self, OUTDATED_CLIENT};
use hatavoice_server::{LiveKitConfig, host_app};
use hv_host::HostConfig;
use hv_roster::request::sign_request;
use hv_roster::{Body, PublicKey, Roster, sign_entry};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

struct TlsServer {
    addr: SocketAddr,
    server_key: PublicKey,
    store: Arc<RosterStore>,
    /// The key the server presented to `client`.
    seen: Arc<Mutex<Option<PublicKey>>>,
    client: reqwest::Client,
    stop: Arc<tokio::sync::Notify>,
    serving: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn spawn(host: Option<HostRuntime>) -> TlsServer {
    let store = Arc::new(RosterStore::open(None).unwrap());
    let channels = Arc::new(ChannelStore::open(None).unwrap());
    let app = host_app(LiveKitConfig::dev(), host.map(Arc::new), channels, store.clone());
    let config = Arc::new(hv_tls::server_config(store.server_identity()).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(tokio::sync::Notify::new());
    let serving = tokio::spawn({
        let stop = stop.clone();
        tls::serve(listener, app, config, async move { stop.notified().await })
    });
    let server_key = store.server_key();
    let seen = Arc::new(Mutex::new(None));
    let client = reqwest::Client::builder()
        .tls_backend_preconfigured(hv_tls::client_config(Some(server_key), seen.clone()))
        .build()
        .unwrap();
    TlsServer { addr, server_key, store, seen, client, stop, serving }
}

#[tokio::test]
async fn health_answers_over_tls_with_the_pinned_key() {
    let server = spawn(None).await;

    let response = server.client.get(format!("https://{}/health", server.addr)).send().await.unwrap();

    assert_eq!(response.status(), 200);
    let json: Value = response.json().await.unwrap();
    assert_eq!(json["status"], "ok");
    // The check really ran: the issuer the server showed is the server key.
    assert_eq!(*server.seen.lock().unwrap(), Some(server.server_key));
}

#[tokio::test]
async fn plain_http_gets_426_with_a_russian_message() {
    let server = spawn(None).await;

    let response = reqwest::get(format!("http://{}/health", server.addr)).await.unwrap();

    assert_eq!(response.status(), 426);
    assert_eq!(response.headers()["content-type"], "application/json");
    let length: usize = response.headers()["content-length"].to_str().unwrap().parse().unwrap();
    let bytes = response.bytes().await.unwrap();
    // The text is multi-byte UTF-8: a length counted in characters would cut the answer short.
    assert_eq!(length, bytes.len());
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["error"], OUTDATED_CLIENT);
    assert_eq!(OUTDATED_CLIENT, "На сервере новая версия ХатаВойс — обнови программу");
}

#[tokio::test]
async fn plain_http_connection_is_closed_after_the_answer() {
    let server = spawn(None).await;

    let mut tcp = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    tcp.write_all(b"POST /api/voice/token HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nbody").await.unwrap();
    let mut answer = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut answer))
        .await
        .expect("the connection stayed open")
        .expect("the answer was cut short by a reset");

    let answer = String::from_utf8(answer).unwrap();
    assert!(answer.starts_with("HTTP/1.1 426 Upgrade Required\r\n"), "{answer}");
    assert!(answer.ends_with(&format!("{{\"error\":\"{OUTDATED_CLIENT}\"}}")), "{answer}");
}

#[tokio::test]
async fn event_stream_upgrades_over_tls() {
    let server = spawn(None).await;
    let owner = id(1);
    let genesis = Body::Genesis { server_name: "Хата".into(), owner: owner.public(), server_key: server.server_key };
    server.store.append(sign_entry(&Roster::new(), &owner, now(), genesis), now()).unwrap();

    let mut request = format!("wss://{}/api/events", server.addr).into_client_request().unwrap();
    let header = sign_request(&owner, &server.server_key, "GET", "/api/events", b"", now()).unwrap();
    request.headers_mut().insert("authorization", header.parse().unwrap());
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(hv_tls::client_config(Some(server.server_key), Default::default())));
    let (mut stream, response) = tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector)).await.unwrap();
    assert_eq!(response.status(), 101);

    // Traffic flows through the upgraded connection, not just the handshake: our own «online» comes back.
    let event = loop {
        let message = tokio::time::timeout(Duration::from_secs(5), stream.next()).await.expect("no event in time");
        if let Some(Ok(Message::Text(text))) = message {
            let event: Value = serde_json::from_str(&text).unwrap();
            if event["type"] == "online" {
                break event;
            }
        }
    };
    assert_eq!((event["user"].as_str(), event["online"].as_bool()), (Some(owner.public().user_id().0.as_str()), Some(true)));
}

#[tokio::test]
async fn host_endpoints_still_see_the_peer_address() {
    let config = HostConfig { name: "Хата".into(), upnp: false, ..Default::default() };
    let host = HostRuntime {
        network: Arc::new(RwLock::new(NetworkReport::new(&config))),
        config,
        livekit: Arc::new(RwLock::new(LiveKitState::Running)),
        p2p_address: None,
        shutdown: Default::default(),
    };
    let server = spawn(Some(host)).await;

    let response = server.client.get(format!("https://{}/api/host/status", server.addr)).send().await.unwrap();

    // Without ConnectInfo the loopback check has no peer to look at and answers 403.
    assert_eq!(response.status(), 200);
    let json: Value = response.json().await.unwrap();
    assert_eq!(json["name"], "Хата");
}

/// Whoever comes through the P2P tunnel arrives from loopback, and is far away: never this PC's owner.
#[tokio::test]
async fn the_tunnel_is_not_this_pc() {
    let config = HostConfig { upnp: false, ..Default::default() };
    let host = HostRuntime {
        network: Arc::new(RwLock::new(NetworkReport::new(&config))),
        config,
        livekit: Arc::new(RwLock::new(LiveKitState::Running)),
        p2p_address: None,
        shutdown: Default::default(),
    };
    let store = Arc::new(RosterStore::open(None).unwrap());
    let channels = Arc::new(ChannelStore::open(None).unwrap());
    let app = host_app(LiveKitConfig::dev(), Some(Arc::new(host)), channels, store.clone());
    let config = Arc::new(hv_tls::server_config(store.server_identity()).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(tokio::sync::Notify::new());
    let serving = tokio::spawn({
        let stop = stop.clone();
        tls::serve_tunnel(listener, app, config, async move { stop.notified().await })
    });
    let client = reqwest::Client::builder()
        .tls_backend_preconfigured(hv_tls::client_config(Some(store.server_key()), Arc::new(Mutex::new(None))))
        .build()
        .unwrap();

    // The room itself answers as for anyone, and what only the owner may see does not.
    assert_eq!(client.get(format!("https://{addr}/health")).send().await.unwrap().status(), 200);
    assert_eq!(client.get(format!("https://{addr}/api/host/status")).send().await.unwrap().status(), 403);
    assert_eq!(client.get(format!("https://localhost:{}/api/host/status", addr.port())).send().await.unwrap().status(), 403);

    stop.notify_one();
    let _ = serving.await;
}

#[tokio::test]
async fn shutdown_closes_idle_connections_and_stops_accepting() {
    let server = spawn(None).await;
    let url = format!("https://{}/health", server.addr);
    // The client keeps this connection alive, idle, after the answer.
    assert_eq!(server.client.get(&url).send().await.unwrap().status(), 200);

    server.stop.notify_one();

    let served = tokio::time::timeout(Duration::from_secs(5), server.serving).await.expect("serve did not return").unwrap();
    assert!(served.is_ok());
    assert!(tokio::net::TcpStream::connect(server.addr).await.is_err());
}

/// `app` behind the TLS front door with `limits`, its certificate issued by key 100.
struct Limited {
    addr: SocketAddr,
    server_key: PublicKey,
    stop: Arc<tokio::sync::Notify>,
    serving: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn spawn_limited(app: axum::Router, limits: tls::Limits) -> Limited {
    let server = id(100);
    let config = Arc::new(hv_tls::server_config(&server).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(tokio::sync::Notify::new());
    let serving = tokio::spawn({
        let stop = stop.clone();
        tls::serve_with(listener, app, config, async move { stop.notified().await }, limits)
    });
    Limited { addr, server_key: server.public(), stop, serving }
}

fn small_app() -> axum::Router {
    use axum::extract::ws::WebSocketUpgrade;
    use axum::routing::{get, post};
    let echo = get(|upgrade: WebSocketUpgrade| async move {
        upgrade.on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                if socket.send(message).await.is_err() {
                    break;
                }
            }
        })
    });
    axum::Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/upload", post(|body: axum::body::Bytes| async move { body.len().to_string() }))
        .route("/ws", echo)
}

/// A TLS connection made the way the app makes one, with nothing sent over it yet.
async fn tls_connect(server: &Limited) -> std::io::Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let config = Arc::new(hv_tls::client_config(Some(server.server_key), Default::default()));
    let tcp = tokio::net::TcpStream::connect(server.addr).await?;
    let name = rustls::pki_types::ServerName::try_from("hatavoice.invalid").unwrap();
    tokio_rustls::TlsConnector::from(config).connect(name, tcp).await
}

/// Reads until the server closes the connection; panics if it is still open after `wait`. Returns what came.
async fn until_closed(stream: &mut (impl tokio::io::AsyncRead + Unpin), wait: Duration) -> Vec<u8> {
    let mut seen = Vec::new();
    let mut buf = [0u8; 4096];
    tokio::time::timeout(wait, async {
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => seen.extend_from_slice(&buf[..n]),
            }
        }
    })
    .await
    .expect("the server kept the connection open");
    seen
}

fn short(header_read: Duration, idle: Duration) -> tls::Limits {
    tls::Limits { header_read, idle, ..tls::Limits::default() }
}

#[test]
fn the_limits_are_the_ruled_ones() {
    let limits = tls::Limits::default();
    assert_eq!(limits.header_read, Duration::from_secs(30));
    assert_eq!(limits.idle, Duration::from_secs(60));
    assert_eq!(limits.request, Duration::from_secs(300));
    assert_eq!(limits.connections, 256);
    assert_eq!(limits.per_peer, 32);
    assert_eq!(limits.shutdown, Duration::from_secs(5));
}

/// [`tls_connect`] from another loopback address, as a second person would come from their own.
async fn tls_connect_from(server: &Limited, local: &str) -> std::io::Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let config = Arc::new(hv_tls::client_config(Some(server.server_key), Default::default()));
    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.bind(format!("{local}:0").parse().unwrap())?;
    let tcp = socket.connect(server.addr).await?;
    let name = rustls::pki_types::ServerName::try_from("hatavoice.invalid").unwrap();
    tokio_rustls::TlsConnector::from(config).connect(name, tcp).await
}

/// Sends `GET /health` over a kept-alive connection and waits for its whole answer.
async fn health_over(stream: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin)) {
    stream.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    let mut seen = Vec::new();
    let mut buf = [0u8; 1024];
    tokio::time::timeout(Duration::from_secs(5), async {
        while !seen.ends_with(b"\r\n\r\nok") {
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "closed instead of answering: {}", String::from_utf8_lossy(&seen));
            seen.extend_from_slice(&buf[..n]);
        }
    })
    .await
    .expect("no answer in time");
}

#[tokio::test]
async fn one_address_cannot_take_every_connection() {
    let limits = tls::Limits { connections: 10, per_peer: 2, ..tls::Limits::default() };
    let server = spawn_limited(small_app(), limits).await;
    let first = tls_connect(&server).await.unwrap();
    let _second = tls_connect(&server).await.unwrap();
    assert!(tls_connect(&server).await.is_err(), "a third connection from one address got through");

    // Somebody else still gets in...
    let mut other = tls_connect_from(&server, "127.0.0.2").await.unwrap();
    health_over(&mut other).await;

    // ...and so does the first address once one of its connections has gone.
    drop(first);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut again = tls_connect(&server).await.unwrap();
    health_over(&mut again).await;
}

#[tokio::test]
async fn a_request_that_drags_on_is_cut_at_the_request_deadline() {
    let limits = tls::Limits { request: Duration::from_millis(600), ..short(Duration::from_secs(30), Duration::from_secs(60)) };
    let server = spawn_limited(small_app(), limits).await;
    let stream = tls_connect(&server).await.unwrap();
    let (mut reader, mut writer) = tokio::io::split(stream);
    writer.write_all(b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n").await.unwrap();
    // A byte now and then keeps the idle timer content: only a deadline for the whole request ends this.
    let trickle = tokio::spawn(async move {
        while writer.write_all(b"x").await.is_ok() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let started = std::time::Instant::now();
    until_closed(&mut reader, Duration::from_secs(5)).await;
    assert!(started.elapsed() < Duration::from_secs(3), "closed only after {:?}", started.elapsed());
    trickle.abort();
}

#[tokio::test]
async fn the_request_deadline_is_for_each_request_not_the_connection() {
    let limits = tls::Limits { request: Duration::from_millis(400), ..tls::Limits::default() };
    let server = spawn_limited(small_app(), limits).await;
    let mut kept = tls_connect(&server).await.unwrap();
    // Quick requests over one kept-alive connection, together much longer than the deadline.
    for _ in 0..5 {
        health_over(&mut kept).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    health_over(&mut kept).await;
}

#[tokio::test]
async fn a_silent_connection_is_closed_after_the_header_timeout() {
    let server = spawn_limited(small_app(), short(Duration::from_millis(300), Duration::from_secs(60))).await;

    // Through the handshake, then nothing: a slow-loris that holds a connection without sending a request.
    let started = std::time::Instant::now();
    let mut silent = tls_connect(&server).await.unwrap();
    until_closed(&mut silent, Duration::from_secs(5)).await;
    assert!(started.elapsed() < Duration::from_secs(3), "closed only after {:?}", started.elapsed());

    // Half a request head is no better.
    let mut slow = tls_connect(&server).await.unwrap();
    slow.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n").await.unwrap();
    until_closed(&mut slow, Duration::from_secs(5)).await;

    // A client that does send its request is answered.
    let mut prompt = tls_connect(&server).await.unwrap();
    prompt.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
    let answer = until_closed(&mut prompt, Duration::from_secs(5)).await;
    assert!(answer.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&answer));
}

#[tokio::test]
async fn a_request_that_stops_halfway_is_closed_after_the_idle_timeout() {
    let server = spawn_limited(small_app(), short(Duration::from_secs(30), Duration::from_millis(300))).await;
    let mut stalled = tls_connect(&server).await.unwrap();
    // The head is complete, the body never comes: the header timer is done with it, the idle one is not.
    stalled.write_all(b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nhalf").await.unwrap();
    let started = std::time::Instant::now();
    until_closed(&mut stalled, Duration::from_secs(5)).await;
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn upgraded_connections_are_not_subject_to_the_timeouts() {
    use futures_util::SinkExt;
    let limits = tls::Limits { request: Duration::from_millis(200), ..short(Duration::from_millis(200), Duration::from_millis(200)) };
    let server = spawn_limited(small_app(), limits).await;
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(hv_tls::client_config(Some(server.server_key), Default::default())));
    let url = format!("wss://{}/ws", server.addr);
    let (mut socket, _) = tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(connector)).await.unwrap();

    // Quiet for longer than both limits, as an event stream between events or LiveKit signaling between pings.
    tokio::time::sleep(Duration::from_millis(800)).await;
    socket.send(Message::Text("still here".into())).await.unwrap();
    let echo = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.expect("an answer").unwrap().unwrap();
    assert_eq!(echo, Message::Text("still here".into()));
}

#[tokio::test]
async fn connections_beyond_the_cap_are_refused() {
    let limits = tls::Limits { connections: 2, ..tls::Limits::default() };
    let server = spawn_limited(small_app(), limits).await;
    let first = tls_connect(&server).await.unwrap();
    let _second = tls_connect(&server).await.unwrap();
    assert!(tls_connect(&server).await.is_err(), "a third connection got through");

    // Once one goes, there is room again.
    drop(first);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut third = tls_connect(&server).await.unwrap();
    third.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
    let answer = until_closed(&mut third, Duration::from_secs(5)).await;
    assert!(answer.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&answer));
}

#[tokio::test]
async fn only_http_1_1_is_spoken() {
    let server = spawn_limited(small_app(), tls::Limits::default()).await;
    let mut h2 = tls_connect(&server).await.unwrap();
    // The HTTP/2 connection preface, as a client trying HTTP/2 would open.
    h2.write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").await.unwrap();
    let answer = until_closed(&mut h2, Duration::from_secs(5)).await;
    assert!(answer.is_empty() || answer.starts_with(b"HTTP/1.1 "), "answered in HTTP/2: {answer:?}");
}

#[tokio::test]
async fn shutdown_finishes_within_the_deadline_with_a_hanging_client() {
    let limits = tls::Limits { shutdown: Duration::from_millis(500), ..tls::Limits::default() };
    let server = spawn_limited(small_app(), limits).await;
    let mut hanging = tls_connect(&server).await.unwrap();
    // A request in flight whose body never comes: graceful shutdown alone would wait for it forever.
    hanging.write_all(b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    server.stop.notify_one();
    let started = std::time::Instant::now();
    let served = tokio::time::timeout(Duration::from_secs(3), server.serving).await.expect("serve did not return");
    assert!(served.unwrap().is_ok());
    assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
}
