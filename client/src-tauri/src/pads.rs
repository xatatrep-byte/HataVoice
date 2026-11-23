//! Playing together (block E2): friends in the call play on our PC with their own game pads, each one a virtual
//! Xbox 360 controller here, once we let them. Asking and letting go through the server's group, signed with each
//! one's identity key and each with a one-time X25519 key, as remote control does (`remote.rs`), under labels of
//! their own, so nothing of one can pass for the other. A pad's state then comes as LiveKit data packets to us
//! alone, sealed under the pair's key and numbered. See docs/superpowers/specs/2026-10-30-split-screen-design.md.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hv_roster::keys::{decode_b64, encode_b64};
use hv_roster::{Identity, PublicKey, Signature, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use x25519_dalek as x25519;

use crate::remote::{Ctx, Lanes, field, one_time_key, session_key, statement};
use crate::vpad::{PadId, PlugError, VirtualPads};

/// At most this many friends play on our PC at once: XInput has four places, the first is usually ours.
pub const MAX_GUESTS: usize = 3;
/// A pad that says nothing for this long lets go of everything (no stick stays pushed).
pub const STALL: Duration = Duration::from_millis(500);
/// A friend who says nothing for this long stops playing.
pub use crate::remote::SILENCE;
const ASK_TTL: Duration = Duration::from_secs(60);
/// What every sealed pad state is bound to.
const AAD: &[u8] = b"hatavoice-pad-input-v1";
/// The label of a pad session key.
const KEY_LABEL: &str = "hatavoice-pad-v1";
/// A pad's state, sealed or not, is exactly this long.
pub const STATE_LEN: usize = 12;
/// The Xbox button: it would open the Game Bar and Steam's overlay on our PC, so it never gets through.
pub const GUIDE: u16 = 0x0400;

pub const NO_ASK: &str = "Просьба о геймпаде уже не действует";
pub const NOT_PLAYING: &str = "Ты сейчас не играешь геймпадом";
pub const ALREADY: &str = "Ты уже играешь геймпадом";

/// One whole state of a game pad, as XInput has it: buttons, triggers 0–255, sticks −32768…32767 (up is plus).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PadState {
    pub buttons: u16,
    pub lt: u8,
    pub rt: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}

impl PadState {
    pub fn to_bytes(self) -> [u8; STATE_LEN] {
        let mut b = [0u8; STATE_LEN];
        b[0..2].copy_from_slice(&(self.buttons & !GUIDE).to_le_bytes());
        b[2] = self.lt;
        b[3] = self.rt;
        for (i, axis) in [self.lx, self.ly, self.rx, self.ry].into_iter().enumerate() {
            b[4 + 2 * i..6 + 2 * i].copy_from_slice(&axis.to_le_bytes());
        }
        b
    }

    /// The state in `bytes`, if they are one; the Xbox button is let go of whatever it says.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        let b: &[u8; STATE_LEN] = bytes.try_into().ok()?;
        let axis = |i: usize| i16::from_le_bytes([b[4 + 2 * i], b[5 + 2 * i]]);
        Some(Self { buttons: u16::from_le_bytes([b[0], b[1]]) & !GUIDE, lt: b[2], rt: b[3], lx: axis(0), ly: axis(1), rx: axis(2), ry: axis(3) })
    }
}

/// What the window is told (`pads`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PadEvent {
    /// `user` asks to play on our PC with a pad.
    Asked { address: String, channel: String, user: String },
    /// `user` asked, but this PC has no driver for pads: the card that says where to get it.
    NoDriver { address: String, user: String },
    /// A pad began: we play on `peer`'s PC as `player` (`host: false`), or `peer` plays on ours.
    Started { address: String, channel: String, peer: String, host: bool, player: u8 },
    /// `user` did not let us play; `why`: `denied`, `full`, `no-driver`, `failed`.
    Refused { address: String, user: String, why: String },
    /// A pad ended; `why`: `stopped` (by us), `peer` (by them), `silence`, `failed`.
    Ended { address: String, channel: String, peer: String, host: bool, why: String },
}

/// Our side of playing together now, for the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PadsView {
    /// We play on someone's PC.
    pub playing: Option<PlayView>,
    /// Friends who play on ours.
    pub guests: Vec<PlayView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlayView {
    pub address: String,
    pub channel: String,
    /// The other one: the host we play on, or the friend who plays on ours.
    pub peer: String,
    pub player: u8,
}

/// A friend who plays on our PC.
struct Guest {
    address: String,
    channel: String,
    peer: UserId,
    lanes: Lanes,
    pad: PadId,
    player: u8,
    heard: Instant,
    /// The pad was let go of after a stall, and nothing came since.
    stalled: bool,
}

/// Our playing on someone's PC.
struct Playing {
    address: String,
    channel: String,
    host: UserId,
    lanes: Lanes,
    player: u8,
}

struct Asking {
    address: String,
    channel: String,
    host: UserId,
    secret: x25519::StaticSecret,
    at: Instant,
}

struct Asked {
    channel: String,
    public: [u8; 32],
    at: Instant,
}

#[derive(Default)]
struct State {
    asking: Option<Asking>,
    asked: HashMap<(String, UserId), Asked>,
    playing: Option<Playing>,
    guests: Vec<Guest>,
}

/// Playing together on this PC, both ways: our pad on someone's PC, and friends' pads on ours.
pub struct Pads {
    state: Mutex<State>,
    driver: Box<dyn VirtualPads>,
}

fn ask_statement(server_key: &PublicKey, channel: &str, guest: &UserId, host: &UserId, guest_pub: &[u8; 32]) -> Vec<u8> {
    statement(json!(["hatavoice-pad-ask-v1", server_key, channel, guest, host, encode_b64(guest_pub)]))
}

#[allow(clippy::too_many_arguments)]
fn grant_statement(server_key: &PublicKey, channel: &str, host: &UserId, guest: &UserId, host_pub: &[u8; 32], guest_pub: &[u8; 32], player: u8) -> Vec<u8> {
    statement(json!(["hatavoice-pad-grant-v1", server_key, channel, host, guest, encode_b64(host_pub), encode_b64(guest_pub), player]))
}

fn view_of_guest(g: &Guest) -> PlayView {
    PlayView { address: g.address.clone(), channel: g.channel.clone(), peer: g.peer.0.clone(), player: g.player }
}

impl Pads {
    pub fn new(driver: Box<dyn VirtualPads>) -> Self {
        Self { state: Mutex::new(State::default()), driver }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn driver_present(&self) -> bool {
        self.driver.present()
    }

    /// We ask `host` to let us play on their PC in voice channel `channel`: the signal to send them.
    pub fn ask(&self, ctx: &Ctx, id: &Identity, channel: &str, host: &UserId, now: Instant) -> Result<Value, String> {
        let mut state = self.lock();
        if state.playing.is_some() {
            return Err(ALREADY.into());
        }
        let (secret, public) = one_time_key()?;
        let signature = id.sign(&ask_statement(&ctx.server_key, channel, &ctx.me, host, &public));
        state.asking = Some(Asking { address: ctx.address.into(), channel: channel.into(), host: host.clone(), secret, at: now });
        Ok(json!({ "t": "pad-ask", "ch": channel, "to": host, "pub": encode_b64(&public), "sig": encode_b64(&signature.0) }))
    }

    /// Our answer to `guest`'s ask: the signal to send them, and, when they play now, the start. A pad is plugged in
    /// for them before they hear yes.
    pub fn answer(&self, ctx: &Ctx, id: &Identity, guest: &UserId, allow: bool, now: Instant) -> Result<(Value, Option<PadEvent>), String> {
        let mut state = self.lock();
        let asked = state.asked.remove(&(ctx.address.to_string(), guest.clone())).filter(|a| now.duration_since(a.at) < ASK_TTL).ok_or(NO_ASK)?;
        let channel = asked.channel;
        let refuse = |why: &str| Ok((json!({ "t": "pad-refuse", "ch": channel, "to": guest, "why": why }), None));
        if !allow {
            return refuse("denied");
        }
        if state.guests.len() >= MAX_GUESTS {
            return refuse("full");
        }
        let (pad, player) = match self.driver.plug() {
            Ok(plugged) => plugged,
            Err(PlugError::NoDriver) => return refuse("no-driver"),
            Err(PlugError::Full) => return refuse("full"),
            Err(PlugError::Failed(_)) => return refuse("failed"),
        };
        let keyed = one_time_key().ok().and_then(|(secret, public)| {
            let key = session_key(KEY_LABEL, &secret, &asked.public, &ctx.server_key, &channel, (&ctx.me, guest), (&public, &asked.public))?;
            Some((key, public))
        });
        let Some((key, public)) = keyed else {
            self.driver.unplug(pad);
            return Err(NO_ASK.into());
        };
        let signature = id.sign(&grant_statement(&ctx.server_key, &channel, &ctx.me, guest, &public, &asked.public, player));
        state.guests.push(Guest {
            address: ctx.address.into(),
            channel: channel.clone(),
            peer: guest.clone(),
            lanes: Lanes::new(key, AAD),
            pad,
            player,
            heard: now,
            stalled: false,
        });
        let grant = json!({ "t": "pad-grant", "ch": channel, "to": guest, "pub": encode_b64(&public), "pl": player, "sig": encode_b64(&signature.0) });
        let started = PadEvent::Started { address: ctx.address.into(), channel, peer: guest.0.clone(), host: true, player };
        Ok((grant, Some(started)))
    }

    /// A pad signal from `sender` came through the group: what the window should hear of it, and a reply to send.
    pub fn on_signal(&self, ctx: &Ctx, sender: &UserId, body: &Value, now: Instant) -> (Option<PadEvent>, Option<Value>) {
        if field(body, "to") != Some(ctx.me.0.as_str()) || *sender == ctx.me {
            return (None, None);
        }
        let Some(channel) = field(body, "ch") else { return (None, None) };
        let mut state = self.lock();
        match field(body, "t") {
            Some("pad-ask") => {
                let (Some(public), Some(signature), Some(key)) =
                    (field(body, "pub").and_then(decode_b64::<32>), field(body, "sig").and_then(decode_b64::<64>), (ctx.key_of)(sender))
                else {
                    return (None, None);
                };
                let already = state.guests.iter().any(|g| g.address == ctx.address && g.peer == *sender);
                if already || !key.verify(&ask_statement(&ctx.server_key, channel, sender, &ctx.me, &public), &Signature(signature)) {
                    return (None, None);
                }
                if !self.driver.present() {
                    let refuse = json!({ "t": "pad-refuse", "ch": channel, "to": sender, "why": "no-driver" });
                    return (Some(PadEvent::NoDriver { address: ctx.address.into(), user: sender.0.clone() }), Some(refuse));
                }
                state.asked.retain(|_, a| now.duration_since(a.at) < ASK_TTL);
                state.asked.insert((ctx.address.into(), sender.clone()), Asked { channel: channel.into(), public, at: now });
                (Some(PadEvent::Asked { address: ctx.address.into(), channel: channel.into(), user: sender.0.clone() }), None)
            }
            Some("pad-grant") => {
                let asking = state.asking.take_if(|a| a.address == ctx.address && a.host == *sender && a.channel == channel && now.duration_since(a.at) < ASK_TTL);
                let Some(asking) = asking else { return (None, None) };
                let ours = x25519::PublicKey::from(&asking.secret).to_bytes();
                let granted = (|| {
                    let player = u8::try_from(body["pl"].as_u64()?).ok().filter(|p| (1..=4).contains(p))?;
                    let public = field(body, "pub").and_then(decode_b64::<32>)?;
                    let signature = Signature(field(body, "sig").and_then(decode_b64::<64>)?);
                    let key = (ctx.key_of)(sender)?;
                    key.verify(&grant_statement(&ctx.server_key, channel, sender, &ctx.me, &public, &ours, player), &signature).then_some(())?;
                    let key = session_key(KEY_LABEL, &asking.secret, &public, &ctx.server_key, channel, (sender, &ctx.me), (&public, &ours))?;
                    Some((key, player))
                })();
                let Some((key, player)) = granted.filter(|_| state.playing.is_none()) else { return (None, None) };
                state.playing = Some(Playing { address: ctx.address.into(), channel: channel.into(), host: sender.clone(), lanes: Lanes::new(key, AAD), player });
                (Some(PadEvent::Started { address: ctx.address.into(), channel: channel.into(), peer: sender.0.clone(), host: false, player }), None)
            }
            Some("pad-refuse") => {
                if state.asking.take_if(|a| a.address == ctx.address && a.host == *sender).is_none() {
                    return (None, None);
                }
                let why = field(body, "why").filter(|why| matches!(*why, "denied" | "full" | "no-driver" | "failed")).unwrap_or("denied");
                (Some(PadEvent::Refused { address: ctx.address.into(), user: sender.0.clone(), why: why.into() }), None)
            }
            Some("pad-stop") => {
                state.asked.remove(&(ctx.address.to_string(), sender.clone()));
                if let Some(i) = state.guests.iter().position(|g| g.address == ctx.address && g.peer == *sender) {
                    let guest = state.guests.remove(i);
                    return (Some(self.end_guest(guest, "peer")), None);
                }
                if state.playing.as_ref().is_some_and(|p| p.address == ctx.address && p.host == *sender) {
                    let playing = state.playing.take().expect("checked above");
                    let ended = PadEvent::Ended { address: playing.address, channel: playing.channel, peer: playing.host.0, host: false, why: "peer".into() };
                    return (Some(ended), None);
                }
                (None, None)
            }
            _ => (None, None),
        }
    }

    /// Takes a friend's pad out of our PC.
    fn end_guest(&self, guest: Guest, why: &str) -> PadEvent {
        self.driver.unplug(guest.pad);
        PadEvent::Ended { address: guest.address, channel: guest.channel, peer: guest.peer.0, host: true, why: why.into() }
    }

    /// Our pad's state, sealed for the PC we play on: to whom it goes (their identity in the call) and the packet.
    pub fn seal(&self, pad: &PadState) -> Result<(String, Vec<u8>), String> {
        let mut state = self.lock();
        let playing = state.playing.as_mut().ok_or(NOT_PLAYING)?;
        Ok((playing.host.0.clone(), playing.lanes.seal(true, &pad.to_bytes())))
    }

    /// A packet from `from`, a friend who plays on our PC: their pad takes the state inside, if it is theirs and newer
    /// than the last. The end of their play, when our pad would not take it.
    pub fn open(&self, from: &UserId, packet: &[u8], now: Instant) -> Option<PadEvent> {
        let mut state = self.lock();
        let i = state.guests.iter().position(|g| g.peer == *from)?;
        let guest = &mut state.guests[i];
        let pad = PadState::from_bytes(&guest.lanes.open(packet)?)?;
        guest.heard = now;
        guest.stalled = false;
        if self.driver.update(guest.pad, &pad).is_ok() {
            return None;
        }
        let guest = state.guests.remove(i);
        Some(self.end_guest(guest, "failed"))
    }

    /// Friends' pads that went quiet: let go of after [`STALL`], taken out after [`SILENCE`] (those ends are returned).
    pub fn tick(&self, now: Instant) -> Vec<PadEvent> {
        let mut state = self.lock();
        let mut ended = Vec::new();
        let mut i = 0;
        while i < state.guests.len() {
            let quiet = now.duration_since(state.guests[i].heard);
            if quiet >= SILENCE {
                let guest = state.guests.remove(i);
                ended.push(self.end_guest(guest, "silence"));
                continue;
            }
            let guest = &mut state.guests[i];
            if quiet >= STALL && !guest.stalled {
                guest.stalled = true;
                let _ = self.driver.update(guest.pad, &PadState::default());
            }
            i += 1;
        }
        ended
    }

    /// We take `guest`'s pad out of our PC.
    pub fn kick(&self, address: &str, guest: &UserId) -> Option<PadEvent> {
        let mut state = self.lock();
        let i = state.guests.iter().position(|g| g.address == address && g.peer == *guest)?;
        let guest = state.guests.remove(i);
        Some(self.end_guest(guest, "stopped"))
    }

    /// Every friend's pad out of our PC (the stop keys, the end of our screen or of the call, the app closing).
    pub fn stop_all(&self) -> Vec<PadEvent> {
        let guests = std::mem::take(&mut self.lock().guests);
        guests.into_iter().map(|g| self.end_guest(g, "stopped")).collect()
    }

    /// We stop playing on someone's PC (and stop asking).
    pub fn release(&self) -> Option<PadEvent> {
        let mut state = self.lock();
        state.asking = None;
        let playing = state.playing.take()?;
        Some(PadEvent::Ended { address: playing.address, channel: playing.channel, peer: playing.host.0, host: false, why: "stopped".into() })
    }

    pub fn view(&self) -> PadsView {
        let state = self.lock();
        PadsView {
            playing: state.playing.as_ref().map(|p| PlayView { address: p.address.clone(), channel: p.channel.clone(), peer: p.host.0.clone(), player: p.player }),
            guests: state.guests.iter().map(view_of_guest).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::Remote;
    use std::collections::HashSet;
    use std::sync::Arc;

    const ADDRESS: &str = "127.0.0.1:7350";
    const CHANNEL: &str = "general";

    /// A driver in memory: what is plugged in, what each pad was last told.
    #[derive(Default)]
    struct Fake {
        present: bool,
        /// XInput places taken by others (our own pad).
        taken: u8,
        pads: Mutex<HashMap<PadId, PadState>>,
        unplugged: Mutex<HashSet<PadId>>,
        next: Mutex<PadId>,
        broken: Mutex<bool>,
    }

    struct Driver(Arc<Fake>);

    impl VirtualPads for Driver {
        fn present(&self) -> bool {
            self.0.present
        }
        fn plug(&self) -> Result<(PadId, u8), PlugError> {
            if !self.0.present {
                return Err(PlugError::NoDriver);
            }
            let mut pads = self.0.pads.lock().unwrap();
            if pads.len() as u8 + self.0.taken >= 4 {
                return Err(PlugError::Full);
            }
            let mut next = self.0.next.lock().unwrap();
            *next += 1;
            pads.insert(*next, PadState::default());
            Ok((*next, pads.len() as u8 + self.0.taken))
        }
        fn update(&self, pad: PadId, state: &PadState) -> Result<(), String> {
            if *self.0.broken.lock().unwrap() {
                return Err("broken".into());
            }
            self.0.pads.lock().unwrap().get_mut(&pad).map(|p| *p = *state).ok_or("unplugged".into())
        }
        fn unplug(&self, pad: PadId) {
            self.0.pads.lock().unwrap().remove(&pad);
            self.0.unplugged.lock().unwrap().insert(pad);
        }
    }

    struct Person {
        id: Identity,
        pads: Pads,
        remote: Remote,
        driver: Arc<Fake>,
    }

    fn person(seed: u8, present: bool) -> Person {
        let driver = Arc::new(Fake { present, taken: 1, ..Default::default() });
        Person { id: Identity::from_seed([seed; 32]), pads: Pads::new(Box::new(Driver(driver.clone()))), remote: Remote::default(), driver }
    }

    fn server() -> PublicKey {
        Identity::from_seed([200; 32]).public()
    }

    fn uid(p: &Person) -> UserId {
        p.id.public().user_id()
    }

    fn with_ctx<R>(me: &Person, f: impl FnOnce(&Ctx) -> R) -> R {
        let people: Vec<(UserId, PublicKey)> = (1..=9u8).map(|s| Identity::from_seed([s; 32])).map(|i| (i.public().user_id(), i.public())).collect();
        let key_of = |u: &UserId| people.iter().find(|(id, _)| id == u).map(|(_, k)| *k);
        f(&Ctx { address: ADDRESS, server_key: server(), me: uid(me), key_of: &key_of })
    }

    /// `guest` asks `host`, who lets them play: the player they are.
    fn join(host: &Person, guest: &Person, now: Instant) -> u8 {
        let ask = with_ctx(guest, |ctx| guest.pads.ask(ctx, &guest.id, CHANNEL, &uid(host), now)).unwrap();
        let (asked, reply) = with_ctx(host, |ctx| host.pads.on_signal(ctx, &uid(guest), &ask, now));
        assert!(matches!(asked, Some(PadEvent::Asked { .. })) && reply.is_none());
        let (grant, started) = with_ctx(host, |ctx| host.pads.answer(ctx, &host.id, &uid(guest), true, now)).unwrap();
        let Some(PadEvent::Started { player, host: true, .. }) = started else { panic!("not started") };
        let (started, _) = with_ctx(guest, |ctx| guest.pads.on_signal(ctx, &uid(host), &grant, now));
        assert_eq!(started, Some(PadEvent::Started { address: ADDRESS.into(), channel: CHANNEL.into(), peer: uid(host).0, host: false, player }));
        player
    }

    fn pressed(buttons: u16) -> PadState {
        PadState { buttons, lt: 255, rt: 7, lx: -32768, ly: 32767, rx: 100, ry: -100 }
    }

    #[test]
    fn a_state_is_twelve_bytes_and_the_xbox_button_never_gets_through() {
        let state = pressed(0x1000 | GUIDE);
        let bytes = state.to_bytes();
        assert_eq!(bytes.len(), STATE_LEN);
        assert_eq!(PadState::from_bytes(&bytes), Some(pressed(0x1000)));
        let mut forged = bytes;
        forged[1] |= (GUIDE >> 8) as u8;
        assert_eq!(PadState::from_bytes(&forged).unwrap().buttons & GUIDE, 0);
        assert_eq!(PadState::from_bytes(&bytes[..11]), None);
        assert_eq!(PadState::from_bytes(&[bytes.as_slice(), &[0]].concat()), None);
    }

    #[test]
    fn a_let_friend_plays_with_a_pad_of_their_own() {
        let (anna, boris) = (person(1, true), person(2, false));
        let now = Instant::now();
        assert_eq!(join(&anna, &boris, now), 2, "Anna's own pad is player 1");
        let (to, packet) = boris.pads.seal(&pressed(0x1000)).unwrap();
        assert_eq!(to, uid(&anna).0);
        assert_eq!(anna.pads.open(&uid(&boris), &packet, now), None);
        assert_eq!(anna.driver.pads.lock().unwrap().values().copied().collect::<Vec<_>>(), vec![pressed(0x1000)]);
        assert_eq!(anna.pads.view().guests, vec![PlayView { address: ADDRESS.into(), channel: CHANNEL.into(), peer: uid(&boris).0, player: 2 }]);
        assert_eq!(boris.pads.view().playing.map(|p| p.player), Some(2));
    }

    #[test]
    fn packets_are_not_taken_twice_nor_late_nor_from_anyone_else_nor_bent() {
        let (anna, boris, carl) = (person(1, true), person(2, false), person(3, false));
        let now = Instant::now();
        join(&anna, &boris, now);
        let (_, first) = boris.pads.seal(&pressed(0x1000)).unwrap();
        let (_, second) = boris.pads.seal(&pressed(0x2000)).unwrap();
        anna.pads.open(&uid(&boris), &second, now);
        anna.pads.open(&uid(&boris), &first, now);
        anna.pads.open(&uid(&boris), &second, now);
        assert_eq!(anna.driver.pads.lock().unwrap().values().next().unwrap().buttons, 0x2000, "late and repeated packets are dropped");
        assert_eq!(anna.pads.open(&uid(&carl), &second, now), None, "Carl plays nothing here");
        let (_, mut third) = boris.pads.seal(&pressed(0x4000)).unwrap();
        let last = third.len() - 1;
        third[last] ^= 1;
        anna.pads.open(&uid(&boris), &third, now);
        assert_eq!(anna.driver.pads.lock().unwrap().values().next().unwrap().buttons, 0x2000, "a bent packet is dropped");
    }

    #[test]
    fn pad_and_remote_control_signatures_and_keys_never_pass_for_each_other() {
        let (anna, boris) = (person(1, true), person(2, false));
        let now = Instant::now();
        // A remote-control ask, its type renamed, is no pad ask.
        let mut ask = with_ctx(&boris, |ctx| boris.remote.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        ask["t"] = json!("pad-ask");
        assert_eq!(with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(&boris), &ask, now)), (None, None));
        // A pad ask is no remote-control ask either.
        let mut ask = with_ctx(&boris, |ctx| boris.pads.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        ask["t"] = json!("rc-ask");
        assert_eq!(with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&boris), &ask, now)).0, None);
        // An ask in Boris's name signed by Carl is nobody's.
        let carl = person(3, false);
        let ask = with_ctx(&boris, |ctx| boris.pads.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        assert_eq!(with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(&carl), &ask, now)), (None, None));
        // A grant that changed the player is not believed.
        assert!(with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(&boris), &ask, now)).0.is_some());
        let (mut grant, _) = with_ctx(&anna, |ctx| anna.pads.answer(ctx, &anna.id, &uid(&boris), true, now)).unwrap();
        grant["pl"] = json!(1);
        assert_eq!(with_ctx(&boris, |ctx| boris.pads.on_signal(ctx, &uid(&anna), &grant, now)), (None, None));
        assert!(boris.pads.seal(&PadState::default()).is_err());
    }

    #[test]
    fn a_quiet_pad_lets_go_then_leaves_and_every_end_takes_it_out() {
        let (anna, boris) = (person(1, true), person(2, false));
        let now = Instant::now();
        join(&anna, &boris, now);
        let (_, packet) = boris.pads.seal(&pressed(0x1000)).unwrap();
        anna.pads.open(&uid(&boris), &packet, now);
        assert!(anna.pads.tick(now + STALL / 2).is_empty());
        assert_eq!(anna.driver.pads.lock().unwrap().values().next(), Some(&pressed(0x1000)));
        assert!(anna.pads.tick(now + STALL).is_empty());
        assert_eq!(anna.driver.pads.lock().unwrap().values().next(), Some(&PadState::default()), "nothing stays pressed");
        let ended = anna.pads.tick(now + SILENCE);
        assert!(matches!(ended.as_slice(), [PadEvent::Ended { why, host: true, .. }] if why == "silence"));
        assert!(anna.driver.pads.lock().unwrap().is_empty() && anna.pads.view().guests.is_empty());

        // Anna says so; Boris's play ends too.
        let told = json!({ "t": "pad-stop", "ch": CHANNEL, "to": uid(&boris) });
        assert!(matches!(with_ctx(&boris, |ctx| boris.pads.on_signal(ctx, &uid(&anna), &told, now)).0, Some(PadEvent::Ended { host: false, .. })));
        assert_eq!(boris.pads.view().playing, None);

        // Kicked, stopped by the guest, or all at once: the pad is out each time.
        join(&anna, &boris, now);
        assert!(anna.pads.kick(ADDRESS, &uid(&boris)).is_some());
        assert!(anna.driver.pads.lock().unwrap().is_empty());
        boris.pads.release();
        join(&anna, &boris, now);
        let stop = json!({ "t": "pad-stop", "ch": CHANNEL, "to": uid(&anna) });
        assert!(matches!(with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(&boris), &stop, now)).0, Some(PadEvent::Ended { host: true, .. })));
        assert!(anna.driver.pads.lock().unwrap().is_empty());
        boris.pads.release();
        join(&anna, &boris, now);
        assert_eq!(anna.pads.stop_all().len(), 1);
        assert!(anna.driver.pads.lock().unwrap().is_empty());
        assert_eq!(anna.driver.unplugged.lock().unwrap().len(), 4);
    }

    #[test]
    fn a_pad_the_driver_will_not_take_ends_that_play() {
        let (anna, boris) = (person(1, true), person(2, false));
        let now = Instant::now();
        join(&anna, &boris, now);
        *anna.driver.broken.lock().unwrap() = true;
        let (_, packet) = boris.pads.seal(&pressed(0x1000)).unwrap();
        assert!(matches!(anna.pads.open(&uid(&boris), &packet, now), Some(PadEvent::Ended { why, .. }) if why == "failed"));
        assert!(anna.pads.view().guests.is_empty());
    }

    #[test]
    fn three_friends_at_most_and_none_without_the_driver() {
        let anna = person(1, true);
        let now = Instant::now();
        let friends: Vec<Person> = (2..=5).map(|s| person(s, false)).collect();
        for friend in &friends[..3] {
            join(&anna, friend, now);
        }
        let fourth = &friends[3];
        let ask = with_ctx(fourth, |ctx| fourth.pads.ask(ctx, &fourth.id, CHANNEL, &uid(&anna), now)).unwrap();
        with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(fourth), &ask, now));
        let (refuse, started) = with_ctx(&anna, |ctx| anna.pads.answer(ctx, &anna.id, &uid(fourth), true, now)).unwrap();
        assert_eq!((refuse["t"].as_str(), refuse["why"].as_str(), started), (Some("pad-refuse"), Some("full"), None));
        let (refused, _) = with_ctx(fourth, |ctx| fourth.pads.on_signal(ctx, &uid(&anna), &refuse, now));
        assert!(matches!(refused, Some(PadEvent::Refused { why, .. }) if why == "full"));

        // A PC without the driver answers at once and tells its owner where to get it.
        let (vika, boris) = (person(6, false), person(2, false));
        let ask = with_ctx(&boris, |ctx| boris.pads.ask(ctx, &boris.id, CHANNEL, &uid(&vika), now)).unwrap();
        let (event, reply) = with_ctx(&vika, |ctx| vika.pads.on_signal(ctx, &uid(&boris), &ask, now));
        assert!(matches!(event, Some(PadEvent::NoDriver { .. })));
        assert_eq!(reply.unwrap()["why"], "no-driver");
    }

    #[test]
    fn a_no_ends_the_ask_and_old_asks_are_forgotten() {
        let (anna, boris) = (person(1, true), person(2, false));
        let now = Instant::now();
        let ask = with_ctx(&boris, |ctx| boris.pads.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(&boris), &ask, now));
        let (deny, started) = with_ctx(&anna, |ctx| anna.pads.answer(ctx, &anna.id, &uid(&boris), false, now)).unwrap();
        assert_eq!((deny["why"].as_str(), started), (Some("denied"), None));
        assert!(anna.driver.pads.lock().unwrap().is_empty(), "no pad for a no");
        let ask = with_ctx(&boris, |ctx| boris.pads.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        with_ctx(&anna, |ctx| anna.pads.on_signal(ctx, &uid(&boris), &ask, now));
        let late = now + Duration::from_secs(61);
        assert_eq!(with_ctx(&anna, |ctx| anna.pads.answer(ctx, &anna.id, &uid(&boris), true, late)).err().as_deref(), Some(NO_ASK));
    }
}
