//! Remote control's commands and its ties to the rest of the app: the signals through the server's group, the
//! window's events (`remote`), the sealed input it passes through LiveKit, the hands that play it here, and the
//! silence that ends it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use hv_roster::UserId;
use hv_roster::keys::{decode_b64_vec, encode_b64};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

use crate::chat::Chats;
use crate::remote::{Held, Input, Remote, RemoteEvent, Screen, SessionView};
use crate::remote_input;

/// What the windows hear of remote control.
pub const EVENT: &str = "remote";
/// How often control we host is checked for silence.
const TICK: Duration = Duration::from_secs(2);

/// One of our screens, to pick which one takes the input.
#[derive(Debug, Clone, Serialize)]
pub struct ScreenChoice {
    pub index: usize,
    pub name: String,
    pub primary: bool,
    #[serde(flatten)]
    pub screen: Screen,
}

/// Starts the silence check of control we host.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(TICK);
        loop {
            every.tick().await;
            let ended = app.state::<Remote>().tick(Instant::now());
            if let (Some(RemoteEvent::Ended { address, peer, .. }), _) = &ended {
                let (address, peer) = (address.clone(), peer.clone());
                finish(&app, ended);
                let _ = tell(&app, &address, "", &UserId(peer)).await;
            }
        }
    });
}

/// Tells `peer` that control is over.
async fn tell(app: &AppHandle, address: &str, channel: &str, peer: &UserId) -> Result<(), String> {
    app.state::<Chats>().signal(address, &json!({ "t": "rc-stop", "ch": channel, "to": peer })).await
}

/// The banner over everything while someone controls our PC (its label; the page draws it alone).
pub const BANNER: &str = "remote-banner";
const BANNER_WIDTH: f64 = 600.0;
const BANNER_HEIGHT: f64 = 56.0;

/// What the banner says: who controls us, and how; and who plays on our PC with a pad.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BannerInfo {
    remote: Option<ControlBanner>,
    pads: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ControlBanner {
    name: String,
    keyboard: bool,
}

static BANNER_INFO: Mutex<BannerInfo> = Mutex::new(BannerInfo { remote: None, pads: Vec::new() });
/// The person turned the banner off in the settings: control and pads go on without it.
static BANNER_OFF: AtomicBool = AtomicBool::new(false);
/// The person closed it for now: it stays away until control and pads are over and something new begins.
static BANNER_CLOSED: AtomicBool = AtomicBool::new(false);

/// The friends who play on our PC with pads, for the banner (none: their part goes).
pub fn banner_pads(app: &AppHandle, names: Vec<String>) {
    BANNER_INFO.lock().unwrap_or_else(|e| e.into_inner()).pads = names;
    update_banner(app);
}

fn banner_remote(app: &AppHandle, remote: Option<ControlBanner>) {
    BANNER_INFO.lock().unwrap_or_else(|e| e.into_inner()).remote = remote;
    update_banner(app);
}

/// Shows the banner while it has something to say, and takes it away when it has not.
fn update_banner(app: &AppHandle) {
    let empty = {
        let info = BANNER_INFO.lock().unwrap_or_else(|e| e.into_inner());
        info.remote.is_none() && info.pads.is_empty()
    };
    if empty {
        BANNER_CLOSED.store(false, Ordering::Relaxed);
        hide_banner(app);
    } else if BANNER_OFF.load(Ordering::Relaxed) || BANNER_CLOSED.load(Ordering::Relaxed) {
        hide_banner(app);
    } else {
        tauri::async_runtime::spawn(show_banner(app.clone()));
    }
}

/// The banner on or off, as the settings say (the main window tells it at start and on every change).
#[tauri::command]
pub fn remote_banner_setting(app: AppHandle, on: bool) {
    BANNER_OFF.store(!on, Ordering::Relaxed);
    update_banner(&app);
}

/// «Скрыть» on the banner: away until this control (and the pads) are over.
#[tauri::command]
pub fn remote_banner_close(app: AppHandle) {
    BANNER_CLOSED.store(true, Ordering::Relaxed);
    update_banner(&app);
}

/// A phone gives no one control of itself, so it has nothing to warn about.
#[cfg(mobile)]
async fn show_banner(_app: AppHandle) {}

/// Shows the banner at the top of the main screen, over everything; it never takes the focus but takes clicks.
#[cfg(desktop)]
async fn show_banner(app: AppHandle) {
    let window = match app.get_webview_window(BANNER) {
        Some(window) => window,
        None => {
            let built = WebviewWindowBuilder::new(&app, BANNER, WebviewUrl::default())
                .title("ХатаВойс — тобой управляют")
                .additional_browser_args(crate::BROWSER_ARGS)
                .inner_size(BANNER_WIDTH, BANNER_HEIGHT)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build();
            match built {
                Ok(window) => window,
                Err(e) => {
                    eprintln!("remote banner: {e}");
                    return;
                }
            }
        }
    };
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let size = LogicalSize::new(BANNER_WIDTH, BANNER_HEIGHT).to_physical::<u32>(scale);
        let x = area.position.x + (area.size.width.saturating_sub(size.width) / 2) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, area.position.y + (8.0 * scale) as i32));
    }
    let _ = window.emit(EVENT, json!({ "kind": "banner" }));
    let _ = window.show();
}

fn hide_banner(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(BANNER) {
        let _ = window.destroy();
    }
}

/// What the banner says now.
#[tauri::command]
pub fn remote_banner() -> BannerInfo {
    BANNER_INFO.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// After a change of control: lets go of what was held, shows or takes away the banner and the stop keys, tells the
/// windows.
fn finish(app: &AppHandle, (event, held): (Option<RemoteEvent>, Vec<Held>)) {
    remote_input::release(&held);
    let Some(event) = event else { return };
    match &event {
        RemoteEvent::Started { address, peer, keyboard, host: true, .. } => {
            let people = app.state::<Chats>().people(address);
            let name = people.profiles.get(&UserId(peer.clone())).map(|p| p.nickname.clone()).unwrap_or_else(|| "Друг".into());
            #[cfg(windows)]
            crate::ptt_hook::watch_stop(app, crate::ptt_hook::STOP_REMOTE, true);
            banner_remote(app, Some(ControlBanner { name, keyboard: *keyboard }));
        }
        RemoteEvent::Ended { host: true, .. } => {
            #[cfg(windows)]
            crate::ptt_hook::watch_stop(app, crate::ptt_hook::STOP_REMOTE, false);
            banner_remote(app, None);
        }
        _ => {}
    }
    let _ = app.emit(EVENT, &event);
}

/// A remote-control signal from `sender` on `address` (or a game pad's, which goes to pads).
pub async fn on_signal(app: &AppHandle, address: &str, sender: UserId, body: Value) {
    if body["t"].as_str().is_some_and(|t| t.starts_with("pad-")) {
        return crate::pads_cmd::on_signal(app, address, sender, body).await;
    }
    let remote = app.state::<Remote>();
    let outcome = app.state::<Chats>().with_remote(address, |ctx, _| remote.on_signal(ctx, &sender, &body, Instant::now()));
    if let Ok(outcome) = outcome {
        finish(app, outcome);
    }
}

#[tauri::command]
pub fn remote_screens(app: AppHandle) -> Vec<ScreenChoice> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, m)| ScreenChoice {
            index,
            name: format!("Экран {}", index + 1),
            primary: Some(*m.position()) == primary,
            screen: Screen { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height },
        })
        .collect()
}

/// We ask `host` to let us control their screen in voice channel `channel`.
#[tauri::command]
pub async fn remote_ask(app: AppHandle, address: String, channel: String, host: String) -> Result<(), String> {
    let remote = app.state::<Remote>();
    let chats = app.state::<Chats>();
    let body = chats.with_remote(&address, |ctx, id| remote.ask(ctx, id, &channel, &UserId(host), Instant::now()))??;
    chats.signal(&address, &body).await
}

/// Our answer to `viewer`: let them in (with or without the keyboard, on our screen number `screen`) or not.
#[tauri::command]
pub async fn remote_answer(app: AppHandle, address: String, viewer: String, allow: bool, keyboard: bool, screen: Option<usize>) -> Result<(), String> {
    let screens = remote_screens(app.clone());
    let chosen = screen
        .and_then(|i| screens.get(i))
        .or_else(|| screens.iter().find(|s| s.primary))
        .or(screens.first())
        .map(|s| s.screen);
    // A phone plays the friend's input itself, by parts of its own screen (`ControlService.kt`): no monitor to choose.
    let chosen = if cfg!(mobile) { chosen.or(Some(Screen { x: 0, y: 0, width: 1, height: 1 })) } else { chosen };
    let chosen = chosen.ok_or("Не вижу ни одного экрана")?;
    let remote = app.state::<Remote>();
    let chats = app.state::<Chats>();
    let viewer = UserId(viewer);
    let (body, started) = chats.with_remote(&address, |ctx, id| remote.answer(ctx, id, &viewer, allow, keyboard, chosen, Instant::now()))??;
    if let Err(e) = chats.signal(&address, &body).await {
        // They never heard yes: no control.
        let _ = remote.stop();
        return Err(e);
    }
    finish(&app, (started, Vec::new()));
    Ok(())
}

/// The packet sealed for the PC we control, and to whom it goes (their identity in the call).
#[derive(Serialize)]
pub struct Sealed {
    to: String,
    packet: String,
}

#[tauri::command]
pub fn remote_seal(app: AppHandle, input: Input, lossy: bool) -> Result<Sealed, String> {
    let (to, packet) = app.state::<Remote>().seal(&input, lossy)?;
    Ok(Sealed { to, packet: encode_b64(&packet) })
}

/// A packet that came through the call from `from`: played if it is theirs and allowed.
#[tauri::command]
pub fn remote_input(app: AppHandle, from: String, packet: String) {
    let Some(packet) = decode_b64_vec(&packet) else { return };
    if let Some((input, screen)) = app.state::<Remote>().open(&UserId(from), &packet, Instant::now()) {
        remote_input::play(&input, screen);
    }
}

/// A packet as `remote_input` takes it, but handed back instead of played: a phone plays it itself, through its
/// accessibility service (`ControlService.kt`). The same checks: theirs, newer than the last, of a kind we allowed.
#[tauri::command]
pub fn remote_open(app: AppHandle, from: String, packet: String) -> Option<Input> {
    let packet = decode_b64_vec(&packet)?;
    app.state::<Remote>().open(&UserId(from), &packet, Instant::now()).map(|(input, _)| input)
}

/// We end control, whichever side we are.
#[tauri::command]
pub async fn remote_stop(app: AppHandle) -> Result<(), String> {
    let Some((view, held)) = app.state::<Remote>().stop() else { return Ok(()) };
    let ended = RemoteEvent::Ended { address: view.address.clone(), peer: view.peer.clone(), host: view.host, why: "stopped".into() };
    finish(&app, (Some(ended), held));
    tell(&app, &view.address, &view.channel, &UserId(view.peer)).await
}

#[tauri::command]
pub fn remote_state(app: AppHandle) -> Option<SessionView> {
    app.state::<Remote>().view()
}
