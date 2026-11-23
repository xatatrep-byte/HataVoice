//! How the client reaches a server: TLS 1.3 only, with the server's certificate checked against its
//! Ed25519 key (`hv_tls`). Every connection - requests, the event stream, the host's own endpoints -
//! is made from a [`Pin`], and a failed one is named by what the handshake showed.

use std::error::Error;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hv_roster::PublicKey;

use crate::session::ServerError;

/// The key a connection must end up talking to, and what the handshake saw.
///
/// `seen` is filled by the certificate check on every handshake that gets as far as the server's
/// certificate, and is only meaningful for the connections made from this pin.
#[derive(Clone, Debug)]
pub struct Pin {
    /// `None` accepts any key: first contact, to be pinned from [`Pin::seen`] once the server has proved it.
    pub expected: Option<PublicKey>,
    seen: Arc<Mutex<Option<PublicKey>>>,
}

impl Pin {
    pub fn to(key: PublicKey) -> Self {
        Pin { expected: Some(key), seen: Arc::default() }
    }

    /// Accepts whatever key the server has; read it with [`Pin::seen`] after a connection went through.
    pub fn learn() -> Self {
        Pin { expected: None, seen: Arc::default() }
    }

    /// The key the server presented to the latest handshake. With `expected == None` it is the server's
    /// only once a connection has succeeded.
    pub fn seen(&self) -> Option<PublicKey> {
        *self.seen.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forgets the last handshake, so a later failure is not blamed on it.
    fn forget(&self) {
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// How long a client keeps an idle connection for reuse. The server closes one that waits 30 s for a request
/// (reqwest would keep it 90 s), and a request sent over it just then fails as "unreachable".
const POOL_IDLE: Duration = Duration::from_secs(20);

/// A client that talks to the holder of `pin`'s key and nobody else. One client keeps its connections,
/// so keep it for as long as the same server is used.
pub fn http_client(pin: &Pin, timeout: Duration) -> Result<reqwest::Client, ServerError> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(hv_tls::client_config(pin.expected, pin.seen.clone()))
        .https_only(true)
        // A redirect would send a signed request somewhere the user never named.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .pool_idle_timeout(POOL_IDLE)
        .build()
        .map_err(|e| ServerError::Unreachable(e.to_string()))
}

/// The client for the server this PC hosts itself, on `127.0.0.1`. Its host endpoints carry no secrets and
/// are answered to loopback peers only, so the key is learned instead of pinned.
pub fn loopback_client(timeout: Duration) -> Result<reqwest::Client, ServerError> {
    http_client(&Pin::learn(), timeout)
}

/// Sends a request made by a client built from `pin`, naming a failed connection by [`connection_error`].
pub async fn send(request: reqwest::RequestBuilder, pin: &Pin) -> Result<reqwest::Response, ServerError> {
    pin.forget();
    request.send().await.map_err(|e| connection_error(&e, pin))
}

/// The same check for the event stream's WebSocket.
pub fn ws_connector(pin: &Pin) -> tokio_tungstenite::Connector {
    tokio_tungstenite::Connector::Rustls(Arc::new(hv_tls::client_config(pin.expected, pin.seen.clone())))
}

/// A server showing another key than the pinned one is `KeyChanged`; an answer that is not TLS at all
/// (a server from before TLS) is `OldServer`; anything else - offline, closed port, timeout - is `Unreachable`.
///
/// Only a key that was actually shown can mean a swap: an empty `seen` says nothing about the server.
pub fn connection_error(error: &reqwest::Error, pin: &Pin) -> ServerError {
    if let (Some(expected), Some(seen)) = (pin.expected, pin.seen()) {
        if seen != expected {
            return ServerError::KeyChanged;
        }
    }
    if answered_without_tls(error) {
        return ServerError::OldServer;
    }
    ServerError::Unreachable(error.to_string())
}

/// A plain HTTP server answers a TLS ClientHello with text, which rustls cannot read as a TLS message.
fn answered_without_tls(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if matches!(error.downcast_ref::<rustls::Error>(), Some(rustls::Error::InvalidMessage(_))) {
            return true;
        }
        // `io::Error::source` skips the error it wraps, and the TLS stack reports rustls errors inside one.
        if let Some(wrapped) = error.downcast_ref::<io::Error>().and_then(io::Error::get_ref) {
            if answered_without_tls(wrapped) {
                return true;
            }
        }
        current = error.source();
    }
    false
}

#[cfg(test)]
pub(crate) mod test_server {
    use std::net::SocketAddr;
    use std::sync::Arc;

    use axum::Router;
    use hv_roster::Identity;

    /// `app` behind the server's real TLS front door, with a certificate issued by `server_key`.
    pub async fn serve_app(app: Router, server_key: &Identity) -> SocketAddr {
        let config = Arc::new(hv_tls::server_config(server_key).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(hatavoice_server::tls::serve(listener, app, config, std::future::pending()));
        addr
    }

    /// The in-process server as it runs for real: its journal's server key signs the certificate.
    pub async fn serve(store: Arc<hatavoice_server::roster_store::RosterStore>) -> SocketAddr {
        let channels = Arc::new(hatavoice_server::channels::ChannelStore::open(None).unwrap());
        let app = hatavoice_server::host_app(hatavoice_server::LiveKitConfig::dev(), None, channels, store.clone());
        serve_app(app, store.server_identity()).await
    }

    /// Nothing listens on the returned address.
    pub async fn closed_address() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::Router;
    use axum::routing::get;
    use hv_roster::Identity;

    use super::test_server::{closed_address, serve_app};
    use super::*;

    fn key(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    async fn get_health(address: &str, pin: &Pin) -> Result<reqwest::Response, ServerError> {
        let client = http_client(pin, Duration::from_secs(5)).unwrap();
        send(client.get(format!("https://{address}/health")), pin).await
    }

    async fn health_server(server_key: &Identity) -> String {
        serve_app(Router::new().route("/health", get(|| async { "ok" })), server_key).await.to_string()
    }

    #[test]
    fn a_kept_connection_is_let_go_well_before_the_server_closes_it() {
        // The server closes a kept-alive connection that waits this long for a request. A client that picks it
        // up again just then gets "connection closed" instead of an answer.
        let server_closes = hatavoice_server::tls::Limits::default().header_read;
        assert!(POOL_IDLE + Duration::from_secs(5) <= server_closes, "{POOL_IDLE:?} vs {server_closes:?}");
    }

    #[tokio::test]
    async fn a_pinned_client_talks_to_the_holder_of_the_key() {
        let address = health_server(&key(1)).await;
        let pin = Pin::to(key(1).public());
        let response = get_health(&address, &pin).await.unwrap();
        assert_eq!(response.text().await.unwrap(), "ok");
        assert_eq!(pin.seen(), Some(key(1).public()));
    }

    #[tokio::test]
    async fn a_learning_client_remembers_the_key_it_met() {
        let address = health_server(&key(1)).await;
        let pin = Pin::learn();
        assert_eq!(pin.seen(), None);
        get_health(&address, &pin).await.unwrap();
        assert_eq!(pin.seen(), Some(key(1).public()));
        assert_eq!(pin.expected, None);
    }

    #[tokio::test]
    async fn another_key_is_a_changed_server() {
        let address = health_server(&key(1)).await;
        let error = get_health(&address, &Pin::to(key(2).public())).await.unwrap_err();
        assert_eq!(error, ServerError::KeyChanged);
    }

    #[tokio::test]
    async fn an_offline_server_is_unreachable_even_after_a_swap_was_seen() {
        let swapped = health_server(&key(1)).await;
        let pin = Pin::to(key(2).public());
        assert_eq!(get_health(&swapped, &pin).await.unwrap_err(), ServerError::KeyChanged);
        // The slot still holds the swapped server's key; the next failure must not be blamed on it.
        let offline = closed_address().await;
        assert!(matches!(get_health(&offline, &pin).await.unwrap_err(), ServerError::Unreachable(_)));
    }

    #[tokio::test]
    async fn a_client_that_learns_never_reports_a_change() {
        let offline = closed_address().await;
        assert!(matches!(get_health(&offline, &Pin::learn()).await.unwrap_err(), ServerError::Unreachable(_)));
    }

    #[tokio::test]
    async fn a_plain_http_server_is_an_old_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move { axum::serve(listener, Router::new().route("/health", get(|| async { "ok" }))).await });
        assert_eq!(get_health(&address, &Pin::learn()).await.unwrap_err(), ServerError::OldServer);
        assert_eq!(get_health(&address, &Pin::to(key(1).public())).await.unwrap_err(), ServerError::OldServer);
    }

    #[tokio::test]
    async fn a_server_that_hangs_up_is_not_called_old() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                drop(socket);
            }
        });
        assert!(matches!(get_health(&address, &Pin::learn()).await.unwrap_err(), ServerError::Unreachable(_)));
    }

    #[tokio::test]
    async fn the_loopback_client_needs_no_key() {
        let address = health_server(&key(1)).await;
        let response = loopback_client(Duration::from_secs(5)).unwrap().get(format!("https://{address}/health")).send().await.unwrap();
        assert_eq!(response.text().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn redirects_and_plain_urls_are_not_followed() {
        let redirect = get(|| async { axum::response::Redirect::temporary("http://127.0.0.1:1/") });
        let address = serve_app(Router::new().route("/go", redirect), &key(1)).await;
        let pin = Pin::to(key(1).public());
        let client = http_client(&pin, Duration::from_secs(5)).unwrap();
        let response = send(client.get(format!("https://{address}/go")), &pin).await.unwrap();
        assert_eq!(response.status().as_u16(), 307);
        assert!(client.get(format!("http://{address}/go")).send().await.is_err(), "plain HTTP is not spoken at all");
    }

    #[tokio::test]
    async fn the_connector_checks_the_same_key() {
        use axum::extract::ws::WebSocketUpgrade;
        let socket = get(|upgrade: WebSocketUpgrade| async move { upgrade.on_upgrade(|_| async {}) });
        let address = serve_app(Router::new().route("/ws", socket), &key(1)).await;
        let open = |pin: Pin| async move {
            let url = format!("wss://{address}/ws");
            tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(ws_connector(&pin))).await
        };

        assert!(open(Pin::to(key(1).public())).await.is_ok(), "the holder of the pinned key is reached");

        let pin = Pin::to(key(2).public());
        let refused = open(pin.clone()).await.expect_err("a server with another key is refused");
        assert!(!matches!(refused, tokio_tungstenite::tungstenite::Error::Http(_)), "refused before any HTTP: {refused}");
        assert_eq!(pin.seen(), Some(key(1).public()), "the handshake met the other key and stopped there");
    }
}
