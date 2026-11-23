//! Playing together's commands and its ties to the rest of the app: the signals through the server's group, the
//! window's events (`pads`), the sealed pad states it passes through LiveKit, the banner over everything and the stop
//! keys while friends play on our PC, and the quiet that lets their pads go.

use std::time::{Duration, Instant};

use hv_roster::UserId;
use hv_roster::keys::{decode_b64_vec, encode_b64};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::Chats;
use crate::pads::{PadEvent, PadState, Pads, PadsView};

/// What the windows hear of playing together.
pub const EVENT: &str = "pads";
/// How often friends' pads are checked for quiet: fine enough to let a stalled pad go after half a second.
const TICK: Duration = Duration::from_millis(100);

/// Starts the quiet check of friends' pads on our PC.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(TICK);
        loop {
            every.tick().await;
            let ended = app.state::<Pads>().tick(Instant::now());
            for event in ended {
                finish(&app, event).await;
            }
        }
    });
}

/// After a change: tells the other one when a pad ended on our side, updates the banner and the stop keys, tells
/// the windows.
async fn finish(app: &AppHandle, event: PadEvent) {
    let chats = app.state::<Chats>();
    if let PadEvent::Ended { address, channel, peer, why, .. } = &event
        && why != "peer"
    {
        let _ = chats.signal(address, &json!({ "t": "pad-stop", "ch": channel, "to": peer })).await;
    }
    let guests = app.state::<Pads>().view().guests;
    let names = guests
        .iter()
        .map(|g| chats.people(&g.address).profiles.get(&UserId(g.peer.clone())).map(|p| p.nickname.clone()).unwrap_or_else(|| "Друг".into()))
        .collect::<Vec<_>>();
    #[cfg(windows)]
    crate::ptt_hook::watch_stop(app, crate::ptt_hook::STOP_PADS, !names.is_empty());
    crate::remote_cmd::banner_pads(app, names);
    let _ = app.emit(EVENT, &event);
}

/// A pad signal from `sender` on `address`.
pub async fn on_signal(app: &AppHandle, address: &str, sender: UserId, body: Value) {
    let pads = app.state::<Pads>();
    let chats = app.state::<Chats>();
    let Ok((event, reply)) = chats.with_remote(address, |ctx, _| pads.on_signal(ctx, &sender, &body, Instant::now())) else { return };
    if let Some(reply) = reply {
        let _ = chats.signal(address, &reply).await;
    }
    if let Some(event) = event {
        finish(app, event).await;
    }
}

/// We ask `host` to let us play on their PC in voice channel `channel`.
#[tauri::command]
pub async fn pad_ask(app: AppHandle, address: String, channel: String, host: String) -> Result<(), String> {
    let pads = app.state::<Pads>();
    let chats = app.state::<Chats>();
    let body = chats.with_remote(&address, |ctx, id| pads.ask(ctx, id, &channel, &UserId(host), Instant::now()))??;
    chats.signal(&address, &body).await
}

/// Our answer to `guest`: let them play on our PC with a pad, or not.
#[tauri::command]
pub async fn pad_answer(app: AppHandle, address: String, guest: String, allow: bool) -> Result<(), String> {
    let pads = app.state::<Pads>();
    let chats = app.state::<Chats>();
    let guest = UserId(guest);
    let (body, started) = chats.with_remote(&address, |ctx, id| pads.answer(ctx, id, &guest, allow, Instant::now()))??;
    if let Err(e) = chats.signal(&address, &body).await {
        // They never heard yes: their pad comes out again.
        let _ = pads.kick(&address, &guest);
        return Err(e);
    }
    if let Some(started) = started {
        finish(&app, started).await;
    }
    Ok(())
}

/// Our pad's state sealed for the PC we play on, and to whom it goes (their identity in the call).
#[derive(Serialize)]
pub struct Sealed {
    to: String,
    packet: String,
}

#[tauri::command]
pub fn pad_seal(app: AppHandle, state: PadState) -> Result<Sealed, String> {
    let (to, packet) = app.state::<Pads>().seal(&state)?;
    Ok(Sealed { to, packet: encode_b64(&packet) })
}

/// A packet that came through the call from `from`: their pad on our PC takes it, if it is theirs.
#[tauri::command]
pub async fn pad_input(app: AppHandle, from: String, packet: String) {
    let Some(packet) = decode_b64_vec(&packet) else { return };
    let ended = app.state::<Pads>().open(&UserId(from), &packet, Instant::now());
    if let Some(ended) = ended {
        finish(&app, ended).await;
    }
}

/// We take `guest`'s pad out of our PC.
#[tauri::command]
pub async fn pad_kick(app: AppHandle, address: String, guest: String) {
    let ended = app.state::<Pads>().kick(&address, &UserId(guest));
    if let Some(ended) = ended {
        finish(&app, ended).await;
    }
}

/// Every friend's pad out of our PC.
#[tauri::command]
pub async fn pad_stop_all(app: AppHandle) {
    let ended = app.state::<Pads>().stop_all();
    for event in ended {
        finish(&app, event).await;
    }
}

/// We stop playing on someone's PC.
#[tauri::command]
pub async fn pad_release(app: AppHandle) {
    let ended = app.state::<Pads>().release();
    if let Some(ended) = ended {
        finish(&app, ended).await;
    }
}

#[tauri::command]
pub fn pad_state(app: AppHandle) -> PadsView {
    app.state::<Pads>().view()
}

/// The driver for pads is on this PC.
#[tauri::command]
pub fn pad_driver(app: AppHandle) -> bool {
    app.state::<Pads>().driver_present()
}
