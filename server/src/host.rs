//! Host mode: a server started from the client on the owner's PC (`--data-dir`).

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};

use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use hv_host::HostConfig;
use serde::Serialize;

use crate::AppState;
use crate::network::{NetworkReport, VirtualNet};
use crate::supervisor::{LiveKitState, SharedState};

pub struct HostRuntime {
    pub config: HostConfig,
    pub livekit: SharedState,
    pub network: Arc<RwLock<NetworkReport>>,
    /// This server's address in the P2P tunnel, when it answers there.
    pub p2p_address: Option<String>,
    /// Signalled by `POST /api/host/shutdown`, so the client can stop us gracefully
    /// (closing router ports) instead of killing the process.
    pub shutdown: Arc<tokio::sync::Notify>,
}

pub async fn shutdown(State(state): State<AppState>, request: Request) -> Response {
    if !is_local_admin(&request) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(host) = state.host else {
        return StatusCode::NOT_FOUND.into_response();
    };
    host.shutdown.notify_one();
    StatusCode::ACCEPTED.into_response()
}

#[derive(Serialize)]
struct HostStatus {
    name: String,
    livekit: LiveKitState,
    network: NetworkReport,
    /// What to send friends: public address plus the API port.
    share_address: Option<String>,
    /// For friends anywhere, a public address or not.
    p2p_address: Option<String>,
    /// For friends on the same Wi-Fi / LAN.
    lan_address: Option<String>,
    /// For friends in the same Radmin VPN / ZeroTier / … network.
    virtual_addresses: Vec<VirtualShare>,
    /// The same networks as this PC is in now: one missing above was joined after the start and needs a restart.
    virtual_addresses_now: Vec<VirtualShare>,
    /// The version of the program this server hands out to its members.
    update_version: Option<String>,
}

#[derive(Serialize)]
struct VirtualShare {
    kind: VirtualNet,
    address: String,
}

/// `ip:port`, with brackets for IPv6.
pub fn address_with_port(ip: IpAddr, port: u16) -> String {
    SocketAddr::new(ip, port).to_string()
}

/// The host status reveals the public IP and router details, so only this PC may ask.
pub fn is_local_peer(peer: SocketAddr) -> bool {
    peer.ip().is_loopback()
}

/// Admin endpoints (status, shutdown, channel edits) serve the client's Rust side on this PC.
/// A loopback peer is not enough: a web page in the host's browser also connects from loopback,
/// either cross-site (it sends `Origin`) or through DNS rebinding (its `Host` is a foreign name).
pub fn allows_local_admin(peer: Option<SocketAddr>, headers: &HeaderMap) -> bool {
    let local_host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(is_local_host);
    peer.is_some_and(is_local_peer) && local_host && !headers.contains_key(header::ORIGIN)
}

/// `localhost`, `127.0.0.1` or `[::1]`, with or without a port.
fn is_local_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(name.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

/// `allows_local_admin` for an incoming request.
pub fn is_local_admin(request: &Request) -> bool {
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    allows_local_admin(peer, request.headers())
}

pub async fn status(State(state): State<AppState>, request: Request) -> Response {
    if !is_local_admin(&request) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(host) = state.host else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let network = host.network.read().unwrap_or_else(|e| e.into_inner()).clone();
    let livekit = host.livekit.read().unwrap_or_else(|e| e.into_inner()).clone();
    let port = host.config.api_port;
    Json(HostStatus {
        name: host.config.name.clone(),
        share_address: network.public_ip.map(|ip| address_with_port(ip, port)),
        p2p_address: host.p2p_address.clone(),
        lan_address: network.local_ip.map(|ip| address_with_port(ip, port)),
        virtual_addresses: network
            .virtual_addresses
            .iter()
            .map(|v| VirtualShare { kind: v.kind, address: address_with_port(v.ip, port) })
            .collect(),
        virtual_addresses_now: crate::network::virtual_addresses_now()
            .iter()
            .map(|v| VirtualShare { kind: v.kind, address: address_with_port(v.ip, port) })
            .collect(),
        livekit,
        network,
        update_version: crate::update::offered_version(),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_formatted_for_pasting() {
        assert_eq!(address_with_port("203.0.113.7".parse().unwrap(), 7350), "203.0.113.7:7350");
        assert_eq!(address_with_port("2001:db8::1".parse().unwrap(), 7350), "[2001:db8::1]:7350");
    }

    #[test]
    fn only_loopback_peers_count_as_local() {
        assert!(is_local_peer("127.0.0.1:5000".parse().unwrap()));
        assert!(is_local_peer("[::1]:5000".parse().unwrap()));
        assert!(!is_local_peer("192.168.0.50:5000".parse().unwrap()));
        assert!(!is_local_peer("203.0.113.7:5000".parse().unwrap()));
    }

    fn headers(pairs: &[(axum::http::HeaderName, &str)]) -> axum::http::HeaderMap {
        pairs.iter().map(|(name, value)| (name.clone(), value.parse().unwrap())).collect()
    }

    #[test]
    fn local_admin_is_the_client_on_this_pc() {
        use axum::http::header::HOST;
        let local = Some("127.0.0.1:5000".parse().unwrap());
        for host in ["127.0.0.1:7350", "localhost:7350", "[::1]:7350", "localhost", "LOCALHOST:7350"] {
            assert!(allows_local_admin(local, &headers(&[(HOST, host)])), "{host}");
        }
    }

    #[test]
    fn web_pages_on_this_pc_are_not_local_admin() {
        use axum::http::header::{HOST, ORIGIN};
        let local = Some("127.0.0.1:5000".parse().unwrap());
        // DNS rebinding: the page's own name now points at 127.0.0.1.
        assert!(!allows_local_admin(local, &headers(&[(HOST, "evil.example:7350")])));
        // A cross-site request, e.g. a form posting to 127.0.0.1.
        assert!(!allows_local_admin(local, &headers(&[(HOST, "127.0.0.1:7350"), (ORIGIN, "https://evil.example")])));
        assert!(!allows_local_admin(local, &headers(&[])));
        let lan = Some("192.168.0.50:5000".parse().unwrap());
        assert!(!allows_local_admin(lan, &headers(&[(HOST, "127.0.0.1:7350")])));
        assert!(!allows_local_admin(None, &headers(&[(HOST, "127.0.0.1:7350")])));
    }
}
