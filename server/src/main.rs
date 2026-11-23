use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, RwLock};

use hatavoice_server::channels::{CHANNELS_FILE, ChannelStore};
use hatavoice_server::host::HostRuntime;
use hatavoice_server::roster_store::RosterStore;
use hatavoice_server::supervisor::{self, LiveKitProcess};
use hatavoice_server::{LiveKitConfig, livekit_conf, network, tls};
use hv_host::{HostConfig, Secrets};

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt().with_target(false).init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match hatavoice_server::cli::parse(&args) {
        Ok(cli) => cli,
        Err(e) => {
            tracing::error!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let result = match cli.data_dir {
        Some(dir) => run_host(&dir, cli.livekit_bin).await,
        None => run_dev().await,
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// Development: LiveKit is started separately (`livekit-server --dev`), settings come from env.
async fn run_dev() -> Result<(), String> {
    let env_listen = std::env::var("HATAVOICE_LISTEN").ok();
    let addr = hatavoice_server::listen_addr(env_listen.as_deref())?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("cannot listen on {addr}: {e}"))?;
    tracing::info!("hatavoice-server (dev) listening on {addr} (TLS)");

    let livekit = LiveKitConfig::from_env();
    match &livekit.public_url {
        Some(url) => tracing::info!("LiveKit signaling for clients: {url}"),
        None => tracing::info!("LiveKit signaling proxied from {}", livekit.internal_url),
    }
    // `hatavoice_server::app` would hide the roster, and the TLS certificate is issued by its server key.
    let channels = Arc::new(ChannelStore::open(None)?);
    let roster = Arc::new(RosterStore::open(None)?);
    let tls_config = tls_config(&roster)?;
    let app = hatavoice_server::host_app(livekit, None, channels, roster);
    tls::serve(listener, app, tls_config, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .map_err(|e| format!("server error: {e}"))
}

fn tls_config(roster: &RosterStore) -> Result<Arc<rustls::ServerConfig>, String> {
    hv_tls::server_config(roster.server_identity())
        .map(Arc::new)
        .map_err(|e| format!("Не удалось подготовить TLS для сервера: {e}"))
}

/// The endpoint's key: kept, so that the server's address in the tunnel stays the same and invites stay good.
fn tunnel_secret(dir: &Path) -> Result<[u8; 32], String> {
    let path = dir.join("p2p.key");
    if let Ok(bytes) = std::fs::read(&path)
        && let Ok(secret) = <[u8; 32]>::try_from(bytes.as_slice())
    {
        return Ok(secret);
    }
    let mut secret = [0; 32];
    getrandom::fill(&mut secret).map_err(|e| e.to_string())?;
    std::fs::write(&path, secret).map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
    Ok(secret)
}

async fn start_tunnel(dir: &Path, listener: &tokio::net::TcpListener, media_port: u16, upnp: bool) -> Option<hv_p2p::Host> {
    let api = listener.local_addr().ok()?;
    let media = std::net::SocketAddr::from((Ipv4Addr::UNSPECIFIED, media_port));
    // A step of its own in the log: should the tunnel take the process down, the tail of the log says so.
    tracing::info!("starting the tunnel");
    let started = async { hv_p2p::Host::start(tunnel_secret(dir)?, api, media, upnp).await }.await;
    match started {
        Ok(host) => {
            tracing::info!(address = host.address(), "reachable by key");
            Some(host)
        }
        Err(e) => {
            tracing::warn!("no tunnel: {e}");
            None
        }
    }
}

fn default_livekit_bin() -> PathBuf {
    let name = if cfg!(windows) { "livekit-server.exe" } else { "livekit-server" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Host mode: our own LiveKit child, generated keys, router ports via UPnP.
async fn run_host(dir: &Path, livekit_bin: Option<PathBuf>) -> Result<(), String> {
    hv_host::protect::set_dir(dir);
    let config = HostConfig::load_or_create(dir)?;
    let secrets = Secrets::load_or_create(dir)?;

    // Take the public port first, so a busy port is reported before anything else starts.
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, config.api_port))
        .await
        .map_err(|e| format!("Порт {} занят или недоступен: {e}", config.api_port))?;
    tracing::info!("«{}» listening on port {} (TLS)", config.name, config.api_port);

    let report = network::map_ports(&config).await;
    tracing::info!(upnp = ?report.upnp, public_ip = ?report.public_ip, "network");

    let config_path = dir.join("livekit.yaml");
    std::fs::write(&config_path, livekit_conf::render(&config, &secrets, report.public_ip))
        .map_err(|e| format!("Не записывается {}: {e}", config_path.display()))?;
    let livekit_state = supervisor::spawn(LiveKitProcess {
        binary: livekit_bin.unwrap_or_else(default_livekit_bin),
        config_path,
        log_path: dir.join("livekit.log"),
        port: config.livekit_port,
    });

    let network = Arc::new(RwLock::new(report));
    if config.upnp {
        // Renew the leases before they expire.
        let (config, network) = (config.clone(), network.clone());
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(network::LEASE / 2).await;
                let fresh = network::map_ports(&config).await;
                *network.write().unwrap_or_else(|e| e.into_inner()) = fresh;
            }
        });
    }

    let shutdown = Arc::new(tokio::sync::Notify::new());
    // The tunnel for friends with no way to our public address, or when we have none. It comes in on a port of its own:
    // whoever arrives there is never taken for this PC.
    let tunnel_listener = if config.p2p { tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.ok() } else { None };
    let tunnel = match &tunnel_listener {
        Some(listener) => start_tunnel(dir, listener, config.rtc_udp_port, config.upnp).await,
        None => None,
    };
    let runtime = Arc::new(HostRuntime {
        config: config.clone(),
        livekit: livekit_state,
        network,
        p2p_address: tunnel.as_ref().map(hv_p2p::Host::address),
        shutdown: shutdown.clone(),
    });
    let livekit = LiveKitConfig {
        internal_url: format!("http://127.0.0.1:{}", config.livekit_port),
        public_url: None,
        api_key: secrets.livekit_key,
        api_secret: secrets.livekit_secret,
    };
    let channels = Arc::new(ChannelStore::open(Some(dir.join(CHANNELS_FILE)))?);
    let roster = Arc::new(RosterStore::open(Some(dir))?);
    let tls_config = tls_config(&roster)?;
    let app = hatavoice_server::host_app(livekit, Some(runtime), channels, roster);

    if let Some(listener) = tunnel_listener {
        let (app, tls_config, shutdown) = (app.clone(), tls_config.clone(), shutdown.clone());
        tokio::spawn(async move {
            let _ = tls::serve_tunnel(listener, app, tls_config, async move { shutdown.notified().await }).await;
        });
    }

    let served = tls::serve(listener, app, tls_config, async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = shutdown.notified() => {}
        }
        tracing::info!("shutting down");
    })
    .await;
    network::unmap_ports(&config).await;
    served.map_err(|e| format!("server error: {e}"))
}
