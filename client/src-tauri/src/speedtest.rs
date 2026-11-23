//! «Проверка скорости»: how fast the way is to the server we are on (through its pinned, signed channel, members only)
//! or to the internet: test files that hosting companies put out for this, one in Russia (Selectel) and one in Europe
//! (Hetzner, Helsinki), so a line blocked one way still shows the other. They see only that this PC fetched a file.
//! Nothing of a chat or a call takes part, and nothing is kept. A VPN that is on is named: any test measures it then.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::commands::{AppIdentity, Sessions, link_of, text};

/// A first, small piece each way: how fast it went sizes the second, which takes about this long.
const FIRST_BYTES: usize = 1024 * 1024;
const AIM: Duration = Duration::from_secs(3);
/// The biggest piece (as the server allows, `speed::MAX_TEST_BYTES`).
const MOST_BYTES: usize = 32 * 1024 * 1024;
const PINGS: usize = 5;
/// The internet's test points: a name to show and a big file to fetch (it is never fetched whole).
const POINTS: [(&str, &str); 2] = [("Россия (Selectel)", "https://speedtest.selectel.ru/1GB"), ("Европа (Hetzner, Хельсинки)", "https://hel1-speed.hetzner.com/1GB.bin")];
/// Fetched at once over this many connections, for this long: one connection does not fill a fast line.
const STREAMS: usize = 4;
const DOWN_FOR: Duration = Duration::from_secs(6);

/// What a test found: the round trip (ms, the best of a few) and both ways (megabits a second).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Speed {
    pub ping_ms: f64,
    pub down_mbps: f64,
    pub up_mbps: f64,
}

/// Megabits a second for `bytes` moved in `took`.
pub fn mbps(bytes: usize, took: Duration) -> f64 {
    let seconds = took.as_secs_f64().max(0.001);
    (bytes as f64 * 8.0 / seconds / 1_000_000.0 * 10.0).round() / 10.0
}

/// The second piece's size: what the first one's speed moves in about `AIM`, between the first's size and the most.
pub fn next_size(first: usize, took: Duration) -> usize {
    let per_second = first as f64 / took.as_secs_f64().max(0.001);
    ((per_second * AIM.as_secs_f64()) as usize).clamp(FIRST_BYTES, MOST_BYTES)
}

/// The best of the round trips measured, ms.
fn best_ms(times: &[Duration]) -> f64 {
    let best = times.iter().min().copied().unwrap_or_default();
    (best.as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

/// A way to measure: a round trip, `n` bytes down, `n` bytes up; each says how long it took.
trait Way {
    async fn ping(&self) -> Result<Duration, String>;
    async fn down(&self, n: usize) -> Result<Duration, String>;
    async fn up(&self, n: usize) -> Result<Duration, String>;
}

async fn measure(way: &impl Way) -> Result<Speed, String> {
    let mut pings = Vec::new();
    for _ in 0..PINGS {
        pings.push(way.ping().await?);
    }
    let first = way.down(FIRST_BYTES).await?;
    let size = next_size(FIRST_BYTES, first);
    let down = mbps(size, way.down(size).await?);
    let first = way.up(FIRST_BYTES).await?;
    let size = next_size(FIRST_BYTES, first);
    let up = mbps(size, way.up(size).await?);
    Ok(Speed { ping_ms: best_ms(&pings), down_mbps: down, up_mbps: up })
}

/// The server we are on, through its own channel.
struct ToServer {
    link: crate::session::Link,
    id: hv_roster::Identity,
}

impl Way for ToServer {
    async fn ping(&self) -> Result<Duration, String> {
        let at = Instant::now();
        let (status, _) = self.link.exchange_bytes(&self.id, "GET", "/api/speed/ping", Vec::new(), 4096).await.map_err(text)?;
        if status != 200 {
            return Err(old_server(status));
        }
        Ok(at.elapsed())
    }

    async fn down(&self, n: usize) -> Result<Duration, String> {
        let at = Instant::now();
        let (status, bytes) = self.link.exchange_bytes(&self.id, "GET", &format!("/api/speed/down?bytes={n}"), Vec::new(), n + 1024).await.map_err(text)?;
        if status != 200 || bytes.len() != n {
            return Err(old_server(status));
        }
        Ok(at.elapsed())
    }

    async fn up(&self, n: usize) -> Result<Duration, String> {
        let body = vec![0x5a; n];
        let at = Instant::now();
        let (status, _) = self.link.exchange_bytes(&self.id, "POST", "/api/speed/up", body, 4096).await.map_err(text)?;
        if status != 200 {
            return Err(old_server(status));
        }
        Ok(at.elapsed())
    }
}

fn old_server(status: u16) -> String {
    match status {
        404 | 405 => "Сервер не умеет проверять скорость — его нужно обновить".into(),
        429 => "Слишком много проверок — подожди минуту".into(),
        _ => format!("Сервер ответил {status}"),
    }
}

/// What one test point of the internet showed: its round trip and how fast it came, or why it did not.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PointSpeed {
    pub name: String,
    pub ping_ms: Option<f64>,
    pub down_mbps: Option<f64>,
    pub error: Option<String>,
}

/// The internet test: each point, and the VPN that is on, if one looks to be (every test measures it then).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InternetSpeed {
    pub points: Vec<PointSpeed>,
    pub vpn: Option<String>,
}

fn unreachable(error: reqwest::Error) -> String {
    if error.is_timeout() { "Не ответил вовремя".into() } else { "Нет связи".into() }
}

/// The best of a few round trips to `url`: until its answer begins (a byte of it asked; the body is never read, a server
/// that sends it all anyway is not waited for).
async fn ping_of(http: &reqwest::Client, url: &str) -> Result<f64, String> {
    let mut times = Vec::new();
    for _ in 0..PINGS {
        let at = Instant::now();
        let response = http.get(url).header("range", "bytes=0-0").send().await.map_err(unreachable)?;
        times.push(at.elapsed());
        if !response.status().is_success() {
            return Err(format!("Ответил {}", response.status().as_u16()));
        }
        drop(response);
    }
    // The first one opens the connection (TLS takes its own round trips): it is not counted.
    Ok(best_ms(&times[1.min(times.len() - 1)..]))
}

/// How fast `url` comes over [`STREAMS`] connections for `limit` (megabits a second).
async fn down_of(http: &reqwest::Client, url: &str, limit: Duration) -> Result<f64, String> {
    let started = Instant::now();
    let stream = |_| async {
        let mut response = http.get(url).send().await.map_err(unreachable)?;
        if !response.status().is_success() {
            return Err(format!("Ответил {}", response.status().as_u16()));
        }
        let mut got = 0usize;
        while started.elapsed() < limit {
            match tokio::time::timeout(limit.saturating_sub(started.elapsed()), response.chunk()).await {
                Ok(Ok(Some(chunk))) => got += chunk.len(),
                Ok(Ok(None)) | Err(_) => break,
                Ok(Err(e)) => return Err(unreachable(e)),
            }
        }
        Ok::<usize, String>(got)
    };
    let results = futures_util::future::join_all((0..STREAMS).map(stream)).await;
    let took = started.elapsed();
    let got: usize = results.iter().filter_map(|r| r.as_ref().ok()).sum();
    if got == 0 {
        return Err(results.into_iter().find_map(Result::err).unwrap_or_else(|| "Ничего не пришло".into()));
    }
    Ok(mbps(got, took))
}

/// One test point: its round trip, then how fast it comes.
async fn point_speed(http: &reqwest::Client, name: &str, url: &str, limit: Duration) -> PointSpeed {
    let ping = match ping_of(http, url).await {
        Ok(ping) => ping,
        Err(error) => return PointSpeed { name: name.into(), ping_ms: None, down_mbps: None, error: Some(error) },
    };
    match down_of(http, url, limit).await {
        Ok(down) => PointSpeed { name: name.into(), ping_ms: Some(ping), down_mbps: Some(down), error: None },
        Err(error) => PointSpeed { name: name.into(), ping_ms: Some(ping), down_mbps: None, error: Some(error) },
    }
}

/// Names a network adapter that looks like a VPN (by what it calls itself), or `None`.
pub fn vpn_name(description: &str, friendly: &str) -> Option<String> {
    const MARKS: [&str; 22] = [
        "wireguard", "wintun", "tap-windows", "tap-win32", "openvpn", "amnezia", "outline", "vpn", "nekoray", "hiddify", "v2ray", "xray", "sing-box",
        "singbox", "clash", "mihomo", "happ", "proton", "nordlynx", "tunnel", "wiretap", "zerotier",
    ];
    const NOT: [&str; 5] = ["teredo", "isatap", "6to4", "ip-https", "loopback"];
    let both = format!("{description} {friendly}").to_lowercase();
    if NOT.iter().any(|n| both.contains(n)) {
        return None;
    }
    MARKS.iter().any(|m| both.contains(m)).then(|| if friendly.trim().is_empty() { description.trim() } else { friendly.trim() }.to_string())
}

/// A VPN adapter that is up now, by name (Windows); `None` elsewhere or when none looks to be.
fn vpn_on() -> Option<String> {
    #[cfg(windows)]
    {
        use windows::Win32::NetworkManagement::IpHelper::{GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH};
        use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
        use windows::Win32::Networking::WinSock::AF_UNSPEC;
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size = 64 * 1024u32;
        let mut buffer = vec![0u8; size as usize];
        // SAFETY: the buffer is as big as told; Windows fills a linked list inside it, read before the buffer goes.
        unsafe {
            let mut result = GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(buffer.as_mut_ptr().cast()), &mut size);
            if result == 111 {
                buffer = vec![0u8; size as usize];
                result = GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(buffer.as_mut_ptr().cast()), &mut size);
            }
            if result != 0 {
                return None;
            }
            let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
            while !adapter.is_null() {
                let a = &*adapter;
                if a.OperStatus == IfOperStatusUp {
                    let description = a.Description.to_string().unwrap_or_default();
                    let friendly = a.FriendlyName.to_string().unwrap_or_default();
                    if let Some(name) = vpn_name(&description, &friendly) {
                        return Some(name);
                    }
                }
                adapter = a.Next;
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Measures the way to the server at `address` (we are on it).
#[tauri::command]
pub async fn speed_server(identity: tauri::State<'_, AppIdentity>, sessions: tauri::State<'_, Sessions>, address: String) -> Result<Speed, String> {
    let link = link_of(&sessions.0, &address).await?;
    measure(&ToServer { link, id: identity.get() }).await
}

/// Measures the way to the internet: each test point in turn, and whether a VPN is on.
#[tauri::command]
pub async fn speed_internet() -> Result<InternetSpeed, String> {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("HataVoice")
        .build()
        .map_err(|e| e.to_string())?;
    let mut points = Vec::new();
    for (name, url) in POINTS {
        points.push(point_speed(&http, name, url, DOWN_FOR).await);
    }
    Ok(InternetSpeed { points, vpn: vpn_on() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_is_megabits_a_second() {
        assert_eq!(mbps(12_500_000, Duration::from_secs(1)), 100.0);
        assert_eq!(mbps(1_000_000, Duration::from_millis(500)), 16.0);
    }

    #[test]
    fn the_second_piece_takes_about_three_seconds_within_bounds() {
        assert_eq!(next_size(FIRST_BYTES, Duration::from_millis(100)), MOST_BYTES.min(FIRST_BYTES * 30));
        assert_eq!(next_size(FIRST_BYTES, Duration::from_secs(10)), FIRST_BYTES, "a slow line is not asked for less");
        assert_eq!(next_size(FIRST_BYTES, Duration::from_micros(1)), MOST_BYTES);
    }

    struct Fake;
    impl Way for Fake {
        async fn ping(&self) -> Result<Duration, String> {
            Ok(Duration::from_millis(12))
        }
        async fn down(&self, n: usize) -> Result<Duration, String> {
            Ok(Duration::from_secs_f64(n as f64 / 12_500_000.0))
        }
        async fn up(&self, n: usize) -> Result<Duration, String> {
            Ok(Duration::from_secs_f64(n as f64 / 2_500_000.0))
        }
    }

    #[test]
    fn a_vpn_is_told_by_what_its_adapter_calls_itself() {
        assert_eq!(vpn_name("WireGuard Tunnel", "AmneziaVPN").as_deref(), Some("AmneziaVPN"));
        assert_eq!(vpn_name("TAP-Windows Adapter V9", "").as_deref(), Some("TAP-Windows Adapter V9"));
        assert_eq!(vpn_name("Wintun Userspace Tunnel", "nekoray-tun").as_deref(), Some("nekoray-tun"));
        assert_eq!(vpn_name("Intel(R) Wi-Fi 6 AX201 160MHz", "Беспроводная сеть"), None);
        assert_eq!(vpn_name("Realtek PCIe GbE Family Controller", "Ethernet"), None);
        assert_eq!(vpn_name("Teredo Tunneling Pseudo-Interface", "Teredo"), None, "Windows's own tunnels are not a VPN");
    }

    #[tokio::test]
    async fn a_test_point_gives_its_round_trip_and_how_fast_it_comes() {
        use axum::Router;
        use axum::routing::get;
        // A file that comes as fast as it can, endlessly.
        let body = || async {
            let chunk = axum::body::Bytes::from(vec![7u8; 64 * 1024]);
            let stream = futures_util::stream::repeat_with(move || Ok::<_, std::io::Error>(chunk.clone()));
            axum::body::Body::from_stream(stream)
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, Router::new().route("/file", get(body))).await });
        let http = reqwest::Client::new();
        let point = point_speed(&http, "тест", &format!("http://{address}/file"), Duration::from_millis(400)).await;
        assert_eq!(point.error, None);
        assert!(point.ping_ms.unwrap() < 200.0, "{point:?}");
        assert!(point.down_mbps.unwrap() > 10.0, "{point:?}");
        let gone = point_speed(&http, "нет", "http://127.0.0.1:9/file", Duration::from_millis(100)).await;
        assert_eq!((gone.ping_ms, gone.error.as_deref()), (None, Some("Нет связи")));
    }

    #[tokio::test]
    async fn a_test_finds_the_round_trip_and_both_ways() {
        assert_eq!(measure(&Fake).await.unwrap(), Speed { ping_ms: 12.0, down_mbps: 100.0, up_mbps: 20.0 });
    }
}
