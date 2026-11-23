//! Remote control (idea 5): a friend in the call who watches our screen moves our mouse and presses our keys, once we
//! let them. The asking and the letting go through the server's group, signed with each one's identity key and each
//! with a one-time X25519 key; the two make a key only those two have. The input itself then goes as LiveKit data
//! packets to us alone, each sealed with ChaCha20-Poly1305 under that key and numbered, so neither the server nor
//! anyone else in the call can read, forge or replay it. See docs/superpowers/specs/2026-10-29-remote-control-design.md.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hkdf::Hkdf;
use hv_roster::keys::{decode_b64, encode_b64, random_bytes};
use hv_roster::{Identity, PublicKey, Signature, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use x25519_dalek as x25519;

/// An ask or an answer not acted on within this long is forgotten.
const ASK_TTL: Duration = Duration::from_secs(60);
/// The one in control says something at least this often; after this long of silence, control ends.
pub const SILENCE: Duration = Duration::from_secs(20);
/// What every sealed packet of remote control is bound to.
const AAD: &[u8] = b"hatavoice-remote-input-v1";
/// The label of a remote-control session key.
const KEY_LABEL: &str = "hatavoice-remote-v1";
/// Lane 0 is reliable (buttons, keys, pings), lane 1 is fast and may lose packets (mouse moves).
const LANES: usize = 2;
const NONCE_LEN: usize = 12;
/// The longest input, sealed: a key code is short, a packet is small.
const MAX_PACKET: usize = 256;
/// The longest key code taken (`KeyboardEvent.code`).
const MAX_CODE: usize = 24;
/// The most letters one text input carries: a word or a pasted line, not a book.
const MAX_TEXT: usize = 64;

pub const BUSY: &str = "Удалённое управление уже идёт";
pub const NO_ASK: &str = "Просьба об управлении уже не действует";
pub const NOT_IN_CONTROL: &str = "Ты сейчас не управляешь чужим ПК";

/// What remote control needs to know of one server: its key, who we are, and the members' identity keys.
pub struct Ctx<'a> {
    pub address: &'a str,
    pub server_key: PublicKey,
    pub me: UserId,
    pub key_of: &'a dyn Fn(&UserId) -> Option<PublicKey>,
}

/// One input of the one in control, as the window gives it (and as it comes, sealed). Coordinates are fractions of
/// the shared screen, 0–65535.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Input {
    Move { x: u16, y: u16 },
    Button { b: Button, down: bool },
    /// In wheel steps of 120, as Windows counts them.
    Wheel { dx: i16, dy: i16 },
    /// `KeyboardEvent.code`, e.g. `KeyA`: the key's place, so the host's own layout types it.
    Key { code: String, down: bool },
    /// Letters to type as they are: for a phone, which has no keys of a PC's, only a field to write into.
    Text { s: String },
    Ping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// Something held down on our PC by the one in control: let go of when control ends.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Held {
    Button(Button),
    Key(String),
}

/// The part of our desktop the shared screen is: where its input lands, physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// What the window is told (`remote`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RemoteEvent {
    /// `user` asks to control our screen.
    Asked { address: String, channel: String, user: String },
    /// Control began: we control `peer`'s PC (`host: false`), or `peer` controls ours.
    Started { address: String, channel: String, peer: String, host: bool, keyboard: bool },
    /// `user` said no.
    Denied { address: String, user: String },
    /// Control ended; `why`: `stopped` (by us), `peer` (by them), `silence`.
    Ended { address: String, peer: String, host: bool, why: String },
}

/// What our side of control is now, for the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionView {
    pub address: String,
    pub channel: String,
    pub peer: String,
    pub host: bool,
    pub keyboard: bool,
}

/// The two numbered lanes of sealed input, one way, every packet bound to `aad`. Game pads (`pads.rs`) use them too.
pub(crate) struct Lanes {
    cipher: ChaCha20Poly1305,
    aad: &'static [u8],
    next: [u64; LANES],
    seen: [Option<u64>; LANES],
}

impl Lanes {
    pub(crate) fn new(key: [u8; 32], aad: &'static [u8]) -> Self {
        Self { cipher: ChaCha20Poly1305::new(&key.into()), aad, next: [0; LANES], seen: [None; LANES] }
    }

    fn nonce(lane: usize, n: u64) -> [u8; NONCE_LEN] {
        let mut nonce = [0u8; NONCE_LEN];
        nonce[0] = lane as u8;
        nonce[4..].copy_from_slice(&n.to_be_bytes());
        nonce
    }

    pub(crate) fn seal(&mut self, lossy: bool, plain: &[u8]) -> Vec<u8> {
        let lane = usize::from(lossy);
        let nonce = Self::nonce(lane, self.next[lane]);
        self.next[lane] += 1;
        let sealed = self.cipher.encrypt(&Nonce::from(nonce), Payload { msg: plain, aad: self.aad }).expect("sealing in memory cannot fail");
        [nonce.as_slice(), &sealed].concat()
    }

    /// The input inside, if it is sealed with our key and newer than any taken from its lane.
    pub(crate) fn open(&mut self, packet: &[u8]) -> Option<Vec<u8>> {
        if packet.len() < NONCE_LEN + 16 || packet.len() > MAX_PACKET {
            return None;
        }
        let lane = usize::from(packet[0]);
        if lane >= LANES || packet[1..4] != [0, 0, 0] {
            return None;
        }
        let n = u64::from_be_bytes(packet[4..NONCE_LEN].try_into().ok()?);
        if self.seen[lane].is_some_and(|seen| n <= seen) {
            return None;
        }
        let nonce: [u8; NONCE_LEN] = packet[..NONCE_LEN].try_into().ok()?;
        let plain = self.cipher.decrypt(&Nonce::from(nonce), Payload { msg: &packet[NONCE_LEN..], aad: self.aad }).ok()?;
        self.seen[lane] = Some(n);
        Some(plain)
    }
}

enum Role {
    Host { lanes: Lanes, keyboard: bool, screen: Screen, held: HashSet<Held> },
    Viewer { lanes: Lanes },
}

struct Session {
    address: String,
    channel: String,
    peer: UserId,
    role: Role,
    heard: Instant,
}

/// Our ask, waiting for the host's answer.
struct Asking {
    address: String,
    channel: String,
    host: UserId,
    secret: x25519::StaticSecret,
    at: Instant,
}

/// Someone's ask, waiting for ours.
struct Asked {
    channel: String,
    public: [u8; 32],
    at: Instant,
}

#[derive(Default)]
struct State {
    asking: Option<Asking>,
    asked: HashMap<(String, UserId), Asked>,
    session: Option<Session>,
}

/// Remote control on this PC: at most one, either way.
#[derive(Default)]
pub struct Remote {
    state: Mutex<State>,
}

pub(crate) fn statement(fields: Value) -> Vec<u8> {
    serde_json::to_vec(&fields).expect("serializing a statement cannot fail")
}

fn ask_statement(server_key: &PublicKey, channel: &str, viewer: &UserId, host: &UserId, viewer_pub: &[u8; 32]) -> Vec<u8> {
    statement(json!(["hatavoice-remote-ask-v1", server_key, channel, viewer, host, encode_b64(viewer_pub)]))
}

#[allow(clippy::too_many_arguments)]
fn grant_statement(server_key: &PublicKey, channel: &str, host: &UserId, viewer: &UserId, host_pub: &[u8; 32], viewer_pub: &[u8; 32], keyboard: bool) -> Vec<u8> {
    statement(json!(["hatavoice-remote-grant-v1", server_key, channel, host, viewer, encode_b64(host_pub), encode_b64(viewer_pub), keyboard]))
}

/// The key of one session of `label` (remote control, a game pad): only the two whose one-time keys met can make it,
/// and it is bound to the label, the server, the channel, both people and both one-time keys. `None` for a one-time
/// key that would give everyone the same secret (a low-order point).
pub(crate) fn session_key(
    label: &str,
    ours: &x25519::StaticSecret,
    theirs: &[u8; 32],
    server_key: &PublicKey,
    channel: &str,
    (host, viewer): (&UserId, &UserId),
    (host_pub, viewer_pub): (&[u8; 32], &[u8; 32]),
) -> Option<[u8; 32]> {
    let shared = ours.diffie_hellman(&x25519::PublicKey::from(*theirs));
    if !shared.was_contributory() {
        return None;
    }
    let info = statement(json!([label, server_key, channel, host, viewer, encode_b64(host_pub), encode_b64(viewer_pub)]));
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&server_key.0), shared.as_bytes()).expand(&info, &mut key).ok()?;
    Some(key)
}

pub(crate) fn one_time_key() -> Result<(x25519::StaticSecret, [u8; 32]), String> {
    let secret = x25519::StaticSecret::from(random_bytes::<32>()?);
    let public = x25519::PublicKey::from(&secret).to_bytes();
    Ok((secret, public))
}

pub(crate) fn field<'a>(body: &'a Value, name: &str) -> Option<&'a str> {
    body[name].as_str()
}

impl Remote {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// We ask `host` to let us control their screen in voice channel `channel`: the signal to send them.
    pub fn ask(&self, ctx: &Ctx, id: &Identity, channel: &str, host: &UserId, now: Instant) -> Result<Value, String> {
        let mut state = self.lock();
        if state.session.is_some() {
            return Err(BUSY.into());
        }
        let (secret, public) = one_time_key()?;
        let signature = id.sign(&ask_statement(&ctx.server_key, channel, &ctx.me, host, &public));
        state.asking = Some(Asking { address: ctx.address.into(), channel: channel.into(), host: host.clone(), secret, at: now });
        Ok(json!({ "t": "rc-ask", "ch": channel, "to": host, "pub": encode_b64(&public), "sig": encode_b64(&signature.0) }))
    }

    /// Our answer to `viewer`'s ask: the signal to send them, and, when we let them, the start of control. Only one
    /// `screen` of ours takes their input.
    #[allow(clippy::too_many_arguments)]
    pub fn answer(
        &self,
        ctx: &Ctx,
        id: &Identity,
        viewer: &UserId,
        allow: bool,
        keyboard: bool,
        screen: Screen,
        now: Instant,
    ) -> Result<(Value, Option<RemoteEvent>), String> {
        let mut state = self.lock();
        let asked = state.asked.remove(&(ctx.address.to_string(), viewer.clone())).filter(|a| now.duration_since(a.at) < ASK_TTL).ok_or(NO_ASK)?;
        let channel = asked.channel;
        if !allow {
            return Ok((json!({ "t": "rc-deny", "ch": channel, "to": viewer }), None));
        }
        if state.session.is_some() {
            return Err(BUSY.into());
        }
        let (secret, public) = one_time_key()?;
        let key = session_key(KEY_LABEL, &secret, &asked.public, &ctx.server_key, &channel, (&ctx.me, viewer), (&public, &asked.public)).ok_or(NO_ASK)?;
        let signature = id.sign(&grant_statement(&ctx.server_key, &channel, &ctx.me, viewer, &public, &asked.public, keyboard));
        state.session = Some(Session {
            address: ctx.address.into(),
            channel: channel.clone(),
            peer: viewer.clone(),
            role: Role::Host { lanes: Lanes::new(key, AAD), keyboard, screen, held: HashSet::new() },
            heard: now,
        });
        let grant = json!({ "t": "rc-grant", "ch": channel, "to": viewer, "pub": encode_b64(&public), "kb": keyboard, "sig": encode_b64(&signature.0) });
        let started = RemoteEvent::Started { address: ctx.address.into(), channel, peer: viewer.0.clone(), host: true, keyboard };
        Ok((grant, Some(started)))
    }

    /// A remote-control signal from `sender` came through the group. What the window should hear of it, and, when it
    /// ends our hosting, what is still held down.
    pub fn on_signal(&self, ctx: &Ctx, sender: &UserId, body: &Value, now: Instant) -> (Option<RemoteEvent>, Vec<Held>) {
        if field(body, "to") != Some(ctx.me.0.as_str()) || *sender == ctx.me {
            return (None, Vec::new());
        }
        let Some(channel) = field(body, "ch") else { return (None, Vec::new()) };
        let mut state = self.lock();
        match field(body, "t") {
            Some("rc-ask") => {
                let (Some(public), Some(signature), Some(key)) =
                    (field(body, "pub").and_then(decode_b64::<32>), field(body, "sig").and_then(decode_b64::<64>), (ctx.key_of)(sender))
                else {
                    return (None, Vec::new());
                };
                if state.session.is_some() || !key.verify(&ask_statement(&ctx.server_key, channel, sender, &ctx.me, &public), &Signature(signature)) {
                    return (None, Vec::new());
                }
                state.asked.retain(|_, a| now.duration_since(a.at) < ASK_TTL);
                state.asked.insert((ctx.address.into(), sender.clone()), Asked { channel: channel.into(), public, at: now });
                (Some(RemoteEvent::Asked { address: ctx.address.into(), channel: channel.into(), user: sender.0.clone() }), Vec::new())
            }
            Some("rc-grant") => {
                let asking = state.asking.take_if(|a| a.address == ctx.address && a.host == *sender && a.channel == channel && now.duration_since(a.at) < ASK_TTL);
                let Some(asking) = asking else { return (None, Vec::new()) };
                let ours = x25519::PublicKey::from(&asking.secret).to_bytes();
                let keyboard = body["kb"].as_bool() == Some(true);
                let granted = (|| {
                    let public = field(body, "pub").and_then(decode_b64::<32>)?;
                    let signature = Signature(field(body, "sig").and_then(decode_b64::<64>)?);
                    let key = (ctx.key_of)(sender)?;
                    key.verify(&grant_statement(&ctx.server_key, channel, sender, &ctx.me, &public, &ours, keyboard), &signature).then_some(())?;
                    session_key(KEY_LABEL, &asking.secret, &public, &ctx.server_key, channel, (sender, &ctx.me), (&public, &ours))
                })();
                let Some(key) = granted.filter(|_| state.session.is_none()) else { return (None, Vec::new()) };
                state.session = Some(Session {
                    address: ctx.address.into(),
                    channel: channel.into(),
                    peer: sender.clone(),
                    role: Role::Viewer { lanes: Lanes::new(key, AAD) },
                    heard: now,
                });
                let started = RemoteEvent::Started { address: ctx.address.into(), channel: channel.into(), peer: sender.0.clone(), host: false, keyboard };
                (Some(started), Vec::new())
            }
            Some("rc-deny") => {
                if state.asking.take_if(|a| a.address == ctx.address && a.host == *sender).is_none() {
                    return (None, Vec::new());
                }
                (Some(RemoteEvent::Denied { address: ctx.address.into(), user: sender.0.clone() }), Vec::new())
            }
            Some("rc-stop") => {
                state.asked.remove(&(ctx.address.to_string(), sender.clone()));
                if state.session.as_ref().is_some_and(|s| s.address == ctx.address && s.peer == *sender) {
                    let session = state.session.take().expect("checked above");
                    return Self::ended(session, "peer");
                }
                (None, Vec::new())
            }
            _ => (None, Vec::new()),
        }
    }

    fn ended(session: Session, why: &str) -> (Option<RemoteEvent>, Vec<Held>) {
        let (host, held) = match session.role {
            Role::Host { held, .. } => (true, held.into_iter().collect()),
            Role::Viewer { .. } => (false, Vec::new()),
        };
        (Some(RemoteEvent::Ended { address: session.address, peer: session.peer.0, host, why: why.into() }), held)
    }

    /// One input of ours, sealed for the PC we control: to whom it goes (their identity in the call) and the packet.
    pub fn seal(&self, input: &Input, lossy: bool) -> Result<(String, Vec<u8>), String> {
        let mut state = self.lock();
        let Some(Session { peer, role: Role::Viewer { lanes }, .. }) = state.session.as_mut() else {
            return Err(NOT_IN_CONTROL.into());
        };
        let plain = serde_json::to_vec(input).map_err(|e| e.to_string())?;
        Ok((peer.0.clone(), lanes.seal(lossy, &plain)))
    }

    /// A packet from `from`, the one we let control us: the input inside and the screen it lands on, if it is theirs,
    /// newer than the last, and of a kind we allowed. Keeps what they hold down, to let go of it at the end.
    pub fn open(&self, from: &UserId, packet: &[u8], now: Instant) -> Option<(Input, Screen)> {
        let mut state = self.lock();
        let session = state.session.as_mut().filter(|s| s.peer == *from)?;
        let Role::Host { lanes, keyboard, screen, held } = &mut session.role else { return None };
        let input: Input = serde_json::from_slice(&lanes.open(packet)?).ok()?;
        session.heard = now;
        match &input {
            Input::Key { code, .. } if !*keyboard || code.is_empty() || code.len() > MAX_CODE || !code.bytes().all(|b| b.is_ascii_alphanumeric()) => {
                return None;
            }
            Input::Text { s } if !*keyboard || s.is_empty() || s.chars().count() > MAX_TEXT || s.chars().any(char::is_control) => return None,
            Input::Key { code, down } => {
                if *down {
                    held.insert(Held::Key(code.clone()));
                } else {
                    held.remove(&Held::Key(code.clone()));
                }
            }
            Input::Button { b, down } => {
                if *down {
                    held.insert(Held::Button(*b));
                } else {
                    held.remove(&Held::Button(*b));
                }
            }
            _ => {}
        }
        Some((input, *screen))
    }

    /// We end control (whichever side we are): to whom to say so (address, channel, peer), and what to let go of.
    pub fn stop(&self) -> Option<(SessionView, Vec<Held>)> {
        let mut state = self.lock();
        state.asking = None;
        let session = state.session.take()?;
        let view = Self::view_of(&session);
        let (_, held) = Self::ended(session, "stopped");
        Some((view, held))
    }

    /// Control we host ends when the other one has been silent for [`SILENCE`].
    pub fn tick(&self, now: Instant) -> (Option<RemoteEvent>, Vec<Held>) {
        let mut state = self.lock();
        let silent = state.session.as_ref().is_some_and(|s| matches!(s.role, Role::Host { .. }) && now.duration_since(s.heard) >= SILENCE);
        if !silent {
            return (None, Vec::new());
        }
        Self::ended(state.session.take().expect("checked above"), "silence")
    }

    fn view_of(session: &Session) -> SessionView {
        let (host, keyboard) = match &session.role {
            Role::Host { keyboard, .. } => (true, *keyboard),
            Role::Viewer { .. } => (false, false),
        };
        SessionView { address: session.address.clone(), channel: session.channel.clone(), peer: session.peer.0.clone(), host, keyboard }
    }

    pub fn view(&self) -> Option<SessionView> {
        self.lock().session.as_ref().map(Self::view_of)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDRESS: &str = "127.0.0.1:7350";
    const CHANNEL: &str = "general";
    const SCREEN: Screen = Screen { x: 0, y: 0, width: 1920, height: 1080 };

    struct Person {
        id: Identity,
        remote: Remote,
    }

    fn person(seed: u8) -> Person {
        Person { id: Identity::from_seed([seed; 32]), remote: Remote::default() }
    }

    fn server() -> PublicKey {
        Identity::from_seed([99; 32]).public()
    }

    /// Everyone knows everyone's identity key, as the server's journal says.
    fn with_ctx<R>(me: &Person, f: impl FnOnce(&Ctx) -> R) -> R {
        let keys: HashMap<UserId, PublicKey> = (1..=3u8).map(|n| Identity::from_seed([n; 32]).public()).map(|k| (k.user_id(), k)).collect();
        let key_of = move |user: &UserId| keys.get(user).copied();
        f(&Ctx { address: ADDRESS, server_key: server(), me: me.id.public().user_id(), key_of: &key_of })
    }

    fn uid(p: &Person) -> UserId {
        p.id.public().user_id()
    }

    /// Anna (host) lets Boris (viewer) control her screen; the signals pass as the group would pass them.
    fn connect(anna: &Person, boris: &Person, keyboard: bool, now: Instant) {
        let ask = with_ctx(boris, |ctx| boris.remote.ask(ctx, &boris.id, CHANNEL, &uid(anna), now)).unwrap();
        let (asked, _) = with_ctx(anna, |ctx| anna.remote.on_signal(ctx, &uid(boris), &ask, now));
        assert!(matches!(asked, Some(RemoteEvent::Asked { .. })), "{asked:?}");
        let (grant, started) = with_ctx(anna, |ctx| anna.remote.answer(ctx, &anna.id, &uid(boris), true, keyboard, SCREEN, now)).unwrap();
        assert!(matches!(started, Some(RemoteEvent::Started { host: true, .. })));
        let (started, _) = with_ctx(boris, |ctx| boris.remote.on_signal(ctx, &uid(anna), &grant, now));
        assert!(matches!(started, Some(RemoteEvent::Started { host: false, .. })), "{started:?}");
    }

    #[test]
    fn a_let_viewer_moves_the_mouse_and_types() {
        let (anna, boris, now) = (person(1), person(2), Instant::now());
        connect(&anna, &boris, true, now);
        let (to, packet) = boris.remote.seal(&Input::Move { x: 32768, y: 100 }, true).unwrap();
        assert_eq!(to, uid(&anna).0);
        assert_eq!(anna.remote.open(&uid(&boris), &packet, now), Some((Input::Move { x: 32768, y: 100 }, SCREEN)));
        let (_, key) = boris.remote.seal(&Input::Key { code: "KeyA".into(), down: true }, false).unwrap();
        assert_eq!(anna.remote.open(&uid(&boris), &key, now).map(|(i, _)| i), Some(Input::Key { code: "KeyA".into(), down: true }));
        assert_eq!(anna.remote.view().unwrap().peer, uid(&boris).0);
        let (_, held) = anna.remote.stop().unwrap();
        assert_eq!(held, vec![Held::Key("KeyA".into())], "what was held is let go of at the end");
        assert!(anna.remote.open(&uid(&boris), &boris.remote.seal(&Input::Ping, false).unwrap().1, now).is_none(), "nothing after the end");
    }

    #[test]
    fn packets_are_not_taken_twice_nor_late_nor_from_anyone_else() {
        let (anna, boris, carl, now) = (person(1), person(2), person(3), Instant::now());
        connect(&anna, &boris, true, now);
        let (_, first) = boris.remote.seal(&Input::Move { x: 1, y: 1 }, true).unwrap();
        let (_, second) = boris.remote.seal(&Input::Move { x: 2, y: 2 }, true).unwrap();
        let (_, click) = boris.remote.seal(&Input::Button { b: Button::Left, down: true }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &second, now).is_some());
        assert!(anna.remote.open(&uid(&boris), &first, now).is_none(), "an older move is late");
        assert!(anna.remote.open(&uid(&boris), &second, now).is_none(), "a replay");
        assert!(anna.remote.open(&uid(&boris), &click, now).is_some(), "the reliable lane counts on its own");
        assert!(anna.remote.open(&uid(&carl), &click, now).is_none(), "someone else in the call");
        let mut forged = boris.remote.seal(&Input::Move { x: 3, y: 3 }, true).unwrap().1;
        *forged.last_mut().unwrap() ^= 1;
        assert!(anna.remote.open(&uid(&boris), &forged, now).is_none(), "a changed packet");
    }

    #[test]
    fn without_the_keyboard_no_key_gets_through() {
        let (anna, boris, now) = (person(1), person(2), Instant::now());
        connect(&anna, &boris, false, now);
        let (_, key) = boris.remote.seal(&Input::Key { code: "KeyA".into(), down: true }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &key, now).is_none());
        let (_, odd) = boris.remote.seal(&Input::Key { code: "Key A".into(), down: true }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &odd, now).is_none());
        let (_, click) = boris.remote.seal(&Input::Button { b: Button::Right, down: true }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &click, now).is_some(), "the mouse still works");
    }

    #[test]
    fn text_for_a_phone_gets_through_with_the_keyboard_only_and_short() {
        let (anna, boris, now) = (person(1), person(2), Instant::now());
        connect(&anna, &boris, true, now);
        let (_, word) = boris.remote.seal(&Input::Text { s: "привет".into() }, false).unwrap();
        assert_eq!(anna.remote.open(&uid(&boris), &word, now).map(|(i, _)| i), Some(Input::Text { s: "привет".into() }));
        let (_, long) = boris.remote.seal(&Input::Text { s: "я".repeat(65) }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &long, now).is_none(), "a book, not a word");
        let (_, control) = boris.remote.seal(&Input::Text { s: "a\u{1b}b".into() }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &control, now).is_none(), "no control characters");
        let (anna, boris) = (person(1), person(2));
        connect(&anna, &boris, false, now);
        let (_, word) = boris.remote.seal(&Input::Text { s: "привет".into() }, false).unwrap();
        assert!(anna.remote.open(&uid(&boris), &word, now).is_none(), "without the keyboard, no text either");
    }

    #[test]
    fn an_ask_or_a_grant_not_signed_by_its_sender_is_ignored() {
        let (anna, boris, carl, now) = (person(1), person(2), person(3), Instant::now());
        let ask = with_ctx(&boris, |ctx| boris.remote.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        // Carl (or the server) passes Boris's ask off as his own: the signature is Boris's.
        let (asked, _) = with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&carl), &ask, now));
        assert_eq!(asked, None);
        let mut changed = ask.clone();
        changed["ch"] = json!("games");
        assert_eq!(with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&boris), &changed, now)).0, None, "another channel");
        assert!(with_ctx(&anna, |ctx| anna.remote.answer(ctx, &anna.id, &uid(&boris), true, true, SCREEN, now)).is_err(), "nothing to answer");
        // A real ask, answered; the grant is then twisted to give the keyboard.
        assert!(with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&boris), &ask, now)).0.is_some());
        let (mut grant, _) = with_ctx(&anna, |ctx| anna.remote.answer(ctx, &anna.id, &uid(&boris), true, false, SCREEN, now)).unwrap();
        grant["kb"] = json!(true);
        assert_eq!(with_ctx(&boris, |ctx| boris.remote.on_signal(ctx, &uid(&anna), &grant, now)).0, None);
        assert!(boris.remote.seal(&Input::Ping, false).is_err(), "Boris is not in control");
    }

    #[test]
    fn a_no_ends_the_ask_and_old_asks_are_forgotten() {
        let (anna, boris, now) = (person(1), person(2), Instant::now());
        let ask = with_ctx(&boris, |ctx| boris.remote.ask(ctx, &boris.id, CHANNEL, &uid(&anna), now)).unwrap();
        with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&boris), &ask, now));
        let (deny, started) = with_ctx(&anna, |ctx| anna.remote.answer(ctx, &anna.id, &uid(&boris), false, false, SCREEN, now)).unwrap();
        assert_eq!((deny["t"].as_str(), started), (Some("rc-deny"), None));
        assert!(matches!(with_ctx(&boris, |ctx| boris.remote.on_signal(ctx, &uid(&anna), &deny, now)).0, Some(RemoteEvent::Denied { .. })));
        let late = now + ASK_TTL;
        with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&boris), &ask, now));
        assert_eq!(with_ctx(&anna, |ctx| anna.remote.answer(ctx, &anna.id, &uid(&boris), true, true, SCREEN, late)).err().as_deref(), Some(NO_ASK));
    }

    #[test]
    fn control_ends_by_either_side_and_by_silence() {
        let (anna, boris, now) = (person(1), person(2), Instant::now());
        connect(&anna, &boris, true, now);
        let (_, down) = boris.remote.seal(&Input::Button { b: Button::Left, down: true }, false).unwrap();
        anna.remote.open(&uid(&boris), &down, now).unwrap();
        assert_eq!(anna.remote.tick(now + SILENCE - Duration::from_millis(1)).0, None);
        let (ended, held) = anna.remote.tick(now + SILENCE);
        assert!(matches!(ended, Some(RemoteEvent::Ended { ref why, host: true, .. }) if why == "silence"), "{ended:?}");
        assert_eq!(held, vec![Held::Button(Button::Left)]);
        // Anna's side tells Boris so.
        let told = json!({ "t": "rc-stop", "ch": CHANNEL, "to": uid(&boris) });
        let (ended, _) = with_ctx(&boris, |ctx| boris.remote.on_signal(ctx, &uid(&anna), &told, now));
        assert!(matches!(ended, Some(RemoteEvent::Ended { host: false, .. })), "{ended:?}");
        // Again, and this time Boris lets go: Anna hears his stop.
        connect(&anna, &boris, true, now);
        let (view, _) = boris.remote.stop().unwrap();
        assert_eq!((view.peer.as_str(), view.host), (uid(&anna).0.as_str(), false));
        let stop = json!({ "t": "rc-stop", "ch": CHANNEL, "to": uid(&anna) });
        assert!(matches!(with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&boris), &stop, now)).0, Some(RemoteEvent::Ended { host: true, .. })));
        assert!(anna.remote.view().is_none());
    }

    #[test]
    fn one_control_at_a_time() {
        let (anna, boris, carl, now) = (person(1), person(2), person(3), Instant::now());
        connect(&anna, &boris, true, now);
        let ask = with_ctx(&carl, |ctx| carl.remote.ask(ctx, &carl.id, CHANNEL, &uid(&anna), now)).unwrap();
        assert_eq!(with_ctx(&anna, |ctx| anna.remote.on_signal(ctx, &uid(&carl), &ask, now)).0, None, "Anna is busy");
        assert_eq!(with_ctx(&boris, |ctx| boris.remote.ask(ctx, &boris.id, CHANNEL, &uid(&carl), now)).err().as_deref(), Some(BUSY));
    }
}
