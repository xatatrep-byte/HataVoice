//! «Любой сайт» in watch-together: the site right in the call (a second webview of the main window over the stage, the
//! player alone shown: «theater») or in a window of its own, and a small script in each of its frames (watch_agent.js)
//! that finds the video and the site's choices (its «Плеер 1/2/3», the player's season, episode and dub), reports them
//! through the page's title and obeys play, pause, seek and a choice to make.
//!
//! Nothing of the program is reachable from that page: Tauri refuses every command of a remote page that no capability
//! names with its address, and none does. It cannot go to the program's own addresses or to anything but http(s),
//! cannot open windows (adverts love those), and every permission it asks for (microphone, camera, screen…) is refused.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "watch-browser";
/// The site in the call: a webview of the main window, over the stage's video box.
pub const VIEW: &str = "watch-view";
const AGENT: &str = include_str!("watch_agent.js");
/// What the agent puts before its word in the page's title.
const MARK: &str = "\u{2063}HV\u{2063}";
const TITLE: &str = "ХатаВойс — просмотр";
const MAX_TEXT: usize = 500;
const MAX_POS: u64 = 7 * 24 * 3600 * 1000;
/// The longest word the agent may write (its choices trimmed to fit, see `fit` in watch_agent.js).
const MAX_WORD: usize = 16 * 1024;
/// The kinds of choices, in the order they are made.
pub const KINDS: [&str; 4] = ["players", "season", "episode", "dub"];
const LABEL_MAX: usize = 60;

fn most(kind: &str) -> usize {
    match kind {
        "players" => 12,
        "episode" => 400,
        _ => 60,
    }
}

fn label(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect()
}

/// A list of choices on the page: its items' words and which one is chosen now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Group {
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub active: usize,
}

/// The video the agent found: whether it plays, where it is and how long it is (ms), and the frame it is in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Video {
    pub playing: bool,
    pub pos: u64,
    pub dur: u64,
    #[serde(default)]
    pub frame: String,
}

/// The agent's word: the site's own title, its video if it has one, its choices, and whether the player is shown alone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentWord {
    #[serde(rename = "t", default)]
    pub title: String,
    #[serde(rename = "v", default)]
    pub video: Option<Video>,
    #[serde(rename = "c", default)]
    pub choices: BTreeMap<String, Group>,
    #[serde(rename = "th", default)]
    pub theater: bool,
}

/// What a title says, if the agent wrote it; trimmed to sizes the program shows.
pub fn read_word(title: &str) -> Option<AgentWord> {
    let json = title.strip_prefix(MARK)?;
    if json.len() > MAX_WORD {
        return None;
    }
    let mut word: AgentWord = serde_json::from_str(json).ok()?;
    word.title = word.title.chars().filter(|c| !c.is_control()).take(200).collect();
    word.choices.retain(|kind, group| {
        group.items.truncate(most(kind));
        group.items = group.items.iter().map(|item| label(item)).collect();
        group.active = group.active.min(group.items.len().saturating_sub(1));
        KINDS.contains(&kind.as_str()) && !group.items.is_empty()
    });
    if let Some(video) = word.video.as_mut() {
        video.pos = video.pos.min(MAX_POS);
        video.dur = video.dur.min(MAX_POS);
        video.frame = video.frame.chars().filter(|c| !c.is_control()).take(MAX_TEXT).collect();
    }
    Some(word)
}

/// An address of this PC or of a home network: a router's page, a NAS, the program's own servers.
fn private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast()
                // Shared address space (CGNAT, also Radmin VPN's 26.x is public, ZeroTier's is private anyway).
                || (a == 100 && (64..128).contains(&b))
                || a == 0
                || a >= 240
        }
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || v6.is_unspecified() || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| private_ip(std::net::IpAddr::V4(v4)))
        }
    }
}

/// Only plain sites on the internet: never the program's own pages (they could reach its commands), never files or
/// other schemes, and never a page of this PC or the home network (a link a friend shares must not open the owner's
/// router or anything else only reachable from inside).
pub fn may_open(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") || url.as_str().chars().count() > 2000 {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => !private_ip(ip.into()),
        Some(url::Host::Ipv6(ip)) => !private_ip(ip.into()),
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            // A name without a dot is a machine on the home network; these endings are only ever local.
            let local_endings = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".home.arpa"];
            name.contains('.') && name != "localhost" && !local_endings.iter().any(|end| name.ends_with(end))
        }
        None => false,
    }
}

fn parse(url: &str) -> Result<Url, String> {
    let url = Url::parse(url.trim()).map_err(|_| "Это не ссылка на сайт".to_string())?;
    if may_open(&url) {
        Ok(url)
    } else {
        Err("Такой адрес здесь не открыть".into())
    }
}

#[derive(Clone, Serialize)]
struct PageLoaded {
    url: String,
}

/// Whether `url` may be opened for watching together, as the address to open: Android opens it in a window of its own
/// (`WatchActivity`), checked here first.
#[tauri::command]
pub fn watch_browser_check(url: String) -> Result<String, String> {
    parse(&url).map(|url| url.to_string())
}

/// A phone has one window per app in Tauri: the site opens in Android's own (see `watch_browser_check`).
#[cfg(mobile)]
const NO_WINDOWS: &str = "На телефоне сайт открывается окном Android";

/// Opens the site for watching together (or goes to it in the window already open).
#[cfg(mobile)]
#[tauri::command]
pub async fn watch_browser_open(_app: AppHandle, url: String) -> Result<(), String> {
    parse(&url)?;
    Err(NO_WINDOWS.into())
}

/// Opens the site for watching together (or goes to it in the window already open).
#[cfg(desktop)]
#[tauri::command]
pub async fn watch_browser_open(app: AppHandle, url: String) -> Result<(), String> {
    let url = parse(&url)?;
    if let Some(window) = app.get_webview_window(LABEL) {
        window.navigate(url).map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url));
    // Debug builds only: a test copy puts the window beyond the desktop (HATAVOICE_WATCH_AT=x,y), off the owner's screen.
    #[cfg(debug_assertions)]
    if let Some((x, y)) = std::env::var("HATAVOICE_WATCH_AT").ok().and_then(|v| {
        let (x, y) = v.split_once(',')?;
        Some((x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?))
    }) {
        builder = builder.position(x, y);
    }
    let window = builder
        // The same browser as the main window's: WebView2 refuses a second set of arguments for one data folder.
        .additional_browser_args(crate::BROWSER_ARGS)
        .title(TITLE)
        .inner_size(1280.0, 760.0)
        .min_inner_size(640.0, 400.0)
        .initialization_script_for_all_frames(AGENT)
        .on_navigation(may_open)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_document_title_changed(|window, title| {
            if let Some(word) = read_word(&title) {
                let name = if word.title.is_empty() { TITLE.to_string() } else { format!("{} — {TITLE}", word.title) };
                let _ = window.set_title(&name);
                let _ = window.app_handle().emit_to("main", "watch-agent", word);
            }
        })
        .on_page_load(|webview, payload| {
            let _ = webview.app_handle().emit_to("main", "watch-browser-url", PageLoaded { url: payload.url().to_string() });
        })
        .build()
        .map_err(|e| format!("Окно просмотра не открылось: {e}"))?;
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app_handle.emit_to("main", "watch-browser-closed", ());
        }
    });
    Ok(())
}

/// The page watched: in the call, or in its window.
fn watched(app: &AppHandle) -> Option<tauri::Webview> {
    app.get_webview(VIEW).or_else(|| app.get_webview(LABEL))
}

/// What the program asks of the site's video or of the page: `play`, `pause`, `seek` (to `ms`), `rate` (the speed in
/// `ms`, kept between 0.5 and 2: catching up with everyone), `choose` (item `label` of list `kind`), `theater` (`on`:
/// the player alone over the page), `back`, `forward`, `reload`, or `navigate` (to `url`).
#[tauri::command]
pub fn watch_browser_command(app: AppHandle, op: String, ms: Option<f64>, url: Option<String>, kind: Option<String>, label: Option<String>, on: Option<bool>) -> Result<(), String> {
    let window = watched(&app).ok_or("Окно просмотра закрыто")?;
    let script = match op.as_str() {
        "play" | "pause" => format!("window.__hvWatch && window.__hvWatch.command({})", serde_json::json!({ "op": op })),
        "seek" => {
            let ms = ms.filter(|m| m.is_finite() && *m >= 0.0).ok_or("Куда перемотать?")?;
            format!("window.__hvWatch && window.__hvWatch.command({})", serde_json::json!({ "op": "seek", "ms": ms.min(MAX_POS as f64) }))
        }
        "rate" => {
            let rate = ms.filter(|r| r.is_finite()).ok_or("Какая скорость?")?.clamp(0.5, 2.0);
            format!("window.__hvWatch && window.__hvWatch.command({})", serde_json::json!({ "op": "rate", "rate": rate }))
        }
        "choose" => {
            let kind = kind.filter(|k| KINDS.contains(&k.as_str())).ok_or("Такого выбора нет")?;
            let label = label.filter(|l| !l.is_empty() && l.chars().count() <= LABEL_MAX).ok_or("Что выбрать?")?;
            format!("window.__hvWatch && window.__hvWatch.command({})", serde_json::json!({ "op": "choose", "kind": kind, "label": label }))
        }
        "theater" => format!("window.__hvWatch && window.__hvWatch.command({})", serde_json::json!({ "op": "theater", "on": on.unwrap_or(true) })),
        "back" => "history.back()".into(),
        "forward" => "history.forward()".into(),
        "reload" => "location.reload()".into(),
        "navigate" => {
            let url = parse(url.as_deref().ok_or("Куда перейти?")?)?;
            window.navigate(url).map_err(|e| e.to_string())?;
            return Ok(());
        }
        _ => return Err("Такой команды нет".into()),
    };
    window.eval(&script).map_err(|e| e.to_string())
}

/// Shows the window again (it may be behind the call); the site in the call is in sight already.
#[tauri::command]
pub fn watch_browser_focus(app: AppHandle) -> Result<(), String> {
    if app.get_webview(VIEW).is_some() {
        return Ok(());
    }
    let window = app.get_webview_window(LABEL).ok_or("Окно просмотра закрыто")?;
    #[cfg(desktop)]
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watch_browser_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
    close_view(&app);
}

/// A box of the main window's page (logical pixels from its top left), kept to sane numbers.
#[cfg_attr(mobile, allow(dead_code))]
fn rect(x: f64, y: f64, width: f64, height: f64) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    let n = |v: f64, lo: f64| if v.is_finite() { v.clamp(lo, 20_000.0) } else { lo };
    (tauri::LogicalPosition::new(n(x, -20_000.0), n(y, -20_000.0)), tauri::LogicalSize::new(n(width, 1.0), n(height, 1.0)))
}

/// Opening and closing the site in the call go one at a time, each with the page's turn (a number that only grows): a
/// page that closes it and opens it again at once (React does so in a debug build) has its commands run in any order,
/// and the close of an older turn must not take away what a newer one opened.
static VIEW_TURN: tokio::sync::Mutex<u64> = tokio::sync::Mutex::const_new(0);

/// Whether a close of `turn` closes what is open now (opened at `current`).
fn closes(current: u64, turn: u64) -> bool {
    turn == current
}

/// Whether an open of `turn` is still wanted (nothing newer was opened since).
fn opens(current: u64, turn: u64) -> bool {
    turn >= current
}

#[cfg_attr(mobile, allow(dead_code))]
const THEATER: &str = "window.__hvWatch && window.__hvWatch.command({\"op\":\"theater\",\"on\":true})";

/// Opens the site right in the call, over the box `x, y, width, height` of the page (or goes to it in the one open).
#[cfg(desktop)]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn watch_view_open(app: AppHandle, url: String, x: f64, y: f64, width: f64, height: f64, turn: u64) -> Result<(), String> {
    let url = parse(&url)?;
    let (at, size) = rect(x, y, width, height);
    let mut current = VIEW_TURN.lock().await;
    if !opens(*current, turn) {
        return Ok(());
    }
    *current = turn;
    if let Some(view) = app.get_webview(VIEW) {
        if view.url().map(|now| now != url).unwrap_or(true) {
            view.navigate(url).map_err(|e| e.to_string())?;
        }
        let _ = view.set_position(at);
        let _ = view.set_size(size);
        return view.show().map_err(|e| e.to_string());
    }
    let main = app.get_window("main").ok_or("Нет окна")?;
    let builder = tauri::webview::WebviewBuilder::new(VIEW, WebviewUrl::External(url))
        // The same browser as the main window's: WebView2 refuses a second set of arguments for one data folder.
        .additional_browser_args(crate::BROWSER_ARGS)
        .initialization_script_for_all_frames(AGENT)
        .focused(false)
        .on_navigation(may_open)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_document_title_changed(|view, title| {
            if let Some(word) = read_word(&title) {
                let _ = view.app_handle().emit_to("main", "watch-agent", word);
            }
        })
        .on_page_load(|view, payload| {
            let _ = view.app_handle().emit_to("main", "watch-browser-url", PageLoaded { url: payload.url().to_string() });
            // In the call the player is shown alone: the site around it (and its adverts) would only be in the way.
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = view.eval(THEATER);
            }
        });
    main.add_child(builder, at, size).map_err(|e| format!("Сайт не открылся: {e}"))?;
    Ok(())
}

/// A phone has no second webview in a window: the site opens in Android's own (see `watch_browser_check`).
#[cfg(mobile)]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn watch_view_open(_app: AppHandle, url: String, _x: f64, _y: f64, _width: f64, _height: f64, _turn: u64) -> Result<(), String> {
    parse(&url)?;
    Err(NO_WINDOWS.into())
}

/// Moves the site in the call over the box `x, y, width, height`; `shown: false` hides it (the box is out of sight, or
/// something of the program is drawn over it: a webview always covers the page).
#[cfg(desktop)]
#[tauri::command]
pub fn watch_view_place(app: AppHandle, x: f64, y: f64, width: f64, height: f64, shown: bool) -> Result<(), String> {
    let view = app.get_webview(VIEW).ok_or("Окно просмотра закрыто")?;
    if !shown {
        return view.hide().map_err(|e| e.to_string());
    }
    let (at, size) = rect(x, y, width, height);
    view.set_position(at).map_err(|e| e.to_string())?;
    view.set_size(size).map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())
}

/// A phone has no site in the call (see `watch_view_open`).
#[cfg(mobile)]
#[tauri::command]
pub fn watch_view_place(_app: AppHandle, _x: f64, _y: f64, _width: f64, _height: f64, _shown: bool) -> Result<(), String> {
    Err(NO_WINDOWS.into())
}

/// Closes the site in the call opened at `turn` (see `VIEW_TURN`).
#[tauri::command]
pub async fn watch_view_close(app: AppHandle, turn: u64) {
    let current = VIEW_TURN.lock().await;
    if closes(*current, turn) {
        close_view(&app);
    }
}

fn close_view(app: &AppHandle) {
    #[cfg(mobile)]
    let _ = app;
    #[cfg(desktop)]
    if let Some(view) = app.get_webview(VIEW) {
        let _ = view.close();
        let _ = app.emit_to("main", "watch-browser-closed", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_sites_open_never_the_programs_own_pages() {
        let ok = |s: &str| may_open(&Url::parse(s).unwrap());
        assert!(ok("https://example.com/serial/7-3"));
        assert!(ok("http://example.org/"));
        for bad in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://localhost:1420/",
            "http://ipc.localhost/identity_forget",
            "http://hvmedia.localhost/x",
            "http://127.0.0.1:7350/",
            "http://[::1]/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,hi",
        ] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[test]
    fn a_page_of_this_pc_or_the_home_network_does_not_open() {
        let ok = |s: &str| may_open(&Url::parse(s).unwrap());
        for bad in [
            "http://192.168.1.1/reboot",
            "http://10.0.0.138/",
            "http://172.16.5.4/",
            "http://127.0.0.2:7350/api/host/status",
            "http://2130706433/",
            "http://0x7f.1/",
            "http://169.254.1.1/",
            "http://100.64.0.1/",
            "http://0.0.0.0:7880/",
            "http://[::ffff:192.168.0.1]/",
            "http://[fe80::1]/",
            "http://[fd12:3456::1]/",
            "http://router/",
            "http://nas.local/",
            "http://printer.lan/",
            "http://box.home.arpa/",
            "http://LOCALHOST./",
        ] {
            assert!(!ok(bad), "{bad}");
        }
        for good in ["http://8.8.8.8/", "https://vkvideo.ru/video-1_2", "https://[2a00:1450:4010::65]/", "http://26.10.20.30/"] {
            assert!(ok(good), "{good}");
        }
    }

    #[test]
    fn a_title_is_read_only_when_the_agent_wrote_it_and_is_trimmed() {
        assert_eq!(read_word("Рик и Морти — смотреть онлайн"), None);
        let word = read_word("\u{2063}HV\u{2063}{\"t\":\"Серия 3\",\"v\":{\"playing\":true,\"pos\":504000,\"dur\":1330000,\"frame\":\"https://player.example/embed/1\"}}").unwrap();
        assert_eq!(word.title, "Серия 3");
        assert_eq!(word.video, Some(Video { playing: true, pos: 504000, dur: 1330000, frame: "https://player.example/embed/1".into() }));
        let long = format!("\u{2063}HV\u{2063}{{\"t\":\"{}\",\"v\":{{\"playing\":false,\"pos\":999999999999,\"dur\":1,\"frame\":\"x\"}}}}", "а".repeat(500));
        let word = read_word(&long).unwrap();
        assert_eq!(word.title.chars().count(), 200);
        assert_eq!(word.video.unwrap().pos, MAX_POS);
        assert_eq!(read_word("\u{2063}HV\u{2063}not json"), None);
        assert_eq!(read_word("\u{2063}HV\u{2063}{\"t\":\"Нет видео\",\"v\":null}").unwrap().video, None);
    }

    #[test]
    fn the_choices_of_a_page_are_read_in_four_kinds_and_sane_sizes() {
        let word = read_word(&format!(
            "\u{2063}HV\u{2063}{}",
            serde_json::json!({
                "t": "Серия",
                "v": null,
                "th": true,
                "c": {
                    "players": { "items": ["Плеер 1", "Плеер 2"], "active": 1 },
                    "episode": { "items": (1..=500).map(|i| format!("{i} серия")).collect::<Vec<_>>(), "active": 900 },
                    "dub": { "items": ["x".repeat(100), "BTi\u{0007}Studios"], "active": 0 },
                    "season": { "items": [], "active": 0 },
                    "script": { "items": ["<b>"], "active": 0 }
                }
            })
        ))
        .unwrap();
        assert!(word.theater);
        assert_eq!(word.choices.keys().collect::<Vec<_>>(), ["dub", "episode", "players"]);
        assert_eq!(word.choices["players"], Group { items: vec!["Плеер 1".into(), "Плеер 2".into()], active: 1 });
        assert_eq!(word.choices["episode"].items.len(), 400);
        assert_eq!(word.choices["episode"].active, 399);
        assert_eq!(word.choices["dub"].items, vec!["x".repeat(60), "BTiStudios".to_string()]);
        let long = format!("\u{2063}HV\u{2063}{{\"t\":\"{}\"}}", "а".repeat(9000));
        assert_eq!(read_word(&long), None, "a word longer than the agent writes is not read");
    }

    #[test]
    fn a_close_of_an_older_turn_leaves_what_a_newer_one_opened() {
        // React in a debug build: open 1, close 1, open 2 — run by Tauri in any order.
        assert!(opens(0, 1) && opens(1, 2) && opens(2, 2));
        assert!(!opens(2, 1), "an older open that runs late is not wanted");
        assert!(closes(1, 1));
        assert!(!closes(2, 1), "the close of turn 1 after open 2 leaves the site open");
    }

    #[test]
    fn a_box_for_the_site_in_the_call_is_kept_to_sane_numbers() {
        let (at, size) = rect(f64::NAN, 10.0, -5.0, f64::INFINITY);
        assert_eq!((at.x, at.y), (-20_000.0, 10.0));
        assert_eq!((size.width, size.height), (1.0, 1.0));
    }
}
