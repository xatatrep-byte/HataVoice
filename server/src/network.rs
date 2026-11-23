//! Public reachability of a home-hosted server: router port mapping via UPnP and the public IP.

use std::net::IpAddr;
use std::time::Duration;

use hv_host::HostConfig;
use igd_next::aio::tokio::search_gateway;
use igd_next::{PortMappingProtocol, SearchOptions};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressKind {
    /// Reachable from the internet (if the ports are open).
    Public,
    /// Carrier-grade NAT (100.64.0.0/10): the ISP shares one public IP, hosting at home won't work.
    Cgnat,
    /// A LAN address: the router itself is behind another NAT.
    Private,
    Loopback,
    Other,
}

pub fn classify(ip: IpAddr) -> AddressKind {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            if v4.is_loopback() {
                AddressKind::Loopback
            } else if a == 100 && (64..128).contains(&b) {
                AddressKind::Cgnat
            } else if v4.is_private() {
                AddressKind::Private
            } else if v4.is_unspecified() || v4.is_link_local() || v4.is_broadcast() || v4.is_multicast() {
                AddressKind::Other
            } else {
                AddressKind::Public
            }
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            if v6.is_loopback() {
                AddressKind::Loopback
            } else if first & 0xfe00 == 0xfc00 {
                AddressKind::Private
            } else if first & 0xe000 == 0x2000 {
                AddressKind::Public
            } else {
                AddressKind::Other
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
}

/// Virtual LANs friends can join instead of needing a white IP and open ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VirtualNet {
    Radmin,
    Zerotier,
    Hamachi,
    Tailscale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VirtualAddress {
    pub kind: VirtualNet,
    pub ip: IpAddr,
}

/// Which virtual LAN an adapter belongs to: by its Windows name, and for Radmin VPN and Hamachi
/// also by the ranges they always hand out (26.0.0.0/8, 25.0.0.0/8), in case it was renamed.
pub fn virtual_net(name: &str, ip: IpAddr) -> Option<VirtualNet> {
    let name = name.to_lowercase();
    let first_octet = match ip {
        IpAddr::V4(v4) => Some(v4.octets()[0]),
        IpAddr::V6(_) => None,
    };
    if name.contains("radmin") || first_octet == Some(26) {
        Some(VirtualNet::Radmin)
    } else if name.contains("zerotier") {
        Some(VirtualNet::Zerotier)
    } else if name.contains("hamachi") || first_octet == Some(25) {
        Some(VirtualNet::Hamachi)
    } else if name.contains("tailscale") {
        Some(VirtualNet::Tailscale)
    } else {
        None
    }
}

/// The IPv4 addresses this PC has in virtual LANs, from `(adapter name, address)` pairs.
pub fn virtual_addresses(interfaces: &[(String, IpAddr)]) -> Vec<VirtualAddress> {
    let mut found: Vec<VirtualAddress> = Vec::new();
    for (name, ip) in interfaces {
        if !ip.is_ipv4() || ip.is_loopback() {
            continue;
        }
        if let Some(kind) = virtual_net(name, *ip) {
            let address = VirtualAddress { kind, ip: *ip };
            if !found.contains(&address) {
                found.push(address);
            }
        }
    }
    found
}

/// The ports friends must reach: API + signaling (TCP), WebRTC over TCP, WebRTC media (UDP).
pub fn required_ports(config: &HostConfig) -> Vec<(Protocol, u16)> {
    vec![
        (Protocol::Tcp, config.api_port),
        (Protocol::Tcp, config.rtc_tcp_port),
        (Protocol::Udp, config.rtc_udp_port),
    ]
}

/// A manually entered IP always wins; the router's answer is used only if it is really public.
pub fn choose_public_ip(manual: Option<IpAddr>, router: Option<IpAddr>) -> Option<IpAddr> {
    manual.or(router.filter(|ip| classify(*ip) == AddressKind::Public))
}

/// Mappings are leased and renewed, so a crashed server doesn't leave ports open forever.
pub const LEASE: Duration = Duration::from_secs(60 * 60);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(4);
const DESCRIPTION: &str = "HataVoice";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortStatus {
    pub protocol: Protocol,
    pub port: u16,
    pub open: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum UpnpState {
    Disabled,
    Searching,
    /// No UPnP router answered, or it refused.
    Unavailable(String),
    Done,
}

/// Everything the host UI needs to tell the user whether friends can reach the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetworkReport {
    pub upnp: UpnpState,
    pub ports: Vec<PortStatus>,
    /// What the router says our public IP is.
    pub router_ip: Option<IpAddr>,
    pub router_ip_kind: Option<AddressKind>,
    /// The IP we tell friends and LiveKit to use.
    pub public_ip: Option<IpAddr>,
    /// This PC's address on the LAN, for friends in the same network.
    pub local_ip: Option<IpAddr>,
    /// Addresses in Radmin VPN, ZeroTier and the like, for friends in those networks.
    pub virtual_addresses: Vec<VirtualAddress>,
}

impl NetworkReport {
    pub fn new(config: &HostConfig) -> Self {
        Self {
            upnp: if config.upnp { UpnpState::Searching } else { UpnpState::Disabled },
            ports: required_ports(config)
                .into_iter()
                .map(|(protocol, port)| PortStatus { protocol, port, open: false, error: None })
                .collect(),
            router_ip: None,
            router_ip_kind: None,
            public_ip: config.external_ip,
            local_ip: None,
            virtual_addresses: Vec::new(),
        }
    }
}

/// Picks the address friends on the same LAN should use. VPN adapters in TUN mode often take
/// the default route with 172.16.0.0/12 or 10/8 addresses, so home-router ranges come first.
pub fn pick_lan_ip(candidates: &[IpAddr]) -> Option<IpAddr> {
    candidates
        .iter()
        .filter_map(|ip| lan_rank(ip).map(|r| (r, *ip)))
        .min_by_key(|(r, _)| *r)
        .map(|(_, ip)| ip)
}

/// How likely a private IPv4 address is the home LAN's (lower is likelier); None for any other address.
fn lan_rank(ip: &IpAddr) -> Option<u8> {
    match ip {
        IpAddr::V4(v4) if classify(*ip) == AddressKind::Private => match v4.octets() {
            [192, 168, ..] => Some(0),
            [10, ..] => Some(1),
            _ => Some(2),
        },
        _ => None,
    }
}

/// The addresses the router search is sent from, all at once: every private IPv4 address of this PC, the likeliest
/// LAN first, and any interface. Windows sends the search's multicast wherever its route says, and a VPN in TUN mode
/// takes that route: from "any interface" the search goes into the tunnel and no router ever answers.
fn search_sources(candidates: &[IpAddr]) -> Vec<IpAddr> {
    let mut ranked: Vec<(u8, IpAddr)> = candidates.iter().filter_map(|ip| lan_rank(ip).map(|r| (r, *ip))).collect();
    ranked.sort_by_key(|(r, _)| *r);
    let mut sources: Vec<IpAddr> = Vec::new();
    for (_, ip) in ranked {
        if !sources.contains(&ip) {
            sources.push(ip);
        }
    }
    sources.push(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    sources
}

/// `(adapter name, address)` of every interface of this PC.
fn interfaces() -> Vec<(String, IpAddr)> {
    if_addrs::get_if_addrs()
        .map(|list| list.into_iter().map(|i| (i.name.clone(), i.ip())).collect())
        .unwrap_or_default()
}

/// The virtual LANs this PC is in right now (the report keeps those of the server's start: LiveKit took its addresses
/// then, so a network joined later needs a restart).
pub fn virtual_addresses_now() -> Vec<VirtualAddress> {
    virtual_addresses(&interfaces())
}

fn interface_ips() -> Vec<IpAddr> {
    interfaces().into_iter().map(|(_, ip)| ip).collect()
}

/// Local address of the interface that routes to `target` (no packets are sent).
fn local_ip_towards(target: IpAddr) -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((target, 9)).ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

fn search_options(source: IpAddr) -> SearchOptions {
    let mut options = SearchOptions::default();
    options.bind_addr = std::net::SocketAddr::new(source, 0);
    options.timeout = Some(SEARCH_TIMEOUT);
    options
}

/// The router, as the first of the searches from [`search_sources`] finds it.
async fn find_gateway() -> Result<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, igd_next::SearchError> {
    let searches = search_sources(&interface_ips()).into_iter().map(|source| Box::pin(search_gateway(search_options(source))));
    futures_util::future::select_ok(searches).await.map(|(gateway, _)| gateway)
}

fn igd_protocol(protocol: Protocol) -> PortMappingProtocol {
    match protocol {
        Protocol::Tcp => PortMappingProtocol::TCP,
        Protocol::Udp => PortMappingProtocol::UDP,
    }
}

/// Asks the router to forward the public ports to this PC and reports what happened.
pub async fn map_ports(config: &HostConfig) -> NetworkReport {
    let mut report = NetworkReport::new(config);
    report.local_ip = pick_lan_ip(&interface_ips());
    report.virtual_addresses = virtual_addresses(&interfaces());
    if !config.upnp {
        return report;
    }

    let gateway = match find_gateway().await {
        Ok(gateway) => gateway,
        Err(e) => {
            report.upnp = UpnpState::Unavailable(format!("Роутер не ответил по UPnP: {e}"));
            return report;
        }
    };
    let Some(local_ip) = local_ip_towards(gateway.addr.ip()) else {
        report.upnp = UpnpState::Unavailable("Не удалось определить адрес этого ПК в сети".into());
        return report;
    };
    report.local_ip = Some(local_ip);

    match gateway.get_external_ip().await {
        Ok(ip) => {
            report.router_ip = Some(ip);
            report.router_ip_kind = Some(classify(ip));
            report.public_ip = choose_public_ip(config.external_ip, Some(ip));
        }
        Err(e) => tracing::warn!("router did not report its external IP: {e}"),
    }

    for status in &mut report.ports {
        let local = std::net::SocketAddr::new(local_ip, status.port);
        let result = gateway
            .add_port(igd_protocol(status.protocol), status.port, local, LEASE.as_secs() as u32, DESCRIPTION)
            .await;
        status.open = result.is_ok();
        status.error = result.err().map(|e| e.to_string());
    }
    report.upnp = UpnpState::Done;
    report
}

/// Removes our mappings on shutdown; errors are only logged, the lease expires anyway.
pub async fn unmap_ports(config: &HostConfig) {
    if !config.upnp {
        return;
    }
    let Ok(gateway) = find_gateway().await else { return };
    for (protocol, port) in required_ports(config) {
        if let Err(e) = gateway.remove_port(igd_protocol(protocol), port).await {
            tracing::warn!("could not remove UPnP mapping {port}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(s: &str) -> AddressKind {
        classify(s.parse().unwrap())
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn lan_ip_prefers_home_router_ranges_over_vpn_adapters() {
        let candidates = [ip("172.19.0.1"), ip("127.0.0.1"), ip("192.168.0.132"), ip("10.8.0.2")];
        assert_eq!(pick_lan_ip(&candidates), Some(ip("192.168.0.132")));
        assert_eq!(pick_lan_ip(&[ip("172.19.0.1"), ip("10.0.0.5")]), Some(ip("10.0.0.5")));
        assert_eq!(pick_lan_ip(&[ip("172.19.0.1")]), Some(ip("172.19.0.1")));
        assert_eq!(pick_lan_ip(&[ip("127.0.0.1"), ip("169.254.3.4")]), None);
        assert_eq!(pick_lan_ip(&[]), None);
    }

    #[test]
    fn the_router_is_looked_for_from_each_lan_address_and_from_anywhere() {
        // A VPN in TUN mode (172.19.0.1) takes the multicast route: from "anywhere" the search goes into the tunnel.
        let candidates = [ip("172.19.0.1"), ip("127.0.0.1"), ip("192.168.0.132"), ip("172.22.128.1"), ip("203.0.113.9")];
        assert_eq!(search_sources(&candidates), [ip("192.168.0.132"), ip("172.19.0.1"), ip("172.22.128.1"), ip("0.0.0.0")]);
        assert_eq!(search_sources(&[ip("10.0.0.5"), ip("10.0.0.5")]), [ip("10.0.0.5"), ip("0.0.0.0")]);
        assert_eq!(search_sources(&[]), [ip("0.0.0.0")]);
    }

    #[test]
    fn the_three_public_ports_come_from_the_config() {
        let config = HostConfig { api_port: 9000, rtc_tcp_port: 9001, rtc_udp_port: 9002, ..Default::default() };
        assert_eq!(
            required_ports(&config),
            vec![(Protocol::Tcp, 9000), (Protocol::Tcp, 9001), (Protocol::Udp, 9002)]
        );
    }

    #[test]
    fn public_ip_prefers_manual_and_ignores_grey_router_addresses() {
        assert_eq!(choose_public_ip(Some(ip("198.51.100.1")), Some(ip("203.0.113.7"))), Some(ip("198.51.100.1")));
        assert_eq!(choose_public_ip(None, Some(ip("203.0.113.7"))), Some(ip("203.0.113.7")));
        assert_eq!(choose_public_ip(None, Some(ip("100.70.1.2"))), None, "CGNAT is not reachable");
        assert_eq!(choose_public_ip(None, Some(ip("192.168.1.1"))), None);
        assert_eq!(choose_public_ip(None, None), None);
    }

    #[test]
    fn recognises_public_cgnat_private_and_loopback() {
        assert_eq!(kind("203.0.113.7"), AddressKind::Public);
        assert_eq!(kind("198.51.100.4"), AddressKind::Public);
        assert_eq!(kind("100.64.0.1"), AddressKind::Cgnat);
        assert_eq!(kind("100.127.255.254"), AddressKind::Cgnat);
        assert_eq!(kind("100.128.0.1"), AddressKind::Public, "just outside 100.64.0.0/10");
        assert_eq!(kind("192.168.0.132"), AddressKind::Private);
        assert_eq!(kind("10.1.2.3"), AddressKind::Private);
        assert_eq!(kind("172.19.0.1"), AddressKind::Private);
        assert_eq!(kind("127.0.0.1"), AddressKind::Loopback);
        assert_eq!(kind("0.0.0.0"), AddressKind::Other);
        assert_eq!(kind("169.254.1.1"), AddressKind::Other, "link-local");
    }

    #[test]
    fn recognises_virtual_lan_adapters() {
        let net = |name: &str, ip: &str| virtual_net(name, ip.parse().unwrap());
        assert_eq!(net("Radmin VPN", "26.10.20.30"), Some(VirtualNet::Radmin));
        assert_eq!(net("Ethernet 3", "26.10.20.30"), Some(VirtualNet::Radmin), "renamed, but Radmin's range");
        assert_eq!(net("ZeroTier One [8056c2e21c000001]", "10.147.17.3"), Some(VirtualNet::Zerotier));
        assert_eq!(net("Hamachi", "25.50.1.2"), Some(VirtualNet::Hamachi));
        assert_eq!(net("Tailscale", "100.101.102.103"), Some(VirtualNet::Tailscale));
        assert_eq!(net("Ethernet", "192.168.0.132"), None);
        assert_eq!(net("tun_tjosssjba", "172.19.0.1"), None, "an ordinary VPN is not a LAN for friends");
    }

    #[test]
    fn lists_virtual_lan_addresses_once_and_only_ipv4() {
        let interfaces = [
            ("Ethernet".to_string(), "192.168.0.132".parse().unwrap()),
            ("Radmin VPN".to_string(), "26.10.20.30".parse().unwrap()),
            ("Radmin VPN".to_string(), "fe80::1".parse().unwrap()),
            ("Radmin VPN".to_string(), "26.10.20.30".parse().unwrap()),
            ("ZeroTier One [8056c2e21c000001]".to_string(), "10.147.17.3".parse().unwrap()),
            ("Loopback Pseudo-Interface 1".to_string(), "127.0.0.1".parse().unwrap()),
        ];
        assert_eq!(
            virtual_addresses(&interfaces),
            vec![
                VirtualAddress { kind: VirtualNet::Radmin, ip: "26.10.20.30".parse().unwrap() },
                VirtualAddress { kind: VirtualNet::Zerotier, ip: "10.147.17.3".parse().unwrap() },
            ]
        );
    }

    #[test]
    fn ipv6_global_is_public_and_ula_is_private() {
        assert_eq!(kind("2001:db8::1"), AddressKind::Public);
        assert_eq!(kind("fd12:3456::1"), AddressKind::Private);
        assert_eq!(kind("::1"), AddressKind::Loopback);
    }
}
