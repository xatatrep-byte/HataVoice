//! The window's only doors to a server. WebView2 cannot check a certificate that only the server's own
//! key vouches for, so the window never talks to a server directly: LiveKit signaling goes over a
//! WebSocket to this loopback bridge, and server media (GIFs, icons) through the `hvmedia` scheme. Both
//! are carried on from here over TLS pinned to the server's key (`tls`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use hv_roster::PublicKey;
use hv_roster::keys::{encode_b64, random_bytes, sha256};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpstreamCloseFrame;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::server_check::server_url;
use crate::session::ServerError;
use crate::tls::{Pin, http_client, send, ws_connector};

type Upstream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const TIMEOUT: Duration = Duration::from_secs(30);
/// More than any file the server stores (8 MB), so an honest answer always fits.
const MAX_MEDIA_BYTES: usize = 16 * 1024 * 1024;
/// `validate` answers with a line of text.
const MAX_VALIDATE_BYTES: usize = 64 * 1024;
/// The types the server gives its files (it sniffs them on upload, `server/src/media.rs`). Any other type
/// (a page, a script, an SVG) is not passed on to the window: such a file is served as plain bytes.
const SERVER_MEDIA_TYPES: [&str; 6] = ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"];

/// A server the window may reach, and the only key it may be reached under.
struct Server {
    key: PublicKey,
    pin: Pin,
    /// Kept for as long as the server is allowed, so its connections are reused.
    client: reqwest::Client,
}

pub struct Bridge {
    port: u16,
    /// Part of every bridge path: a web page in the user's browser can try 127.0.0.1 ports, but cannot guess this.
    secret: String,
    servers: RwLock<HashMap<String, Arc<Server>>>,
}

impl Bridge {
    fn new(port: u16, secret: String) -> Self {
        Bridge { port, secret, servers: RwLock::default() }
    }

    /// Listens on a free loopback port until the program ends.
    pub async fn start() -> Result<Arc<Bridge>, String> {
        let secret = encode_b64(&random_bytes::<32>()?);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Не открывается локальный мост: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let bridge = Arc::new(Bridge::new(port, secret));
        let app = Router::new().fallback(relay).with_state(bridge.clone());
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("bridge stopped: {e}");
            }
        });
        Ok(bridge)
    }

    /// From now on the window may reach `address`, as long as it is the holder of `server_key`.
    pub fn allow(&self, address: &str, server_key: PublicKey) {
        let mut servers = self.servers.write().unwrap_or_else(|e| e.into_inner());
        if servers.get(address).is_some_and(|server| server.key == server_key) {
            return;
        }
        // A different key for a known address replaces the old one; a failure leaves the address closed.
        servers.remove(address);
        let pin = Pin::to(server_key);
        match http_client(&pin, TIMEOUT) {
            Ok(client) => {
                servers.insert(address.to_string(), Arc::new(Server { key: server_key, pin, client }));
            }
            Err(e) => eprintln!("bridge cannot reach {address}: {}", e.message()),
        }
    }

    /// Where livekit-client connects instead of the server: it adds `/rtc/v1` and the query itself.
    pub fn url(&self, address: &str) -> String {
        format!("ws://127.0.0.1:{}/{}/{}", self.port, self.secret, utf8_percent_encode(address, NON_ALPHANUMERIC))
    }

    fn server(&self, address: &str) -> Option<Arc<Server>> {
        self.servers.read().unwrap_or_else(|e| e.into_inner()).get(address).cloned()
    }

    /// The server, its address and the `/rtc…` path that `/{secret}/{address}/rtc…` stands for.
    fn route(&self, path: &str) -> Option<(Arc<Server>, String, String)> {
        let (secret, rest) = path.strip_prefix('/')?.split_once('/')?;
        if !same(secret, &self.secret) {
            return None;
        }
        let (address, rtc) = rest.split_once('/')?;
        let address = percent_decode_str(address).decode_utf8().ok()?;
        let server = self.server(&address)?;
        Some((server, address.into_owned(), format!("/{rtc}")))
    }
}

/// A secret to put in a local address.
#[cfg(target_os = "linux")]
pub fn random_secret() -> Result<String, String> {
    Ok(encode_b64(&random_bytes::<32>()?))
}

/// Compares without stopping at the first difference, so the time taken tells nothing about the secret.
pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |different, (x, y)| different | (x ^ y)) == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Не найдено").into_response()
}

/// A failed connection to the server, named by what the handshake showed.
fn bad_gateway(error: ServerError) -> Response {
    (StatusCode::BAD_GATEWAY, error.message()).into_response()
}

/// The `/rtc…` URL on the server for what the window asked, or `None` if it leads anywhere else
/// (`/rtc/../api/…` must not be a way to the rest of the server's routes).
fn upstream_url(address: &str, path: &str, query: Option<&str>, websocket: bool) -> Option<String> {
    let mut url = server_url(address, path).ok()?;
    if url.path() != "/rtc" && !url.path().starts_with("/rtc/") {
        return None;
    }
    url.set_query(query);
    if websocket {
        url.set_scheme("wss").ok()?;
    }
    Some(url.into())
}

async fn relay(State(bridge): State<Arc<Bridge>>, request: Request) -> Response {
    let Some((server, address, path)) = bridge.route(request.uri().path()) else {
        return not_found();
    };
    let websocket = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let Some(url) = upstream_url(&address, &path, request.uri().query(), websocket) else {
        return not_found();
    };
    if websocket { relay_websocket(server, address, url, request).await } else { relay_validate(server, url, request).await }
}

/// livekit-client asks `…/validate` when its WebSocket fails, to tell a refused pass from a network error.
async fn relay_validate(server: Arc<Server>, url: String, request: Request) -> Response {
    if request.method() != Method::GET || !request.uri().path().ends_with("/validate") {
        return not_found();
    }
    let response = match send(server.client.get(url), &server.pin).await {
        Ok(response) => response,
        Err(e) => return bad_gateway(e),
    };
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).cloned();
    let body = match read_capped(response, MAX_VALIDATE_BYTES).await {
        Ok(body) => body,
        Err(e) => return (StatusCode::BAD_GATEWAY, e).into_response(),
    };
    // The window is another origin than the bridge; the secret in the path is what guards it.
    let mut out = Response::builder().status(status).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if let Some(content_type) = content_type {
        out = out.header(header::CONTENT_TYPE, content_type.as_bytes());
    }
    out.body(Body::from(body)).unwrap_or_else(|e| (StatusCode::BAD_GATEWAY, e.to_string()).into_response())
}

async fn relay_websocket(server: Arc<Server>, address: String, url: String, request: Request) -> Response {
    let (mut parts, _body) = request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let Ok(request) = url.into_client_request() else {
        return not_found();
    };
    // Connect first, so a server that is gone or replaced is a clear 502 instead of a socket dropped after opening.
    let pin = Pin::to(server.key);
    let connector = ws_connector(&pin);
    let upstream = match tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector)).await {
        Ok((upstream, _)) => upstream,
        Err(e) => {
            return match pin.seen() {
                Some(seen) if seen != server.key => bad_gateway(ServerError::KeyChanged),
                _ => bad_gateway(ServerError::Unreachable(e.to_string())),
            };
        }
    };
    // Over a tunnel, the server's addresses for its media are the tunnel's local port.
    let media_port = crate::server_check::tunnel_ports(&address).map(|ports| ports.media);
    upgrade.on_upgrade(move |client| pump(client, upstream, media_port))
}

async fn pump(client: WebSocket, upstream: Upstream, media_port: Option<u16>) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let to_upstream = async {
        while let Some(Ok(mut message)) = client_rx.next().await {
            if let (Some(_), Message::Binary(data)) = (media_port, &message) {
                match crate::signal_rewrite::rewrite_request(data) {
                    Some(rewritten) => message = Message::Binary(rewritten.into()),
                    None => continue,
                }
            }
            if upstream_tx.send(to_upstream_message(message)).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let to_client = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let Some(mut message) = to_client_message(message) else { continue };
            if let (Some(port), Message::Binary(data)) = (media_port, &message) {
                // Asked each time: the network may change during a call.
                let tunnel = SocketAddr::new(hv_p2p::media_ip(), port);
                match crate::signal_rewrite::rewrite_signal(data, tunnel) {
                    Some(rewritten) => message = Message::Binary(rewritten.into()),
                    None => continue,
                }
            }
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

/// The body of `response`, refusing one longer than `limit` without reading the rest.
pub(crate) async fn read_capped(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let too_long = || "Ответ сервера слишком большой".to_string();
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(too_long());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Сервер недоступен: {e}"))? {
        if body.len() + chunk.len() > limit {
            return Err(too_long());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// `hvmedia`: the path is `/{percent("address/sha256")}`. Fetches `https://{address}/api/media/{sha256}`
/// and hands it over only if its SHA-256 is the one asked for, so a server cannot swap a file the journal
/// named by hash. The type is the server's, if it is one the server makes.
pub async fn media(bridge: &Bridge, path: &str) -> Result<(Vec<u8>, String), (u16, String)> {
    let broken = || (400, "Испорчена ссылка на файл".to_string());
    let decoded = percent_decode_str(path).decode_utf8().map_err(|_| broken())?;
    // The address may hold slashes itself ("https://host/"), the hash never does.
    let (address, sha) = decoded.strip_prefix('/').unwrap_or(&decoded).rsplit_once('/').ok_or_else(broken)?;
    if !is_hash(sha) {
        return Err(broken());
    }
    let server = bridge.server(address).ok_or_else(|| (404, "Сервер ещё не открыт".to_string()))?;
    let url = server_url(address, &format!("/api/media/{sha}")).map_err(|e| (400, e))?;
    let response = send(server.client.get(url), &server.pin).await.map_err(|e| (502, e.message()))?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err((404, "Файл не найден".into())),
        other => return Err((502, format!("Сервер ответил ошибкой {other}"))),
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|sent| SERVER_MEDIA_TYPES.contains(sent))
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = read_capped(response, MAX_MEDIA_BYTES).await.map_err(|e| (502, e))?;
    if hex(&sha256(&body)) != sha {
        return Err((502, "Файл на сервере подменён — он не совпал с хэшем".into()));
    }
    Ok((body, content_type))
}

/// The `hvmedia` answer for the window.
pub fn media_reply(result: Result<(Vec<u8>, String), (u16, String)>) -> tauri::http::Response<Vec<u8>> {
    let reply = tauri::http::Response::builder().header("x-content-type-options", "nosniff");
    match result {
        Ok((body, content_type)) => reply.status(200).header(header::CONTENT_TYPE, content_type).body(body),
        Err((status, message)) => reply.status(status).header(header::CONTENT_TYPE, "text/plain; charset=utf-8").body(message.into_bytes()),
    }
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::Router;
    use axum::extract::ws::{Message, WebSocketUpgrade};
    use axum::extract::{RawQuery, Request, State};
    use axum::http::header;
    use axum::middleware::{self, Next};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use futures_util::{SinkExt, StreamExt};
    use hv_roster::Identity;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::{Error as WsError, Message as ClientMessage};

    use super::*;
    use crate::tls::test_server::serve_app;

    const GIF: &[u8] = b"GIF89a-the-pixels";

    fn key(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn hash_of(bytes: &[u8]) -> String {
        hex(&hv_roster::keys::sha256(bytes))
    }

    /// What the fake server saw, apart from the routes it answers.
    #[derive(Clone, Default)]
    struct Seen {
        requests: Arc<AtomicUsize>,
        echo_ended: Arc<AtomicBool>,
    }

    /// A server behind the real TLS front door: LiveKit-like signaling, `validate`, media, and a
    /// route the bridge must never reach.
    async fn upstream(server_key: &Identity, media: &'static [u8]) -> (String, Seen) {
        let seen = Seen::default();
        let app = Router::new()
            .route("/rtc/v1", get(echo))
            .route("/rtc", get(echo))
            .route("/rtc/v1/validate", get(validate))
            .route("/api/media/{sha}", get(move || async move { ([(header::CONTENT_TYPE, "image/gif")], media) }))
            .route("/api/state", get(|| async { "members only" }))
            .with_state(seen.clone())
            .layer(middleware::from_fn_with_state(seen.clone(), count));
        (serve_app(app, server_key).await.to_string(), seen)
    }

    async fn count(State(seen): State<Seen>, request: Request, next: Next) -> Response {
        seen.requests.fetch_add(1, Ordering::SeqCst);
        next.run(request).await
    }

    /// Answers each text with the query it came in on, so a test sees what the bridge forwarded;
    /// "bye" makes it hang up.
    async fn echo(State(seen): State<Seen>, upgrade: WebSocketUpgrade, RawQuery(query): RawQuery) -> Response {
        let query = query.unwrap_or_default();
        upgrade.on_upgrade(move |mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                let reply = match message {
                    Message::Text(text) if text.as_str() == "bye" => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Message::Text(text) => Message::Text(format!("{query}|{text}").into()),
                    Message::Binary(data) => Message::Binary(data),
                    _ => continue,
                };
                if socket.send(reply).await.is_err() {
                    break;
                }
            }
            seen.echo_ended.store(true, Ordering::SeqCst);
        })
    }

    async fn validate(RawQuery(query): RawQuery) -> Response {
        match query.as_deref() {
            Some("access_token=t") => "ok".into_response(),
            _ => (axum::http::StatusCode::FORBIDDEN, "no pass").into_response(),
        }
    }

    async fn within<T>(future: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), future).await.expect("timed out")
    }

    fn http_url(bridge: &Bridge, address: &str, path: &str) -> String {
        format!("{}{path}", bridge.url(address).replacen("ws://", "http://", 1))
    }

    fn refused_with(error: WsError) -> u16 {
        match error {
            WsError::Http(response) => response.status().as_u16(),
            other => panic!("expected an HTTP refusal, got {other}"),
        }
    }

    #[tokio::test]
    async fn signaling_is_relayed_over_pinned_tls() {
        let (address, _) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let (mut socket, _) = within(tokio_tungstenite::connect_async(format!("{}/rtc/v1?access_token=t", bridge.url(&address))))
            .await
            .unwrap();
        socket.send(ClientMessage::Text("hello".into())).await.unwrap();
        // The access token travels in the query and must reach the server as it was.
        assert_eq!(within(socket.next()).await.unwrap().unwrap(), ClientMessage::Text("access_token=t|hello".into()));
        socket.send(ClientMessage::Binary(vec![1, 2, 3].into())).await.unwrap();
        assert_eq!(within(socket.next()).await.unwrap().unwrap(), ClientMessage::Binary(vec![1, 2, 3].into()));
    }

    #[tokio::test]
    async fn the_older_signaling_path_is_relayed_too() {
        let (address, _) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let (mut socket, _) = within(tokio_tungstenite::connect_async(format!("{}/rtc?access_token=t", bridge.url(&address))))
            .await
            .unwrap();
        socket.send(ClientMessage::Text("hello".into())).await.unwrap();
        assert_eq!(within(socket.next()).await.unwrap().unwrap(), ClientMessage::Text("access_token=t|hello".into()));
    }

    #[tokio::test]
    async fn validate_is_relayed_too() {
        let (address, _) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let response = within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=t"))).await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        // livekit-client reads this answer from the window, which is another origin.
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert_eq!(response.text().await.unwrap(), "ok");

        // The server's refusal reaches livekit-client as it was: it tells a bad pass from a network error.
        let refused = within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=old"))).await.unwrap();
        assert_eq!(refused.status().as_u16(), 403);
        assert_eq!(refused.text().await.unwrap(), "no pass");
    }

    #[tokio::test]
    async fn wrong_secret_or_unknown_server_is_404() {
        let (address, seen) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let wrong_secret = bridge.url(&address).replace(&bridge.secret, "not-the-secret");
        assert_eq!(refused_with(within(tokio_tungstenite::connect_async(format!("{wrong_secret}/rtc/v1"))).await.unwrap_err()), 404);
        let response = within(reqwest::get(format!("{}/rtc/v1/validate", wrong_secret.replacen("ws://", "http://", 1)))).await.unwrap();
        assert_eq!(response.status().as_u16(), 404);

        let stranger = "127.0.0.1:9";
        assert_eq!(refused_with(within(tokio_tungstenite::connect_async(format!("{}/rtc/v1", bridge.url(stranger)))).await.unwrap_err()), 404);
        let response = within(reqwest::get(http_url(&bridge, stranger, "/rtc/v1/validate"))).await.unwrap();
        assert_eq!(response.status().as_u16(), 404);

        // A path outside the secret does not exist either.
        let response = within(reqwest::get(bridge.url(&address).replacen("ws://", "http://", 1).replace(&bridge.secret, ""))).await.unwrap();
        assert_eq!(response.status().as_u16(), 404);
        assert_eq!(seen.requests.load(Ordering::SeqCst), 0, "nothing reached the server");
    }

    #[tokio::test]
    async fn upstream_with_another_key_is_not_reached() {
        let (address, seen) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(2).public());

        let error = within(tokio_tungstenite::connect_async(format!("{}/rtc/v1?access_token=t", bridge.url(&address)))).await.unwrap_err();
        assert_eq!(refused_with(error), 502);
        let response = within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=t"))).await.unwrap();
        assert_eq!(response.status().as_u16(), 502);
        assert_eq!(response.text().await.unwrap(), ServerError::KeyChanged.message());
        let path = format!("/{}", encode(&format!("{address}/{}", hash_of(GIF))));
        assert_eq!(within(media(&bridge, &path)).await.unwrap_err().0, 502);
        // The handshake was refused before any request was sent.
        assert_eq!(seen.requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn allowing_an_address_again_with_another_key_replaces_the_pin() {
        let (address, _) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(2).public());
        assert_eq!(within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=t"))).await.unwrap().status().as_u16(), 502);
        bridge.allow(&address, key(1).public());
        assert_eq!(within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=t"))).await.unwrap().status().as_u16(), 200);
        // Opening the same server again keeps what works.
        bridge.allow(&address, key(1).public());
        assert_eq!(within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=t"))).await.unwrap().status().as_u16(), 200);
    }

    #[tokio::test]
    async fn an_address_as_typed_still_reaches_the_server() {
        let (host, _) = upstream(&key(1), GIF).await;
        let address = format!("https://{host}/");
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let response = within(reqwest::get(http_url(&bridge, &address, "/rtc/v1/validate?access_token=t"))).await.unwrap();
        assert_eq!(response.text().await.unwrap(), "ok");
        let path = format!("/{}", encode(&format!("{address}/{}", hash_of(GIF))));
        assert_eq!(within(media(&bridge, &path)).await.unwrap().0, GIF);
    }

    /// The status of a GET sent as written: reqwest would tidy `/rtc/../` away before it left, but the
    /// bridge has to cope with whatever reaches its port.
    async fn raw_status(bridge: &Bridge, address: &str, path: &str) -> u16 {
        let url = bridge.url(address);
        let (host, prefix) = url.strip_prefix("ws://").unwrap().split_once('/').unwrap();
        let mut socket = tokio::net::TcpStream::connect(host).await.unwrap();
        socket.write_all(format!("GET /{prefix}{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut answer = String::new();
        within(socket.read_to_string(&mut answer)).await.unwrap();
        answer.split(' ').nth(1).unwrap().parse().unwrap()
    }

    #[tokio::test]
    async fn only_signaling_is_relayed() {
        let (address, seen) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        for path in [
            "/api/state",
            "/rtc/../api/state",
            "/rtc/%2e%2e/api/state",
            "/rtc/%2E%2E/%2e%2e/api/state",
            "/rtcx/v1/validate",
            "/rtc/v1",
            "/rtc",
        ] {
            assert_eq!(raw_status(&bridge, &address, path).await, 404, "{path}");
        }
        let error = within(tokio_tungstenite::connect_async(format!("{}/rtc/../api/state", bridge.url(&address)))).await.unwrap_err();
        assert_eq!(refused_with(error), 404);
        assert_eq!(seen.requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_path_that_climbs_out_of_rtc_leads_nowhere() {
        let url = |path: &str| upstream_url("127.0.0.1:7350", path, Some("access_token=t"), false);
        assert_eq!(url("/rtc/v1/validate").as_deref(), Some("https://127.0.0.1:7350/rtc/v1/validate?access_token=t"));
        assert_eq!(url("/rtc/../api/state"), None);
        assert_eq!(url("/rtc/%2e%2E/api/state"), None);
        assert_eq!(url("/rtc/./v1").as_deref(), Some("https://127.0.0.1:7350/rtc/v1?access_token=t"));
        assert_eq!(url("/rtcx"), None);
        assert_eq!(upstream_url("127.0.0.1:7350", "/rtc/v1", Some("a=b"), true).as_deref(), Some("wss://127.0.0.1:7350/rtc/v1?a=b"));
    }

    #[tokio::test]
    async fn the_server_hanging_up_ends_the_window_socket() {
        let (address, _) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let (mut socket, _) = within(tokio_tungstenite::connect_async(format!("{}/rtc/v1", bridge.url(&address)))).await.unwrap();
        socket.send(ClientMessage::Text("bye".into())).await.unwrap();
        loop {
            match within(socket.next()).await {
                Some(Ok(ClientMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    }

    #[tokio::test]
    async fn the_window_leaving_ends_the_server_connection() {
        let (address, seen) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let (mut socket, _) = within(tokio_tungstenite::connect_async(format!("{}/rtc/v1", bridge.url(&address)))).await.unwrap();
        socket.send(ClientMessage::Text("hello".into())).await.unwrap();
        within(socket.next()).await.unwrap().unwrap();
        socket.close(None).await.unwrap();
        within(async {
            while !seen.echo_ended.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
    }

    fn encode(text: &str) -> String {
        utf8_percent_encode(text, NON_ALPHANUMERIC).to_string()
    }

    #[tokio::test]
    async fn media_with_the_right_hash_is_served() {
        let (address, _) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        // The window sends the whole "address/hash" as one encoded path segment.
        let path = format!("/{}", encode(&format!("{address}/{}", hash_of(GIF))));
        let (body, content_type) = within(media(&bridge, &path)).await.unwrap();
        assert_eq!(body, GIF);
        assert_eq!(content_type, "image/gif");
    }

    #[tokio::test]
    async fn media_keeps_only_a_type_the_server_itself_makes() {
        let cases = [
            ("image/png", "image/png"),
            ("image/jpeg", "image/jpeg"),
            ("image/gif", "image/gif"),
            ("image/webp", "image/webp"),
            ("video/mp4", "video/mp4"),
            ("video/webm", "video/webm"),
            // A page or a script the window would run, or anything else, is just bytes.
            ("text/html", "application/octet-stream"),
            ("image/svg+xml", "application/octet-stream"),
            ("application/javascript", "application/octet-stream"),
            ("image/gif; charset=utf-8", "application/octet-stream"),
        ];
        let bridge = Bridge::start().await.unwrap();
        for (sent, served) in cases {
            let app = Router::new().route("/api/media/{sha}", get(move || async move { ([(header::CONTENT_TYPE, sent)], GIF) }));
            let address = serve_app(app, &key(1)).await.to_string();
            bridge.allow(&address, key(1).public());
            let path = format!("/{}", encode(&format!("{address}/{}", hash_of(GIF))));
            let (body, content_type) = within(media(&bridge, &path)).await.unwrap();
            assert_eq!((body.as_slice(), content_type.as_str()), (GIF, served), "{sent}");
        }
    }

    #[tokio::test]
    async fn media_with_a_wrong_hash_is_refused() {
        // The server hands out other bytes than the hash names.
        let (address, _) = upstream(&key(1), b"GIF89a-something-else").await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());

        let path = format!("/{}", encode(&format!("{address}/{}", hash_of(GIF))));
        let (status, _) = within(media(&bridge, &path)).await.unwrap_err();
        assert_eq!(status, 502);
    }

    #[tokio::test]
    async fn media_for_an_unknown_server_or_a_broken_link_is_refused_before_any_request() {
        let (address, seen) = upstream(&key(1), GIF).await;
        let bridge = Bridge::start().await.unwrap();
        bridge.allow(&address, key(1).public());
        let sha = hash_of(GIF);

        let stranger = format!("/{}", encode(&format!("127.0.0.1:9/{sha}")));
        assert_eq!(within(media(&bridge, &stranger)).await.unwrap_err().0, 404);
        for bad in [
            format!("/{}", encode(&format!("{address}/../state"))),
            format!("/{}", encode(&format!("{address}/{}", sha.to_uppercase()))),
            format!("/{}", encode(&address)),
            "/".to_string(),
            format!("/{}", encode(&format!("{address}/{sha}")).replace("%2E", "%FF")),
        ] {
            assert_eq!(within(media(&bridge, &bad)).await.unwrap_err().0, 400, "{bad}");
        }
        assert_eq!(seen.requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_missing_file_is_a_404_for_the_window() {
        let bridge = Bridge::start().await.unwrap();
        // The fake server answers any hash with the GIF, so ask a server without that route.
        let empty = serve_app(Router::new(), &key(1)).await.to_string();
        bridge.allow(&empty, key(1).public());

        let path = format!("/{}", encode(&format!("{empty}/{}", hash_of(GIF))));
        assert_eq!(within(media(&bridge, &path)).await.unwrap_err().0, 404);
    }

    #[test]
    fn the_window_gets_the_bytes_with_their_type_and_failures_as_plain_text() {
        let ok = media_reply(Ok((GIF.to_vec(), "image/gif".into())));
        assert_eq!(ok.status().as_u16(), 200);
        assert_eq!(ok.headers()["content-type"], "image/gif");
        assert_eq!(ok.headers()["x-content-type-options"], "nosniff");
        assert_eq!(ok.body(), GIF);

        let failed = media_reply(Err((502, "Файл не совпал".into())));
        assert_eq!(failed.status().as_u16(), 502);
        assert_eq!(failed.headers()["content-type"], "text/plain; charset=utf-8");
        assert_eq!(failed.body(), "Файл не совпал".as_bytes());
    }

    #[test]
    fn the_bridge_address_names_the_server_in_percent_form() {
        let bridge = Bridge::new(4242, "SECRET".into());
        assert_eq!(bridge.url("127.0.0.1:7350"), "ws://127.0.0.1:4242/SECRET/127%2E0%2E0%2E1%3A7350");
        assert_eq!(bridge.url("https://a.b/"), "ws://127.0.0.1:4242/SECRET/https%3A%2F%2Fa%2Eb%2F");
    }

    /// `setup` is synchronous: the bridge is started on Tauri's runtime and must outlive that call.
    #[test]
    fn a_bridge_started_the_way_setup_does_keeps_serving() {
        let bridge = tauri::async_runtime::block_on(Bridge::start()).unwrap();
        let status = tauri::async_runtime::block_on(async { reqwest::get(http_url(&bridge, "127.0.0.1:1", "/rtc/v1/validate")).await.unwrap().status() });
        assert_eq!(status.as_u16(), 404);
    }

    #[tokio::test]
    async fn every_bridge_has_its_own_secret() {
        let (first, second) = (Bridge::start().await.unwrap(), Bridge::start().await.unwrap());
        assert_ne!(first.secret, second.secret);
        // 32 random bytes, URL-safe, nothing to escape in a path.
        assert_eq!(first.secret.len(), 43);
        assert!(first.secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }
}
