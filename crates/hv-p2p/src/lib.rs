//! A server with no public address, reached anyway. Each side runs an iroh endpoint: they find each other by key, punch
//! through their NATs where they can and go through a relay where they cannot. Everything on the way is encrypted by
//! iroh, and everything inside is the same TLS pinned to the server's key and the same end-to-end encrypted media as on
//! any other connection, so a relay learns only who talks to whom.
//!
//! The server's address in this mode is `<endpoint id>.p2p`. On the client a tunnel looks like two local ports: a TCP
//! one for the server's API and signaling, carried in QUIC streams, and a UDP one for the call's media, carried in QUIC
//! datagrams so that a lost packet stays lost instead of holding up the rest.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::{BufMut, Bytes, BytesMut};
use iroh::endpoint::{Connection, PortmapperConfig, QuicTransportConfig, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::watch;

pub const ALPN: &[u8] = b"hatavoice/tunnel/1";
pub const SUFFIX: &str = ".p2p";

/// How many tunnels a server keeps at once: friends on a server number in the tens.
const MAX_CONNECTIONS: usize = 128;
/// How many media flows of one peer stay open (each peer connection of a call is one); a new one replaces the oldest.
const MAX_FLOWS: usize = 16;
/// How much media waits for the network: more would be late anyway, and a call's own control reacts to what gets lost.
const SEND_BUFFER: usize = 512 * 1024;
const RECEIVE_BUFFER: usize = 4 * 1024 * 1024;
/// Packets waiting for their other parts.
const MAX_PENDING: usize = 64;
const UDP_BUFFER: usize = 65_536;
const RETRY: Duration = Duration::from_secs(2);
/// How long a new TCP connection waits for the tunnel to come up.
const DIAL_PATIENCE: Duration = Duration::from_secs(25);

/// Where WebRTC on this PC finds a tunnel's media port: it sends from this PC's network addresses, and a socket on one of
/// those cannot reach loopback. This is the one that goes to the internet; no packet is sent to find it.
pub fn media_ip() -> IpAddr {
    let towards_the_internet = || {
        let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        socket.connect((Ipv4Addr::new(1, 1, 1, 1), 9)).ok()?;
        socket.local_addr().ok().map(|address| address.ip())
    };
    towards_the_internet()
        .filter(|ip| !ip.is_unspecified())
        .or_else(|| own_addresses().into_iter().find(|ip| ip.is_ipv4() && !ip.is_loopback()))
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

fn own_addresses() -> Vec<IpAddr> {
    if_addrs::get_if_addrs().map(|list| list.into_iter().map(|i| i.ip()).collect()).unwrap_or_default()
}

/// Who may use a tunnel's media port: this PC alone. It listens on the network so that WebRTC can reach it, and so can a
/// neighbour on that network, who has no business here.
#[derive(Default)]
struct OwnAddresses {
    known: Vec<IpAddr>,
    looked: Option<Instant>,
}

impl OwnAddresses {
    fn contains(&mut self, ip: IpAddr) -> bool {
        if ip.is_loopback() || self.known.contains(&ip) {
            return true;
        }
        // An unknown address: adapters come and go, but it is not worth asking the system for each stranger's packet.
        if self.looked.is_none_or(|at| at.elapsed() > Duration::from_secs(2)) {
            self.known = own_addresses();
            self.looked = Some(Instant::now());
        }
        self.known.contains(&ip)
    }
}

/// The address a server has in this mode.
pub fn address_of(id: &EndpointId) -> String {
    format!("{id}{SUFFIX}")
}

/// The endpoint behind an address, when it is such an address.
pub fn id_of(address: &str) -> Option<EndpointId> {
    address.trim().strip_suffix(SUFFIX)?.parse().ok()
}

fn transport() -> QuicTransportConfig {
    QuicTransportConfig::builder().datagram_send_buffer_size(SEND_BUFFER).datagram_receive_buffer_size(Some(RECEIVE_BUFFER)).build()
}

/// A media packet on its way: which flow it belongs to, then the packet.
fn frame(flow: u16, payload: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(payload.len() + 2);
    out.put_u16(flow);
    out.put_slice(payload);
    out.freeze()
}

/// In the flow's number: this datagram is a part of a packet longer than the path carries.
const PART: u16 = 0x8000;
/// A part's header: flow, packet, its place, how many there are.
const PART_HEADER: usize = 6;

/// A packet in as many datagrams as it takes: a path may start with less room than WebRTC's packets need.
fn datagrams(flow: u16, payload: &[u8], limit: usize, packet: &mut u16) -> Vec<Bytes> {
    if payload.len() + 2 <= limit {
        return vec![frame(flow, payload)];
    }
    let Some(room) = limit.checked_sub(PART_HEADER).filter(|room| *room > 0) else { return Vec::new() };
    let count = payload.len().div_ceil(room);
    let Ok(count_byte) = u8::try_from(count) else { return Vec::new() };
    *packet = packet.wrapping_add(1);
    payload
        .chunks(room)
        .enumerate()
        .map(|(index, part)| {
            let mut out = BytesMut::with_capacity(part.len() + PART_HEADER);
            out.put_u16(flow | PART);
            out.put_u16(*packet);
            out.put_u8(index as u8);
            out.put_u8(count_byte);
            out.put_slice(part);
            out.freeze()
        })
        .collect()
}

fn send_media(connection: &Connection, flow: u16, payload: &[u8], packet: &mut u16) {
    let Some(limit) = connection.max_datagram_size() else { return };
    for datagram in datagrams(flow, payload, limit, packet) {
        let _ = connection.send_datagram(datagram);
    }
}

/// Puts packets back together. What loses a part is lost, as it would be in plain UDP.
#[derive(Default)]
struct Unframer {
    pending: VecDeque<((u16, u16), Vec<Option<Bytes>>)>,
}

impl Unframer {
    /// The flow and the packet, once a datagram completes one.
    fn take(&mut self, datagram: &Bytes) -> Option<(u16, Bytes)> {
        let flow = u16::from_be_bytes([*datagram.first()?, *datagram.get(1)?]);
        if flow & PART == 0 {
            return Some((flow, datagram.slice(2..)));
        }
        if datagram.len() < PART_HEADER {
            return None;
        }
        let flow = flow & !PART;
        let packet = u16::from_be_bytes([datagram[2], datagram[3]]);
        let (index, count) = (usize::from(datagram[4]), usize::from(datagram[5]));
        if index >= count {
            return None;
        }
        let key = (flow, packet);
        let at = match self.pending.iter().position(|(k, parts)| *k == key && parts.len() == count) {
            Some(at) => at,
            None => {
                if self.pending.len() >= MAX_PENDING {
                    self.pending.pop_front();
                }
                self.pending.push_back((key, vec![None; count]));
                self.pending.len() - 1
            }
        };
        self.pending[at].1[index] = Some(datagram.slice(PART_HEADER..));
        if self.pending[at].1.iter().any(Option::is_none) {
            return None;
        }
        let (_, parts) = self.pending.remove(at)?;
        let mut whole = BytesMut::new();
        for part in parts.into_iter().flatten() {
            whole.put_slice(&part);
        }
        Some((flow, whole.freeze()))
    }
}

// ---------------------------------------------------------------------------------------------- a phone's DNS lookups

/// How long the public resolvers may take once the phone's own lookup had nothing.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const PUBLIC_DNS_PATIENCE: Duration = Duration::from_secs(5);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
type Lookup<T> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<iroh::dns::BoxIter<T>, iroh::dns::DnsError>> + Send + 'static>>;

/// The phone's own name lookup first (the system's resolver: its network's DNS and its «Частный DNS», reached without
/// Java), iroh's public resolvers after it. Those alone (0.23.1) depended on 1.1.1.1 and 8.8.8.8 being reachable from
/// the phone's network. TXT records, which the system's lookup cannot ask, come from the public ones.
#[derive(Debug)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct SystemFirst {
    public: iroh::dns::DnsResolver,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
impl SystemFirst {
    fn new() -> Self {
        // No system configuration: on a phone iroh would read it through Java (see `Host::start`).
        SystemFirst { public: iroh::dns::DnsResolver::builder().build() }
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn system_addresses(host: &str) -> Vec<IpAddr> {
    tokio::net::lookup_host((host, 0)).await.map(|found| found.map(|a| a.ip()).collect()).unwrap_or_default()
}

impl iroh::dns::Resolver for SystemFirst {
    fn lookup_ipv4(&self, host: String) -> Lookup<Ipv4Addr> {
        let public = self.public.clone();
        Box::pin(async move {
            let v4 = |ip: IpAddr| match ip {
                IpAddr::V4(ip) => Some(ip),
                IpAddr::V6(_) => None,
            };
            let mine: Vec<Ipv4Addr> = system_addresses(&host).await.into_iter().filter_map(v4).collect();
            if !mine.is_empty() {
                return Ok(Box::new(mine.into_iter()) as iroh::dns::BoxIter<Ipv4Addr>);
            }
            let theirs: Vec<Ipv4Addr> = public.lookup_ipv4(host, PUBLIC_DNS_PATIENCE).await?.filter_map(v4).collect();
            Ok(Box::new(theirs.into_iter()) as iroh::dns::BoxIter<Ipv4Addr>)
        })
    }

    fn lookup_ipv6(&self, host: String) -> Lookup<Ipv6Addr> {
        let public = self.public.clone();
        Box::pin(async move {
            let v6 = |ip: IpAddr| match ip {
                IpAddr::V6(ip) => Some(ip),
                IpAddr::V4(_) => None,
            };
            let mine: Vec<Ipv6Addr> = system_addresses(&host).await.into_iter().filter_map(v6).collect();
            if !mine.is_empty() {
                return Ok(Box::new(mine.into_iter()) as iroh::dns::BoxIter<Ipv6Addr>);
            }
            let theirs: Vec<Ipv6Addr> = public.lookup_ipv6(host, PUBLIC_DNS_PATIENCE).await?.filter_map(v6).collect();
            Ok(Box::new(theirs.into_iter()) as iroh::dns::BoxIter<Ipv6Addr>)
        })
    }

    fn lookup_txt(&self, host: String) -> Lookup<iroh::dns::TxtRecordData> {
        let public = self.public.clone();
        Box::pin(async move {
            let records: Vec<iroh::dns::TxtRecordData> = public.lookup_txt(host, PUBLIC_DNS_PATIENCE).await?.collect();
            Ok(Box::new(records.into_iter()) as iroh::dns::BoxIter<iroh::dns::TxtRecordData>)
        })
    }

    fn clear_cache(&self) {
        self.public.clear_cache();
    }

    fn reset(&self) -> Box<dyn iroh::dns::Resolver> {
        Box::new(SystemFirst::new())
    }
}

// ------------------------------------------------------------------------------------------------- the server's side

/// The server's end: whoever dials is passed on to the server's own ports, like anyone from the internet.
pub struct Host {
    endpoint: Endpoint,
}

impl Host {
    /// Starts answering. `api` is where streams go (a port that does not take its callers for this PC, see `tls::Limits`),
    /// `media` is LiveKit's UDP port: with no IP, on this PC's network address as it is at the moment (LiveKit listens on
    /// the network adapters, not on loopback). `upnp` lets it ask the router for a port too, which makes a direct path likelier;
    /// without it the router is left alone.
    pub async fn start(secret: [u8; 32], api: SocketAddr, media: SocketAddr, upnp: bool) -> Result<Self, String> {
        let builder = Endpoint::builder(presets::N0)
            .secret_key(SecretKey::from_bytes(&secret))
            .alpns(vec![ALPN.to_vec()])
            .transport_config(transport())
            .portmapper_config(if upnp { PortmapperConfig::default() } else { PortmapperConfig::Disabled });
        // A server on a phone is a program of its own, with no Java beside it, and Android keeps its DNS servers behind
        // Java: iroh's reader of them panics there, and with `panic = "abort"` that takes the whole server down (signal
        // 6). The phone's own lookup answers instead, the public resolvers after it (see `SystemFirst`).
        #[cfg(target_os = "android")]
        let builder = builder.dns_resolver(iroh::dns::DnsResolver::custom(SystemFirst::new()));
        let endpoint = builder
            .bind()
            .await
            .map_err(|e| format!("P2P не запустился: {e}"))?;
        tokio::spawn(accept_loop(endpoint.clone(), api, media));
        Ok(Host { endpoint })
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// The server's address in this mode.
    pub fn address(&self) -> String {
        address_of(&self.endpoint.id())
    }

    /// How to reach it without looking it up, for tests.
    pub fn endpoint_addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    pub async fn close(self) {
        self.endpoint.close().await;
    }
}

async fn accept_loop(endpoint: Endpoint, api: SocketAddr, media: SocketAddr) {
    let seats = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    while let Some(incoming) = endpoint.accept().await {
        let Ok(seat) = seats.clone().try_acquire_owned() else {
            incoming.refuse();
            continue;
        };
        tokio::spawn(async move {
            let _seat = seat;
            match incoming.await {
                Ok(connection) => serve_peer(connection, api, media).await,
                Err(e) => tracing::debug!("p2p: {e}"),
            }
        });
    }
}

/// One peer: its streams go to `api`, and its media flows each get a UDP socket of their own toward `media`.
async fn serve_peer(connection: Connection, api: SocketAddr, media: SocketAddr) {
    let streams = {
        let connection = connection.clone();
        tokio::spawn(async move {
            while let Ok((mut send, mut recv)) = connection.accept_bi().await {
                tokio::spawn(async move {
                    let Ok(mut tcp) = TcpStream::connect(api).await else { return };
                    let mut tunnel = tokio::io::join(&mut recv, &mut send);
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut tunnel).await;
                });
            }
        })
    };
    // Flow numbers only go up, so the smallest is the oldest.
    let mut flows: BTreeMap<u16, (Arc<UdpSocket>, tokio::task::JoinHandle<()>)> = BTreeMap::new();
    let mut unframer = Unframer::default();
    while let Ok(datagram) = connection.read_datagram().await {
        let Some((flow, payload)) = unframer.take(&datagram) else { continue };
        let socket = match flows.get(&flow) {
            Some((socket, _)) => socket.clone(),
            None => {
                let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await else { continue };
                let target = if media.ip().is_unspecified() { SocketAddr::new(media_ip(), media.port()) } else { media };
                if socket.connect(target).await.is_err() {
                    continue;
                }
                if flows.len() >= MAX_FLOWS
                    && let Some((_, (_, back))) = flows.pop_first()
                {
                    back.abort();
                }
                let socket = Arc::new(socket);
                let back = tokio::spawn(media_back(socket.clone(), connection.clone(), flow));
                flows.insert(flow, (socket.clone(), back));
                socket
            }
        };
        let _ = socket.send(&payload).await;
    }
    for (_, back) in flows.into_values() {
        back.abort();
    }
    streams.abort();
}

/// What LiveKit sends to this flow goes back into the tunnel.
async fn media_back(socket: Arc<UdpSocket>, connection: Connection, flow: u16) {
    let mut buffer = vec![0; UDP_BUFFER];
    let mut packet = 0;
    loop {
        tokio::select! {
            received = socket.recv(&mut buffer) => match received {
                Ok(length) => send_media(&connection, flow, &buffer[..length], &mut packet),
                // A UDP socket reports an unreachable port this way; LiveKit may just be restarting.
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            },
            _ = connection.closed() => return,
        }
    }
}

// ------------------------------------------------------------------------------------------------- the client's side

/// What a tunnel looks like from this PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ports {
    /// TLS to the server's API and signaling.
    pub api: u16,
    /// The call's media: WebRTC sends here as if to the server.
    pub media: u16,
}

/// How a tunnel is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TunnelState {
    pub connected: bool,
    /// Straight to the other side, not through a relay.
    pub direct: bool,
    pub rtt_ms: Option<u32>,
}

struct Tunnel {
    ports: Ports,
    connection: watch::Receiver<Option<Connection>>,
}

/// All the tunnels of this program, each set up the first time its server is needed. It runs on its own threads, so
/// that an address can be turned into a local port from anywhere.
pub struct Dialer {
    runtime: tokio::runtime::Runtime,
    endpoint: tokio::sync::OnceCell<Endpoint>,
    tunnels: Mutex<HashMap<EndpointId, Arc<Tunnel>>>,
}

impl Dialer {
    pub fn global() -> &'static Dialer {
        static DIALER: OnceLock<Dialer> = OnceLock::new();
        DIALER.get_or_init(|| Dialer {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("hv-p2p")
                .enable_all()
                .build()
                .expect("a runtime starts"),
            endpoint: tokio::sync::OnceCell::new(),
            tunnels: Mutex::default(),
        })
    }

    async fn endpoint(&self) -> Result<&Endpoint, String> {
        self.endpoint
            .get_or_try_init(|| async {
                // A guest asks nothing of the router.
                Endpoint::builder(presets::N0)
                    .transport_config(transport())
                    .portmapper_config(PortmapperConfig::Disabled)
                    .bind()
                    .await
                    .map_err(|e| format!("P2P не запустился: {e}"))
            })
            .await
    }

    /// The local ports of the tunnel to `address`, when it is a tunnel's address. The ports are open at once; the
    /// connection comes up behind them.
    pub fn ports(&'static self, address: &str) -> Option<Ports> {
        let id = id_of(address)?;
        self.ports_of(id.into())
    }

    /// [`ports`](Self::ports) for an endpoint known by more than its id.
    pub fn ports_of(&'static self, target: EndpointAddr) -> Option<Ports> {
        let id = target.id;
        let mut tunnels = self.tunnels.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tunnel) = tunnels.get(&id) {
            return Some(tunnel.ports);
        }
        let tunnel = Arc::new(self.open(target)?);
        let ports = tunnel.ports;
        tunnels.insert(id, tunnel);
        Some(ports)
    }

    fn open(&'static self, target: EndpointAddr) -> Option<Tunnel> {
        // Plain sockets: this may be called from anywhere, inside a runtime or not.
        let tcp = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
        let udp = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        tcp.set_nonblocking(true).ok()?;
        udp.set_nonblocking(true).ok()?;
        let ports = Ports { api: tcp.local_addr().ok()?.port(), media: udp.local_addr().ok()?.port() };
        let (publish, connection) = watch::channel(None);
        self.runtime.spawn(keep_connected(self, target, publish));
        let (for_tcp, for_media) = (connection.clone(), connection.clone());
        self.runtime.spawn(async move {
            if let Ok(tcp) = TcpListener::from_std(tcp) {
                listen_tcp(tcp, for_tcp).await;
            }
        });
        self.runtime.spawn(async move {
            if let Ok(udp) = UdpSocket::from_std(udp) {
                pump_media(Arc::new(udp), for_media).await;
            }
        });
        Some(Tunnel { ports, connection })
    }

    /// How the tunnel to `address` is doing.
    pub fn state(&self, address: &str) -> Option<TunnelState> {
        let id = id_of(address)?;
        let tunnels = self.tunnels.lock().unwrap_or_else(|e| e.into_inner());
        let tunnel = tunnels.get(&id)?;
        let connection = tunnel.connection.borrow().clone();
        Some(connection.map_or(TunnelState::default(), |c| state_of(&c)))
    }
}

/// The way packets go now.
pub fn state_of(connection: &Connection) -> TunnelState {
    let mut state = TunnelState { connected: connection.close_reason().is_none(), ..Default::default() };
    for path in connection.paths().iter() {
        if path.is_selected() {
            state.direct = path.is_ip();
            state.rtt_ms = Some(path.rtt().as_millis() as u32);
        }
    }
    state
}

/// Dials, and dials again whenever the connection is lost.
async fn keep_connected(dialer: &'static Dialer, target: EndpointAddr, publish: watch::Sender<Option<Connection>>) {
    loop {
        let endpoint = match dialer.endpoint().await {
            Ok(endpoint) => endpoint,
            Err(e) => {
                tracing::warn!("{e}");
                tokio::time::sleep(RETRY).await;
                continue;
            }
        };
        match endpoint.connect(target.clone(), ALPN).await {
            Ok(connection) => {
                let _ = publish.send(Some(connection.clone()));
                let reason = connection.closed().await;
                tracing::debug!("p2p connection ended: {reason}");
                let _ = publish.send(None);
            }
            Err(e) => tracing::debug!("p2p: {e}"),
        }
        tokio::time::sleep(RETRY).await;
    }
}

async fn listen_tcp(listener: TcpListener, connection: watch::Receiver<Option<Connection>>) {
    while let Ok((mut tcp, _)) = listener.accept().await {
        let mut connection = connection.clone();
        tokio::spawn(async move {
            let live = match tokio::time::timeout(DIAL_PATIENCE, connection.wait_for(Option::is_some)).await {
                Ok(Ok(ready)) => ready.clone(),
                _ => return,
            };
            let Some(live) = live else { return };
            let Ok((mut send, mut recv)) = live.open_bi().await else { return };
            let mut tunnel = tokio::io::join(&mut recv, &mut send);
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut tunnel).await;
        });
    }
}

/// The sockets of WebRTC on this PC, each a flow with a number of its own. Numbers only go up: an old one is never mistaken
/// for a new one on the server's side.
#[derive(Default)]
struct Flows {
    next: u16,
    known: VecDeque<(u16, SocketAddr)>,
}

impl Flows {
    fn flow_of(&mut self, peer: SocketAddr) -> u16 {
        if let Some((flow, _)) = self.known.iter().find(|(_, known)| *known == peer) {
            return *flow;
        }
        if self.known.len() >= MAX_FLOWS {
            self.known.pop_front();
        }
        let flow = self.next;
        // The top bit marks a part of a packet: 32 thousand new peer connections later it starts over.
        self.next = (self.next + 1) & !PART;
        self.known.push_back((flow, peer));
        flow
    }

    fn peer_of(&self, flow: u16) -> Option<SocketAddr> {
        self.known.iter().find(|(known, _)| *known == flow).map(|(_, peer)| *peer)
    }
}

/// WebRTC on this PC talks to the UDP port: each of its sockets is a flow of its own, and the answers find their way back.
async fn pump_media(socket: Arc<UdpSocket>, mut connection: watch::Receiver<Option<Connection>>) {
    let peers: Arc<Mutex<Flows>> = Arc::default();
    {
        let (socket, peers, connection) = (socket.clone(), peers.clone(), connection.clone());
        tokio::spawn(async move {
            let mut buffer = vec![0; UDP_BUFFER];
            let mut packet = 0;
            let mut own = OwnAddresses::default();
            while let Ok((length, from)) = socket.recv_from(&mut buffer).await {
                if !own.contains(from.ip()) {
                    continue;
                }
                let live = connection.borrow().clone();
                let Some(live) = live else { continue };
                let flow = peers.lock().unwrap_or_else(|e| e.into_inner()).flow_of(from);
                send_media(&live, flow, &buffer[..length], &mut packet);
            }
        });
    }
    loop {
        if connection.wait_for(Option::is_some).await.is_err() {
            return;
        }
        let live = connection.borrow().clone();
        let Some(live) = live else { continue };
        let mut unframer = Unframer::default();
        while let Ok(datagram) = live.read_datagram().await {
            let Some((flow, payload)) = unframer.take(&datagram) else { continue };
            let peer = peers.lock().unwrap_or_else(|e| e.into_inner()).peer_of(flow);
            if let Some(peer) = peer {
                let _ = socket.send_to(&payload, peer).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_phone_asks_its_own_lookup_first() {
        use iroh::dns::Resolver as _;
        // `localhost` is answered by the system without any network: the public resolvers are never asked.
        let found: Vec<Ipv4Addr> = SystemFirst::new().lookup_ipv4("localhost".into()).await.expect("localhost").collect();
        assert!(found.contains(&Ipv4Addr::LOCALHOST), "{found:?}");
    }

    #[test]
    fn a_server_address_is_its_endpoint() {
        let secret = SecretKey::from_bytes(&[7; 32]);
        let id = secret.public();
        let address = address_of(&id);
        assert!(address.ends_with(".p2p"));
        assert_eq!(id_of(&address), Some(id));
        assert_eq!(id_of(&format!("  {address} ")), Some(id));
        for other in ["203.0.113.7:7350", "abc.p2p", "", ".p2p", "voice.example"] {
            assert_eq!(id_of(other), None, "{other}");
        }
    }

    #[test]
    fn only_this_pc_may_use_the_media_port() {
        let mut own = OwnAddresses::default();
        assert!(own.contains(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(own.contains(media_ip()));
        assert!(!own.contains(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7))));
    }

    #[test]
    fn a_media_packet_keeps_its_flow() {
        let mut unframer = Unframer::default();
        let framed = frame(513, b"hello");
        let (flow, payload) = unframer.take(&framed).unwrap();
        assert_eq!(flow, 513);
        assert_eq!(&payload[..], b"hello");
        assert!(unframer.take(&Bytes::from_static(b"x")).is_none());
        assert_eq!(unframer.take(&Bytes::from_static(&[0, 1])).unwrap().1.len(), 0);
    }

    #[test]
    fn a_long_packet_goes_in_parts_and_comes_back_whole() {
        let long: Vec<u8> = (0..3000).map(|i| i as u8).collect();
        let mut packet = 0;
        let mut parts = datagrams(7, &long, 1200, &mut packet);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|p| p.len() <= 1200));
        // They may come in any order, and something else may come in between.
        parts.reverse();
        let mut unframer = Unframer::default();
        let last = parts.pop().unwrap();
        for part in &parts {
            assert!(unframer.take(part).is_none());
        }
        assert_eq!(unframer.take(&frame(9, b"other")).unwrap().0, 9);
        let (flow, whole) = unframer.take(&last).unwrap();
        assert_eq!(flow, 7);
        assert_eq!(&whole[..], &long[..]);
        assert!(unframer.pending.is_empty());

        // What fits goes as it is.
        assert_eq!(datagrams(7, b"short", 1200, &mut packet).len(), 1);
        // Nothing can be done with no room at all.
        assert!(datagrams(7, &long, 6, &mut packet).is_empty());
    }

    #[test]
    fn lost_parts_do_not_pile_up_and_noise_does_nothing() {
        let long = vec![1; 3000];
        let mut packet = 0;
        let mut unframer = Unframer::default();
        for _ in 0..MAX_PENDING * 3 {
            let parts = datagrams(1, &long, 1200, &mut packet);
            unframer.take(&parts[0]);
        }
        assert_eq!(unframer.pending.len(), MAX_PENDING);
        for noise in [&[0x80, 0, 0, 0, 5, 2][..], &[0x80, 0, 0, 0, 0, 0], &[0x80, 0, 0]] {
            assert!(unframer.take(&Bytes::copy_from_slice(noise)).is_none());
        }
    }

    #[test]
    fn flow_numbers_never_come_back_while_they_are_in_use() {
        let mut flows = Flows::default();
        let at = |port| SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let first = flows.flow_of(at(1));
        assert_eq!(flows.flow_of(at(1)), first);
        for port in 2..=(MAX_FLOWS as u16 + 1) {
            assert_ne!(flows.flow_of(at(port)), first);
        }
        assert_eq!(flows.peer_of(first), None, "the oldest made room");
        let other = flows.flow_of(at(5));
        assert_eq!(flows.peer_of(other), Some(at(5)));
    }

    /// Two endpoints on this PC, with a TCP and a UDP echo behind one of them: what goes in the tunnel comes out at the
    /// server's ports, and what those answer comes back.
    #[test]
    fn streams_and_media_cross_the_tunnel() {
        let dialer = Dialer::global();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let (api, media) = (tcp.local_addr().unwrap(), udp.local_addr().unwrap());
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = tcp.accept().await.unwrap();
                    tokio::spawn(async move {
                        let (mut read, mut write) = socket.split();
                        let _ = tokio::io::copy(&mut read, &mut write).await;
                    });
                }
            });
            tokio::spawn(async move {
                let mut buffer = [0; 2048];
                loop {
                    let (length, from) = udp.recv_from(&mut buffer).await.unwrap();
                    udp.send_to(&buffer[..length], from).await.unwrap();
                }
            });
            let host = Host::start([9; 32], api, media, false).await.unwrap();
            // Waits for the endpoint to know its own addresses.
            let mut target = host.endpoint_addr();
            for _ in 0..50 {
                if !target.addrs.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                target = host.endpoint_addr();
            }
            let ports = dialer.ports_of(target).unwrap();

            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, ports.api)).await.unwrap();
            client.write_all(b"ping").await.unwrap();
            let mut answer = [0; 4];
            tokio::time::timeout(Duration::from_secs(30), client.read_exact(&mut answer)).await.expect("in time").unwrap();
            assert_eq!(&answer, b"ping");

            // Two sockets, as a call's two peer connections: each gets its own answers.
            let one = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let two = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            for (socket, word) in [(&one, b"first"), (&two, b"other")] {
                socket.connect((Ipv4Addr::LOCALHOST, ports.media)).await.unwrap();
                let mut buffer = [0; 16];
                // Datagrams may be lost while the connection settles: asks again.
                let got = tokio::time::timeout(Duration::from_secs(20), async {
                    loop {
                        socket.send(word).await.unwrap();
                        if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(300), socket.recv(&mut buffer)).await {
                            return n;
                        }
                    }
                })
                .await
                .expect("in time");
                assert_eq!(&buffer[..got], word);
            }
            host.close().await;
        });
    }
}
