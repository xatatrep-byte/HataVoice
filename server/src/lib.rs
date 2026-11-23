use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::FromRef;
use axum::http::{HeaderValue, Method, header};
use axum::routing::{any, get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use tower_http::cors::{AllowOrigin, CorsLayer};

mod api;
pub mod audit;
pub mod auth;
pub mod calls;
pub mod channels;
pub mod chat_media;
pub mod events;
pub mod group;
pub mod group_api;
pub mod cli;
pub mod host;
pub mod livekit_admin;
pub mod livekit_conf;
pub mod media;
pub mod moderation;
pub mod network;
pub mod occupancy;
pub mod people;
pub mod roster_store;
pub mod rooms;
mod rtc_proxy;
pub mod speed;
pub mod supervisor;
#[cfg(feature = "testing")]
pub mod testing;
pub mod tls;
pub mod update;
mod voice;

pub use voice::{LiveKitConfig, TokenRequest, TokenResponse, issue_token};

pub const DEFAULT_LISTEN: &str = "127.0.0.1:7350";

#[derive(Serialize)]
struct Health {
    status: &'static str,
    name: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Origin of the UI dev server (`pnpm dev`); the desktop app talks to us from Rust and needs no CORS.
const DEV_UI_ORIGIN: &str = "http://localhost:1420";

#[derive(Clone)]
pub struct AppState {
    pub livekit: Arc<LiveKitConfig>,
    /// Present only when this process hosts the server for its owner (`--data-dir`).
    pub host: Option<Arc<host::HostRuntime>>,
    /// Channels from before the journal; only read when the host carries them over.
    pub channels: Arc<channels::ChannelStore>,
    pub roster: Arc<roster_store::RosterStore>,
    pub nonces: Arc<std::sync::Mutex<hv_roster::request::NonceCache>>,
    pub mutes: Arc<moderation::MuteStore>,
    pub audit: Arc<audit::AuditLog>,
    pub media: Arc<media::MediaStore>,
    /// How often one member may upload a moderation GIF or an icon.
    pub media_rate: Arc<group_api::RateLimit>,
    pub events: Arc<events::EventHub>,
    pub calls: Arc<calls::CallStore>,
    /// The server's group (its chat): ciphertext only.
    pub group: Arc<group::GroupStore>,
    /// Every group of the chat: the server's, closed channels', direct messages'.
    pub rooms: Arc<rooms::Rooms>,
    pub group_rate: Arc<group_api::RateLimit>,
    /// Encrypted files of the chat: blobs only.
    pub chat_media: Arc<chat_media::ChatMediaStore>,
    pub chat_media_rate: Arc<group_api::RateLimit>,
    pub signal_rate: Arc<group_api::RateLimit>,
    /// How often one person may fetch the installer.
    pub update_rate: Arc<group_api::RateLimit>,
    /// How much one member may measure the way here (`speed`).
    pub speed_rate: Arc<group_api::RateLimit>,
}

impl FromRef<AppState> for Arc<LiveKitConfig> {
    fn from_ref(state: &AppState) -> Self {
        state.livekit.clone()
    }
}

/// Dev / test server: no hosting, channels kept in memory.
pub fn app(livekit: LiveKitConfig) -> Router {
    let channels = channels::ChannelStore::open(None).expect("in-memory channel store");
    let roster = roster_store::RosterStore::open(None).expect("in-memory journal");
    host_app(livekit, None, Arc::new(channels), Arc::new(roster))
}

pub fn host_app(
    livekit: LiveKitConfig,
    host: Option<Arc<host::HostRuntime>>,
    channels: Arc<channels::ChannelStore>,
    roster: Arc<roster_store::RosterStore>,
) -> Router {
    people::forget_profiles(roster.dir());
    let mutes = Arc::new(moderation::MuteStore::open(roster.dir()));
    let audit = Arc::new(audit::AuditLog::open(roster.dir()));
    let media = Arc::new(media::MediaStore::open(roster.dir()));
    let group = Arc::new(group::GroupStore::open(roster.dir()));
    let rooms = Arc::new(rooms::Rooms::open(roster.dir(), group.clone()));
    let chat_media = Arc::new(chat_media::ChatMediaStore::open(roster.dir()));
    let state = AppState {
        livekit: Arc::new(livekit),
        host,
        channels,
        mutes,
        audit,
        media,
        media_rate: Arc::new(media::upload_limit()),
        roster,
        events: Default::default(),
        calls: Default::default(),
        nonces: Default::default(),
        group,
        rooms,
        group_rate: Default::default(),
        chat_media,
        chat_media_rate: Arc::new(chat_media::upload_limit()),
        signal_rate: Arc::new(group_api::RateLimit::per(group_api::SIGNAL_BURST, group_api::SIGNAL_WINDOW)),
        update_rate: Arc::new(update::fetch_limit()),
        speed_rate: Arc::new(speed::test_limit()),
    };
    moderation::spawn_expiry(state.clone());
    events::spawn_occupancy_watch(state.clone());
    group_api::spawn_prune(state.clone());
    chat_media::spawn_prune(state.clone());
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([HeaderValue::from_static(DEV_UI_ORIGIN)]))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    Router::new()
        .route("/health", get(health))
        .route("/api/voice/token", post(api::voice_token))
        .route("/api/state", get(api::state))
        .route("/api/profile", put(api::gone))
        .route("/api/presence", put(api::gone))
        .route("/api/moderation", post(moderation::moderate))
        .route("/api/audit", get(api::audit))
        .route("/api/events", get(events::events))
        .route("/api/call/{channel}", get(calls::fetch))
        .route("/api/call/{channel}/create", post(calls::create))
        .route("/api/call/{channel}/join", post(calls::join))
        .route("/api/call/{channel}/commit", post(calls::commit))
        .route("/api/call/{channel}/leave", post(calls::leave))
        .route("/api/group", get(group_api::fetch))
        .route("/api/group/create", post(group_api::create))
        .route("/api/group/join", post(group_api::join))
        .route("/api/group/commit", post(group_api::commit))
        .route("/api/group/message", post(group_api::message))
        .route("/api/group/reset", post(group_api::reset))
        .route("/api/group/signal", post(group_api::signal))
        .route("/api/group/withdraw", post(group_api::withdraw))
        .route("/api/rooms", get(group_api::rooms))
        .route("/api/chat-media", post(chat_media::upload))
        .route("/api/chat-media/{sha}", get(chat_media::download))
        .route("/api/media", post(media::upload))
        .route("/api/media/{sha}", get(media::download))
        .route("/api/host/status", get(host::status))
        .route("/api/host/shutdown", post(host::shutdown))
        .route("/api/host/legacy-channels", get(api::legacy_channels))
        .route("/api/hello", get(api::hello))
        .route("/api/roster", get(api::get_roster).post(api::post_roster))
        .route("/api/invite", get(api::invite_info))
        .route("/api/speed/ping", get(speed::ping))
        .route("/api/speed/down", get(speed::down))
        .route("/api/speed/up", post(speed::up))
        .route("/api/update", get(update::info))
        .route("/api/update/file", get(update::file))
        .route("/api/update/android", get(update::android_info))
        .route("/api/update/android/seal", get(update::android_seal))
        .route("/api/update/android/file", get(update::android_file))
        .route("/rtc", any(rtc_proxy::proxy))
        .route("/rtc/{*rest}", any(rtc_proxy::proxy))
        .with_state(state)
        .layer(cors)
}

/// Parses the listen address, falling back to [`DEFAULT_LISTEN`] when none is given.
pub fn listen_addr(value: Option<&str>) -> Result<SocketAddr, String> {
    let raw = value.unwrap_or(DEFAULT_LISTEN);
    raw.parse()
        .map_err(|e| format!("invalid listen address {raw:?}: {e}"))
}
