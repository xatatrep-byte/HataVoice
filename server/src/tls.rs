//! The API port speaks TLS 1.3 and nothing else. A client from before TLS (plain HTTP) is told to
//! update instead of being left to time out.
//!
//! The port faces the internet, so a connection is held to [`Limits`]: HTTP/1.1 only, a request head
//! must come in time, a connection that goes quiet is closed, there are only so many at once, and
//! shutting down does not wait for ever on a client that never finishes its request.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::response::Response;
use hyper::Request;
use hyper::body::{Frame, Incoming, SizeHint};
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;
use tower::ServiceExt;

pub const OUTDATED_CLIENT: &str = "На сервере новая версия ХатаВойс — обнови программу";

/// Every TLS connection opens with a handshake record; plain HTTP opens with a method letter.
const TLS_HANDSHAKE_RECORD: u8 = 0x16;
/// How long a new connection may stay silent, and then how long its TLS handshake may take.
const OPENING_WAIT: Duration = Duration::from_secs(10);
/// The whole refusal of a plain-HTTP client, so a client that never reads cannot hold the connection.
const REFUSAL_WAIT: Duration = Duration::from_secs(5);
/// How much of the refused request is read and thrown away.
const REFUSAL_DRAIN: u64 = 64 * 1024;

/// What one connection may take of the server.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// From the moment a connection waits for a request to the end of its head. The timer runs whenever
    /// the connection waits for a request, so it also closes a keep-alive connection that sits idle
    /// between requests for this long.
    pub header_read: Duration,
    /// No byte either way for this long, in the middle of a request (a body that stops coming, an answer
    /// nobody reads): the connection is closed. Upgraded connections (the event stream, `/rtc`) keep
    /// their own pings and are not timed.
    pub idle: Duration,
    /// The longest one request may take, from its head to the last byte of its answer. A byte now and then
    /// keeps `idle` quiet, so without this a trickled body would hold the connection for ever. Upgraded
    /// connections are not timed.
    pub request: Duration,
    /// Connections open at once, upgraded ones included; beyond that a new one is closed straight away.
    pub connections: usize,
    /// Connections open at once from one address (an IPv6 /64 counts as one), so a single client cannot
    /// take every one of `connections`.
    pub per_peer: usize,
    /// How long shutting down waits for the requests in flight.
    pub shutdown: Duration,
    /// Everyone here comes through the P2P tunnel: from loopback, but from far away. The peer is told as an address that
    /// is not this PC, or a stranger through the tunnel would pass for its owner (`host::is_local_admin`).
    pub tunnel: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            header_read: Duration::from_secs(30),
            idle: Duration::from_secs(60),
            request: Duration::from_secs(300),
            connections: 256,
            per_peer: 32,
            shutdown: Duration::from_secs(5),
            tunnel: false,
        }
    }
}

/// Accepts connections until `shutdown` completes, then lets the requests in flight finish, for at most
/// a few seconds.
///
/// A first byte of 0x16 is TLS and goes to `app` (WebSocket upgrades and `ConnectInfo<SocketAddr>`
/// work as with `axum::serve`); anything else gets `426 Upgrade Required` with a JSON error, and the
/// connection is closed.
pub async fn serve(
    listener: TcpListener,
    app: Router,
    config: Arc<rustls::ServerConfig>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_limited(listener, app, config, shutdown, Limits::default()).await
}

/// A documentation address (RFC 5737): not this PC, not anyone's.
pub const TUNNEL_PEER: std::net::IpAddr = std::net::IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, 1));

/// [`serve`] for the P2P tunnel's connections: nobody here counts as this PC.
pub async fn serve_tunnel(
    listener: TcpListener,
    app: Router,
    config: Arc<rustls::ServerConfig>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let limits = Limits { tunnel: true, per_peer: 256, ..Limits::default() };
    serve_limited(listener, app, config, shutdown, limits).await
}

/// [`serve`] with other limits, so tests need not wait for the real ones.
#[cfg(feature = "testing")]
pub async fn serve_with(
    listener: TcpListener,
    app: Router,
    config: Arc<rustls::ServerConfig>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    limits: Limits,
) -> io::Result<()> {
    serve_limited(listener, app, config, shutdown, limits).await
}

async fn serve_limited(
    listener: TcpListener,
    app: Router,
    config: Arc<rustls::ServerConfig>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    limits: Limits,
) -> io::Result<()> {
    let acceptor = TlsAcceptor::from(config);
    let seats = Arc::new(Semaphore::new(limits.connections));
    let peers = Arc::new(Peers::default());
    // Connections are told to wind down through `stop`; `done` closes when the last of them has gone.
    let (stop_tx, stop_rx) = watch::channel(());
    let (done_tx, done_rx) = watch::channel(());
    let mut shutdown = pin!(shutdown);
    loop {
        let (tcp, peer) = tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(e) => {
                    tracing::warn!("accept failed: {e}");
                    // Running out of file handles fails every accept at once; don't spin on it.
                    if !matches!(e.kind(), io::ErrorKind::ConnectionRefused | io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionReset) {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    continue;
                }
            },
        };
        let peer = if limits.tunnel { SocketAddr::new(TUNNEL_PEER, peer.port()) } else { peer };
        let Ok(all) = seats.clone().try_acquire_owned() else {
            tracing::debug!("connection from {peer} refused: {} open already", limits.connections);
            drop(tcp);
            continue;
        };
        let Some(own) = Peers::take(&peers, peer.ip(), limits.per_peer) else {
            tracing::debug!("connection from {peer} refused: {} open from there already", limits.per_peer);
            drop(tcp);
            continue;
        };
        let seat = Seat { _all: all, _own: own };
        tokio::spawn(connection(tcp, peer, seat, acceptor.clone(), app.clone(), limits, stop_rx.clone(), done_rx.clone()));
    }
    drop(listener);
    let _ = stop_tx.send(());
    drop(done_rx);
    // A client that never finishes its request must not keep the host from closing its router ports.
    if tokio::time::timeout(limits.shutdown, done_tx.closed()).await.is_err() {
        tracing::warn!("requests still in flight after {:?}: stopping without them", limits.shutdown);
    }
    Ok(())
}

/// Where connections come from: an IPv4 address, or the /64 of an IPv6 one (one home gets a whole /64).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct PeerKey(IpAddr);

impl PeerKey {
    fn of(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => PeerKey(IpAddr::V4(v4)),
                None => {
                    let s = v6.segments();
                    PeerKey(IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0)))
                }
            },
            v4 => PeerKey(v4),
        }
    }
}

/// How many connections each address has open.
#[derive(Default)]
struct Peers(Mutex<HashMap<PeerKey, usize>>);

impl Peers {
    /// One more connection from `ip`, unless it has `limit` open already.
    fn take(peers: &Arc<Peers>, ip: IpAddr, limit: usize) -> Option<PeerSeat> {
        let key = PeerKey::of(ip);
        let mut open = peers.0.lock().unwrap_or_else(|e| e.into_inner());
        let count = open.entry(key).or_default();
        if *count >= limit {
            return None;
        }
        *count += 1;
        Some(PeerSeat { peers: peers.clone(), key })
    }
}

/// One connection of an address, given back when the connection goes.
struct PeerSeat {
    peers: Arc<Peers>,
    key: PeerKey,
}

impl Drop for PeerSeat {
    fn drop(&mut self) {
        let mut open = self.peers.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = open.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                open.remove(&self.key);
            }
        }
    }
}

/// A connection's place among all of them and among its address's.
struct Seat {
    _all: OwnedSemaphorePermit,
    _own: PeerSeat,
}

/// When the last byte went either way over a connection, and since when its current request runs.
struct Activity {
    opened: Instant,
    /// Milliseconds after `opened`.
    last: AtomicU64,
    /// Milliseconds after `opened`, plus one; 0 while no request is in flight.
    request_since: AtomicU64,
}

impl Activity {
    fn new() -> Arc<Self> {
        Arc::new(Activity { opened: Instant::now(), last: AtomicU64::new(0), request_since: AtomicU64::new(0) })
    }

    fn now(&self) -> u64 {
        u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX - 1)
    }

    fn touch(&self) {
        self.last.store(self.now(), Ordering::Relaxed);
    }

    fn quiet_for(&self) -> Duration {
        self.opened.elapsed().saturating_sub(Duration::from_millis(self.last.load(Ordering::Relaxed)))
    }

    fn begin_request(&self) {
        self.request_since.store(self.now() + 1, Ordering::Relaxed);
    }

    fn end_request(&self) {
        self.request_since.store(0, Ordering::Relaxed);
    }

    /// How long the request in flight has been running, if there is one.
    fn request_age(&self) -> Option<Duration> {
        match self.request_since.load(Ordering::Relaxed) {
            0 => None,
            since => Some(self.opened.elapsed().saturating_sub(Duration::from_millis(since - 1))),
        }
    }
}

/// An answer's body that marks its request done once the body is through, or dropped.
struct Answer {
    inner: axum::body::Body,
    activity: Arc<Activity>,
}

impl hyper::body::Body for Answer {
    type Data = axum::body::Bytes;
    type Error = axum::Error;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_frame(cx);
        if matches!(poll, Poll::Ready(None | Some(Err(_)))) {
            this.activity.end_request();
        }
        poll
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        self.activity.end_request();
    }
}

/// A connection's stream that notes every byte through it and holds the connection's seat for as long
/// as the stream lives, an upgraded one included.
struct Watched<T> {
    inner: T,
    activity: Arc<Activity>,
    _seat: Seat,
}

impl<T: AsyncRead + Unpin> AsyncRead for Watched<T> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let poll = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(poll, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            this.activity.touch();
        }
        poll
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Watched<T> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_write(cx, data);
        if matches!(poll, Poll::Ready(Ok(written)) if written > 0) {
            this.activity.touch();
        }
        poll
    }

    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_write_vectored(cx, data);
        if matches!(poll, Poll::Ready(Ok(written)) if written > 0) {
            this.activity.touch();
        }
        poll
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[allow(clippy::too_many_arguments, reason = "one connection's whole setting, passed once")]
async fn connection(
    tcp: TcpStream,
    peer: SocketAddr,
    seat: Seat,
    acceptor: TlsAcceptor,
    app: Router,
    limits: Limits,
    mut stop: watch::Receiver<()>,
    _done: watch::Receiver<()>,
) {
    // Before the first request nothing is in flight, so a stop simply drops the connection.
    let tls = tokio::select! {
        _ = stop.changed() => return,
        tls = open(tcp, peer, &acceptor) => match tls {
            Some(tls) => tls,
            None => return,
        },
    };
    let activity = Activity::new();
    let stream = Watched { inner: tls, activity: activity.clone(), _seat: seat };
    let (begun, answered) = (activity.clone(), activity.clone());
    let service = app
        .map_request(move |mut request: Request<Incoming>| {
            begun.begin_request();
            // What `into_make_service_with_connect_info` does for `axum::serve`: host endpoints check the peer.
            request.extensions_mut().insert(ConnectInfo(peer));
            request
        })
        .map_response(move |response: Response| response.map(|inner| Body::new(Answer { inner, activity: answered.clone() })));
    let service = TowerToHyperService::new(service);
    let mut builder = http1::Builder::new();
    builder.timer(TokioTimer::new()).header_read_timeout(limits.header_read).keep_alive(true);
    // Once upgraded (a WebSocket) the connection future is done and the stream goes to the socket's task.
    let mut conn = pin!(builder.serve_connection(TokioIo::new(stream), service).with_upgrades());
    let mut quiet = pin!(tokio::time::sleep(limits.idle));
    let mut deadline = pin!(tokio::time::sleep(limits.request));
    let mut stopping = false;
    loop {
        tokio::select! {
            result = conn.as_mut() => {
                if let Err(e) = result {
                    tracing::debug!("connection from {peer} ended: {e}");
                }
                break;
            }
            // Finishes the request in flight and closes the connection when it is idle.
            _ = stop.changed(), if !stopping => {
                stopping = true;
                conn.as_mut().graceful_shutdown();
            }
            _ = quiet.as_mut() => {
                let silent = activity.quiet_for();
                if silent >= limits.idle {
                    tracing::debug!("connection from {peer} closed: nothing for {silent:?}");
                    break;
                }
                quiet.as_mut().reset(tokio::time::Instant::now() + (limits.idle - silent));
            }
            _ = deadline.as_mut() => {
                let left = match activity.request_age() {
                    Some(age) if age >= limits.request => {
                        tracing::debug!("connection from {peer} closed: a request still running after {age:?}");
                        break;
                    }
                    Some(age) => limits.request - age,
                    None => limits.request,
                };
                deadline.as_mut().reset(tokio::time::Instant::now() + left);
            }
        }
    }
}

/// The TLS stream of a client that opened with a handshake. Anyone else is answered and dropped.
async fn open(tcp: TcpStream, peer: SocketAddr, acceptor: &TlsAcceptor) -> Option<TlsStream<TcpStream>> {
    let mut first = [0u8; 1];
    match tokio::time::timeout(OPENING_WAIT, tcp.peek(&mut first)).await {
        Ok(Ok(1)) if first[0] == TLS_HANDSHAKE_RECORD => {}
        Ok(Ok(1)) => {
            tracing::debug!("plain HTTP from {peer} refused");
            refuse(tcp).await;
            return None;
        }
        _ => return None,
    }
    match tokio::time::timeout(OPENING_WAIT, acceptor.accept(tcp)).await {
        Ok(Ok(tls)) => Some(tls),
        Ok(Err(e)) => {
            tracing::debug!("TLS handshake with {peer} failed: {e}");
            None
        }
        Err(_) => None,
    }
}

async fn refuse(mut tcp: TcpStream) {
    let body = serde_json::json!({ "error": OUTDATED_CLIENT }).to_string();
    let answer = format!(
        "HTTP/1.1 426 Upgrade Required\r\nUpgrade: TLS/1.3\r\nConnection: Upgrade, close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = tokio::time::timeout(REFUSAL_WAIT, async {
        tcp.write_all(answer.as_bytes()).await?;
        tcp.shutdown().await?;
        // Closing with the request unread makes the OS reset the connection, and a reset can discard the answer before the client reads it.
        tokio::io::copy(&mut (&mut tcp).take(REFUSAL_DRAIN), &mut tokio::io::sink()).await
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(ip: &str) -> PeerKey {
        PeerKey::of(ip.parse().unwrap())
    }

    #[test]
    fn one_home_counts_as_one_address() {
        // An IPv6 home gets a whole /64: every address in it is the same client.
        assert!(key("2001:db8:1:2:aaaa::1") == key("2001:db8:1:2:bbbb:cccc:dddd:9"));
        assert!(key("2001:db8:1:2::1") != key("2001:db8:1:3::1"));
        // An IPv4 client seen through a dual-stack socket is still that IPv4 address.
        assert!(key("::ffff:203.0.113.9") == key("203.0.113.9"));
        assert!(key("203.0.113.9") != key("203.0.113.10"));
    }
}
