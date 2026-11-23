use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use url::Url;

/// Servers whose own address stopped answering, with the tunnel that replaced it until the program closes. The server's
/// key stays pinned whichever way the connection goes, so a wrong tunnel can do no more than a wrong address.
static ROUTES: LazyLock<RwLock<HashMap<String, String>>> = LazyLock::new(Default::default);

/// Sends a server's traffic through `tunnel` from now on. False when that is no tunnel's address.
pub fn route_through_tunnel(address: &str, tunnel: &str) -> bool {
    if hv_p2p::id_of(tunnel).is_none() {
        return false;
    }
    ROUTES.write().unwrap_or_else(|e| e.into_inner()).insert(address.trim().to_string(), tunnel.trim().to_string());
    true
}

/// The tunnel a server is reached through, if any.
pub fn tunnel_of(address: &str) -> Option<String> {
    if hv_p2p::id_of(address).is_some() {
        return Some(address.trim().to_string());
    }
    ROUTES.read().unwrap_or_else(|e| e.into_inner()).get(address.trim()).cloned()
}

/// The local ports of that tunnel.
pub fn tunnel_ports(address: &str) -> Option<hv_p2p::Ports> {
    hv_p2p::Dialer::global().ports(&tunnel_of(address)?)
}

/// Builds `path` on the server given by a user-typed address ("1.2.3.4:7350", "https://host:7350/").
/// Servers speak TLS only, so the result is always `https`, even for a typed `http://`.
pub fn server_url(address: &str, path: &str) -> Result<Url, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("Введите адрес сервера".into());
    }
    // A server reached by its key: it is behind the tunnel's local port.
    let with_scheme = if let Some(ports) = tunnel_ports(address) {
        format!("https://127.0.0.1:{}", ports.api)
    } else if address.contains("://") {
        address.to_string()
    } else {
        format!("https://{address}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|e| format!("Неверный адрес: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Неподдерживаемый протокол: {}", url.scheme()));
    }
    url.set_scheme("https").map_err(|()| "Неверный адрес".to_string())?;
    url.set_path(path);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_can_be_routed_through_a_tunnel_only_to_a_tunnel() {
        assert!(!route_through_tunnel("192.0.2.77:7350", "203.0.113.7:7350"));
        assert_eq!(tunnel_of("192.0.2.77:7350"), None);
        let tunnel = format!("{}.p2p", "a".repeat(64));
        assert!(route_through_tunnel("192.0.2.77:7350", &tunnel));
        assert_eq!(tunnel_of(" 192.0.2.77:7350 "), Some(tunnel.clone()));
        assert_eq!(tunnel_of(&tunnel), Some(tunnel));
    }

    #[test]
    fn bare_host_port_gets_the_https_scheme_and_the_path() {
        assert_eq!(server_url("127.0.0.1:7350", "/api/hello").unwrap().as_str(), "https://127.0.0.1:7350/api/hello");
    }

    #[test]
    fn existing_scheme_and_trailing_slash_are_kept_tidy() {
        assert_eq!(server_url(" https://host:1/ ", "/api/x").unwrap().as_str(), "https://host:1/api/x");
        assert_eq!(server_url("https://voice.example", "/").unwrap().as_str(), "https://voice.example/");
    }

    #[test]
    fn plain_http_is_never_spoken() {
        assert_eq!(server_url("http://host:1/", "/api/x").unwrap().as_str(), "https://host:1/api/x");
    }

    #[test]
    fn empty_or_unsupported_addresses_are_rejected() {
        assert!(server_url("", "/").is_err());
        assert!(server_url("   ", "/").is_err());
        assert!(server_url("ftp://host", "/").is_err());
    }
}
