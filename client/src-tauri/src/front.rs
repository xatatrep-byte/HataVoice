//! Linux: the system's web view (WebKitGTK) has no WebRTC, so no call could start in it. The window there is a browser of
//! the Chromium family the user already has, in a profile of its own and with no browser around the page. The program
//! stays what it is: the page's `invoke` and events go over a local pipe to a hidden Tauri window, which makes the real
//! calls (`front_shim.js` on one end, `platform/relay.ts` on the other), so every command and every permission is as on
//! any other system. With no such browser the page opens in the web view as usual, and works but for calls.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
use tokio::sync::mpsc;

use crate::bridge::Bridge;

/// In the order they are worth trying. `HATAVOICE_BROWSER` names any other.
const BROWSERS: [&str; 10] = [
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
    "microsoft-edge-stable",
    "microsoft-edge",
    "brave-browser",
    "brave",
    "vivaldi-stable",
    "opera",
];

const SHIM: &str = include_str!("front_shim.js");
const PORT_FILE: &str = "front.port";
const PROFILE_DIR: &str = "browser";

type Tx = mpsc::UnboundedSender<Message>;

/// The pipe's two ends. What the page says before the hidden window is ready waits for it.
#[derive(Default)]
struct Ends {
    page: Option<Tx>,
    relay: Option<Tx>,
    waiting: VecDeque<Message>,
}

struct Front {
    app: AppHandle,
    secret: String,
    csp: String,
    ends: Mutex<Ends>,
}

/// `name` on the PATH.
fn on_path(name: &str, path: &str) -> Option<PathBuf> {
    std::env::split_paths(path).map(|dir| dir.join(name)).find(|file| file.is_file())
}

fn find_browser() -> Option<PathBuf> {
    if let Ok(chosen) = std::env::var("HATAVOICE_BROWSER")
        && !chosen.is_empty()
    {
        return Some(PathBuf::from(chosen));
    }
    let path = std::env::var("PATH").unwrap_or_default();
    BROWSERS.iter().find_map(|name| on_path(name, &path))
}

/// The page with the shim first of all its scripts.
fn with_shim(html: &str, secret: &str) -> String {
    let script = format!(r#"<script src="/{secret}/shim.js"></script>"#);
    match html.find("<head>") {
        Some(at) => {
            let at = at + "<head>".len();
            format!("{}{script}{}", &html[..at], &html[at..])
        }
        None => format!("{script}{html}"),
    }
}

/// What the profile starts with: the program's page may use the microphone and show notifications without asking each time
/// (it asks in its own words), and no welcome pages.
fn first_preferences(port: u16) -> String {
    let origin = format!("http://127.0.0.1:{port},*");
    let allowed = serde_json::json!({ origin: { "setting": 1 } });
    serde_json::json!({
        "browser": { "has_seen_welcome_page": true, "check_default_browser": false },
        "profile": {
            "exit_type": "Normal",
            "content_settings": {
                "exceptions": {
                    "media_stream_mic": allowed,
                    "media_stream_camera": allowed,
                    "notifications": allowed,
                    "clipboard": allowed,
                }
            }
        }
    })
    .to_string()
}

/// The browser's arguments. Nothing but this page lives in that profile.
fn browser_args(url: &str, profile: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        format!("--app={url}"),
        format!("--user-data-dir={}", profile.display()),
        "--class=HataVoice".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-extensions".to_string(),
        "--disable-sync".to_string(),
        "--autoplay-policy=no-user-gesture-required".to_string(),
        // Screen sharing under Wayland, and the video card for video where the driver lets it.
        "--enable-features=WebRTCPipeWireCapturer,VaapiVideoDecoder,VaapiVideoEncoder,AcceleratedVideoEncoder".to_string(),
    ]
    .into();
    if let Ok(extra) = std::env::var("HATAVOICE_BROWSER_ARGS") {
        args.extend(extra.split_whitespace().map(str::to_string));
    }
    args
}

/// The port of the page's address: the browser keeps everything (settings, servers) under it, so it has to stay the same.
async fn listen(dir: &Path) -> Result<(tokio::net::TcpListener, u16), String> {
    let file = dir.join(PORT_FILE);
    let saved = std::fs::read_to_string(&file).ok().and_then(|text| text.trim().parse::<u16>().ok());
    if let Some(port) = saved
        && let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await
    {
        return Ok((listener, port));
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Не открывается порт окна: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::fs::write(&file, port.to_string()).map_err(|e| e.to_string())?;
    Ok((listener, port))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Не найдено").into_response()
}

async fn index(State(front): State<Arc<Front>>, UrlPath(secret): UrlPath<String>) -> Response {
    if !crate::bridge::same(&secret, &front.secret) {
        return not_found();
    }
    let Some(asset) = front.app.asset_resolver().get("index.html".to_string()) else { return not_found() };
    let html = with_shim(&String::from_utf8_lossy(asset.bytes()), &secret);
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()), (header::CONTENT_SECURITY_POLICY, front.csp.clone()), (header::CACHE_CONTROL, "no-store".to_string())], html)
        .into_response()
}

async fn shim(State(front): State<Arc<Front>>, UrlPath(secret): UrlPath<String>) -> Response {
    if !crate::bridge::same(&secret, &front.secret) {
        return not_found();
    }
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], SHIM.replace("__SECRET__", &secret)).into_response()
}

/// The program's own files: the same for everyone, so they ask for no secret.
async fn asset(State(front): State<Arc<Front>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() || path.contains("..") {
        return not_found();
    }
    let Some(asset) = front.app.asset_resolver().get(path) else { return not_found() };
    let mime = asset.mime_type().to_string();
    ([(header::CONTENT_TYPE, mime), (header::CONTENT_SECURITY_POLICY, front.csp.clone())], asset.bytes().to_vec()).into_response()
}

/// The chat's and the server's files, as the `hvmedia` scheme gives them to a web view.
async fn media(State(front): State<Arc<Front>>, uri: Uri) -> Response {
    let prefix = format!("/{}/hvmedia", front.secret);
    let Some(path) = uri.path().strip_prefix(prefix.as_str()) else { return not_found() };
    let result = if path.starts_with("/chat/") {
        crate::chat::media(&front.app, path).await
    } else if path.starts_with("/avatar/") {
        crate::avatar::media(&front.app, path).await
    } else {
        match front.app.try_state::<Arc<Bridge>>() {
            Some(bridge) => crate::bridge::media(&bridge, path).await,
            None => Err((503, "Мост ещё не запущен".to_string())),
        }
    };
    let (parts, body) = crate::bridge::media_reply(result).into_parts();
    Response::from_parts(parts, Body::from(body))
}

#[derive(Deserialize)]
struct Side {
    side: String,
}

async fn pipe(
    State(front): State<Arc<Front>>,
    UrlPath(secret): UrlPath<String>,
    Query(side): Query<Side>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !crate::bridge::same(&secret, &front.secret) {
        return not_found();
    }
    let is_page = side.side == "page";
    // A file of the chat comes through here whole.
    const BIG: usize = 256 * 1024 * 1024;
    upgrade.max_message_size(BIG).max_frame_size(BIG).on_upgrade(move |socket| run_end(front, socket, is_page))
}

async fn run_end(front: Arc<Front>, socket: WebSocket, is_page: bool) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    {
        let mut ends = front.ends.lock().unwrap_or_else(|e| e.into_inner());
        if is_page {
            ends.page = Some(tx.clone());
        } else {
            for message in std::mem::take(&mut ends.waiting) {
                let _ = tx.send(message);
            }
            ends.relay = Some(tx.clone());
        }
    }
    let (mut out, mut incoming) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if out.send(message).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(message)) = incoming.next().await {
        if !matches!(message, Message::Text(_) | Message::Binary(_)) {
            continue;
        }
        let mut ends = front.ends.lock().unwrap_or_else(|e| e.into_inner());
        if is_page {
            match &ends.relay {
                Some(relay) => {
                    let _ = relay.send(message);
                }
                None => ends.waiting.push_back(message),
            }
        } else if let Some(page) = &ends.page {
            let _ = page.send(message);
        }
    }
    writer.abort();
    let mut ends = front.ends.lock().unwrap_or_else(|e| e.into_inner());
    if is_page {
        // The page was reloaded or closed: what it listened to is listened to by no one.
        if ends.page.as_ref().is_some_and(|page| page.same_channel(&tx)) {
            ends.page = None;
            ends.waiting.clear();
            if let Some(relay) = &ends.relay {
                let _ = relay.send(Message::Text(r#"{"pageGone":true}"#.into()));
            }
        }
    } else if ends.relay.as_ref().is_some_and(|relay| relay.same_channel(&tx)) {
        ends.relay = None;
    }
}

/// Opens the program's window: in a browser when there is one, in the web view otherwise.
pub fn open(app: &tauri::App) -> Result<(), String> {
    let config = app.config().app.windows.first().cloned().ok_or("Нет настроек окна")?;
    let builder = WebviewWindowBuilder::from_config(app, &config).map_err(|e| e.to_string())?;
    let Some(browser) = find_browser() else {
        builder.visible(true).build().map_err(|e| e.to_string())?;
        return Ok(());
    };

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (listener, port) = tauri::async_runtime::block_on(listen(&dir))?;
    let secret: String = crate::bridge::random_secret()?;
    let front = Arc::new(Front {
        app: app.handle().clone(),
        secret: secret.clone(),
        csp: app.config().app.security.csp.as_ref().map(ToString::to_string).unwrap_or_default(),
        ends: Mutex::default(),
    });
    let router = Router::new()
        .route("/{secret}/", get(index))
        .route("/{secret}/shim.js", get(shim))
        .route("/{secret}/pipe", get(pipe))
        .route("/{secret}/hvmedia/{*rest}", get(media))
        .fallback(asset)
        .with_state(front);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("window server stopped: {e}");
        }
    });

    let relay = serde_json::json!({ "port": port, "secret": secret });
    builder
        .visible(false)
        .initialization_script(format!("window.__HV_RELAY__ = {relay};"))
        .build()
        .map_err(|e| e.to_string())?;

    let profile = dir.join(PROFILE_DIR);
    let preferences = profile.join("Default").join("Preferences");
    if !preferences.exists() {
        std::fs::create_dir_all(profile.join("Default")).map_err(|e| e.to_string())?;
        std::fs::write(&preferences, first_preferences(port)).map_err(|e| e.to_string())?;
    }
    let url = format!("http://127.0.0.1:{port}/{secret}/");
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let started = std::process::Command::new(&browser).args(browser_args(&url, &profile)).spawn();
        match started {
            // The program lives as long as its window.
            Ok(mut child) => {
                let _ = child.wait();
                handle.exit(0);
            }
            Err(e) => {
                eprintln!("{} did not start: {e}", browser.display());
                handle.exit(1);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shim_comes_before_every_other_script() {
        let html = r#"<!doctype html><html><head><meta charset="UTF-8"><script type="module" src="/assets/a.js"></script></head></html>"#;
        let out = with_shim(html, "S3");
        let shim = out.find(r#"src="/S3/shim.js""#).unwrap();
        assert!(shim < out.find("/assets/a.js").unwrap());
        assert!(with_shim("<p>no head</p>", "S3").starts_with("<script"));
    }

    #[test]
    fn the_first_preferences_name_only_this_page() {
        let parsed: serde_json::Value = serde_json::from_str(&first_preferences(4242)).unwrap();
        let mic = &parsed["profile"]["content_settings"]["exceptions"]["media_stream_mic"];
        assert_eq!(mic["http://127.0.0.1:4242,*"]["setting"], 1);
        assert_eq!(mic.as_object().unwrap().len(), 1);
    }

    #[test]
    fn a_browser_is_found_on_the_path() {
        let dir = std::env::temp_dir().join(format!("hv-front-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chromium"), "").unwrap();
        assert_eq!(on_path("chromium", dir.to_str().unwrap()), Some(dir.join("chromium")));
        assert_eq!(on_path("opera", dir.to_str().unwrap()), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nothing_else_lives_in_the_browsers_profile() {
        let args = browser_args("http://127.0.0.1:1/s/", Path::new("/data/browser"));
        assert!(args.contains(&"--app=http://127.0.0.1:1/s/".to_string()));
        assert!(args.contains(&"--user-data-dir=/data/browser".to_string()));
        assert!(args.contains(&"--disable-extensions".to_string()));
    }
}
