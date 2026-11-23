//! What the server chat says: the records of the history checked against the rules of every chat event and folded
//! into the views the window shows. The author of a record is the person of the leaf that sent it (MLS proves that),
//! never a field inside; whatever breaks a rule is skipped, so a member who sends garbage changes nothing.
//!
//! Rules are checked against the journal as it is now: a channel closed since, or a right taken away, applies to
//! the whole history when it is read again.
//!
//! An event also carries its author's signature (`sig`, Ed25519 with the identity key over the event's statement):
//! MLS proves the author only to those in the epoch, the signature to anyone later, so what is signed can be passed
//! on to a newcomer. An event without one (an earlier version) is taken in all the same; one whose signature does not
//! check is not.

use std::collections::{HashMap, HashSet};

use hv_roster::keys::{Signature, decode_b64, encode_b64, random_bytes};
use hv_roster::perms::Permission;
use hv_roster::request::SignedProfile;
use hv_roster::{Body, Identity, PublicKey, Roster, UserId};
use serde::{Deserialize, Serialize};

use crate::chat_files::{MAX_FILE, safe_name};
use crate::chat_store::HistoryRecord;

pub const MAX_TEXT: usize = 4000;
pub const MAX_QUESTION: usize = 300;
pub const MAX_OPTION: usize = 100;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 10;
pub const MAX_EMOJI: usize = 16;
/// Different emoji under one message; one person can't bury it under thousands.
pub const MAX_REACTIONS: usize = 20;
/// How much of the quoted message a reply shows.
const QUOTE: usize = 120;
/// Unread messages counted per channel, at most (the window shows «99+»).
pub const UNREAD_LIMIT: usize = 100;
pub const MAX_FILES: usize = 10;
const MAX_MIME: usize = 100;

/// A file of a message: its blob on the server (SHA-256 in hex), the key it was sealed with, and what the sender said
/// it is. The type the window shows is told again by the file's first bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRef {
    pub blob: String,
    pub size: u64,
    pub key: String,
    pub name: String,
    pub mime: String,
    /// A file bigger than [`MAX_FILE`] goes in this many parts; `blob` is then their sealed list (`chat_files::seal_parts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<u32>,
}

fn is_hex_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `type/subtype`, the way a media type is written.
fn is_mime(text: &str) -> bool {
    let part = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+-.".contains(&b));
    text.len() <= MAX_MIME && text.split_once('/').is_some_and(|(kind, sub)| part(kind) && part(sub))
}

impl FileRef {
    fn is_valid(&self) -> bool {
        is_hex_hash(&self.blob)
            && match self.parts {
                None => self.size <= MAX_FILE as u64,
                Some(parts) => self.size <= crate::chat_files::MAX_BIG_FILE && parts == crate::chat_files::parts_for(self.size) && parts >= 1,
            }
            && decode_b64::<32>(&self.key).is_some()
            && safe_name(&self.name).is_some()
            && is_mime(&self.mime)
    }
}

/// The people a text mentions (`<@user_id>`), each once, in order.
pub fn mentions(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for piece in text.split("<@").skip(1) {
        let Some((id, _)) = piece.split_once('>') else { continue };
        let fits = (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        if fits && !found.iter().any(|seen| seen == id) {
            found.push(id.to_string());
        }
    }
    found
}

/// The plaintext of an application message of the server group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ChatEvent {
    Msg {
        id: String,
        ch: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<FileRef>,
    },
    Edit { id: String, text: String },
    Del { id: String },
    React { id: String, emoji: String, on: bool },
    Poll { id: String, ch: String, q: String, opts: Vec<String>, multi: bool },
    Vote { poll: String, choice: Vec<u8> },
    Close { poll: String },
    /// The sender's nickname and color, signed by them for this server.
    Profile { p: SignedProfile },
    /// The history for newcomers (`to`): a file of the chat, sealed like any other, holding a [`PackContent`].
    Pack { to: Vec<String>, blob: String, key: String, size: u64 },
}

/// 1..=`max` characters, not only spaces.
fn fits(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max
}

fn is_id(id: &str) -> bool {
    decode_b64::<16>(id).is_some()
}

/// One emoji, as far as its size tells: up to 16 bytes, no spaces or control characters.
fn is_emoji(emoji: &str) -> bool {
    !emoji.is_empty() && emoji.len() <= MAX_EMOJI && !emoji.chars().any(|c| c.is_whitespace() || c.is_control())
}

impl ChatEvent {
    /// The event in `body`, when it is one and keeps to the limits.
    pub fn parse(body: &[u8]) -> Option<ChatEvent> {
        let event: ChatEvent = serde_json::from_slice(body).ok()?;
        event.is_valid().then_some(event)
    }

    fn is_valid(&self) -> bool {
        match self {
            ChatEvent::Msg { id, text, reply, files, .. } => {
                // A message of files may say nothing.
                let said = if files.is_empty() { fits(text, MAX_TEXT) } else { text.chars().count() <= MAX_TEXT };
                is_id(id) && said && reply.as_deref().is_none_or(is_id) && files.len() <= MAX_FILES && files.iter().all(FileRef::is_valid)
            }
            ChatEvent::Edit { id, text } => is_id(id) && fits(text, MAX_TEXT),
            ChatEvent::Del { id } => is_id(id),
            ChatEvent::React { id, emoji, .. } => is_id(id) && is_emoji(emoji),
            ChatEvent::Poll { id, q, opts, .. } => {
                is_id(id) && fits(q, MAX_QUESTION) && (MIN_OPTIONS..=MAX_OPTIONS).contains(&opts.len()) && opts.iter().all(|o| fits(o, MAX_OPTION))
            }
            ChatEvent::Vote { poll, choice } => {
                let distinct: HashSet<&u8> = choice.iter().collect();
                is_id(poll) && distinct.len() == choice.len()
            }
            ChatEvent::Close { poll } => is_id(poll),
            // Checked against the server's key when it is taken in.
            ChatEvent::Profile { .. } => true,
            ChatEvent::Pack { to, blob, key, size } => {
                (1..=MAX_PACK_TO).contains(&to.len())
                    && is_hex_hash(blob)
                    && decode_b64::<32>(key).is_some()
                    && *size <= crate::chat_files::MAX_FILE as u64
            }
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a chat event is plain JSON")
    }
}

/// The label every statement of the chat starts with.
pub const STATEMENT: &str = "hatavoice-chat-v1";

/// What an edit keeps of the message it changes: an edit is signed over the whole message as it reads after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MsgContent {
    pub ch: String,
    pub reply: Option<String>,
    pub files: Vec<FileRef>,
}

/// The bytes an author signs for `event`: a JSON array of the label, the server's key, the kind and the event's
/// fields. An edit is the statement of the message with its new text; `None` when `target` (the message) is missing.
pub fn statement(server_key: &PublicKey, event: &ChatEvent, target: Option<&MsgContent>) -> Option<Vec<u8>> {
    let fields = match event {
        ChatEvent::Msg { id, ch, text, reply, files } => serde_json::json!([STATEMENT, server_key, "msg", id, ch, text, reply, files]),
        ChatEvent::Edit { id, text } => {
            let MsgContent { ch, reply, files } = target?;
            serde_json::json!([STATEMENT, server_key, "msg", id, ch, text, reply, files])
        }
        ChatEvent::Del { id } => serde_json::json!([STATEMENT, server_key, "del", id]),
        ChatEvent::React { id, emoji, on } => serde_json::json!([STATEMENT, server_key, "react", id, emoji, on]),
        ChatEvent::Poll { id, ch, q, opts, multi } => serde_json::json!([STATEMENT, server_key, "poll", id, ch, q, opts, multi]),
        ChatEvent::Vote { poll, choice } => serde_json::json!([STATEMENT, server_key, "vote", poll, choice]),
        ChatEvent::Close { poll } => serde_json::json!([STATEMENT, server_key, "close", poll]),
        // A profile carries a signature of its own; a pack holds records signed each.
        ChatEvent::Profile { .. } | ChatEvent::Pack { .. } => return None,
    };
    Some(serde_json::to_vec(&fields).expect("a statement is plain JSON"))
}

/// The body that goes out: the event's JSON with its signature beside the fields.
pub fn signed_body(event: &ChatEvent, sig: &Signature) -> Vec<u8> {
    let mut value = serde_json::to_value(event).expect("a chat event is plain JSON");
    value["sig"] = serde_json::Value::String(encode_b64(&sig.0));
    serde_json::to_vec(&value).expect("a chat event is plain JSON")
}

/// `event` signed by `id` (an edit over `target`), ready to send; `None` for an edit of no message.
pub fn sign_event(id: &Identity, server_key: &PublicKey, event: &ChatEvent, target: Option<&MsgContent>) -> Option<Vec<u8>> {
    let bytes = statement(server_key, event, target)?;
    Some(signed_body(event, &id.sign(&bytes)))
}

#[derive(Deserialize)]
struct SigField {
    #[serde(default)]
    sig: Option<String>,
}

#[derive(Deserialize)]
struct EditedField {
    #[serde(default)]
    edited: bool,
}

/// A message in a pack says whether it was edited: its text is the last one, signed by that edit.
fn edited_in(body: &[u8]) -> bool {
    serde_json::from_slice::<EditedField>(body).is_ok_and(|field| field.edited)
}

/// The signature in a body: `Ok(None)` when there is none, `Err` when its `sig` is no signature.
fn signature_in(body: &[u8]) -> Result<Option<Signature>, &'static str> {
    let Ok(SigField { sig }) = serde_json::from_slice::<SigField>(body) else { return Ok(None) };
    match sig {
        None => Ok(None),
        Some(text) => decode_b64::<64>(&text).map(|bytes| Some(Signature(bytes))).ok_or("a signature that is none"),
    }
}

/// The key of `user`, a member now or once: whoever wrote to the journal or joined it.
fn key_of(roster: &Roster, user: &UserId) -> Option<PublicKey> {
    if let Some(member) = roster.member(user) {
        return Some(member.key);
    }
    roster.entries().iter().find_map(|entry| match &entry.body {
        Body::Join { user: key, .. } if key.user_id() == *user => Some(*key),
        _ => (entry.author.user_id() == *user).then_some(entry.author),
    })
}

pub const PACK_VERSION: u8 = 1;
/// Newcomers one pack is for, at most.
const MAX_PACK_TO: usize = 100;

/// What a pack holds: the newest profile of each person, and the signed records of the history a newcomer may see,
/// each under the number and time the server gave it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackContent {
    pub v: u8,
    pub profiles: Vec<SignedProfile>,
    pub records: Vec<HistoryRecord>,
}

impl PackContent {
    /// The pack as bytes of at most `max`: the oldest records go first until it fits; `None` when even with no
    /// records it does not.
    pub fn fitted(mut self, max: usize) -> Option<Vec<u8>> {
        loop {
            let bytes = serde_json::to_vec(&self).ok()?;
            if bytes.len() <= max {
                return Some(bytes);
            }
            if self.records.is_empty() {
                return None;
            }
            let cut = (self.records.len() / 10).max(1);
            self.records.drain(..cut);
        }
    }
}

/// A pack the history of the group says is for us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackRef {
    pub from: UserId,
    pub seq: u64,
    pub blob: String,
    pub key: String,
    pub size: u64,
}

/// Where the signature of a reaction, a vote or a close came: the record it was in.
#[derive(Debug, Clone)]
struct Proof {
    seq: u64,
    at: u64,
    sig: Signature,
}

/// The signatures of what others did to a message or poll, kept so it can be passed on.
#[derive(Debug, Clone, Default)]
struct Proofs {
    reactions: HashMap<(String, UserId), Proof>,
    votes: HashMap<UserId, Proof>,
    close: Option<Proof>,
}

/// A fresh id for a message or a poll: 16 random bytes, base64url.
pub fn new_id() -> Result<String, String> {
    Ok(encode_b64(&random_bytes::<16>()?))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChannelChat {
    pub channel: String,
    pub items: Vec<ItemView>,
    /// The number of the channel's newest message or poll; 0 when it has none.
    pub last_seq: u64,
    /// For a newcomer: how the history before their entry came (or did not).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<HistoryNote>,
}

/// The history before our entry: `passed` by `from` (its messages have numbers below `before`), `loading`,
/// `failed` (the pack did not come), or `off` (the owner gives newcomers none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryNote {
    pub state: &'static str,
    pub from: String,
    pub before: u64,
}

/// A message or a poll. A deleted one keeps its place with no text, reactions or poll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ItemView {
    pub id: String,
    pub seq: u64,
    pub at: u64,
    pub author: String,
    pub text: String,
    pub reply: Option<ReplyView>,
    pub edited: bool,
    pub deleted: bool,
    pub reactions: Vec<ReactionView>,
    pub poll: Option<PollView>,
    pub files: Vec<FileView>,
    /// Someone else mentions us in it.
    pub mentions_me: bool,
}

/// A file as the window sees it: everything but its key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileView {
    pub blob: String,
    pub size: u64,
    pub name: String,
    pub mime: String,
    /// In parts: too big to show in place, it is saved.
    pub big: bool,
}

/// Others' messages and polls in one channel, not deleted, the newest [`UNREAD_LIMIT`] by number, and those of them
/// that mention us: what the window counts unread against what it marked read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnreadBase {
    pub seqs: Vec<u64>,
    pub mentions: Vec<u64>,
}

/// The message a reply quotes; its `text` is empty when that message was deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplyView {
    pub id: String,
    pub author: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReactionView {
    pub emoji: String,
    pub users: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PollView {
    pub question: String,
    pub options: Vec<PollOption>,
    pub multi: bool,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PollOption {
    pub text: String,
    pub voters: Vec<String>,
}

struct Poll {
    question: String,
    options: Vec<String>,
    multi: bool,
    closed: bool,
    /// Each voter once, in the order of their last vote.
    votes: Vec<(UserId, Vec<u8>)>,
}

struct Item {
    seq: u64,
    at: u64,
    author: UserId,
    channel: String,
    text: String,
    reply: Option<String>,
    edited: bool,
    deleted: bool,
    /// Each emoji in the order it first appeared, with who put it.
    reactions: Vec<(String, Vec<UserId>)>,
    poll: Option<Poll>,
    files: Vec<FileRef>,
    /// The author's signature over the message (or poll) as it reads now; `None` when that is not signed.
    sig: Option<Signature>,
}

type Outcome = Result<String, &'static str>;

/// The chat of one server, every channel at once.
#[derive(Default)]
pub struct ChatModel {
    /// Whose chat this is: what mentions them is marked.
    me: Option<UserId>,
    /// The server whose chat this is: signatures are checked against it. Without it none are checked or kept.
    server_key: Option<PublicKey>,
    seen: HashSet<u64>,
    items: HashMap<String, Item>,
    /// The ids of each channel's messages and polls.
    channels: HashMap<String, Vec<String>>,
    /// The message each blob came with.
    files: HashMap<String, String>,
    /// The newest profile of each person, checked.
    profiles: HashMap<UserId, SignedProfile>,
    /// A profile came in since the window was last told.
    people_changed: bool,
    /// The signatures of reactions, votes and closes, by message or poll.
    proofs: HashMap<String, Proofs>,
    /// Packs for us, in the order they came.
    packs: Vec<PackRef>,
    /// What this chat's group carries.
    scope: Scope,
}

/// The channel is in the journal and open to everyone in the group.
fn open_channel(roster: &Roster, channel: &str) -> bool {
    roster.channels().iter().any(|c| c.id == channel && !c.is_closed())
}

/// What a chat's group may carry: the server's group, the open channels; a room, one closed channel or two people's
/// direct messages. Rules are the journal's as it is now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Scope {
    #[default]
    Main,
    Closed(String),
    Dm { room: String, pair: [UserId; 2] },
}

impl Scope {
    /// The scope of the room named `room` (`ch.<id>`, `dm.<a>.<b>`).
    pub fn of_room(room: &str) -> Option<Scope> {
        if let Some(id) = room.strip_prefix("ch.") {
            return (!id.is_empty()).then(|| Scope::Closed(id.to_string()));
        }
        let (a, b) = room.strip_prefix("dm.")?.split_once('.')?;
        (!a.is_empty() && a < b).then(|| Scope::Dm { room: room.to_string(), pair: [UserId(a.into()), UserId(b.into())] })
    }

    /// The room the chat of `channel` lives in: none for an open channel (the server's group), `ch.<id>` for a
    /// closed one, the channel itself for direct messages.
    pub fn room_of(roster: &Roster, channel: &str) -> Option<String> {
        if channel.starts_with("dm.") {
            return Some(channel.to_string());
        }
        roster.channels().iter().find(|c| c.id == channel && c.is_closed()).map(|c| format!("ch.{}", c.id))
    }

    /// The room of two people's direct messages.
    pub fn dm_room(one: &UserId, other: &UserId) -> String {
        let (a, b) = if one <= other { (one, other) } else { (other, one) };
        format!("dm.{}.{}", a.0, b.0)
    }

    /// `channel` is this group's, and is there now.
    pub fn holds(&self, roster: &Roster, channel: &str) -> bool {
        match self {
            Scope::Main => open_channel(roster, channel),
            Scope::Closed(id) => channel == id && roster.channels().iter().any(|c| c.id == *id && c.is_closed()),
            Scope::Dm { room, pair } => channel == room && pair.iter().all(|user| roster.member(user).is_some()),
        }
    }

    /// `channel` is this group's, and `user` may write in it now.
    pub fn takes(&self, roster: &Roster, channel: &str, user: &UserId) -> bool {
        self.holds(roster, channel)
            && match self {
                Scope::Main => true,
                Scope::Closed(id) => roster.access(user, id).is_some_and(|access| access.view),
                Scope::Dm { pair, .. } => pair.contains(user),
            }
    }

    /// The other one of direct messages.
    pub fn peer(&self, me: &UserId) -> Option<&UserId> {
        match self {
            Scope::Dm { pair, .. } => pair.iter().find(|user| *user != me),
            _ => None,
        }
    }
}

fn quote(text: &str) -> String {
    if text.chars().count() <= QUOTE {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(QUOTE - 1).collect();
    cut.push('…');
    cut
}

impl ChatModel {
    pub fn for_user(me: UserId, server_key: PublicKey) -> Self {
        Self { me: Some(me), server_key: Some(server_key), ..Self::default() }
    }

    /// The model of a room's chat: only what is of `scope` goes in.
    pub fn for_room(me: UserId, server_key: PublicKey, scope: Scope) -> Self {
        Self { scope, ..Self::for_user(me, server_key) }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// Keeps the signature of what was just taken in, for passing it on; what is undone loses it.
    fn prove(&mut self, event: &ChatEvent, record: &HistoryRecord, sig: Option<Signature>, edited: bool) {
        let proof = sig.map(|sig| Proof { seq: record.seq, at: record.at, sig });
        let sender = record.sender.clone();
        match event {
            // Only a pack says a message came edited: its signature is that of the last edit.
            ChatEvent::Msg { id, .. } if edited => {
                if let Some(item) = self.items.get_mut(id) {
                    item.edited = true;
                }
            }
            ChatEvent::React { id, emoji, on } => {
                let reactions = &mut self.proofs.entry(id.clone()).or_default().reactions;
                match proof.filter(|_| *on) {
                    Some(proof) => reactions.insert((emoji.clone(), sender), proof),
                    None => reactions.remove(&(emoji.clone(), sender)),
                };
            }
            ChatEvent::Vote { poll, choice } => {
                let votes = &mut self.proofs.entry(poll.clone()).or_default().votes;
                match proof.filter(|_| !choice.is_empty()) {
                    Some(proof) => votes.insert(sender, proof),
                    None => votes.remove(&sender),
                };
            }
            ChatEvent::Close { poll } => self.proofs.entry(poll.clone()).or_default().close = proof,
            ChatEvent::Del { id } => {
                self.proofs.remove(id);
            }
            _ => {}
        }
    }

    /// The pack for newcomers: every profile, and — when `since` (unix seconds) is given — the signed history from
    /// then on in channels open to everyone: each message or poll as it reads now, the reactions on it now, the last
    /// vote of each, its close. Nothing deleted, and nothing of a message before its last edit.
    pub fn pack(&self, roster: &Roster, since: Option<u64>) -> PackContent {
        let mut records = Vec::new();
        let signed = |proof: &Proof, sender: &UserId, event: ChatEvent| HistoryRecord {
            seq: proof.seq,
            at: proof.at,
            sender: sender.clone(),
            body: signed_body(&event, &proof.sig),
        };
        for (id, item) in self.items.iter().filter(|_| since.is_some()) {
            let fresh = since.is_some_and(|since| item.at >= since);
            let (false, true, Some(sig)) = (item.deleted, fresh && self.scope.holds(roster, &item.channel), item.sig) else { continue };
            let event = match &item.poll {
                None => ChatEvent::Msg { id: id.clone(), ch: item.channel.clone(), text: item.text.clone(), reply: item.reply.clone(), files: item.files.clone() },
                Some(poll) => ChatEvent::Poll {
                    id: id.clone(),
                    ch: item.channel.clone(),
                    q: poll.question.clone(),
                    opts: poll.options.clone(),
                    multi: poll.multi,
                },
            };
            let mut body: serde_json::Value = serde_json::from_slice(&signed_body(&event, &sig)).expect("a chat event is plain JSON");
            if item.edited {
                body["edited"] = serde_json::Value::Bool(true);
            }
            records.push(HistoryRecord { seq: item.seq, at: item.at, sender: item.author.clone(), body: body.to_string().into_bytes() });
            let Some(proofs) = self.proofs.get(id) else { continue };
            for ((emoji, user), proof) in &proofs.reactions {
                if item.reactions.iter().any(|(e, users)| e == emoji && users.contains(user)) {
                    records.push(signed(proof, user, ChatEvent::React { id: id.clone(), emoji: emoji.clone(), on: true }));
                }
            }
            let Some(poll) = &item.poll else { continue };
            for (voter, choice) in &poll.votes {
                if let Some(proof) = proofs.votes.get(voter) {
                    records.push(signed(proof, voter, ChatEvent::Vote { poll: id.clone(), choice: choice.clone() }));
                }
            }
            if let Some(proof) = proofs.close.as_ref().filter(|_| poll.closed) {
                records.push(signed(proof, &item.author, ChatEvent::Close { poll: id.clone() }));
            }
        }
        records.sort_by_key(|record| record.seq);
        let mut profiles: Vec<SignedProfile> = self.profiles.values().cloned().collect();
        profiles.sort_by_key(|profile| profile.user.user_id().0);
        PackContent { v: PACK_VERSION, profiles, records }
    }

    /// A record of a pack: taken in like any other, but only when it is a chat event signed by its author.
    pub fn apply_packed(&mut self, record: &HistoryRecord, roster: &Roster) -> Option<String> {
        if self.server_key.is_none() || !matches!(signature_in(&record.body), Ok(Some(_))) {
            return None;
        }
        match ChatEvent::parse(&record.body)? {
            ChatEvent::Profile { .. } | ChatEvent::Pack { .. } => None,
            _ => self.apply(record, roster),
        }
    }

    /// A profile of a pack: checked like one the person sent themselves.
    pub fn take_packed_profile(&mut self, profile: SignedProfile) {
        let user = profile.user.user_id();
        let _ = self.take_profile(profile, &user);
    }

    /// The packs for us that came, in order.
    pub fn packs(&self) -> &[PackRef] {
        &self.packs
    }

    /// The newest profile of each person, checked against the server's key.
    pub fn profiles(&self) -> &HashMap<UserId, SignedProfile> {
        &self.profiles
    }

    /// A profile came in since the last call.
    pub fn take_people_changed(&mut self) -> bool {
        std::mem::take(&mut self.people_changed)
    }

    fn take_profile(&mut self, profile: SignedProfile, sender: &UserId) -> Result<(), &'static str> {
        let server_key = self.server_key.as_ref().ok_or("no key to check a profile against")?;
        if profile.user.user_id() != *sender {
            return Err("someone else's profile");
        }
        if !profile.verify(server_key) {
            return Err("a profile that does not check");
        }
        if self.profiles.get(sender).is_some_and(|old| old.at >= profile.at) {
            return Err("an older profile");
        }
        self.profiles.insert(sender.clone(), profile);
        self.people_changed = true;
        Ok(())
    }

    /// What an edit of message `id` keeps of it.
    pub fn content(&self, id: &str) -> Option<MsgContent> {
        let item = self.items.get(id).filter(|item| item.poll.is_none())?;
        Some(MsgContent { ch: item.channel.clone(), reply: item.reply.clone(), files: item.files.clone() })
    }

    /// The message or poll `id` reads now as its author signed it.
    #[cfg(test)]
    pub fn is_signed(&self, id: &str) -> bool {
        self.items.get(id).is_some_and(|item| item.sig.is_some())
    }

    /// The signature of the record, checked: `Ok(None)` for none (or no key to check against).
    fn checked_signature(&self, event: &ChatEvent, record: &HistoryRecord, roster: &Roster) -> Result<Option<Signature>, &'static str> {
        let Some(sig) = signature_in(&record.body)? else { return Ok(None) };
        let Some(server_key) = &self.server_key else { return Ok(None) };
        let target = match event {
            ChatEvent::Edit { id, .. } => Some(self.content(id).ok_or("an edit of no message")?),
            _ => None,
        };
        let bytes = statement(server_key, event, target.as_ref()).ok_or("an edit of no message")?;
        let key = key_of(roster, &record.sender).ok_or("an author the journal does not know")?;
        if !key.verify(&bytes, &sig) {
            return Err("a signature that does not match");
        }
        Ok(Some(sig))
    }

    /// Takes in one record of the history: the channel it changed, or `None` when it changed nothing (a rule broken,
    /// garbage, a number already seen).
    pub fn apply(&mut self, record: &HistoryRecord, roster: &Roster) -> Option<String> {
        if !self.seen.insert(record.seq) {
            return None;
        }
        let outcome = match ChatEvent::parse(&record.body) {
            Some(ChatEvent::Profile { p }) => self.take_profile(p, &record.sender).and(Err("a profile changes no channel")),
            Some(ChatEvent::Pack { to, blob, key, size }) => {
                if self.me.as_ref().is_some_and(|me| to.contains(&me.0)) {
                    self.packs.push(PackRef { from: record.sender.clone(), seq: record.seq, blob, key, size });
                }
                Err("a profile changes no channel")
            }
            Some(event) => self.checked_signature(&event, record, roster).and_then(|sig| {
                let proved = event.clone();
                let channel = self.take(event, record, roster, sig)?;
                self.prove(&proved, record, sig, edited_in(&record.body));
                Ok(channel)
            }),
            None => Err("not a chat event"),
        };
        match outcome {
            Ok(channel) => Some(channel),
            Err("a profile changes no channel") => None,
            Err(_why) => {
                #[cfg(debug_assertions)]
                eprintln!("chat record {} skipped: {_why}", record.seq);
                None
            }
        }
    }

    fn take(&mut self, event: ChatEvent, record: &HistoryRecord, roster: &Roster, sig: Option<Signature>) -> Outcome {
        let sender = &record.sender;
        match event {
            ChatEvent::Msg { id, ch, text, reply, files } => self.add(roster, record, id, ch, text, reply, None, files, sig),
            ChatEvent::Poll { id, ch, q, opts, multi } => {
                let poll = Poll { question: q, options: opts, multi, closed: false, votes: Vec::new() };
                self.add(roster, record, id, ch, String::new(), None, Some(poll), Vec::new(), sig)
            }
            ChatEvent::Edit { id, text } => {
                let item = self.live(&id, roster)?;
                if item.author != *sender || item.poll.is_some() {
                    return Err("only the author edits a message");
                }
                if item.text == text {
                    return Err("the same text");
                }
                item.text = text;
                item.edited = true;
                item.sig = sig;
                Ok(item.channel.clone())
            }
            ChatEvent::Del { id } => {
                let item = self.live(&id, roster)?;
                if item.author != *sender && !roster.permissions_of(sender).has(Permission::ManageChannels) {
                    return Err("only the author or a channel manager deletes");
                }
                item.deleted = true;
                item.text.clear();
                item.reactions.clear();
                item.poll = None;
                item.files.clear();
                item.sig = None;
                Ok(item.channel.clone())
            }
            ChatEvent::React { id, emoji, on } => {
                let item = self.live(&id, roster)?;
                let at = item.reactions.iter().position(|(e, _)| *e == emoji);
                match (at, on) {
                    (Some(at), true) => {
                        let users = &mut item.reactions[at].1;
                        if users.contains(sender) {
                            return Err("already put");
                        }
                        users.push(sender.clone());
                    }
                    (None, true) => {
                        if item.reactions.len() >= MAX_REACTIONS {
                            return Err("too many different reactions");
                        }
                        item.reactions.push((emoji, vec![sender.clone()]));
                    }
                    (Some(at), false) => {
                        let users = &mut item.reactions[at].1;
                        let before = users.len();
                        users.retain(|u| u != sender);
                        if users.len() == before {
                            return Err("not put");
                        }
                        if users.is_empty() {
                            item.reactions.remove(at);
                        }
                    }
                    (None, false) => return Err("not put"),
                }
                Ok(item.channel.clone())
            }
            ChatEvent::Vote { poll, choice } => {
                let item = self.live(&poll, roster)?;
                let channel = item.channel.clone();
                let Some(poll) = item.poll.as_mut() else { return Err("not a poll") };
                if poll.closed {
                    return Err("the poll is closed");
                }
                if choice.iter().any(|&n| usize::from(n) >= poll.options.len()) || (!poll.multi && choice.len() > 1) {
                    return Err("not a choice of this poll");
                }
                let before = poll.votes.iter().position(|(u, _)| u == sender);
                if before.is_some_and(|at| poll.votes[at].1 == choice) || (before.is_none() && choice.is_empty()) {
                    return Err("the same vote");
                }
                if let Some(at) = before {
                    poll.votes.remove(at);
                }
                if !choice.is_empty() {
                    poll.votes.push((sender.clone(), choice));
                }
                Ok(channel)
            }
            ChatEvent::Close { poll } => {
                let item = self.live(&poll, roster)?;
                if item.author != *sender {
                    return Err("only the author closes a poll");
                }
                let channel = item.channel.clone();
                let Some(poll) = item.poll.as_mut() else { return Err("not a poll") };
                if poll.closed {
                    return Err("already closed");
                }
                poll.closed = true;
                Ok(channel)
            }
            ChatEvent::Profile { .. } | ChatEvent::Pack { .. } => Err("a profile changes no channel"),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        roster: &Roster,
        record: &HistoryRecord,
        id: String,
        ch: String,
        text: String,
        reply: Option<String>,
        poll: Option<Poll>,
        files: Vec<FileRef>,
        sig: Option<Signature>,
    ) -> Outcome {
        if !self.scope.takes(roster, &ch, &record.sender) {
            return Err("no such open channel");
        }
        if self.items.contains_key(&id) {
            return Err("an id already taken");
        }
        let item = Item {
            seq: record.seq,
            at: record.at,
            author: record.sender.clone(),
            channel: ch.clone(),
            text,
            reply,
            edited: false,
            deleted: false,
            reactions: Vec::new(),
            poll,
            files,
            sig,
        };
        for file in &item.files {
            self.files.entry(file.blob.clone()).or_insert_with(|| id.clone());
        }
        self.items.insert(id.clone(), item);
        self.channels.entry(ch.clone()).or_default().push(id);
        Ok(ch)
    }

    /// The message or poll `id`, not deleted, in a channel that is still open.
    fn live(&mut self, id: &str, roster: &Roster) -> Result<&mut Item, &'static str> {
        let item = self.items.get_mut(id).ok_or("no such message")?;
        if item.deleted {
            return Err("deleted");
        }
        if !self.scope.holds(roster, &item.channel) {
            return Err("no such open channel");
        }
        Ok(item)
    }

    fn view(&self, id: &str, item: &Item) -> ItemView {
        let reply = item.reply.as_ref().and_then(|quoted| {
            let original = self.items.get(quoted).filter(|o| o.channel == item.channel)?;
            let text = original.poll.as_ref().map_or(original.text.as_str(), |p| p.question.as_str());
            Some(ReplyView { id: quoted.clone(), author: original.author.0.clone(), text: quote(text) })
        });
        let poll = item.poll.as_ref().map(|poll| PollView {
            question: poll.question.clone(),
            options: (0..poll.options.len())
                .map(|n| PollOption {
                    text: poll.options[n].clone(),
                    voters: poll.votes.iter().filter(|(_, choice)| choice.contains(&(n as u8))).map(|(u, _)| u.0.clone()).collect(),
                })
                .collect(),
            multi: poll.multi,
            closed: poll.closed,
        });
        ItemView {
            id: id.to_string(),
            seq: item.seq,
            at: item.at,
            author: item.author.0.clone(),
            text: item.text.clone(),
            reply,
            edited: item.edited,
            deleted: item.deleted,
            reactions: item.reactions.iter().map(|(emoji, users)| ReactionView { emoji: emoji.clone(), users: users.iter().map(|u| u.0.clone()).collect() }).collect(),
            poll,
            files: item.files.iter().map(|f| FileView { blob: f.blob.clone(), size: f.size, name: f.name.clone(), mime: f.mime.clone(), big: f.parts.is_some() }).collect(),
            mentions_me: self.mentions_me(item),
        }
    }

    fn mentions_me(&self, item: &Item) -> bool {
        self.me.as_ref().is_some_and(|me| item.author != *me && !item.deleted && mentions(&item.text).contains(&me.0))
    }

    /// The channel's messages and polls by number.
    pub fn channel(&self, channel: &str) -> ChannelChat {
        let mut items: Vec<ItemView> = self
            .channels
            .get(channel)
            .into_iter()
            .flatten()
            .filter_map(|id| self.items.get(id).map(|item| self.view(id, item)))
            .collect();
        items.sort_by_key(|item| item.seq);
        let last_seq = items.last().map_or(0, |item| item.seq);
        ChannelChat { channel: channel.to_string(), items, last_seq, history: None }
    }

    /// The number of the newest message or poll of every channel that has one.
    pub fn last_seqs(&self) -> HashMap<String, u64> {
        self.channels
            .iter()
            .filter_map(|(channel, ids)| ids.iter().filter_map(|id| self.items.get(id)).map(|item| item.seq).max().map(|seq| (channel.clone(), seq)))
            .collect()
    }

    /// What the window counts unread in each channel that has others' messages.
    pub fn unread(&self, me: &UserId) -> HashMap<String, UnreadBase> {
        self.channels
            .iter()
            .filter_map(|(channel, ids)| {
                let mut theirs: Vec<&Item> = ids.iter().filter_map(|id| self.items.get(id)).filter(|item| item.author != *me && !item.deleted).collect();
                theirs.sort_unstable_by_key(|item| item.seq);
                let newest = &theirs[theirs.len().saturating_sub(UNREAD_LIMIT)..];
                let seqs = newest.iter().map(|item| item.seq).collect::<Vec<_>>();
                let mentions = newest.iter().filter(|item| mentions(&item.text).contains(&me.0)).map(|item| item.seq).collect();
                (!seqs.is_empty()).then(|| (channel.clone(), UnreadBase { seqs, mentions }))
            })
            .collect()
    }

    /// The file `blob` and its channel, for the window to show or save: only from a message that is still there, in
    /// a channel open now.
    pub fn file(&self, blob: &str, roster: &Roster) -> Option<(FileRef, String)> {
        let item = self.items.get(self.files.get(blob)?)?;
        if item.deleted || !self.scope.holds(roster, &item.channel) {
            return None;
        }
        let file = item.files.iter().find(|f| f.blob == blob)?.clone();
        Some((file, item.channel.clone()))
    }

    /// The message or poll `id` and its channel, for the commands to check their rule before sending.
    pub fn item(&self, id: &str) -> Option<(String, ItemView)> {
        self.items.get(id).map(|item| (item.channel.clone(), self.view(id, item)))
    }
}

#[cfg(test)]
mod tests {
    use hv_roster::perms::{ChannelDef, ChannelOverride, Tri};
    use hv_roster::{Body, Identity, PublicKey, RoleId, sign_entry, sign_genesis, sign_join};
    use serde_json::{Value, json};

    use super::*;

    const T0: u64 = 1_800_000_000;

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn user(n: u8) -> String {
        id(n).public().user_id().0
    }

    fn mid(n: u8) -> String {
        encode_b64(&[n; 16])
    }

    /// Owner 1, admin 2 (manages channels), members 3 and 4; channels general and games, and a closed staff.
    fn roster() -> Roster {
        let mut r = Roster::new();
        r.apply(sign_genesis(&id(1), &id(100), "Хата", T0)).unwrap();
        let act = |r: &mut Roster, body| {
            let entry = sign_entry(r, &id(1), T0, body);
            r.apply(entry).unwrap();
        };
        let channel = |id: &str, overrides| ChannelDef { id: id.into(), name: id.into(), user_limit: 0, overrides, kind: Default::default() };
        act(&mut r, Body::ChannelCreate(channel("general", vec![])));
        act(&mut r, Body::ChannelCreate(channel("games", vec![])));
        let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
        act(&mut r, Body::ChannelCreate(channel("staff", vec![hidden])));
        for (n, roles) in [(2u8, vec!["admin"]), (3, vec![]), (4, vec![])] {
            let invite = Identity::generate().unwrap();
            let roles = roles.into_iter().map(|x| RoleId::parse(x).unwrap()).collect();
            act(&mut r, Body::InviteCreate { invite: invite.public(), roles, max_uses: None, expires_at: None });
            let join = sign_join(&r, &id(n), &invite, T0);
            r.apply(join).unwrap();
        }
        r
    }

    fn record(seq: u64, n: u8, event: Value) -> HistoryRecord {
        HistoryRecord { seq, at: T0 + seq, sender: id(n).public().user_id(), body: event.to_string().into_bytes() }
    }

    fn msg(id: u8, ch: &str, text: &str) -> Value {
        json!({ "t": "msg", "id": mid(id), "ch": ch, "text": text })
    }

    fn poll(id: u8, multi: bool, opts: &[&str]) -> Value {
        json!({ "t": "poll", "id": mid(id), "ch": "general", "q": "Во что играем?", "opts": opts, "multi": multi })
    }

    fn vote(poll: u8, choice: &[u8]) -> Value {
        json!({ "t": "vote", "poll": mid(poll), "choice": choice })
    }

    fn react(id: u8, emoji: &str, on: bool) -> Value {
        json!({ "t": "react", "id": mid(id), "emoji": emoji, "on": on })
    }

    /// Applies `(sender, event)` in turn, numbering them after what the model has seen; what each `apply` gave.
    fn run(model: &mut ChatModel, roster: &Roster, events: Vec<(u8, Value)>) -> Vec<Option<String>> {
        events
            .into_iter()
            .map(|(n, event)| {
                let seq = model.seen.iter().max().map_or(1, |s| s + 1);
                model.apply(&record(seq, n, event), roster)
            })
            .collect()
    }

    fn general(model: &ChatModel) -> Vec<ItemView> {
        model.channel("general").items
    }

    fn some(channel: &str) -> Option<String> {
        Some(channel.to_string())
    }

    fn server_key() -> PublicKey {
        id(100).public()
    }

    /// The model of member 1, which checks signatures.
    fn checking() -> ChatModel {
        ChatModel::for_user(id(1).public().user_id(), server_key())
    }

    /// `event` with the signature of `signer` over its statement (`target` for an edit).
    fn signed_by(signer: u8, event: Value, target: Option<&MsgContent>) -> Value {
        let parsed = ChatEvent::parse(event.to_string().as_bytes()).unwrap();
        let bytes = statement(&server_key(), &parsed, target).unwrap();
        let body = signed_body(&parsed, &id(signer).sign(&bytes));
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn every_event_goes_out_signed_and_is_checked() {
        let (r, mut m) = (roster(), checking());
        let good = signed_by(3, msg(1, "general", "подписано"), None);
        assert!(good["sig"].is_string(), "the signature sits beside the event's fields");
        assert_eq!(run(&mut m, &r, vec![(3, good.clone())]), vec![some("general")]);
        assert!(m.is_signed(&mid(1)), "a message whose signature checks");

        let mut forged = signed_by(3, msg(2, "general", "подписано"), None);
        forged["text"] = json!("подменено");
        let someone_else = signed_by(4, msg(3, "general", "от чужого имени"), None);
        let mut broken = msg(4, "general", "кривая подпись");
        broken["sig"] = json!("не подпись");
        assert_eq!(run(&mut m, &r, vec![(3, forged), (3, someone_else), (3, broken)]), vec![None, None, None]);

        assert_eq!(run(&mut m, &r, vec![(3, msg(5, "general", "старый клиент"))]), vec![some("general")]);
        assert!(!m.is_signed(&mid(5)), "taken in by MLS alone, never passed on");
        for event in [react(1, "👍", true), poll(6, false, &["да", "нет"]), json!({ "t": "del", "id": mid(5) })] {
            assert!(run(&mut m, &r, vec![(3, signed_by(3, event, None))])[0].is_some(), "every kind is signed the same way");
        }
        let vote = signed_by(4, vote(6, &[0]), None);
        let close = signed_by(3, json!({ "t": "close", "poll": mid(6) }), None);
        assert_eq!(run(&mut m, &r, vec![(4, vote), (3, close)]), vec![some("general"), some("general")]);
        run(&mut m, &r, vec![(3, signed_by(3, json!({ "t": "del", "id": mid(1) }), None))]);
        assert!(!m.is_signed(&mid(1)), "nothing of a deleted message stays to be passed on");
    }

    #[test]
    fn an_edit_is_signed_over_the_whole_message() {
        let (r, mut m) = (roster(), checking());
        run(&mut m, &r, vec![(3, signed_by(3, msg(1, "general", "опечтка"), None))]);
        let content = m.content(&mid(1)).unwrap();
        assert_eq!(content, MsgContent { ch: "general".into(), reply: None, files: vec![] });
        let edit = json!({ "t": "edit", "id": mid(1), "text": "опечатка" });
        // A signature over the edit alone, not over the message it makes.
        let parsed = ChatEvent::parse(edit.to_string().as_bytes()).unwrap();
        let mut alone = serde_json::to_value(&parsed).unwrap();
        alone["sig"] = json!(encode_b64(&id(3).sign(&parsed.to_bytes()).0));
        assert_eq!(run(&mut m, &r, vec![(3, alone)]), vec![None]);
        assert_eq!(general(&m)[0].text, "опечтка");
        assert_eq!(run(&mut m, &r, vec![(3, signed_by(3, edit, Some(&content)))]), vec![some("general")]);
        assert_eq!(general(&m)[0].text, "опечатка");
        assert!(m.is_signed(&mid(1)), "the message as it reads now is signed");
        run(&mut m, &r, vec![(3, json!({ "t": "edit", "id": mid(1), "text": "без подписи" }))]);
        assert!(!m.is_signed(&mid(1)), "an unsigned edit leaves the message unsigned");
        assert_eq!(statement(&server_key(), &ChatEvent::parse(json!({ "t": "edit", "id": mid(9), "text": "x" }).to_string().as_bytes()).unwrap(), None), None);
    }

    #[test]
    fn a_former_members_signature_still_checks() {
        let mut r = roster();
        let leave = sign_entry(&r, &id(3), T0, Body::Leave);
        r.apply(leave).unwrap();
        assert!(r.member(&id(3).public().user_id()).is_none());
        let mut m = checking();
        assert_eq!(run(&mut m, &r, vec![(3, signed_by(3, msg(1, "general", "до ухода"), None))]), vec![some("general")]);
        assert!(m.is_signed(&mid(1)));
        assert_eq!(run(&mut m, &r, vec![(9, signed_by(9, msg(2, "general", "кто это?"), None))]), vec![None], "nobody the journal knows");
    }

    fn profile(of: u8, nickname: &str, at: u64, server: u8) -> Value {
        json!({ "t": "profile", "p": hv_roster::request::sign_profile(&id(of), &id(server).public(), nickname, "pink", at) })
    }

    #[test]
    fn a_profile_of_someone_else_or_for_another_server_is_dropped() {
        let (r, mut m) = (roster(), checking());
        let three = id(3).public().user_id();
        assert_eq!(run(&mut m, &r, vec![(3, profile(3, "Петя", T0, 100))]), vec![None], "a profile changes no channel");
        assert_eq!(m.profiles()[&three].nickname, "Петя");
        assert!(m.take_people_changed(), "the window hears to read the people again");
        assert!(!m.take_people_changed());
        let mut tampered = profile(3, "Петя", T0 + 2, 100);
        tampered["p"]["nickname"] = json!("Админ");
        run(&mut m, &r, vec![(3, profile(4, "Вася", T0 + 5, 100)), (3, profile(3, "Чужой сервер", T0 + 1, 101)), (3, tampered)]);
        assert!(!m.profiles().contains_key(&id(4).public().user_id()), "someone else's profile, sent by 3");
        assert_eq!(m.profiles()[&three].nickname, "Петя");
        assert!(!m.take_people_changed());
    }

    #[test]
    fn the_newest_profile_wins() {
        let (r, mut m) = (roster(), checking());
        run(&mut m, &r, vec![(3, profile(3, "Новый", T0 + 10, 100)), (3, profile(3, "Старый", T0 + 5, 100))]);
        assert_eq!(m.profiles()[&id(3).public().user_id()].nickname, "Новый");
        let mut blind = ChatModel::default();
        run(&mut blind, &r, vec![(3, profile(3, "Петя", T0, 100))]);
        assert!(blind.profiles().is_empty(), "with no server key nothing can be checked");
    }

    /// A history of member 3 and 4: a message with a reaction, a poll voted and closed, an unsigned message, an old
    /// one, a deleted one and an edited one; and both profiles.
    fn packed() -> (Roster, ChatModel) {
        let (r, mut m) = (roster(), checking());
        let edit = json!({ "t": "edit", "id": mid(6), "text": "второй текст" });
        let content = MsgContent { ch: "general".into(), reply: None, files: vec![] };
        let events = vec![
            (3, signed_by(3, msg(9, "general", "старое"), None)),
            (3, signed_by(3, msg(1, "general", "привет"), None)),
            (4, signed_by(4, react(1, "👍", true), None)),
            (3, signed_by(3, poll(2, false, &["да", "нет"]), None)),
            (4, signed_by(4, vote(2, &[1]), None)),
            (3, signed_by(3, json!({ "t": "close", "poll": mid(2) }), None)),
            (4, msg(3, "general", "без подписи")),
            (4, signed_by(4, msg(5, "general", "секрет1"), None)),
            (4, signed_by(4, react(5, "🔥", true), None)),
            (4, signed_by(4, json!({ "t": "del", "id": mid(5) }), None)),
            (3, signed_by(3, msg(6, "general", "первый текст"), None)),
            (3, signed_by(3, edit, Some(&content))),
            (3, profile(3, "Петя", T0, 100)),
            (4, profile(4, "Вася", T0, 100)),
        ];
        run(&mut m, &r, events);
        (r, m)
    }

    #[test]
    fn a_pack_holds_what_a_newcomer_may_see() {
        let (r, m) = packed();
        let pack = m.pack(&r, Some(T0 + 2));
        assert_eq!(pack.profiles.iter().map(|p| p.nickname.as_str()).collect::<Vec<_>>().len(), 2);
        let kinds: Vec<String> = pack.records.iter().map(|rec| serde_json::from_slice::<Value>(&rec.body).unwrap()["t"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["msg", "react", "poll", "vote", "close", "msg"], "old, unsigned and deleted stay out");
        let seqs: Vec<u64> = pack.records.iter().map(|rec| rec.seq).collect();
        assert_eq!(seqs, [2, 3, 4, 5, 6, 11], "each under its own number");
        // A newcomer takes it in and sees the same, signatures checked.
        let mut newcomer = checking();
        for record in &pack.records {
            assert!(newcomer.apply(record, &r).is_some(), "{}", String::from_utf8_lossy(&record.body));
        }
        let items = general(&newcomer);
        assert_eq!(items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["привет", "", "второй текст"]);
        assert_eq!(items[0].reactions[0].users, [user(4)]);
        assert!(items[1].poll.as_ref().unwrap().closed && items[1].poll.as_ref().unwrap().options[1].voters == [user(4)]);
        assert!(items[2].edited && newcomer.is_signed(&mid(6)));
        assert!(m.pack(&r, None).records.is_empty(), "«не передавать»: profiles only");
        assert_eq!(m.pack(&r, None).profiles.len(), 2);
    }

    #[test]
    fn a_pack_never_holds_deleted_or_replaced_text() {
        let (r, m) = packed();
        // The bodies are base64 in the pack's JSON: read them as the newcomer will.
        let pack = m.pack(&r, Some(0));
        let text: String = pack.records.iter().map(|record| String::from_utf8(record.body.clone()).unwrap()).collect();
        for gone in ["секрет1", "🔥", "первый текст"] {
            assert!(!text.contains(gone), "{gone} is in the pack");
        }
        assert!(text.contains("второй текст"));
    }

    #[test]
    fn a_pack_that_is_too_big_loses_the_oldest_first() {
        let (r, m) = packed();
        let pack = m.pack(&r, Some(0));
        let whole = serde_json::to_vec(&pack).unwrap();
        assert_eq!(pack.clone().fitted(whole.len()).unwrap(), whole);
        let cut: PackContent = serde_json::from_slice(&pack.clone().fitted(whole.len() - 1).unwrap()).unwrap();
        assert_eq!(cut.records, pack.records[1..], "the oldest went");
        assert_eq!(cut.profiles, pack.profiles, "profiles always go");
        assert_eq!(pack.fitted(10), None);
    }

    #[test]
    fn a_forged_record_in_a_pack_is_skipped() {
        let (r, m) = packed();
        let mut pack = m.pack(&r, Some(0));
        let mut forged: Value = serde_json::from_slice(&pack.records[0].body).unwrap();
        forged["text"] = json!("подменено");
        pack.records[0].body = forged.to_string().into_bytes();
        // A reaction of 4 passed as if 3 put it.
        let react = pack.records.iter().position(|rec| rec.sender == id(4).public().user_id() && rec.body.windows(5).any(|w| w == b"react")).unwrap();
        pack.records[react].sender = id(3).public().user_id();
        let unsigned = HistoryRecord { seq: 1, at: T0, sender: id(4).public().user_id(), body: msg(7, "general", "без подписи").to_string().into_bytes() };
        let mut newcomer = checking();
        let taken: Vec<bool> = pack.records.iter().chain([&unsigned]).map(|record| newcomer.apply_packed(record, &r).is_some()).collect();
        assert!(!taken[0] && !taken[react] && !taken[taken.len() - 1], "{taken:?}");
        assert_eq!(taken.iter().filter(|t| **t).count(), pack.records.len() - 2, "the rest goes in");
        let mut someone_else = sign_profile_for(4, "Самозванец");
        someone_else.user = id(3).public();
        newcomer.take_packed_profile(someone_else);
        newcomer.take_packed_profile(sign_profile_for(4, "Вася"));
        assert!(!newcomer.profiles().contains_key(&id(3).public().user_id()));
        assert_eq!(newcomer.profiles()[&id(4).public().user_id()].nickname, "Вася");
    }

    fn sign_profile_for(n: u8, nickname: &str) -> SignedProfile {
        hv_roster::request::sign_profile(&id(n), &server_key(), nickname, "blue", T0)
    }

    #[test]
    fn messages_land_in_their_channel() {
        let (r, mut m) = (roster(), ChatModel::default());
        let got = run(&mut m, &r, vec![(3, msg(1, "general", "привет")), (4, msg(2, "games", "го")), (3, msg(3, "general", "ещё"))]);
        assert_eq!(got, vec![some("general"), some("games"), some("general")]);
        let items = general(&m);
        assert_eq!(items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["привет", "ещё"]);
        assert_eq!((items[0].id.as_str(), items[0].author.as_str(), items[0].seq, items[0].at), (mid(1).as_str(), user(3).as_str(), 1, T0 + 1));
        assert_eq!(m.channel("general").last_seq, 3);
        assert_eq!(m.channel("games").items[0].text, "го");
        assert_eq!(m.last_seqs(), HashMap::from([("general".to_string(), 3), ("games".to_string(), 2)]));
        assert_eq!(m.channel("nothing"), ChannelChat { channel: "nothing".into(), items: vec![], last_seq: 0, history: None });
        let exact = "я".repeat(MAX_TEXT);
        assert_eq!(run(&mut m, &r, vec![(3, msg(4, "general", &exact))]), vec![some("general")]);
    }

    #[test]
    fn replies_show_the_quoted_message() {
        let (r, mut m) = (roster(), ChatModel::default());
        let long = "а".repeat(200);
        let reply = |id: u8, to: String| json!({ "t": "msg", "id": mid(id), "ch": "general", "text": "согласен", "reply": to });
        let got = run(&mut m, &r, vec![(3, msg(1, "general", &long)), (4, reply(2, mid(1))), (4, reply(3, mid(77)))]);
        assert_eq!(got, vec![some("general"); 3]);
        let quoted = general(&m)[1].reply.clone().unwrap();
        assert_eq!((quoted.id, quoted.author), (mid(1), user(3)));
        assert_eq!(quoted.text.chars().count(), 120);
        assert!(quoted.text.ends_with('…'));
        assert_eq!(general(&m)[2].reply, None, "the quoted message is not here");
        run(&mut m, &r, vec![(3, json!({ "t": "del", "id": mid(1) }))]);
        assert_eq!(general(&m)[1].reply.as_ref().unwrap().text, "", "a deleted message is quoted with no text");
    }

    #[test]
    fn only_the_author_edits() {
        let (r, mut m) = (roster(), ChatModel::default());
        let edit = |text: &str| json!({ "t": "edit", "id": mid(1), "text": text });
        run(&mut m, &r, vec![(3, msg(1, "general", "превет"))]);
        assert_eq!(run(&mut m, &r, vec![(4, edit("взлом")), (2, edit("админ")), (1, edit("владелец")), (3, edit("   "))]), vec![None; 4]);
        assert_eq!((general(&m)[0].text.as_str(), general(&m)[0].edited), ("превет", false));
        assert_eq!(run(&mut m, &r, vec![(3, edit("привет"))]), vec![some("general")]);
        assert_eq!((general(&m)[0].text.as_str(), general(&m)[0].edited), ("привет", true));
    }

    #[test]
    fn the_author_or_a_channel_manager_deletes() {
        let (r, mut m) = (roster(), ChatModel::default());
        let del = |id: u8| json!({ "t": "del", "id": mid(id) });
        run(&mut m, &r, vec![(3, msg(1, "general", "раз")), (3, msg(2, "general", "два")), (4, msg(3, "general", "три"))]);
        run(&mut m, &r, vec![(4, react(1, "👍", true))]);
        assert_eq!(run(&mut m, &r, vec![(4, del(1))]), vec![None], "a member without the right");
        assert_eq!(run(&mut m, &r, vec![(3, del(1)), (2, del(2)), (1, del(3))]), vec![some("general"); 3]);
        let items = general(&m);
        assert!(items.iter().all(|i| i.deleted && i.text.is_empty() && i.reactions.is_empty()));
        assert_eq!(items.len(), 3, "a deleted message keeps its place");
        let after = vec![(3, del(1)), (3, json!({ "t": "edit", "id": mid(1), "text": "вернул" })), (4, react(1, "👍", true))];
        assert_eq!(run(&mut m, &r, after), vec![None; 3]);
    }

    #[test]
    fn reactions_toggle_per_person() {
        let (r, mut m) = (roster(), ChatModel::default());
        run(&mut m, &r, vec![(3, msg(1, "general", "смотри"))]);
        let reactions = |m: &ChatModel| -> Vec<(String, Vec<String>)> { general(m)[0].reactions.iter().map(|x| (x.emoji.clone(), x.users.clone())).collect() };
        run(&mut m, &r, vec![(3, react(1, "👍", true)), (4, react(1, "👍", true)), (4, react(1, "❤️", true))]);
        assert_eq!(reactions(&m), vec![("👍".into(), vec![user(3), user(4)]), ("❤️".into(), vec![user(4)])]);
        assert_eq!(run(&mut m, &r, vec![(3, react(1, "👍", false))]), vec![some("general")]);
        assert_eq!(reactions(&m), vec![("👍".into(), vec![user(4)]), ("❤️".into(), vec![user(4)])]);
        assert_eq!(run(&mut m, &r, vec![(4, react(1, "👍", true)), (3, react(1, "❤️", false))]), vec![None, None]);
        run(&mut m, &r, vec![(4, react(1, "❤️", false))]);
        assert_eq!(reactions(&m), vec![("👍".into(), vec![user(4)])]);
        // One person can't bury a message under thousands of different reactions.
        let many: Vec<(u8, Value)> = (0..30).map(|n| (3, react(1, &format!("x{n}"), true))).collect();
        let took = run(&mut m, &r, many).into_iter().filter(Option::is_some).count();
        assert_eq!((took, general(&m)[0].reactions.len()), (MAX_REACTIONS - 1, MAX_REACTIONS));
    }

    fn voters(m: &ChatModel) -> Vec<Vec<String>> {
        general(m)[0].poll.as_ref().unwrap().options.iter().map(|o| o.voters.clone()).collect()
    }

    #[test]
    fn a_poll_counts_one_vote_per_person_and_the_last_wins() {
        let (r, mut m) = (roster(), ChatModel::default());
        assert_eq!(run(&mut m, &r, vec![(3, poll(1, true, &["CS2", "Танки", "Дота"]))]), vec![some("general")]);
        let item = &general(&m)[0];
        let view = item.poll.as_ref().unwrap();
        assert_eq!((view.question.as_str(), view.multi, view.closed, item.author.as_str()), ("Во что играем?", true, false, user(3).as_str()));
        run(&mut m, &r, vec![(4, vote(1, &[0, 2])), (2, vote(1, &[1])), (4, vote(1, &[1]))]);
        assert_eq!(voters(&m), vec![vec![], vec![user(2), user(4)], vec![]]);
        assert_eq!(run(&mut m, &r, vec![(2, vote(1, &[]))]), vec![some("general")], "an empty choice takes the vote back");
        assert_eq!(voters(&m), vec![vec![], vec![user(4)], vec![]]);
        assert_eq!(run(&mut m, &r, vec![(4, vote(1, &[1])), (2, vote(1, &[]))]), vec![None, None], "nothing changes");
    }

    #[test]
    fn single_choice_polls_take_one_option() {
        let (r, mut m) = (roster(), ChatModel::default());
        run(&mut m, &r, vec![(3, poll(1, false, &["да", "нет"]))]);
        assert_eq!(run(&mut m, &r, vec![(4, vote(1, &[0, 1]))]), vec![None]);
        assert_eq!(run(&mut m, &r, vec![(4, vote(1, &[1])), (4, vote(1, &[0]))]), vec![some("general"); 2]);
        assert_eq!(voters(&m), vec![vec![user(4)], vec![]]);
    }

    #[test]
    fn only_the_poll_author_closes_and_closed_polls_take_no_votes() {
        let (r, mut m) = (roster(), ChatModel::default());
        let close = || json!({ "t": "close", "poll": mid(1) });
        run(&mut m, &r, vec![(3, poll(1, false, &["да", "нет"])), (4, vote(1, &[0]))]);
        assert_eq!(run(&mut m, &r, vec![(4, close()), (1, close())]), vec![None, None]);
        assert_eq!(run(&mut m, &r, vec![(3, close())]), vec![some("general")]);
        assert!(general(&m)[0].poll.as_ref().unwrap().closed);
        assert_eq!(run(&mut m, &r, vec![(2, vote(1, &[1])), (4, vote(1, &[])), (3, close())]), vec![None; 3]);
        assert_eq!(voters(&m), vec![vec![user(4)], vec![]], "the result stays");
        let not_a_poll = vec![(3, msg(2, "general", "текст")), (3, json!({ "t": "close", "poll": mid(2) })), (4, vote(2, &[0]))];
        assert_eq!(run(&mut m, &r, not_a_poll), vec![some("general"), None, None]);
    }

    #[test]
    fn closed_or_unknown_channels_take_nothing() {
        let (r, mut m) = (roster(), ChatModel::default());
        let staff_poll = json!({ "t": "poll", "id": mid(3), "ch": "staff", "q": "?", "opts": ["а", "б"], "multi": false });
        let got = run(&mut m, &r, vec![(1, msg(1, "staff", "секрет")), (3, msg(2, "nope", "куда")), (1, staff_poll)]);
        assert_eq!(got, vec![None; 3]);
        assert!(m.last_seqs().is_empty());
        assert!(m.channel("staff").items.is_empty());
    }

    #[test]
    fn garbage_is_skipped() {
        let (r, mut m) = (roster(), ChatModel::default());
        run(&mut m, &r, vec![(3, msg(1, "general", "живое")), (3, poll(2, false, &["да", "нет"]))]);
        let before = m.channel("general");
        let eleven: Vec<String> = (0..11).map(|n| n.to_string()).collect();
        let garbage = vec![
            json!("не объект"),
            json!({ "t": "boom", "id": mid(9) }),
            msg(9, "general", &"я".repeat(MAX_TEXT + 1)),
            msg(9, "general", ""),
            msg(9, "general", "  \n "),
            json!({ "t": "msg", "id": "короткий", "ch": "general", "text": "id не 16 байт" }),
            json!({ "t": "msg", "id": mid(9), "ch": "general", "text": "ответ", "reply": "мусор" }),
            json!({ "t": "msg", "id": mid(9), "ch": "general" }),
            msg(1, "general", "тот же id"),
            poll(2, false, &["тот же", "id"]),
            json!({ "t": "poll", "id": mid(9), "ch": "general", "q": "?", "opts": eleven, "multi": false }),
            json!({ "t": "poll", "id": mid(9), "ch": "general", "q": "?", "opts": ["один"], "multi": false }),
            json!({ "t": "poll", "id": mid(9), "ch": "general", "q": "в".repeat(MAX_QUESTION + 1), "opts": ["а", "б"], "multi": false }),
            json!({ "t": "poll", "id": mid(9), "ch": "general", "q": "?", "opts": ["а", "б".repeat(MAX_OPTION + 1)], "multi": false }),
            vote(2, &[7]),
            vote(2, &[0, 0]),
            vote(9, &[0]),
            react(1, &"😀".repeat(5), true),
            react(1, "", true),
            react(1, "a b", true),
            json!({ "t": "edit", "id": mid(9), "text": "чего нет" }),
            json!({ "t": "del", "id": mid(9) }),
        ];
        let got = run(&mut m, &r, garbage.into_iter().map(|g| (4, g)).collect());
        assert!(got.iter().all(Option::is_none), "{got:?}");
        let bytes = HistoryRecord { seq: 1000, at: T0, sender: id(4).public().user_id(), body: vec![0xff, 0, 0x7b] };
        assert_eq!(m.apply(&bytes, &r), None);
        assert_eq!(m.channel("general"), before);
        assert_eq!(m.last_seqs(), HashMap::from([("general".to_string(), 2)]));
    }

    #[test]
    fn the_same_seq_twice_is_ignored() {
        let (r, mut m) = (roster(), ChatModel::default());
        let first = record(5, 3, msg(1, "general", "раз"));
        assert_eq!(m.apply(&first, &r), some("general"));
        assert_eq!(m.apply(&first, &r), None);
        assert_eq!(m.apply(&record(5, 4, msg(2, "general", "другое под тем же номером")), &r), None);
        assert_eq!(general(&m).len(), 1);
    }

    #[test]
    fn unread_counts_what_others_wrote() {
        let (r, mut m) = (roster(), ChatModel::default());
        let del = |id: u8| json!({ "t": "del", "id": mid(id) });
        run(&mut m, &r, vec![(3, msg(1, "general", "моё")), (4, msg(2, "general", "чужое")), (4, poll(3, false, &["да", "нет"]))]);
        run(&mut m, &r, vec![(4, msg(4, "games", "там")), (4, msg(5, "general", "удалю")), (4, del(5)), (4, react(1, "👍", true))]);
        let unread: HashMap<String, Vec<u64>> = m.unread(&id(3).public().user_id()).into_iter().map(|(c, base)| (c, base.seqs)).collect();
        assert_eq!(unread, HashMap::from([("general".to_string(), vec![2, 3]), ("games".to_string(), vec![4])]));
        let many: Vec<(u8, Value)> = (0..120).map(|n| (4, msg(10 + n as u8, "games", "флуд"))).collect();
        run(&mut m, &r, many);
        let games = &m.unread(&id(3).public().user_id())["games"].seqs;
        assert_eq!(games.len(), UNREAD_LIMIT);
        assert!(games.windows(2).all(|w| w[0] < w[1]) && *games.last().unwrap() == m.channel("games").last_seq);
    }

    fn file(n: u8, name: &str) -> Value {
        json!({ "blob": format!("{:02x}", n).repeat(32), "size": 1000, "key": encode_b64(&[n; 32]), "name": name, "mime": "image/png" })
    }

    fn with_files(id: u8, text: &str, files: Vec<Value>) -> Value {
        json!({ "t": "msg", "id": mid(id), "ch": "general", "text": text, "files": files })
    }

    #[test]
    fn files_land_with_their_message() {
        let (r, mut m) = (roster(), ChatModel::default());
        assert_eq!(run(&mut m, &r, vec![(3, with_files(1, "глянь", vec![file(1, "кот.png"), file(2, "отчёт.pdf")]))]), vec![some("general")]);
        let item = &general(&m)[0];
        assert_eq!(item.text, "глянь");
        let names: Vec<(&str, u64)> = item.files.iter().map(|f| (f.name.as_str(), f.size)).collect();
        assert_eq!(names, [("кот.png", 1000), ("отчёт.pdf", 1000)]);
        assert_eq!(item.files[0].blob, "01".repeat(32));
        let json = serde_json::to_string(item).unwrap();
        assert!(!json.contains(&encode_b64(&[1; 32])), "the key never goes to the window");
    }

    #[test]
    fn a_message_of_files_alone_has_no_text() {
        let (r, mut m) = (roster(), ChatModel::default());
        assert_eq!(run(&mut m, &r, vec![(3, with_files(1, "", vec![file(1, "a.gif")]))]), vec![some("general")]);
        assert_eq!(general(&m)[0].text, "");
        assert_eq!(run(&mut m, &r, vec![(3, with_files(2, "", vec![]))]), vec![None], "no text and no file");
    }

    #[test]
    fn a_big_file_comes_in_as_many_parts_as_its_size_takes() {
        let (r, mut m) = (roster(), ChatModel::default());
        let mut big = file(1, "фильм.mp4");
        big["size"] = json!(MAX_FILE as u64 + 1);
        big["parts"] = json!(2);
        assert_eq!(run(&mut m, &r, vec![(3, with_files(1, "", vec![big.clone()]))]), vec![some("general")]);
        let shown = &general(&m)[0].files[0];
        assert!(shown.big, "the window shows it as a file to save");
        assert!(!general(&m).iter().any(|i| i.files.iter().any(|f| f.big && f.size <= MAX_FILE as u64)));
        let mut wrong_count = big.clone();
        wrong_count["parts"] = json!(3);
        let mut too_big = big.clone();
        too_big["size"] = json!(crate::chat_files::MAX_BIG_FILE + 1);
        too_big["parts"] = json!(crate::chat_files::parts_for(crate::chat_files::MAX_BIG_FILE + 1));
        let mut no_parts = big.clone();
        no_parts["parts"] = json!(0);
        for (n, bad) in [wrong_count, too_big, no_parts].into_iter().enumerate() {
            assert_eq!(run(&mut m, &r, vec![(3, with_files(n as u8 + 2, "", vec![bad]))]), vec![None], "case {n}");
        }
        let small = &general(&m)[0];
        assert_eq!(small.files.len(), 1);
    }

    #[test]
    fn bad_files_skip_the_whole_message() {
        let (r, mut m) = (roster(), ChatModel::default());
        let eleven: Vec<Value> = (0..11).map(|n| file(n, "a.png")).collect();
        let mut huge = file(1, "a.png");
        huge["size"] = json!(MAX_FILE as u64 + 1);
        let mut not_hex = file(1, "a.png");
        not_hex["blob"] = json!("zz".repeat(32));
        let mut short_key = file(1, "a.png");
        short_key["key"] = json!(encode_b64(&[1; 16]));
        let mut no_mime = file(1, "a.png");
        no_mime["mime"] = json!("<script>");
        let bad = vec![eleven, vec![huge], vec![not_hex], vec![short_key], vec![file(1, "..\\evil.exe")], vec![file(1, "CON.txt")], vec![no_mime]];
        for (n, files) in bad.into_iter().enumerate() {
            assert_eq!(run(&mut m, &r, vec![(3, with_files(n as u8 + 1, "текст", files))]), vec![None], "case {n}");
        }
        assert!(general(&m).is_empty());
    }

    #[test]
    fn mentions_count_for_the_one_mentioned() {
        let r = roster();
        let mut m = ChatModel::for_user(id(3).public().user_id(), server_key());
        let to_three = format!("<@{}> глянь, и <@{}>", user(3), user(4));
        run(&mut m, &r, vec![(4, msg(1, "general", &to_three)), (4, msg(2, "general", "без упоминаний")), (3, msg(3, "general", &to_three))]);
        let items = general(&m);
        assert_eq!(items.iter().map(|i| i.mentions_me).collect::<Vec<_>>(), [true, false, false], "our own message does not mention us to ourselves");
        assert_eq!(mentions(&to_three), vec![user(3), user(4)]);
        let unread = m.unread(&id(3).public().user_id());
        assert_eq!(unread["general"], UnreadBase { seqs: vec![1, 2], mentions: vec![1] });
        assert_eq!(mentions("<@> <@НЕ-ID> <@abc"), Vec::<String>::new());
    }

    #[test]
    fn a_file_is_found_only_in_a_live_open_channel() {
        let r = roster();
        let mut m = ChatModel::default();
        run(&mut m, &r, vec![(3, with_files(1, "", vec![file(1, "a.png")])), (3, with_files(2, "", vec![file(2, "b.png")]))]);
        let (found, channel) = m.file(&"01".repeat(32), &r).unwrap();
        assert_eq!((found.name.as_str(), found.key.as_str(), channel.as_str()), ("a.png", encode_b64(&[1; 32]).as_str(), "general"));
        assert!(m.file(&"07".repeat(32), &r).is_none(), "no message has it");
        run(&mut m, &r, vec![(3, json!({ "t": "del", "id": mid(2) }))]);
        assert!(m.file(&"02".repeat(32), &r).is_none(), "its message was deleted");
        let mut closed = r.clone();
        let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
        let staff = ChannelDef { id: "general".into(), name: "general".into(), user_limit: 0, overrides: vec![hidden], kind: Default::default() };
        let entry = sign_entry(&closed, &id(1), T0, Body::ChannelUpdate(staff));
        closed.apply(entry).unwrap();
        assert!(m.file(&"01".repeat(32), &closed).is_none(), "the channel is closed now");
    }

    #[test]
    fn events_round_trip_as_bytes() {
        let event = ChatEvent::Msg { id: new_id().unwrap(), ch: "general".into(), text: "привет".into(), reply: None, files: vec![] };
        assert_eq!(ChatEvent::parse(&event.to_bytes()), Some(event.clone()));
        assert!(!String::from_utf8(event.to_bytes()).unwrap().contains("reply"));
        assert!(!String::from_utf8(event.to_bytes()).unwrap().contains("files"), "a message without files reads as before");
        assert_ne!(new_id().unwrap(), new_id().unwrap());
    }
}
