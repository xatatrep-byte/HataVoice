//! The server chat in the app: per open server, the group engine, the chat model built from the history on disk,
//! and a timer. The window reads views and sends through the commands here, and hears `chat-changed` (which channels
//! to read again) and `chat-status` (the keys of the chat).
//!
//! Every command checks its rule before anything is sent (its own message, an open channel, a poll still open), so
//! the person is told why in words; the model checks the same rules again on what comes back. The model is read
//! without waiting for the engine, which may be waiting for the server.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use hv_roster::keys::{decode_b64, encode_b64};
use hv_roster::perms::Permission;
use hv_roster::request::{SignedProfile, sign_profile_full};
use hv_roster::{Identity, PublicKey, Roster, UserId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::call::Journal;
use crate::call_plan::STEP;
use crate::chat_files::{FileError, MAX_BIG_FILE, MAX_FILE, PART, blob_hash, clean_name, new_key, open_file, open_parts, parts_for, seal_file, seal_parts, seal_with, sniff};
use crate::chat_model::{Scope, 
    ChannelChat, ChatEvent, ChatModel, FileRef, HistoryNote, ItemView, MAX_FILES, MAX_OPTION, MAX_OPTIONS, MAX_QUESTION, MAX_TEXT, MIN_OPTIONS,
    PACK_VERSION, PackContent, PackRef, UnreadBase, new_id, sign_event,
};
use crate::chat_store::{ChatStore, HistoryRecord};
use crate::server_group::{GroupEngine, GroupStatus, GroupTransport, NO_FILE, NOT_READY, SessionGroupTransport, admit_by};
use crate::session::{ServerError, Session, unix_now};

/// How often the app's timer looks at each chat.
const TICK: Duration = Duration::from_millis(STEP.as_millis() as u64 / 4);
/// «печатает…» goes out at most this often while someone types.
pub const TYPING_EVERY: Duration = Duration::from_secs(3);

const NO_CHAT: &str = "Чат этого сервера ещё не открыт";
const NO_CHANNEL: &str = "Такого канала нет";
pub const CLOSED: &str = "Чат в закрытом канале появится позже";
const EMPTY: &str = "Пустое сообщение";
const TOO_LONG: &str = "Сообщение длиннее 4000 символов";
const NO_MESSAGE: &str = "Сообщения нет — возможно, его удалили";
const ROOM_NOT_READY: &str = "Чат этого канала ещё подключается — подожди немного";
const NO_PERSON: &str = "Такого человека на сервере нет";
const NOT_YOURS: &str = "Менять можно только свои сообщения";
const NOT_YOURS_TO_DELETE: &str = "Удалять чужие сообщения может тот, кто управляет каналами";
const NOT_EMOJI: &str = "Это не эмодзи";
const NO_POLL: &str = "Голосования нет";
const POLL_CLOSED: &str = "Голосование уже завершено";
const NOT_YOUR_POLL: &str = "Завершить может только автор голосования";
const ONE_CHOICE: &str = "Здесь можно выбрать только один вариант";
const NO_CHOICE: &str = "Такого варианта нет";
const BAD_QUESTION: &str = "Вопрос — от 1 до 300 символов";
const BAD_OPTIONS: &str = "Нужно от 2 до 10 вариантов, каждый до 100 символов";
const NOT_OWNER: &str = "Пересоздать группу может только владелец";
const TOO_BIG: &str = "Файл больше 25 МБ";
const TOO_BIG_FILE: &str = "Файл больше 2 ГБ";
const SAVE_ONLY: &str = "Это большой файл — его можно только сохранить";
/// How long a part waits when the server says too many files went in a minute, and how many times.
const BUSY_WAIT: Duration = Duration::from_secs(12);
const BUSY_TRIES: usize = 10;
const TOO_MANY_FILES: &str = "Не больше 10 файлов в одном сообщении";
/// The type of a file that is only ever saved.
const OCTET: &str = "application/octet-stream";

/// A file to send: one the person picked or dropped (`token`, see `picked`), or the bytes the window has (a picture
/// pasted from the clipboard). Never a path the page names.
#[derive(Debug, Clone, Deserialize)]
pub struct Attachment {
    pub token: Option<String>,
    pub data: Option<Vec<u8>>,
    pub name: String,
}

/// An attachment once looked at: up to 25 MB read whole, a bigger file (up to 2 GB) read part by part as it goes.
enum Loaded {
    Whole { name: String, bytes: Vec<u8> },
    Big { name: String, path: PathBuf, size: u64 },
}

impl Loaded {
    fn size(&self) -> u64 {
        match self {
            Loaded::Whole { bytes, .. } => bytes.len() as u64,
            Loaded::Big { size, .. } => *size,
        }
    }
}

impl Attachment {
    /// The file and the name it goes out with: bytes the window has are at most 25 MB, a file on disk at most 2 GB.
    fn read(self) -> Result<Loaded, String> {
        let path = match (&self.data, &self.token) {
            (None, Some(token)) => Some(crate::picked::take(token, crate::picked::Access::Read)?),
            _ => None,
        };
        let name = match (self.name.trim(), &path) {
            ("", Some(path)) => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            (name, _) => name.to_string(),
        };
        let name = clean_name(&name);
        let bytes = match (self.data, path) {
            (Some(data), _) => data,
            (None, Some(path)) => {
                let size = std::fs::metadata(&path).map_err(|e| format!("Не читается {}: {e}", path.display()))?.len();
                if size > MAX_BIG_FILE {
                    return Err(TOO_BIG_FILE.into());
                }
                if size > MAX_FILE as u64 {
                    return Ok(Loaded::Big { name, path, size });
                }
                std::fs::read(&path).map_err(|e| format!("Не читается {}: {e}", path.display()))?
            }
            (None, None) => return Err("Пустое вложение".into()),
        };
        if bytes.len() > MAX_FILE {
            return Err(TOO_BIG.into());
        }
        Ok(Loaded::Whole { name, bytes })
    }
}

/// `want` bytes more of a file, read off the async threads.
async fn read_part(file: std::fs::File, want: usize) -> Result<(std::fs::File, Vec<u8>), String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = file;
        let mut bytes = vec![0; want];
        file.read_exact(&mut bytes).map_err(|e| format!("Файл не дочитался: {e}"))?;
        Ok((file, bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bytes at the end of a file being written, off the async threads.
async fn write_part(file: std::fs::File, bytes: Vec<u8>) -> Result<std::fs::File, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut file = file;
        file.write_all(&bytes).map_err(|e| format!("Файл не записался: {e}"))?;
        Ok(file)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `chat-file-progress`: how far a big send or save is. `key` is `up:{channel}` for a message being sent (all its
/// files together) and `down:{blob}` for a file being saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileProgress {
    pub address: String,
    pub key: String,
    pub done: u64,
    pub total: u64,
}

/// `chat-changed`: the channels of `address` whose chat changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatChanged {
    pub address: String,
    pub channels: Vec<String>,
}

/// `chat-status`: the keys of the chat of `address`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatStatusEvent {
    pub address: String,
    pub status: GroupStatus,
}

/// `chat-message`: a new message or poll from someone else, for the window to decide on a notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatMessage {
    pub address: String,
    pub channel: String,
    pub id: String,
    pub author: String,
    /// The text, or the question of a poll.
    pub text: String,
    /// The names of its files.
    pub files: Vec<String>,
    pub mentions_me: bool,
    pub poll: bool,
}

/// `chat-typing`: `user` is typing in `channel` of `address`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatTyping {
    pub address: String,
    pub channel: String,
    pub user: String,
}

/// `chat-music`: what `user` plays for the others in voice channel `channel` of `address` (music together), or that
/// they stopped (`on: false`) or take over from whoever plays (`take`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatMusic {
    pub address: String,
    pub channel: String,
    pub user: String,
    pub on: bool,
    pub take: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub app: Option<String>,
    pub cover: Option<String>,
}

/// `chat-watch`: what `user` watches with the others in voice channel `channel` of `address` — the link, playing
/// or paused at `pos` (ms) as of `at` (the server's clock, ms); no `url`: they stopped it for everyone. `picks`: on a
/// site, the player, season, episode and dub everyone watches (see `watch_picks`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatWatch {
    pub address: String,
    pub channel: String,
    pub user: String,
    pub url: Option<String>,
    pub playing: bool,
    pub pos: u64,
    pub at: u64,
    pub picks: std::collections::BTreeMap<String, String>,
}

/// Picks as they may go and come: the four kinds a site's page has (`watch_browser::KINDS`), each a short line of words.
fn watch_picks(value: &Value) -> std::collections::BTreeMap<String, String> {
    let mut picks = std::collections::BTreeMap::new();
    let Some(map) = value.as_object() else { return picks };
    for kind in crate::watch_browser::KINDS {
        if let Some(label) = map.get(kind).and_then(Value::as_str) {
            let label: String = label.chars().filter(|c| !c.is_control()).take(60).collect();
            if !label.is_empty() {
                picks.insert(kind.to_string(), label);
            }
        }
    }
    picks
}

/// `chat-act`: `user` in voice channel `channel` of `address` made their 3D character do `act` — alone, or to `to`
/// (hug them, give them five…). The window knows which acts there are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatAct {
    pub address: String,
    pub channel: String,
    pub user: String,
    pub act: String,
    pub to: Option<String>,
}

/// The longest name of an act.
const MAX_ACT: usize = 16;

/// An act's name: a short word of small Latin letters.
fn act_name(act: &str) -> bool {
    (1..=MAX_ACT).contains(&act.len()) && act.bytes().all(|b| b.is_ascii_lowercase())
}

/// Someone an act may be done to: a user id as the app writes them.
fn act_target(to: &str) -> bool {
    (1..=64).contains(&to.len()) && to.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The longest link watched together.
pub const MAX_WATCH_URL: usize = 500;
/// A week of video, in ms: no position is further.
const MAX_WATCH_POS: u64 = 7 * 24 * 3600 * 1000;

/// A link that may be watched together: `https`, of a sane length; the window says which sites it plays.
fn watch_url(url: &str) -> bool {
    url.starts_with("https://") && url.chars().count() <= MAX_WATCH_URL && !url.chars().any(char::is_control)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Changed(ChatChanged),
    Status(ChatStatusEvent),
    Typing(ChatTyping),
    Message(ChatMessage),
    /// Nicknames or games of `address` changed: the window reads the server's people again.
    People(String),
    Watch(ChatWatch),
    Music(ChatMusic),
    Act(ChatAct),
    /// A remote-control (`rc-…`) or game pad (`pad-…`) signal from `sender`: those check it themselves.
    Remote { address: String, sender: UserId, body: Value },
    /// The rooms of direct messages of `address` changed: the window reads the list again.
    Rooms(String),
    Progress(FileProgress),
}

/// Who is who on one server, as its group says: the newest profile of each person and what each plays now.
#[derive(Debug, Clone, Default)]
pub struct People {
    pub profiles: HashMap<UserId, SignedProfile>,
    pub playing: HashMap<UserId, String>,
}

/// Our profile as the window set it: nickname, color, the frame around the avatar, the 3D character.
type OwnProfile = (String, String, Option<String>, Option<String>);

/// Where a chat remembers the profile it last sent: `[nickname, color, frame, character]`.
const SENT_PROFILE: &str = "profile.bin";
/// Where a chat keeps the history packs it was given, opened: they are read again with the history at every start.
const PACKS: &str = "packs.bin";

/// A pack we took, as kept: who gave it, the number of its message, what it held.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeptPack {
    seq: u64,
    from: UserId,
    content: PackContent,
}

/// The model of a chat from its history and the packs it was given, in the order of their numbers: a reaction to
/// a message from a pack finds it whichever came to this PC first.
fn build_model(me: UserId, server_key: PublicKey, scope: Scope, history: &[HistoryRecord], packs: &[KeptPack], roster: &Roster) -> ChatModel {
    let mut model = ChatModel::for_room(me, server_key, scope);
    for pack in packs {
        for profile in &pack.content.profiles {
            model.take_packed_profile(profile.clone());
        }
    }
    let packed = packs.iter().flat_map(|pack| pack.content.records.iter().filter(move |record| record.seq < pack.seq)).map(|record| (record, true));
    let mut records: Vec<(&HistoryRecord, bool)> = history.iter().map(|record| (record, false)).chain(packed).collect();
    // Written in the order things came; an edit must find its message.
    records.sort_by_key(|(record, _)| record.seq);
    for (record, packed) in records {
        if packed {
            model.apply_packed(record, roster);
        } else {
            model.apply(record, roster);
        }
    }
    let _ = model.take_people_changed();
    model
}
/// The longest name of a game, as the detector gives it.
pub const MAX_GAME: usize = 64;

/// The game in a `playing` signal: `Some(None)` for «stopped», `None` when it is no game name.
fn game_in(signal: &Value) -> Option<Option<String>> {
    match &signal["g"] {
        Value::Null => Some(None),
        Value::String(game) => {
            let game = game.trim();
            (!game.is_empty() && game.chars().count() <= MAX_GAME).then(|| Some(game.to_string()))
        }
        _ => None,
    }
}

fn playing_signal(game: Option<&str>) -> Vec<u8> {
    serde_json::json!({ "t": "playing", "g": game }).to_string().into_bytes()
}

/// Where the chats tell the window what changed.
pub type Notify = Arc<dyn Fn(Notice) + Send + Sync>;

fn missing() -> (u16, String) {
    (404, FileError::Missing.text().to_string())
}

fn damaged() -> (u16, String) {
    (422, FileError::Damaged.text().to_string())
}

/// How far a send or a save is, told to the window at most every percent.
struct Progress<'a> {
    notify: &'a Notify,
    address: &'a str,
    key: String,
    done: u64,
    total: u64,
}

impl Progress<'_> {
    fn add(&mut self, bytes: u64) {
        let before = self.done * 100 / self.total.max(1);
        self.done = (self.done + bytes).min(self.total);
        if self.done * 100 / self.total.max(1) != before || self.done == self.total {
            (self.notify)(Notice::Progress(FileProgress { address: self.address.to_string(), key: self.key.clone(), done: self.done, total: self.total }));
        }
    }
}

pub fn to_window(app: tauri::AppHandle) -> Notify {
    Arc::new(move |notice| {
        let _ = match notice {
            Notice::Changed(changed) => app.emit("chat-changed", &changed),
            Notice::Status(status) => app.emit("chat-status", &status),
            Notice::Typing(typing) => app.emit("chat-typing", &typing),
            Notice::Watch(watch) => app.emit("chat-watch", &watch),
            Notice::Music(music) => app.emit("chat-music", &music),
            Notice::Act(act) => app.emit("chat-act", &act),
            Notice::Remote { address, sender, body } => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { crate::remote_cmd::on_signal(&app, &address, sender, body).await });
                Ok(())
            }
            Notice::Message(message) => app.emit("chat-message", &message),
            Notice::Rooms(address) => app.emit("chat-rooms", &address),
            Notice::Progress(progress) => app.emit("chat-file-progress", &progress),
            Notice::People(address) => app.emit("server-event", serde_json::json!({ "address": address, "event": { "type": "people" } })),
        };
    })
}

/// What opening a chat takes from the server's session, which may be let go of right after.
pub struct Opening {
    address: String,
    server_key: PublicKey,
    roster: Roster,
    transport: SessionGroupTransport,
    /// A way of its own for files, so a big upload never holds up the group.
    files: SessionGroupTransport,
    /// Where the rooms' ways to the server come from.
    seed: SessionGroupTransport,
    id: Identity,
}

impl Opening {
    pub fn new(session: &Session, id: &Identity) -> Self {
        Self {
            address: session.address.clone(),
            server_key: session.server_key,
            roster: session.roster().clone(),
            transport: SessionGroupTransport::new(session, id),
            files: SessionGroupTransport::new(session, id),
            seed: SessionGroupTransport::new(session, id),
            id: Identity::from_seed(id.seed()),
        }
    }
}

struct Chat {
    generation: u64,
    server_key: PublicKey,
    me: UserId,
    /// The journal the engine and the rules check people against; refreshed after every sync.
    journal: Journal,
    /// `None` while it starts: whatever comes meanwhile waits for it.
    engine: tokio::sync::Mutex<Option<GroupEngine<SessionGroupTransport>>>,
    model: Mutex<ChatModel>,
    /// What the window was last told.
    status: Mutex<GroupStatus>,
    files: SessionGroupTransport,
    /// The chat's folder, for the blobs of files.
    store: ChatStore,
    /// Where and when we last said we are typing.
    typed: Mutex<Option<(String, Instant)>>,
    /// Who we are here: every event we send is signed with this key.
    id: Identity,
    /// The profile this chat last sent.
    sent_profile: Mutex<Option<OwnProfile>>,
    /// What the others in the group play now, by their signals.
    games: Mutex<HashMap<UserId, String>>,
    /// We said «hello» since the group was last ready.
    said_hello: Mutex<bool>,
    /// Someone said «hello»: our game is owed to them.
    owe_game: Mutex<bool>,
    /// The packs we took (kept in `packs.bin`) and those that did not come this run.
    packs: Mutex<Vec<KeptPack>>,
    failed_packs: Mutex<HashSet<u64>>,
    /// The room this chat is (a closed channel's, direct messages'); none for the server's own group.
    room: Option<String>,
    /// The server's chat only: where its rooms' ways to the server come from.
    seed: Option<SessionGroupTransport>,
}

/// The chat of every open server, by address.
pub struct Chats {
    base: PathBuf,
    notify: Notify,
    open: Mutex<HashMap<String, Arc<Chat>>>,
    generation: AtomicU64,
    /// Held while a chat is looked for and put in place: two opens at once (the window retrying) make one chat.
    opening: tokio::sync::Mutex<()>,
    /// Our nickname, color and frame, as the window last set them; every chat sends them once its group is ready.
    profile: Mutex<Option<OwnProfile>>,
    /// What we play now, as the detector last said.
    playing: Mutex<Option<String>>,
}

fn fits(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max
}

fn check_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(EMPTY.into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(TOO_LONG.into());
    }
    Ok(())
}

/// The key of a room's chat among the open chats.
fn room_key(address: &str, room: &str) -> String {
    format!("{address}#{room}")
}

/// The journal lets `user` into a room of `scope` now, as the server does.
fn admit_room(journal: crate::call::Journal, scope: Scope) -> crate::call::Admit {
    Arc::new(move |user| {
        let roster = journal.read().unwrap_or_else(|e| e.into_inner());
        let member = roster.member(user).is_some() && !roster.is_banned_at(user, unix_now());
        member
            && match &scope {
                Scope::Main => true,
                Scope::Closed(id) => roster.channels().iter().any(|c| c.id == *id && c.is_closed()) && roster.access(user, id).is_some_and(|a| a.view),
                Scope::Dm { pair, .. } => pair.contains(user),
            }
    })
}

fn open_channel(roster: &Roster, channel: &str) -> Result<(), String> {
    match roster.channels().iter().find(|c| c.id == channel) {
        None => Err(NO_CHANNEL.into()),
        Some(c) if c.is_closed() => Err(CLOSED.into()),
        Some(_) => Ok(()),
    }
}

impl Chats {
    pub fn new(base: PathBuf, notify: Notify) -> Self {
        Self {
            base,
            notify,
            open: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            opening: tokio::sync::Mutex::new(()),
            profile: Mutex::new(None),
            playing: Mutex::new(None),
        }
    }

    fn chat(&self, address: &str) -> Option<Arc<Chat>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).get(address).cloned()
    }

    fn need(&self, address: &str) -> Result<Arc<Chat>, String> {
        self.chat(address).ok_or_else(|| NO_CHAT.into())
    }

    #[cfg(test)]
    pub fn is_open(&self, address: &str) -> bool {
        self.chat(address).is_some()
    }

    /// Opens the chat of a server: the history on disk at once, then the engine, which may wait for the server. The
    /// generation is the one [`tick`](Self::tick) takes. The window opens a server again each time it is picked:
    /// the chat already open for it (same key, same identity) stays, with the journal just read, and this is `None`.
    /// Another one at that address goes first, its engine done with whatever it was doing, so two engines never work
    /// on one folder.
    pub async fn open(&self, opening: Opening, now: Instant) -> Result<Option<u64>, String> {
        let Opening { address, server_key, roster, transport, files, seed, id } = opening;
        let placing = self.opening.lock().await;
        if let Some(chat) = self.chat(&address) {
            if chat.server_key == server_key && chat.me == id.public().user_id() {
                *chat.journal.write().unwrap_or_else(|e| e.into_inner()) = roster;
                return Ok(None);
            }
            self.close(&address).await;
        }
        // The same server under another address (its LAN one, a VPN's): one identity has one leaf in its group, so
        // two engines would push each other out by turns. The newest address keeps the chat.
        let elsewhere: Vec<String> = self
            .open
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(other, chat)| **other != address && chat.server_key == server_key)
            .map(|(other, _)| other.clone())
            .collect();
        for other in elsewhere {
            self.close(&other).await;
        }
        crate::chat_store::adopt_legacy(&self.base, &address, &server_key);
        let store = ChatStore::open(&self.base, &server_key)?;
        let history = store.load_history();
        let packs: Vec<KeptPack> = store.note(PACKS).and_then(|note| serde_json::from_slice(&note).ok()).unwrap_or_default();
        let model = build_model(id.public().user_id(), server_key, Scope::Main, &history, &packs, &roster);
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let chat = Arc::new(Chat {
            generation,
            server_key,
            me: id.public().user_id(),
            journal: Arc::new(RwLock::new(roster)),
            engine: tokio::sync::Mutex::new(None),
            model: Mutex::new(model),
            status: Mutex::new(GroupStatus::Joining),
            files,
            store: store.clone(),
            typed: Mutex::new(None),
            id: Identity::from_seed(id.seed()),
            sent_profile: Mutex::new(store.note(SENT_PROFILE).and_then(|note| serde_json::from_slice(&note).ok())),
            games: Mutex::new(HashMap::new()),
            said_hello: Mutex::new(false),
            owe_game: Mutex::new(false),
            packs: Mutex::new(packs),
            failed_packs: Mutex::new(HashSet::new()),
            room: None,
            seed: Some(seed),
        });
        // Taken before anyone can find the chat: events wait for the engine instead of missing it.
        let mut slot = chat.engine.lock().await;
        self.open.lock().unwrap_or_else(|e| e.into_inner()).insert(address.clone(), chat.clone());
        drop(placing);
        let (channels, named) = {
            let model = chat.model.lock().unwrap_or_else(|e| e.into_inner());
            (model.last_seqs().into_keys().collect::<Vec<String>>(), !model.profiles().is_empty())
        };
        if !channels.is_empty() {
            (self.notify)(Notice::Changed(ChatChanged { address: address.clone(), channels }));
        }
        // The window may have read the people before the names on disk were here.
        if named {
            (self.notify)(Notice::People(address.clone()));
        }
        (self.notify)(Notice::Status(ChatStatusEvent { address: address.clone(), status: GroupStatus::Joining }));
        let (engine, records) = GroupEngine::start(transport, &id, store, admit_by(chat.journal.clone()), now).await;
        let status = engine.status();
        *slot = Some(engine);
        // What came while the app was closed shows as unread, without a notification each.
        self.take_quietly(&chat, &address, &records, false);
        self.report(&chat, &address, status);
        if let Some(engine) = slot.as_mut() {
            self.settle(&chat, &address, engine).await;
        }
        Ok(Some(generation))
    }

    /// The chat of `address` goes (the server was left, or the identity changed); its history stays on disk. Returns
    /// once its engine is done with whatever it was doing.
    pub async fn close(&self, address: &str) {
        let rooms: Vec<String> = self.rooms_of(address).into_iter().map(|(key, _)| key).collect();
        for key in rooms.into_iter().chain([address.to_string()]) {
            let chat = self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            if let Some(chat) = chat {
                chat.engine.lock().await.take();
            }
        }
    }

    /// The rooms of `address` open now: (their key, the chat).
    fn rooms_of(&self, address: &str) -> Vec<(String, Arc<Chat>)> {
        let prefix = format!("{address}#");
        self.open.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(key, _)| key.starts_with(&prefix)).map(|(k, c)| (k.clone(), c.clone())).collect()
    }

    /// The chat that carries `channel` of `address`: the server's own for an open channel, a room for a closed one or
    /// for direct messages.
    fn chat_for(&self, address: &str, channel: &str) -> Result<Arc<Chat>, String> {
        let main = self.need(address)?;
        let roster = Self::roster(&main);
        match Scope::room_of(&roster, channel) {
            None => Ok(main),
            // A closed channel we may not see is no chat of ours.
            Some(_) if !channel.starts_with("dm.") && !roster.access(&main.me, channel).is_some_and(|access| access.view) => Err(NO_CHANNEL.into()),
            Some(room) => self.chat(&room_key(address, &room)).ok_or_else(|| ROOM_NOT_READY.into()),
        }
    }

    /// The chat of `address` (the server's or a room's) whose model has the message or poll `id`.
    fn chat_with(&self, address: &str, id: &str) -> Result<Arc<Chat>, String> {
        let main = self.need(address)?;
        let rooms = self.rooms_of(address).into_iter().map(|(_, chat)| chat);
        std::iter::once(main).chain(rooms).find(|chat| chat.model.lock().unwrap_or_else(|e| e.into_inner()).item(id).is_some()).ok_or_else(|| NO_MESSAGE.into())
    }

    /// `channel` is this chat's to write in: an open channel for the server's group, the room's own for a room.
    fn allowed(chat: &Chat, channel: &str) -> Result<(), String> {
        let roster = Self::roster(chat);
        let scope = chat.model.lock().unwrap_or_else(|e| e.into_inner()).scope().clone();
        match scope {
            Scope::Main => open_channel(&roster, channel),
            room if room.takes(&roster, channel, &chat.me) => Ok(()),
            _ => Err(NO_CHANNEL.into()),
        }
    }

    /// Opens the room `room` of `address` (its history at once, its engine then), unless it is open.
    pub async fn open_room(&self, address: &str, room: &str) -> Result<(), String> {
        let key = room_key(address, room);
        if self.chat(&key).is_some() {
            return Ok(());
        }
        let main = self.need(address)?;
        let scope = Scope::of_room(room).ok_or(NO_CHANNEL)?;
        if matches!(&scope, Scope::Dm { pair, .. } if !pair.contains(&main.me)) {
            return Err(NO_CHANNEL.into());
        }
        let seed = main.seed.as_ref().ok_or(NOT_READY)?;
        let store = ChatStore::open_room(&self.base, &main.server_key, room)?;
        let history = store.load_history();
        let packs: Vec<KeptPack> = store.note(PACKS).and_then(|note| serde_json::from_slice(&note).ok()).unwrap_or_default();
        let roster = Self::roster(&main);
        let model = build_model(main.me.clone(), main.server_key, scope.clone(), &history, &packs, &roster);
        let chat = Arc::new(Chat {
            generation: main.generation,
            server_key: main.server_key,
            me: main.me.clone(),
            // The server's journal itself: when it is read again, the room has it too.
            journal: main.journal.clone(),
            engine: tokio::sync::Mutex::new(None),
            model: Mutex::new(model),
            status: Mutex::new(GroupStatus::Joining),
            files: seed.for_room(room),
            store: store.clone(),
            typed: Mutex::new(None),
            id: Identity::from_seed(main.id.seed()),
            sent_profile: Mutex::new(None),
            games: Mutex::new(HashMap::new()),
            said_hello: Mutex::new(false),
            owe_game: Mutex::new(false),
            packs: Mutex::new(packs),
            failed_packs: Mutex::new(HashSet::new()),
            room: Some(room.to_string()),
            seed: None,
        });
        let mut slot = chat.engine.lock().await;
        {
            let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
            if open.contains_key(&key) {
                return Ok(());
            }
            open.insert(key.clone(), chat.clone());
        }
        let channels: Vec<String> = chat.model.lock().unwrap_or_else(|e| e.into_inner()).last_seqs().into_keys().collect();
        if !channels.is_empty() {
            (self.notify)(Notice::Changed(ChatChanged { address: address.to_string(), channels }));
        }
        if matches!(scope, Scope::Dm { .. }) {
            (self.notify)(Notice::Rooms(address.to_string()));
        }
        let admit = admit_room(chat.journal.clone(), scope);
        let (engine, records) = GroupEngine::start_in(seed.for_room(room), &chat.id, store, admit, &format!("@{room}"), Instant::now()).await;
        let status = engine.status();
        *slot = Some(engine);
        self.take_quietly(&chat, address, &records, false);
        *chat.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
        if let Some(engine) = slot.as_mut() {
            self.settle(&chat, address, engine).await;
        }
        Ok(())
    }

    /// The rooms of `address` follow the journal: a closed channel we may see has its room, one we may not see any
    /// more loses it (its history stays on disk). With `list`, the server's rooms of direct messages are opened too.
    pub async fn sync_rooms(&self, address: &str, list: bool) {
        let Some(main) = self.chat(address) else { return };
        let roster = Self::roster(&main);
        let wanted: Vec<String> = roster
            .channels()
            .iter()
            .filter(|c| c.is_closed() && roster.access(&main.me, &c.id).is_some_and(|access| access.view))
            .map(|c| format!("ch.{}", c.id))
            .collect();
        for (key, chat) in self.rooms_of(address) {
            if chat.room.as_deref().is_some_and(|room| room.starts_with("ch.") && !wanted.iter().any(|w| w == room)) {
                let removed = self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                if let Some(chat) = removed {
                    chat.engine.lock().await.take();
                }
            }
        }
        for room in wanted {
            if let Err(e) = self.open_room(address, &room).await {
                eprintln!("room {room} of {address} not opened: {e}");
            }
        }
        if !list {
            return;
        }
        let Some(seed) = main.seed.as_ref() else { return };
        match seed.rooms().await {
            Ok(rooms) => {
                for room in rooms {
                    if let Err(e) = self.open_room(address, &room).await {
                        eprintln!("room {room} of {address} not opened: {e}");
                    }
                }
            }
            Err(e) => eprintln!("rooms of {address} not listed: {}", e.message()),
        }
    }

    /// The rooms of direct messages of `address`: the channel and the other one of each.
    pub fn dms(&self, address: &str) -> Vec<DmView> {
        let mut dms: Vec<DmView> = self
            .rooms_of(address)
            .into_iter()
            .filter_map(|(_, chat)| {
                let model = chat.model.lock().unwrap_or_else(|e| e.into_inner());
                let peer = model.scope().peer(&chat.me)?.0.clone();
                Some(DmView { channel: chat.room.clone()?, peer, last: model.last_seqs().values().max().copied().unwrap_or(0) })
            })
            .collect();
        dms.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.peer.cmp(&b.peer)));
        dms
    }

    /// Our direct messages with `user` on `address`: their room opened (started on the server if new). Its channel.
    pub async fn open_dm(&self, address: &str, user: &str) -> Result<String, String> {
        let main = self.need(address)?;
        let user = UserId(user.to_string());
        if user == main.me || Self::roster(&main).member(&user).is_none() {
            return Err(NO_PERSON.into());
        }
        let room = Scope::dm_room(&main.me, &user);
        self.open_room(address, &room).await?;
        Ok(room)
    }

    pub async fn close_all(&self) {
        let chats: Vec<Arc<Chat>> = self.open.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, chat)| chat).collect();
        for chat in chats {
            chat.engine.lock().await.take();
        }
    }

    /// Records the engine gave go to the model; the window hears which channels changed.
    fn take(&self, chat: &Chat, address: &str, records: &[HistoryRecord]) {
        self.take_quietly(chat, address, records, true);
    }

    /// Records the engine gave go to the model; the window hears which channels changed and, when `announce`, of
    /// every new message or poll from someone else.
    fn take_quietly(&self, chat: &Chat, address: &str, records: &[HistoryRecord], announce: bool) {
        if records.is_empty() {
            return;
        }
        let roster = chat.journal.read().unwrap_or_else(|e| e.into_inner()).clone();
        let mut model = chat.model.lock().unwrap_or_else(|e| e.into_inner());
        let mut channels: Vec<String> = Vec::new();
        let mut news = Vec::new();
        for record in records {
            let Some(channel) = model.apply(record, &roster) else { continue };
            if !channels.contains(&channel) {
                channels.push(channel.clone());
            }
            let new = match ChatEvent::parse(&record.body) {
                Some(ChatEvent::Msg { id, .. } | ChatEvent::Poll { id, .. }) => Some(id),
                _ => None,
            };
            if let Some(id) = new.filter(|_| announce && record.sender != chat.me)
                && let Some((_, item)) = model.item(&id)
            {
                let text = item.poll.as_ref().map_or(item.text.clone(), |poll| poll.question.clone());
                news.push(ChatMessage {
                    address: address.to_string(),
                    channel,
                    id,
                    author: item.author,
                    text,
                    files: item.files.into_iter().map(|f| f.name).collect(),
                    mentions_me: item.mentions_me,
                    poll: item.poll.is_some(),
                });
            }
        }
        let people = model.take_people_changed();
        drop(model);
        if people {
            (self.notify)(Notice::People(address.to_string()));
        }
        if !channels.is_empty() {
            (self.notify)(Notice::Changed(ChatChanged { address: address.to_string(), channels }));
        }
        for message in news {
            (self.notify)(Notice::Message(message));
        }
    }

    fn report(&self, chat: &Chat, address: &str, status: GroupStatus) {
        let mut shown = chat.status.lock().unwrap_or_else(|e| e.into_inner());
        if *shown != status {
            *shown = status;
            (self.notify)(Notice::Status(ChatStatusEvent { address: address.to_string(), status }));
        }
    }

    /// A `group_*` event (or `resync`) from the stream of `address`.
    pub async fn on_event(&self, address: &str, event: &Value) {
        if event["type"] == "room_opened" {
            if let Some(room) = event["room"].as_str()
                && let Err(e) = self.open_room(address, room).await
            {
                eprintln!("room {room} of {address} not opened: {e}");
            }
            return;
        }
        // Back after a gap: rooms of direct messages may have been started meanwhile.
        if event["type"] == "resync" {
            self.sync_rooms(address, true).await;
        }
        let key = match event["room"].as_str() {
            Some(room) => room_key(address, room),
            None => address.to_string(),
        };
        let Some(chat) = self.chat(&key) else { return };
        let mut slot = chat.engine.lock().await;
        let Some(engine) = slot.as_mut() else { return };
        let records = engine.on_event(event, Instant::now()).await;
        let status = engine.status();
        let signals = engine.take_signals();
        self.take(&chat, address, &records);
        self.report(&chat, address, status);
        self.signals(&chat, address, signals);
        self.settle(&chat, address, engine).await;
    }

    /// What is due once the group is ready: the history for whoever our commit just put in, «hello» (and our game)
    /// when we just got there, our game to whoever said «hello», our profile when this chat has not sent it as it is.
    async fn settle(&self, chat: &Chat, address: &str, engine: &mut GroupEngine<SessionGroupTransport>) {
        let added = engine.take_added();
        if !added.is_empty() {
            self.send_pack(chat, address, engine, &added).await;
        }
        self.take_packs(chat, address).await;
        if chat.room.is_some() {
            return;
        }
        if engine.status() != GroupStatus::Ready {
            *chat.said_hello.lock().unwrap_or_else(|e| e.into_inner()) = false;
            return;
        }
        let game = self.playing.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let arrived = !std::mem::replace(&mut *chat.said_hello.lock().unwrap_or_else(|e| e.into_inner()), true);
        if arrived {
            let _ = engine.signal(br#"{"t":"hello"}"#).await;
        }
        let owed = std::mem::take(&mut *chat.owe_game.lock().unwrap_or_else(|e| e.into_inner()));
        if let Some(game) = game.as_deref().filter(|_| arrived || owed) {
            let _ = engine.signal(&playing_signal(Some(game))).await;
        }
        let wanted = self.profile.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(own) = wanted else { return };
        if chat.sent_profile.lock().unwrap_or_else(|e| e.into_inner()).as_ref() == Some(&own) {
            return;
        }
        let (nickname, color, frame, character) = own.clone();
        // In ms: two changes within a second must still be told apart, the newer one winning.
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let profile = sign_profile_full(&chat.id, &chat.server_key, &nickname, &color, frame.as_deref(), character.as_deref(), at);
        let records = match engine.send(ChatEvent::Profile { p: profile }.to_bytes(), Instant::now()).await {
            Ok(records) => records,
            Err(e) => {
                eprintln!("profile not sent to {address}: {e}");
                return;
            }
        };
        self.take(chat, address, &records);
        let _ = chat.store.save_note(SENT_PROFILE, &serde_json::to_vec(&own).unwrap_or_default());
        *chat.sent_profile.lock().unwrap_or_else(|e| e.into_inner()) = Some(own);
    }

    /// The history for `to`, whom our commit just put in: a pack of profiles and signed records for as many days as
    /// the server's settings say, sealed and put on the server like a file, its key in the group.
    async fn send_pack(&self, chat: &Chat, address: &str, engine: &mut GroupEngine<SessionGroupTransport>, to: &[UserId]) {
        let roster = Self::roster(chat);
        let days = u64::from(roster.settings().history_days);
        let since = (days > 0).then(|| unix_now().saturating_sub(days * 24 * 3600));
        let content = chat.model.lock().unwrap_or_else(|e| e.into_inner()).pack(&roster, since);
        let Some(plain) = content.fitted(MAX_FILE) else { return };
        let Ok((blob, key)) = seal_file(&plain) else { return };
        let sha = match chat.files.upload(&blob).await {
            Ok(sha) => sha,
            Err(e) => {
                eprintln!("history pack not put on {address}: {}", e.message());
                return;
            }
        };
        let _ = chat.store.put_blob(&sha, &blob);
        let event = ChatEvent::Pack { to: to.iter().map(|user| user.0.clone()).collect(), blob: sha, key: encode_b64(&key), size: plain.len() as u64 };
        match engine.send(event.to_bytes(), Instant::now()).await {
            Ok(records) => self.take(chat, address, &records),
            Err(e) => eprintln!("history pack not sent on {address}: {e}"),
        }
    }

    /// Packs for us that came and are not taken yet: each is fetched, opened and checked record by record; what
    /// passes goes into the model with the history, and the pack is kept for the next start. One that does not come
    /// is tried again at the next start.
    async fn take_packs(&self, chat: &Chat, address: &str) {
        let refs: Vec<PackRef> = chat.model.lock().unwrap_or_else(|e| e.into_inner()).packs().to_vec();
        let todo: Vec<PackRef> = {
            let kept = chat.packs.lock().unwrap_or_else(|e| e.into_inner());
            let failed = chat.failed_packs.lock().unwrap_or_else(|e| e.into_inner());
            refs.into_iter().filter(|pack| !kept.iter().any(|k| k.seq == pack.seq) && !failed.contains(&pack.seq)).collect()
        };
        for pack in todo {
            let content = match self.fetch_pack(chat, &pack).await {
                Some(content) => content,
                None => {
                    chat.failed_packs.lock().unwrap_or_else(|e| e.into_inner()).insert(pack.seq);
                    (self.notify)(Notice::Changed(ChatChanged { address: address.to_string(), channels: self.channels_of(chat) }));
                    continue;
                }
            };
            let packs = {
                let mut kept = chat.packs.lock().unwrap_or_else(|e| e.into_inner());
                kept.push(KeptPack { seq: pack.seq, from: pack.from.clone(), content });
                kept.clone()
            };
            let _ = chat.store.save_note(PACKS, &serde_json::to_vec(&packs).unwrap_or_default());
            let roster = Self::roster(chat);
            let scope = chat.model.lock().unwrap_or_else(|e| e.into_inner()).scope().clone();
            let model = build_model(chat.me.clone(), chat.server_key, scope, &chat.store.load_history(), &packs, &roster);
            *chat.model.lock().unwrap_or_else(|e| e.into_inner()) = model;
            (self.notify)(Notice::People(address.to_string()));
            (self.notify)(Notice::Changed(ChatChanged { address: address.to_string(), channels: self.channels_of(chat) }));
        }
    }

    /// The text channels of the chat's server, and any the model has messages in.
    fn channels_of(&self, chat: &Chat) -> Vec<String> {
        let mut channels: Vec<String> = Self::roster(chat).channels().iter().map(|c| c.id.clone()).collect();
        for channel in chat.model.lock().unwrap_or_else(|e| e.into_inner()).last_seqs().into_keys() {
            if !channels.contains(&channel) {
                channels.push(channel);
            }
        }
        channels
    }

    /// The content of a pack, fetched (or from this PC) and opened; `None` when it is gone or damaged.
    async fn fetch_pack(&self, chat: &Chat, pack: &PackRef) -> Option<PackContent> {
        let sealed = match chat.store.blob(&pack.blob) {
            Some(sealed) => sealed,
            None => {
                let fetched = chat.files.download(&pack.blob).await.ok()?;
                if blob_hash(&fetched) != pack.blob {
                    return None;
                }
                let _ = chat.store.put_blob(&pack.blob, &fetched);
                fetched
            }
        };
        let key = decode_b64::<32>(&pack.key)?;
        let plain = open_file(&sealed, &key).ok()?;
        let content: PackContent = serde_json::from_slice(&plain).ok()?;
        (content.v == PACK_VERSION).then_some(content)
    }

    /// Our nickname, color, frame and character: every open chat sends them now if its group is ready, the others once
    /// theirs is.
    pub async fn set_profile(&self, nickname: String, color: String, frame: Option<String>, character: Option<String>) {
        let frame = frame.filter(|f| !f.is_empty());
        let character = character.filter(|c| !c.is_empty());
        *self.profile.lock().unwrap_or_else(|e| e.into_inner()) = Some((nickname.trim().to_string(), color, frame, character));
        let chats: Vec<(String, Arc<Chat>)> = self.open.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(_, c)| c.room.is_none()).map(|(a, c)| (a.clone(), c.clone())).collect();
        for (address, chat) in chats {
            let mut slot = chat.engine.lock().await;
            if let Some(engine) = slot.as_mut() {
                self.settle(&chat, &address, engine).await;
            }
        }
    }

    /// Our nickname, as the window last set it.
    pub fn nickname(&self) -> Option<String> {
        self.profile.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(nickname, ..)| nickname.clone())
    }

    /// Who is who on `address`: the profiles its group has, ours among them even before it went out.
    pub fn people(&self, address: &str) -> People {
        let Some(chat) = self.chat(address) else { return People::default() };
        let mut profiles = chat.model.lock().unwrap_or_else(|e| e.into_inner()).profiles().clone();
        if !profiles.contains_key(&chat.me)
            && let Some((nickname, color, frame, character)) = self.profile.lock().unwrap_or_else(|e| e.into_inner()).clone()
        {
            let own = sign_profile_full(&chat.id, &chat.server_key, &nickname, &color, frame.as_deref(), character.as_deref(), 0);
            profiles.insert(chat.me.clone(), own);
        }
        let mut playing = chat.games.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(game) = self.playing.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            playing.insert(chat.me.clone(), game);
        }
        People { profiles, playing }
    }

    /// Signals that came: «печатает…» in a channel open now goes to the window, a game to the people, a «hello»
    /// makes our game owed.
    fn signals(&self, chat: &Chat, address: &str, signals: Vec<(UserId, Vec<u8>)>) {
        let roster = Self::roster(chat);
        let mut people = false;
        for (sender, body) in signals {
            let Ok(signal) = serde_json::from_slice::<Value>(&body) else { continue };
            if sender == chat.me {
                continue;
            }
            if chat.room.is_some() && signal["t"] != "typing" {
                continue;
            }
            match signal["t"].as_str() {
                Some("typing") => {
                    let Some(channel) = signal["ch"].as_str() else { continue };
                    let scope = chat.model.lock().unwrap_or_else(|e| e.into_inner()).scope().clone();
                    let fits = match &scope {
                        Scope::Main => open_channel(&roster, channel).is_ok(),
                        room => room.takes(&roster, channel, &sender),
                    };
                    if fits {
                        (self.notify)(Notice::Typing(ChatTyping { address: address.to_string(), channel: channel.to_string(), user: sender.0 }));
                    }
                }
                Some("playing") => {
                    let Some(game) = game_in(&signal) else { continue };
                    let mut games = chat.games.lock().unwrap_or_else(|e| e.into_inner());
                    let changed = match game {
                        Some(game) => games.insert(sender, game.clone()).as_ref() != Some(&game),
                        None => games.remove(&sender).is_some(),
                    };
                    people |= changed;
                }
                Some("hello") => *chat.owe_game.lock().unwrap_or_else(|e| e.into_inner()) = true,
                Some("watch") => {
                    let (Some(channel), Some(playing), Some(pos), Some(at)) =
                        (signal["ch"].as_str(), signal["playing"].as_bool(), signal["pos"].as_u64(), signal["at"].as_u64())
                    else {
                        continue;
                    };
                    let url = match &signal["url"] {
                        Value::Null => None,
                        Value::String(url) if watch_url(url) => Some(url.clone()),
                        _ => continue,
                    };
                    if pos <= MAX_WATCH_POS && open_channel(&roster, channel).is_ok() {
                        let picks = watch_picks(&signal["picks"]);
                        let watch = ChatWatch { address: address.to_string(), channel: channel.to_string(), user: sender.0.clone(), url, playing, pos, at, picks };
                        (self.notify)(Notice::Watch(watch));
                    }
                }
                Some("music") => {
                    let (Some(channel), Some(word)) = (signal["ch"].as_str(), crate::music_word::read(&signal)) else { continue };
                    if open_channel(&roster, channel).is_ok() {
                        let crate::music_word::MusicWord { on, take, title, artist, app, cover } = word;
                        let music = ChatMusic { address: address.to_string(), channel: channel.to_string(), user: sender.0.clone(), on, take, title, artist, app, cover };
                        (self.notify)(Notice::Music(music));
                    }
                }
                Some("act") => {
                    let (Some(channel), Some(act)) = (signal["ch"].as_str(), signal["a"].as_str()) else { continue };
                    let to = match &signal["to"] {
                        Value::Null => None,
                        Value::String(to) if act_target(to) => Some(to.clone()),
                        _ => continue,
                    };
                    if act_name(act) && open_channel(&roster, channel).is_ok() {
                        let act = ChatAct { address: address.to_string(), channel: channel.to_string(), user: sender.0.clone(), act: act.to_string(), to };
                        (self.notify)(Notice::Act(act));
                    }
                }
                // Remote control's and game pads' signals: they check them themselves.
                Some(kind) if kind.starts_with("rc-") || kind.starts_with("pad-") => {
                    (self.notify)(Notice::Remote { address: address.to_string(), sender: sender.clone(), body: signal.clone() });
                }
                _ => {}
            }
        }
        if people {
            (self.notify)(Notice::People(address.to_string()));
        }
    }

    /// `user` of `address` came online or went: one who went plays nothing any more. When it is us coming back
    /// (the stream dropped and the others heard we went), we say «hello» and our game again.
    pub fn online(&self, address: &str, user: &UserId, online: bool) {
        let Some(chat) = self.chat(address) else { return };
        if online && *user == chat.me {
            *chat.said_hello.lock().unwrap_or_else(|e| e.into_inner()) = false;
            return;
        }
        if !online && chat.games.lock().unwrap_or_else(|e| e.into_inner()).remove(user).is_some() {
            (self.notify)(Notice::People(address.to_string()));
        }
    }

    /// What we play now (`None`: nothing): every chat whose group is ready tells the others at once.
    pub async fn set_playing(&self, game: Option<String>) {
        let game = game.map(|g| g.trim().chars().take(MAX_GAME).collect::<String>()).filter(|g| !g.is_empty());
        *self.playing.lock().unwrap_or_else(|e| e.into_inner()) = game.clone();
        let chats: Vec<(String, Arc<Chat>)> = self.open.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(_, c)| c.room.is_none()).map(|(a, c)| (a.clone(), c.clone())).collect();
        for (address, chat) in chats {
            let mut slot = chat.engine.lock().await;
            let Some(engine) = slot.as_mut().filter(|engine| engine.status() == GroupStatus::Ready) else { continue };
            if let Err(e) = engine.signal(&playing_signal(game.as_deref())).await {
                eprintln!("game not told on {address}: {e}");
            }
        }
    }

    /// What we watch with the others in voice channel `channel` (`url: None` stops it for everyone): they hear of it
    /// through the group, the server sees only that something went.
    #[allow(clippy::too_many_arguments)]
    pub async fn watch(&self, address: &str, channel: &str, url: Option<String>, playing: bool, pos: u64, at: u64, picks: &Value) -> Result<(), String> {
        let chat = self.need(address)?;
        open_channel(&Self::roster(&chat), channel)?;
        if url.as_deref().is_some_and(|url| !watch_url(url)) || pos > MAX_WATCH_POS {
            return Err("Такую ссылку нельзя смотреть вместе".into());
        }
        let body = serde_json::json!({ "t": "watch", "ch": channel, "url": url, "playing": playing, "pos": pos, "at": at, "picks": watch_picks(picks) });
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        engine.signal(body.to_string().as_bytes()).await
    }

    /// What we play for the others in voice channel `channel` (music together): they hear of it through the group, the
    /// server sees only that something went.
    pub async fn music(&self, address: &str, channel: &str, word: crate::music_word::MusicWord) -> Result<(), String> {
        let chat = self.need(address)?;
        open_channel(&Self::roster(&chat), channel)?;
        if !word.valid() {
            return Err("Такое о музыке не отправить".into());
        }
        let body = crate::music_word::body(channel, &word);
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        engine.signal(body.to_string().as_bytes()).await
    }

    /// Our 3D character in voice channel `channel` does `act` (to `to`, if anyone): the others see it at once.
    pub async fn act(&self, address: &str, channel: &str, act: &str, to: Option<String>) -> Result<(), String> {
        let chat = self.need(address)?;
        open_channel(&Self::roster(&chat), channel)?;
        if !act_name(act) || to.as_deref().is_some_and(|to| !act_target(to)) {
            return Err("Такого действия нет".into());
        }
        let body = serde_json::json!({ "t": "act", "ch": channel, "a": act, "to": to });
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        engine.signal(body.to_string().as_bytes()).await
    }

    /// What remote control needs of `address` — its key, who we are, the members' keys — and our identity to sign
    /// with there.
    pub fn with_remote<R>(&self, address: &str, f: impl FnOnce(&crate::remote::Ctx, &Identity) -> R) -> Result<R, String> {
        let chat = self.need(address)?;
        let roster = Self::roster(&chat);
        let key_of = |user: &UserId| roster.member(user).map(|m| m.key);
        let ctx = crate::remote::Ctx { address, server_key: chat.server_key, me: chat.me.clone(), key_of: &key_of };
        Ok(f(&ctx, &chat.id))
    }

    /// A signal of remote control to the others on `address`, through the group.
    pub async fn signal(&self, address: &str, body: &Value) -> Result<(), String> {
        let chat = self.need(address)?;
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        engine.signal(body.to_string().as_bytes()).await
    }

    /// We are typing in `channel`: the others hear of it, at most every [`TYPING_EVERY`].
    pub async fn typing(&self, address: &str, channel: &str) -> Result<(), String> {
        let chat = self.chat_for(address, channel)?;
        Self::allowed(&chat, channel)?;
        {
            let mut typed = chat.typed.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if typed.as_ref().is_some_and(|(there, at)| there == channel && now.duration_since(*at) < TYPING_EVERY) {
                return Ok(());
            }
            *typed = Some((channel.to_string(), now));
        }
        let body = serde_json::json!({ "t": "typing", "ch": channel }).to_string().into_bytes();
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        engine.signal(&body).await
    }

    /// Time passes for the chat of `address`; false once it is not the chat of `generation` any more.
    pub async fn tick(&self, address: &str, generation: u64) -> bool {
        let Some(chat) = self.chat(address).filter(|chat| chat.generation == generation) else { return false };
        let mut slot = chat.engine.lock().await;
        let Some(engine) = slot.as_mut() else { return true };
        let records = engine.tick(Instant::now()).await;
        let status = engine.status();
        self.take(&chat, address, &records);
        self.report(&chat, address, status);
        self.settle(&chat, address, engine).await;
        drop(slot);
        for (_, room) in self.rooms_of(address) {
            let mut slot = room.engine.lock().await;
            let Some(engine) = slot.as_mut() else { continue };
            let records = engine.tick(Instant::now()).await;
            *room.status.lock().unwrap_or_else(|e| e.into_inner()) = engine.status();
            self.take(&room, address, &records);
            self.settle(&room, address, engine).await;
        }
        true
    }

    /// The session of `address` has re-read its journal: the chat checks people and rules against the new one.
    pub async fn journal_read(&self, address: &str, roster: &Roster) {
        let Some(chat) = self.chat(address) else { return };
        *chat.journal.write().unwrap_or_else(|e| e.into_inner()) = roster.clone();
        let mut slot = chat.engine.lock().await;
        let Some(engine) = slot.as_mut() else { return };
        let records = engine.journal_changed(Instant::now()).await;
        let status = engine.status();
        self.take(&chat, address, &records);
        self.report(&chat, address, status);
        self.settle(&chat, address, engine).await;
        drop(slot);
        // The rooms share the journal: they check their people against it, and follow its closed channels.
        for (_, room) in self.rooms_of(address) {
            let mut slot = room.engine.lock().await;
            let Some(engine) = slot.as_mut() else { continue };
            let records = engine.journal_changed(Instant::now()).await;
            self.take(&room, address, &records);
            self.settle(&room, address, engine).await;
        }
        self.sync_rooms(address, false).await;
    }

    pub fn view(&self, address: &str, channel: &str) -> ChannelChat {
        let Ok(chat) = self.chat_for(address, channel) else {
            return ChannelChat { channel: channel.to_string(), items: Vec::new(), last_seq: 0, history: None };
        };
        let model = chat.model.lock().unwrap_or_else(|e| e.into_inner());
        let mut view = model.channel(channel);
        let first = model.packs().first().cloned();
        drop(model);
        view.history = first.map(|pack| {
            let kept = chat.packs.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|k| k.seq == pack.seq).map(|k| k.content.records.is_empty());
            let failed = chat.failed_packs.lock().unwrap_or_else(|e| e.into_inner()).contains(&pack.seq);
            let state = match kept {
                Some(true) if Self::roster(&chat).settings().history_days == 0 => "off",
                Some(_) => "passed",
                None if failed => "failed",
                None => "loading",
            };
            HistoryNote { state, from: pack.from.0, before: pack.seq }
        });
        view
    }

    pub fn status(&self, address: &str) -> GroupStatus {
        self.chat(address).map_or(GroupStatus::Joining, |chat| *chat.status.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn unread_base(&self, address: &str) -> HashMap<String, UnreadBase> {
        let Some(main) = self.chat(address) else { return HashMap::new() };
        let mut base = HashMap::new();
        for chat in std::iter::once(main).chain(self.rooms_of(address).into_iter().map(|(_, chat)| chat)) {
            base.extend(chat.model.lock().unwrap_or_else(|e| e.into_inner()).unread(&chat.me));
        }
        base
    }

    fn roster(chat: &Chat) -> Roster {
        chat.journal.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The message or poll `id` as the model has it now, with its channel, still there and in an open channel.
    fn live_item(chat: &Chat, id: &str) -> Result<(String, ItemView), String> {
        let (channel, item) = chat.model.lock().unwrap_or_else(|e| e.into_inner()).item(id).ok_or(NO_MESSAGE)?;
        if item.deleted {
            return Err(NO_MESSAGE.into());
        }
        Self::allowed(chat, &channel)?;
        Ok((channel, item))
    }

    /// Sends one chat event, whose rule the caller has checked.
    async fn send(&self, address: &str, chat: &Chat, event: ChatEvent) -> Result<(), String> {
        ChatEvent::parse(&event.to_bytes()).ok_or("Неверное сообщение")?;
        let target = match &event {
            ChatEvent::Edit { id, .. } => chat.model.lock().unwrap_or_else(|e| e.into_inner()).content(id),
            _ => None,
        };
        let body = sign_event(&chat.id, &chat.server_key, &event, target.as_ref()).ok_or("Сообщение не найдено")?;
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        let sent = engine.send(body, Instant::now()).await;
        let status = engine.status();
        self.report(chat, address, status);
        self.take(chat, address, &sent?);
        Ok(())
    }

    /// A message with up to ten files. The files are read first, then each is sealed and put on the server; a file
    /// that can't be read or put sends nothing.
    pub async fn send_message(&self, address: &str, channel: &str, text: String, reply: Option<String>, files: Vec<Attachment>) -> Result<(), String> {
        let chat = self.chat_for(address, channel)?;
        if files.len() > MAX_FILES {
            return Err(TOO_MANY_FILES.into());
        }
        if files.is_empty() {
            check_text(&text)?;
        } else if text.chars().count() > MAX_TEXT {
            return Err(TOO_LONG.into());
        }
        Self::allowed(&chat, channel)?;
        if let Some(quoted) = &reply {
            let (quoted_channel, _) = Self::live_item(&chat, quoted)?;
            if quoted_channel != channel {
                return Err(NO_MESSAGE.into());
            }
        }
        let loaded = files.into_iter().map(Attachment::read).collect::<Result<Vec<_>, String>>()?;
        let total: u64 = loaded.iter().map(Loaded::size).sum();
        let mut progress = Progress { notify: &self.notify, address, key: format!("up:{channel}"), done: 0, total };
        let mut sent = Vec::with_capacity(loaded.len());
        for file in loaded {
            match file {
                Loaded::Whole { name, bytes: plain } => {
                    let (blob, key) = seal_file(&plain)?;
                    let sha = Self::put_blob(&chat, &blob).await?;
                    // The sender sees it at once, without fetching it back.
                    let _ = chat.store.put_blob(&sha, &blob);
                    let mime = sniff(&plain).unwrap_or(OCTET).to_string();
                    progress.add(plain.len() as u64);
                    sent.push(FileRef { blob: sha, size: plain.len() as u64, key: encode_b64(&key), name, mime, parts: None });
                }
                Loaded::Big { name, path, size } => sent.push(Self::put_parts(&chat, name, &path, size, &mut progress).await?),
            }
        }
        let event = ChatEvent::Msg { id: new_id()?, ch: channel.to_string(), text, reply, files: sent };
        self.send(address, &chat, event).await
    }

    /// A sealed blob on the server: its name. When the server says too many files went in a minute (a big file is many
    /// parts), it waits and puts it again.
    async fn put_blob(chat: &Chat, blob: &[u8]) -> Result<String, String> {
        let mut tries = 0;
        let sha = loop {
            match chat.files.upload(blob).await {
                Ok(sha) => break sha,
                Err(ServerError::Refused(text)) if text.contains("подожди") && tries < BUSY_TRIES => {
                    tries += 1;
                    tokio::time::sleep(BUSY_WAIT).await;
                }
                Err(e) => return Err(e.message()),
            }
        };
        if sha != blob_hash(blob) {
            return Err("Сервер принял файл с ошибкой — попробуй ещё раз".into());
        }
        Ok(sha)
    }

    /// A file bigger than 25 MB on the server: read, sealed and put part by part (16 MB each, the same key), then the
    /// sealed list of the parts, which the message names. Nothing of it is kept here: the file is on this PC already.
    async fn put_parts(chat: &Chat, name: String, path: &Path, size: u64, progress: &mut Progress<'_>) -> Result<FileRef, String> {
        let key = new_key()?;
        let parts = parts_for(size);
        let mut file = std::fs::File::open(path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
        let mut hashes = Vec::with_capacity(parts as usize);
        let mut mime = OCTET;
        let mut left = size;
        for index in 0..parts {
            let want = left.min(PART as u64) as usize;
            let (rest, plain) = read_part(file, want).await?;
            file = rest;
            if index == 0 {
                mime = sniff(&plain).unwrap_or(OCTET);
            }
            let blob = seal_with(&plain, &key)?;
            hashes.push(Self::put_blob(chat, &blob).await?);
            left -= want as u64;
            progress.add(want as u64);
        }
        let list = seal_parts(&hashes, &key)?;
        let sha = Self::put_blob(chat, &list).await?;
        let _ = chat.store.put_blob(&sha, &list);
        Ok(FileRef { blob: sha, size, key: encode_b64(&key), name, mime: mime.to_string(), parts: Some(parts) })
    }

    /// A file of a message the model holds, in a channel open now: the chat it is in, the file, and its key.
    fn find_file(&self, address: &str, blob: &str) -> Result<(Arc<Chat>, FileRef, [u8; 32]), (u16, String)> {
        let main = self.chat(address).ok_or_else(missing)?;
        let roster = Self::roster(&main);
        let rooms = self.rooms_of(address).into_iter().map(|(_, chat)| chat);
        let (chat, (file, _)) = std::iter::once(main)
            .chain(rooms)
            .find_map(|chat| {
                let found = chat.model.lock().unwrap_or_else(|e| e.into_inner()).file(blob, &roster);
                found.map(|found| (chat, found))
            })
            .ok_or_else(missing)?;
        let key = decode_b64::<32>(&file.key).ok_or_else(damaged)?;
        Ok((chat, file, key))
    }

    /// A sealed blob: from the chat's folder, or from the server (checked against its hash; kept when `keep`).
    async fn sealed(chat: &Chat, blob: &str, keep: bool) -> Result<Vec<u8>, (u16, String)> {
        if let Some(sealed) = chat.store.blob(blob) {
            return Ok(sealed);
        }
        let fetched = chat.files.download(blob).await.map_err(|e| match e {
            ServerError::Refused(text) if text == NO_FILE => missing(),
            other => (502, other.message()),
        })?;
        if blob_hash(&fetched) != blob {
            return Err(damaged());
        }
        if keep {
            let _ = chat.store.put_blob(blob, &fetched);
        }
        Ok(fetched)
    }

    /// A file of a message the model holds, in a channel open now, opened: its bytes and its type by its first bytes.
    /// The blob comes from the chat's folder, or from the server (checked against its hash, then kept). A file in
    /// parts is never opened whole here: it is saved.
    pub async fn file_bytes(&self, address: &str, blob: &str) -> Result<(Vec<u8>, String), (u16, String)> {
        let (chat, file, key) = self.find_file(address, blob)?;
        if file.parts.is_some() {
            return Err((413, SAVE_ONLY.to_string()));
        }
        let sealed = Self::sealed(&chat, blob, true).await?;
        let plain = open_file(&sealed, &key).map_err(|_| damaged())?;
        let mime = sniff(&plain).unwrap_or(OCTET).to_string();
        Ok((plain, mime))
    }

    /// Each part of a file in parts, opened, in order, handed to `take` (the window hears how far it is).
    async fn each_part<F, Fut>(&self, address: &str, chat: &Chat, file: &FileRef, key: &[u8; 32], mut take: F) -> Result<(), String>
    where
        F: FnMut(Vec<u8>) -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        let parts = file.parts.ok_or(SAVE_ONLY)?;
        let list = Self::sealed(chat, &file.blob, true).await.map_err(|(_, text)| text)?;
        let hashes = open_parts(&list, key, parts).map_err(FileError::text)?;
        let mut progress = Progress { notify: &self.notify, address, key: format!("down:{}", file.blob), done: 0, total: file.size };
        let mut left = file.size;
        for hash in hashes {
            let sealed = Self::sealed(chat, &hash, false).await.map_err(|(_, text)| text)?;
            let plain = open_file(&sealed, key).map_err(FileError::text)?;
            let want = left.min(PART as u64);
            if plain.len() as u64 != want {
                return Err(FileError::Damaged.text().into());
            }
            left -= want;
            take(plain).await?;
            progress.add(want);
        }
        Ok(())
    }

    /// Saves a file of the chat where the person chose in the program's own dialog (`token`, see `picked`); a file in
    /// parts is written part by part as they come, and nothing half-written is left when one does not.
    pub async fn save_file(&self, address: &str, blob: &str, token: &str) -> Result<(), String> {
        let (chat, file, key) = self.find_file(address, blob).map_err(|(_, text)| text)?;
        let path = crate::picked::take(token, crate::picked::Access::Write)?;
        let shown = path.to_string_lossy().into_owned();
        if file.parts.is_none() {
            let (plain, _) = self.file_bytes(address, blob).await.map_err(|(_, text)| text)?;
            std::fs::write(&path, plain).map_err(|e| format!("Не записывается {shown}: {e}"))?;
        } else {
            let out = std::fs::File::create(&path).map_err(|e| format!("Не записывается {shown}: {e}"))?;
            let slot = Arc::new(tokio::sync::Mutex::new(Some(out)));
            let written = self
                .each_part(address, &chat, &file, &key, |plain| {
                    let slot = slot.clone();
                    async move {
                        let mut slot = slot.lock().await;
                        let out = slot.take().ok_or("Файл не записался")?;
                        *slot = Some(write_part(out, plain).await?);
                        Ok(())
                    }
                })
                .await;
            drop(slot);
            if let Err(e) = written {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
        }
        mark_from_internet(&shown);
        crate::picked::written(&path)
    }

    /// A file of the chat opened whole, a big one put together from its parts, if it is no bigger than `max` bytes
    /// (to be sent to an antivirus site the person asked for).
    pub async fn file_whole(&self, address: &str, blob: &str, max: u64) -> Result<Vec<u8>, String> {
        let (chat, file, key) = self.find_file(address, blob).map_err(|(_, text)| text)?;
        if file.size > max {
            return Err(format!("Файл больше {} МБ — так его не отправить", max / (1024 * 1024)));
        }
        if file.parts.is_none() {
            return Ok(self.file_bytes(address, blob).await.map_err(|(_, why)| why)?.0);
        }
        let whole = Arc::new(Mutex::new(Vec::with_capacity(file.size as usize)));
        self.each_part(address, &chat, &file, &key, |plain| {
            whole.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&plain);
            async { Ok(()) }
        })
        .await?;
        let bytes = std::mem::take(&mut *whole.lock().unwrap_or_else(|e| e.into_inner()));
        Ok(bytes)
    }

    /// A file's fingerprint (SHA-256 of its opened bytes, in hex), a big one counted part by part.
    pub async fn file_fingerprint(&self, address: &str, blob: &str) -> Result<String, String> {
        use sha2::Digest;
        let (chat, file, key) = self.find_file(address, blob).map_err(|(_, text)| text)?;
        if file.parts.is_none() {
            let (bytes, _) = self.file_bytes(address, blob).await.map_err(|(_, why)| why)?;
            return Ok(fingerprint(&bytes));
        }
        let hasher = Arc::new(Mutex::new(sha2::Sha256::new()));
        self.each_part(address, &chat, &file, &key, |plain| {
            hasher.lock().unwrap_or_else(|e| e.into_inner()).update(&plain);
            async { Ok(()) }
        })
        .await?;
        let digest = hasher.lock().unwrap_or_else(|e| e.into_inner()).clone().finalize();
        Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
    }

    pub async fn edit(&self, address: &str, id: &str, text: String) -> Result<(), String> {
        let chat = self.chat_with(address, id)?;
        check_text(&text)?;
        let (_, item) = Self::live_item(&chat, id)?;
        if item.author != chat.me.0 || item.poll.is_some() {
            return Err(NOT_YOURS.into());
        }
        if item.text == text {
            return Ok(());
        }
        self.send(address, &chat, ChatEvent::Edit { id: id.to_string(), text }).await
    }

    pub async fn delete(&self, address: &str, id: &str) -> Result<(), String> {
        let chat = self.chat_with(address, id)?;
        let (_, item) = Self::live_item(&chat, id)?;
        if item.author != chat.me.0 && !Self::roster(&chat).permissions_of(&chat.me).has(Permission::ManageChannels) {
            return Err(NOT_YOURS_TO_DELETE.into());
        }
        self.send(address, &chat, ChatEvent::Del { id: id.to_string() }).await
    }

    pub async fn react(&self, address: &str, id: &str, emoji: String, on: bool) -> Result<(), String> {
        let chat = self.chat_with(address, id)?;
        let (_, item) = Self::live_item(&chat, id)?;
        let event = ChatEvent::React { id: id.to_string(), emoji, on };
        ChatEvent::parse(&event.to_bytes()).ok_or(NOT_EMOJI)?;
        let ChatEvent::React { emoji, .. } = &event else { unreachable!() };
        let mine = item.reactions.iter().any(|r| r.emoji == *emoji && r.users.contains(&chat.me.0));
        if mine == on {
            return Ok(());
        }
        self.send(address, &chat, event).await
    }

    pub async fn poll(&self, address: &str, channel: &str, question: String, options: Vec<String>, multi: bool) -> Result<(), String> {
        let chat = self.chat_for(address, channel)?;
        if !fits(&question, MAX_QUESTION) {
            return Err(BAD_QUESTION.into());
        }
        if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&options.len()) || !options.iter().all(|o| fits(o, MAX_OPTION)) {
            return Err(BAD_OPTIONS.into());
        }
        Self::allowed(&chat, channel)?;
        let event = ChatEvent::Poll { id: new_id()?, ch: channel.to_string(), q: question, opts: options, multi };
        self.send(address, &chat, event).await
    }

    fn live_poll(chat: &Chat, poll: &str) -> Result<ItemView, String> {
        let (_, item) = Self::live_item(chat, poll).map_err(|_| NO_POLL.to_string())?;
        match &item.poll {
            None => Err(NO_POLL.into()),
            Some(view) if view.closed => Err(POLL_CLOSED.into()),
            Some(_) => Ok(item),
        }
    }

    pub async fn vote(&self, address: &str, poll: &str, choice: Vec<u8>) -> Result<(), String> {
        let chat = self.chat_with(address, poll).map_err(|_| NO_POLL.to_string())?;
        let item = Self::live_poll(&chat, poll)?;
        let view = item.poll.as_ref().ok_or(NO_POLL)?;
        if !view.multi && choice.len() > 1 {
            return Err(ONE_CHOICE.into());
        }
        let mut seen = std::collections::HashSet::new();
        if choice.iter().any(|&n| usize::from(n) >= view.options.len() || !seen.insert(n)) {
            return Err(NO_CHOICE.into());
        }
        self.send(address, &chat, ChatEvent::Vote { poll: poll.to_string(), choice }).await
    }

    pub async fn close_poll(&self, address: &str, poll: &str) -> Result<(), String> {
        let chat = self.chat_with(address, poll).map_err(|_| NO_POLL.to_string())?;
        let item = Self::live_poll(&chat, poll)?;
        if item.author != chat.me.0 {
            return Err(NOT_YOUR_POLL.into());
        }
        self.send(address, &chat, ChatEvent::Close { poll: poll.to_string() }).await
    }

    /// The owner starts the group over; everyone joins the new one, the history stays where it is.
    pub async fn reset(&self, address: &str) -> Result<(), String> {
        let chat = self.need(address)?;
        if Self::roster(&chat).owner().map(|owner| owner.user_id()) != Some(chat.me.clone()) {
            return Err(NOT_OWNER.into());
        }
        let mut slot = chat.engine.lock().await;
        let engine = slot.as_mut().ok_or(NOT_READY)?;
        engine.reset(Instant::now()).await?;
        let status = engine.status();
        self.report(&chat, address, status);
        Ok(())
    }
}

/// Opens the chat of the server `session` is open on, behind the caller's back, with its timer.
pub fn start(app: &tauri::AppHandle, session: &Session, id: &Identity) {
    let opening = Opening::new(session, id);
    let address = session.address.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let generation = match app.state::<Chats>().open(opening, Instant::now()).await {
            Ok(Some(generation)) => generation,
            // Open already, with its timer: its rooms may have changed meanwhile.
            Ok(None) => {
                app.state::<Chats>().sync_rooms(&address, true).await;
                return;
            }
            Err(e) => {
                eprintln!("chat of {address} not opened: {e}");
                return;
            }
        };
        app.state::<Chats>().sync_rooms(&address, true).await;
        loop {
            tokio::time::sleep(TICK).await;
            if !app.state::<Chats>().tick(&address, generation).await {
                return;
            }
        }
    });
}

/// A `group_*` event (or a `resync`) from the stream of `address`.
pub async fn on_server_event(app: &tauri::AppHandle, address: &str, event: &Value) {
    app.state::<Chats>().on_event(address, event).await;
}

#[tauri::command]
pub fn chat_view(chats: tauri::State<'_, Chats>, address: String, channel: String) -> ChannelChat {
    chats.view(&address, &channel)
}

/// One room of direct messages, for the window's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DmView {
    pub channel: String,
    pub peer: String,
    /// The number of its newest entry: the list is newest first.
    pub last: u64,
}

#[tauri::command]
pub fn chat_dms(chats: tauri::State<'_, Chats>, address: String) -> Vec<DmView> {
    chats.dms(&address)
}

#[tauri::command]
pub async fn chat_dm_open(chats: tauri::State<'_, Chats>, address: String, user: String) -> Result<String, String> {
    chats.open_dm(&address, &user).await
}

#[tauri::command]
pub fn chat_status(chats: tauri::State<'_, Chats>, address: String) -> GroupStatus {
    chats.status(&address)
}

/// The numbers of others' messages and polls in each channel (the newest 100): what the window counts unread
/// against what it marked read.
#[tauri::command]
pub fn chat_unread_base(chats: tauri::State<'_, Chats>, address: String) -> HashMap<String, UnreadBase> {
    chats.unread_base(&address)
}

#[tauri::command]
pub async fn chat_send(
    chats: tauri::State<'_, Chats>,
    address: String,
    channel: String,
    text: String,
    reply: Option<String>,
    files: Option<Vec<Attachment>>,
) -> Result<(), String> {
    chats.send_message(&address, &channel, text, reply, files.unwrap_or_default()).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_watch(
    chats: tauri::State<'_, Chats>,
    address: String,
    channel: String,
    url: Option<String>,
    playing: bool,
    pos: u64,
    at: u64,
    picks: Option<Value>,
) -> Result<(), String> {
    chats.watch(&address, &channel, url, playing, pos, at, &picks.unwrap_or(Value::Null)).await
}

#[tauri::command]
pub async fn chat_music(chats: tauri::State<'_, Chats>, address: String, channel: String, word: crate::music_word::MusicWord) -> Result<(), String> {
    chats.music(&address, &channel, word).await
}

#[tauri::command]
pub async fn chat_act(chats: tauri::State<'_, Chats>, address: String, channel: String, act: String, to: Option<String>) -> Result<(), String> {
    chats.act(&address, &channel, &act, to).await
}

#[tauri::command]
pub async fn chat_typing(chats: tauri::State<'_, Chats>, address: String, channel: String) -> Result<(), String> {
    chats.typing(&address, &channel).await
}

#[tauri::command]
pub async fn chat_file_save(chats: tauri::State<'_, Chats>, address: String, blob: String, token: String) -> Result<(), String> {
    chats.save_file(&address, &blob, &token).await
}

/// A file's fingerprint as antivirus sites know files: SHA-256 of its opened bytes, in hex. Only this goes out to look
/// a file up (VirusTotal): never the file, nor anything of the chat.
pub fn fingerprint(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[tauri::command]
pub async fn chat_file_fingerprint(chats: tauri::State<'_, Chats>, address: String, blob: String) -> Result<String, String> {
    chats.file_fingerprint(&address, &blob).await
}

/// Marks a saved file as one from the internet, as a browser marks a download: SmartScreen asks before it runs a
/// program, Office opens a document read-only. A disk that keeps no such mark (FAT) is left as it is.
fn mark_from_internet(path: &str) {
    if cfg!(windows) {
        let _ = std::fs::write(format!("{path}:Zone.Identifier"), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
}

/// The server's address and the blob in an `hvmedia` path `/chat/{percent(address)}/{blob}`.
fn media_path(path: &str) -> Option<(String, String)> {
    let (address, blob) = path.strip_prefix("/chat/")?.rsplit_once('/')?;
    let address = percent_encoding::percent_decode_str(address).decode_utf8().ok()?;
    let hex = blob.len() == 64 && blob.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (hex && !address.is_empty()).then(|| (address.into_owned(), blob.to_string()))
}

/// `hvmedia` `/chat/{percent(address)}/{blob}`: a file of the chat, opened, for the window to show.
pub async fn media(app: &tauri::AppHandle, path: &str) -> Result<(Vec<u8>, String), (u16, String)> {
    let (address, blob) = media_path(path).ok_or_else(|| (400, "Испорчена ссылка на файл".to_string()))?;
    app.state::<Chats>().file_bytes(&address, &blob).await
}

#[tauri::command]
pub async fn chat_edit(chats: tauri::State<'_, Chats>, address: String, id: String, text: String) -> Result<(), String> {
    chats.edit(&address, &id, text).await
}

#[tauri::command]
pub async fn chat_delete(chats: tauri::State<'_, Chats>, address: String, id: String) -> Result<(), String> {
    chats.delete(&address, &id).await
}

#[tauri::command]
pub async fn chat_react(chats: tauri::State<'_, Chats>, address: String, id: String, emoji: String, on: bool) -> Result<(), String> {
    chats.react(&address, &id, emoji, on).await
}

#[tauri::command]
pub async fn chat_poll(
    chats: tauri::State<'_, Chats>,
    address: String,
    channel: String,
    question: String,
    options: Vec<String>,
    multi: bool,
) -> Result<(), String> {
    chats.poll(&address, &channel, question, options, multi).await
}

#[tauri::command]
pub async fn chat_vote(chats: tauri::State<'_, Chats>, address: String, poll: String, choice: Vec<u8>) -> Result<(), String> {
    chats.vote(&address, &poll, choice).await
}

#[tauri::command]
pub async fn chat_poll_close(chats: tauri::State<'_, Chats>, address: String, poll: String) -> Result<(), String> {
    chats.close_poll(&address, &poll).await
}

#[tauri::command]
pub async fn chat_reset(chats: tauri::State<'_, Chats>, address: String) -> Result<(), String> {
    chats.reset(&address).await
}

#[cfg(all(test, windows))]
mod tests {
    use std::sync::Mutex;

    use hv_roster::perms::{ChannelDef, ChannelOverride, Tri};
    use hv_roster::{Body, RoleId};
    use serde_json::json;
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    use super::*;
    use crate::chat_files::MAX_FILE;
    use crate::server_group::{GroupTransport, SessionGroupTransport};
    use crate::testkit::{CHANNEL, folder, id, serve, stream};

    const QUIET: Duration = Duration::from_millis(300);
    const PUMP_LIMIT: Duration = Duration::from_secs(20);

    /// One person's app: its session, its chats and what they told the window.
    struct App {
        n: u8,
        address: String,
        session: Session,
        chats: Chats,
        generation: u64,
        told: Arc<Mutex<Vec<Notice>>>,
        events: mpsc::UnboundedReceiver<Value>,
        _stream: JoinHandle<()>,
    }

    impl App {
        async fn open(test: &str, n: u8, session: Session) -> App {
            let told: Arc<Mutex<Vec<Notice>>> = Arc::default();
            let log = told.clone();
            let chats = Chats::new(folder(test, n), Arc::new(move |notice| log.lock().unwrap().push(notice)));
            let (events, stream) = stream(&session.address, session.server_key, n).await;
            let address = session.address.clone();
            let generation = chats.open(Opening::new(&session, &id(n)), Instant::now()).await.unwrap().expect("a new chat");
            App { n, address, session, chats, generation, told, events, _stream: stream }
        }

        fn view(&self) -> ChannelChat {
            self.chats.view(&self.address, CHANNEL)
        }

        fn texts(&self) -> Vec<String> {
            self.view().items.into_iter().map(|item| item.text).collect()
        }

        /// The journal as the app reads it after a `roster` event.
        async fn sync(&mut self) {
            self.session.sync(&id(self.n)).await.unwrap();
            self.chats.journal_read(&self.address, self.session.roster()).await;
        }

        /// Entries the server has logged, as anyone in the group can count them.
        async fn logged(&self) -> usize {
            SessionGroupTransport::new(&self.session, &id(self.n)).since(0).await.unwrap().entries.len()
        }
    }

    /// Hands every app the events that reach it, until none have come for a while.
    async fn pump(apps: &mut [&mut App]) {
        let limit = Instant::now() + PUMP_LIMIT;
        while Instant::now() < limit {
            let mut moved = false;
            for app in apps.iter_mut() {
                while let Ok(event) = app.events.try_recv() {
                    app.chats.on_event(&app.address, &event).await;
                    moved = true;
                }
            }
            if !moved {
                tokio::time::sleep(QUIET).await;
                if apps.iter().all(|app| app.events.is_empty()) {
                    return;
                }
            }
        }
    }

    async fn pair(test: &str) -> (App, App) {
        let mut sessions = serve(2).await;
        let mut a = App::open(test, 1, sessions.remove(&1).unwrap()).await;
        let mut b = App::open(test, 2, sessions.remove(&2).unwrap()).await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!((a.chats.status(&a.address), b.chats.status(&b.address)), (GroupStatus::Ready, GroupStatus::Ready));
        (a, b)
    }

    #[tokio::test]
    async fn sending_reaches_the_other_app() {
        let (mut a, mut b) = pair("chat-send").await;
        a.chats.send_message(&a.address, CHANNEL, "привет".into(), None, vec![]).await.unwrap();
        assert_eq!(a.texts(), ["привет"], "our own message shows at once");
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.texts(), ["привет"]);
        let changed = Notice::Changed(ChatChanged { address: b.address.clone(), channels: vec![CHANNEL.into()] });
        assert!(b.told.lock().unwrap().contains(&changed));
        let ready = Notice::Status(ChatStatusEvent { address: b.address.clone(), status: GroupStatus::Ready });
        assert!(b.told.lock().unwrap().contains(&ready));
        let first = b.view().items[0].id.clone();
        b.chats.send_message(&b.address, CHANNEL, "и тебе".into(), Some(first.clone()), vec![]).await.unwrap();
        b.chats.react(&b.address, &first, "👍".into(), true).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let items = a.view().items;
        assert_eq!(items[1].reply.as_ref().map(|r| r.id.clone()), Some(first));
        assert_eq!(items[0].reactions[0].users, [crate::testkit::user(2).0]);
        let base = UnreadBase { seqs: vec![items[1].seq], mentions: vec![] };
        assert_eq!(a.chats.unread_base(&a.address), HashMap::from([(CHANNEL.to_string(), base)]), "our own does not count");
    }

    #[tokio::test]
    async fn what_we_send_is_signed_and_the_other_app_checks_it() {
        let (mut a, mut b) = pair("chat-signed").await;
        a.chats.send_message(&a.address, CHANNEL, "подпишусь".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let id = b.view().items[0].id.clone();
        let signed = |app: &App, id: &str| app.chats.need(&app.address).unwrap().model.lock().unwrap().is_signed(id);
        assert!(signed(&b, &id), "the signature checks with A's key");
        a.chats.edit(&a.address, &id, "подпишусь (правка)".into()).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.view().items[0].text, "подпишусь (правка)");
        assert!(signed(&b, &id), "the edit is signed over the whole message");
        assert!(signed(&a, &id), "and so is our own copy");
    }

    #[tokio::test]
    async fn a_newcomer_reads_the_history_before_its_entry() {
        let mut sessions = serve(2).await;
        let mut a = App::open("chat-pack-take", 1, sessions.remove(&1).unwrap()).await;
        a.chats.set_profile("Аня".into(), "pink".into(), None, None).await;
        a.chats.send_message(&a.address, CHANNEL, "до тебя".into(), None, vec![]).await.unwrap();
        let first = a.view().items[0].id.clone();
        a.chats.react(&a.address, &first, "👍".into(), true).await.unwrap();
        let mut b = App::open("chat-pack-take", 2, sessions.remove(&2).unwrap()).await;
        pump(&mut [&mut a, &mut b]).await;
        let view = b.view();
        assert_eq!(view.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["до тебя"]);
        assert_eq!(view.items[0].reactions[0].emoji, "👍");
        let note = view.history.clone().expect("a newcomer's history note");
        assert_eq!((note.state, note.from.as_str()), ("passed", crate::testkit::user(1).0.as_str()));
        assert_eq!(b.chats.people(&b.address).profiles[&crate::testkit::user(1)].nickname, "Аня", "names came with it");
        a.chats.send_message(&a.address, CHANNEL, "уже при тебе".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.texts(), ["до тебя", "уже при тебе"]);
        // After a restart, from this PC alone.
        b.chats.close(&b.address).await;
        let kept = std::env::temp_dir().join(format!("hv-chat-pack-take-2-{}", std::process::id()));
        let again = Chats::new(kept, Arc::new(|_| {}));
        again.open(Opening::new(&b.session, &id(2)), Instant::now()).await.unwrap();
        assert_eq!(again.view(&b.address, CHANNEL).items.iter().map(|i| i.text.clone()).collect::<Vec<_>>(), ["до тебя", "уже при тебе"]);
        assert_eq!(again.view(&b.address, CHANNEL).history.map(|n| n.state), Some("passed"));
        assert!(a.view().history.is_none(), "the one who was there gets no note");
    }

    #[tokio::test]
    async fn the_committer_sends_a_pack_after_adding() {
        let mut sessions = serve(2).await;
        let mut a = App::open("chat-pack-send", 1, sessions.remove(&1).unwrap()).await;
        assert_eq!(a.chats.status(&a.address), GroupStatus::Ready);
        a.chats.send_message(&a.address, CHANNEL, "до тебя".into(), None, vec![]).await.unwrap();
        let mut b = App::open("chat-pack-send", 2, sessions.remove(&2).unwrap()).await;
        pump(&mut [&mut a, &mut b]).await;
        let packs = b.chats.need(&b.address).unwrap().model.lock().unwrap().packs().to_vec();
        assert_eq!(packs.len(), 1, "one pack, for B");
        assert_eq!(packs[0].from, crate::testkit::user(1));
        assert!(a.chats.need(&a.address).unwrap().model.lock().unwrap().packs().is_empty(), "not for A");
    }

    #[tokio::test]
    async fn a_profile_reaches_the_other_member_through_the_group() {
        let (mut a, mut b) = pair("chat-profile").await;
        a.chats.set_profile("Аня".into(), "pink".into(), None, None).await;
        pump(&mut [&mut a, &mut b]).await;
        let anna = crate::testkit::user(1);
        let profile = b.chats.people(&b.address).profiles[&anna].clone();
        assert_eq!((profile.nickname.as_str(), profile.color.as_str()), ("Аня", "pink"));
        assert!(b.told.lock().unwrap().contains(&Notice::People(b.address.clone())), "the window reads the people again");
        assert_eq!(a.chats.people(&a.address).profiles[&anna].nickname, "Аня");
        let bob = crate::testkit::user(2);
        assert!(!b.chats.people(&b.address).profiles.contains_key(&bob), "nothing set, nothing sent");
        a.chats.set_profile("Аня".into(), "#ff8a4c".into(), Some("neon".into()), None).await;
        pump(&mut [&mut a, &mut b]).await;
        let framed = b.chats.people(&b.address).profiles[&anna].clone();
        assert_eq!((framed.color.as_str(), framed.frame.as_deref()), ("#ff8a4c", Some("neon")), "an own color and a frame come too");
        let code = "c1.round.f6d1b1.ff8a4c.short.3b2a20.crown.dots";
        a.chats.set_profile("Аня".into(), "#ff8a4c".into(), Some("neon".into()), Some(code.into())).await;
        pump(&mut [&mut a, &mut b]).await;
        let dressed = b.chats.people(&b.address).profiles[&anna].clone();
        assert_eq!((dressed.frame.as_deref(), dressed.character.as_deref()), (Some("neon"), Some(code)), "and the 3D character");
    }

    #[tokio::test]
    async fn opening_a_chat_tells_the_window_to_read_the_names_again() {
        // The window reads the server's people before the chat is open; the names on disk come with the chat.
        let (mut a, mut b) = pair("chat-profile-open").await;
        a.chats.set_profile("Аня".into(), "pink".into(), None, None).await;
        pump(&mut [&mut a, &mut b]).await;
        b.chats.close(&b.address).await;
        let told: Arc<Mutex<Vec<Notice>>> = Arc::default();
        let log = told.clone();
        let kept = std::env::temp_dir().join(format!("hv-chat-profile-open-2-{}", std::process::id()));
        let again = Chats::new(kept, Arc::new(move |notice| log.lock().unwrap().push(notice)));
        again.open(Opening::new(&b.session, &id(2)), Instant::now()).await.unwrap();
        assert_eq!(again.people(&b.address).profiles[&crate::testkit::user(1)].nickname, "Аня", "from the disk");
        assert!(told.lock().unwrap().contains(&Notice::People(b.address.clone())), "{:?}", told.lock().unwrap());
    }

    #[tokio::test]
    async fn the_profile_goes_out_once_the_group_is_ready() {
        let mut sessions = serve(1).await;
        let session = sessions.remove(&1).unwrap();
        let address = session.address.clone();
        let logged = || async { SessionGroupTransport::new(&session, &id(1)).since(0).await.unwrap().entries.len() };
        let folder = folder("chat-profile-ready", 1);
        let chats = Chats::new(folder.clone(), Arc::new(|_| {}));
        chats.set_profile("Аня".into(), "pink".into(), None, None).await;
        let generation = chats.open(Opening::new(&session, &id(1)), Instant::now()).await.unwrap().unwrap();
        chats.tick(&address, generation).await;
        assert_eq!(chats.status(&address), GroupStatus::Ready);
        let sent = logged().await;
        assert_eq!(chats.people(&address).profiles[&crate::testkit::user(1)].nickname, "Аня");
        chats.tick(&address, generation).await;
        chats.set_profile("Аня".into(), "pink".into(), None, None).await;
        assert_eq!(logged().await, sent, "the same profile goes once");
        chats.close(&address).await;
        let again = Chats::new(folder, Arc::new(|_| {}));
        again.set_profile("Аня".into(), "pink".into(), None, None).await;
        let generation = again.open(Opening::new(&session, &id(1)), Instant::now()).await.unwrap().unwrap();
        again.tick(&address, generation).await;
        assert_eq!(logged().await, sent, "nor after a restart");
        again.set_profile("Аня".into(), "green".into(), None, None).await;
        assert_eq!(logged().await, sent + 1, "a new color goes at once");
    }

    #[tokio::test]
    async fn an_edit_of_someone_elses_message_is_refused_before_it_is_sent() {
        let (mut a, mut b) = pair("chat-edit").await;
        a.chats.send_message(&a.address, CHANNEL, "моё".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let id = b.view().items[0].id.clone();
        let logged = b.logged().await;
        assert_eq!(b.chats.edit(&b.address, &id, "чужое".into()).await, Err(NOT_YOURS.into()));
        assert_eq!(b.chats.delete(&b.address, &id).await, Err(NOT_YOURS_TO_DELETE.into()));
        assert_eq!(b.chats.edit(&b.address, "нет такого", "x".into()).await, Err(NO_MESSAGE.into()));
        assert_eq!(b.chats.send_message(&b.address, CHANNEL, "  ".into(), None, vec![]).await, Err(EMPTY.into()));
        assert_eq!(b.chats.send_message(&b.address, CHANNEL, "я".repeat(MAX_TEXT + 1), None, vec![]).await, Err(TOO_LONG.into()));
        assert_eq!(b.logged().await, logged, "nothing reached the server");
        // The owner manages channels: someone else's message is theirs to delete.
        let mine = a.view().items[0].id.clone();
        b.chats.send_message(&b.address, CHANNEL, "спам".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let spam = a.view().items[1].id.clone();
        a.chats.delete(&a.address, &spam).await.unwrap();
        a.chats.edit(&a.address, &mine, "моё (правка)".into()).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let items = b.view().items;
        assert_eq!((items[0].text.as_str(), items[0].edited, items[1].deleted), ("моё (правка)", true, true));
    }

    #[tokio::test]
    async fn a_closed_channel_has_a_chat_of_its_own() {
        let (mut a, mut b) = pair("chat-closed").await;
        let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
        let staff = ChannelDef { id: "staff".into(), name: "Админская".into(), user_limit: 0, overrides: vec![hidden], kind: Default::default() };
        a.session.append(&id(1), Body::ChannelCreate(staff)).await.unwrap();
        a.sync().await;
        b.sync().await;
        let logged = a.logged().await;
        // The owner may see the channel: its room opened by itself, and the message goes there.
        a.chats.send_message(&a.address, "staff", "секрет".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let texts = |app: &App, channel: &str| app.chats.view(&app.address, channel).items.into_iter().map(|i| i.text).collect::<Vec<_>>();
        assert_eq!(texts(&a, "staff"), ["секрет"]);
        assert_eq!(a.logged().await, logged, "nothing of it in the server's group");
        // Bob may not see it: no room, no word of it, and he can't write there.
        assert!(texts(&b, "staff").is_empty());
        assert_eq!(b.chats.send_message(&b.address, "staff", "я тоже".into(), None, vec![]).await, Err(NO_CHANNEL.into()));
        assert_eq!(b.chats.open_room(&b.address, "ch.staff").await, Ok(()), "his client may try");
        pump(&mut [&mut a, &mut b]).await;
        assert!(texts(&b, "staff").is_empty(), "the server keeps him out of the room");
        let options = vec!["да".to_string(), "нет".to_string()];
        assert_eq!(a.chats.send_message(&a.address, "nope", "куда".into(), None, vec![]).await, Err(NO_CHANNEL.into()));
        // A poll in an open channel goes, and its rules hold.
        a.chats.poll(&a.address, CHANNEL, "Идём?".into(), options, false).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let poll = b.view().items[0].id.clone();
        assert_eq!(b.chats.vote(&b.address, &poll, vec![0, 1]).await, Err(ONE_CHOICE.into()));
        assert_eq!(b.chats.vote(&b.address, &poll, vec![5]).await, Err(NO_CHOICE.into()));
        assert_eq!(b.chats.close_poll(&b.address, &poll).await, Err(NOT_YOUR_POLL.into()));
        b.chats.vote(&b.address, &poll, vec![1]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        a.chats.close_poll(&a.address, &poll).await.unwrap();
        assert_eq!(a.chats.vote(&a.address, &poll, vec![0]).await, Err(POLL_CLOSED.into()));
        let view = a.view().items[0].poll.clone().unwrap();
        assert!(view.closed);
        assert_eq!(view.options[1].voters, [crate::testkit::user(2).0]);
    }

    fn gif(size: usize) -> Vec<u8> {
        b"GIF89a".iter().copied().chain(std::iter::repeat_n(5u8, size)).collect()
    }

    fn attach(data: Vec<u8>, name: &str) -> Attachment {
        Attachment { token: None, data: Some(data), name: name.into() }
    }

    #[test]
    fn the_window_names_a_file_by_its_server_and_blob() {
        let blob = "ab".repeat(32);
        assert_eq!(media_path(&format!("/chat/127.0.0.1%3A7350/{blob}")), Some(("127.0.0.1:7350".into(), blob.clone())));
        assert_eq!(media_path(&format!("/chat/1.2.3.4:7350/{blob}")), Some(("1.2.3.4:7350".into(), blob.clone())));
        for bad in [format!("/media/a/{blob}"), "/chat/a/../../key.bin".into(), format!("/chat//{blob}"), format!("/chat/a/{}", "AB".repeat(32))] {
            assert_eq!(media_path(&bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn a_picture_sent_is_shown_to_the_other_app() {
        let (mut a, mut b) = pair("chat-picture").await;
        let picture = gif(200_000);
        a.chats.send_message(&a.address, CHANNEL, "смотри".into(), None, vec![attach(picture.clone(), "кот.gif")]).await.unwrap();
        let mine = a.view().items[0].files[0].clone();
        assert_eq!(a.chats.file_bytes(&a.address, &mine.blob).await, Ok((picture.clone(), "image/gif".to_string())), "the sender sees it at once");
        pump(&mut [&mut a, &mut b]).await;
        let item = b.view().items[0].clone();
        assert_eq!(item.text, "смотри");
        let file = &item.files[0];
        assert_eq!((file.name.as_str(), file.mime.as_str(), file.size), ("кот.gif", "image/gif", picture.len() as u64));
        assert_eq!(b.chats.file_bytes(&b.address, &file.blob).await, Ok((picture.clone(), "image/gif".to_string())));
        // A file with no text, and a name the PC had that Windows would take for a path.
        let path = std::env::temp_dir().join(format!("hv-chat-attach-{}.txt", std::process::id()));
        std::fs::write(&path, b"plain words").unwrap();
        let token = crate::picked::hold(path.clone(), crate::picked::Access::Read).unwrap();
        let from_disk = Attachment { token: Some(token), data: None, name: "..\\отчёт:1.txt".into() };
        b.chats.send_message(&b.address, CHANNEL, "".into(), None, vec![from_disk]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let file = a.view().items[1].files[0].clone();
        assert_eq!((file.name.as_str(), file.mime.as_str()), (".._отчёт_1.txt", "application/octet-stream"));
        assert_eq!(a.chats.file_bytes(&a.address, &file.blob).await, Ok((b"plain words".to_vec(), "application/octet-stream".to_string())));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn a_blob_of_a_closed_channel_or_unknown_message_is_refused() {
        let (mut a, mut b) = pair("chat-file-refused").await;
        a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![attach(gif(10), "a.gif")]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let blob = b.view().items[0].files[0].blob.clone();
        let missing = (404, "Файл недоступен".to_string());
        assert_eq!(b.chats.file_bytes(&b.address, &"0".repeat(64)).await, Err(missing.clone()));
        assert_eq!(b.chats.file_bytes("9.9.9.9:7350", &blob).await, Err(missing.clone()), "another server");
        let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
        let closed = ChannelDef { id: CHANNEL.into(), name: "Общий".into(), user_limit: 0, overrides: vec![hidden], kind: Default::default() };
        a.session.append(&id(1), Body::ChannelUpdate(closed)).await.unwrap();
        b.sync().await;
        assert_eq!(b.chats.file_bytes(&b.address, &blob).await, Err(missing), "the channel is closed now");
    }

    #[tokio::test]
    async fn a_file_that_does_not_open_with_its_key_is_damaged() {
        // A sender (or a server) whose blob is not what the message's key opens: the window gets «Файл повреждён».
        let (mut a, mut b) = pair("chat-file-damaged").await;
        let (blob, _) = seal_file(b"real bytes").unwrap();
        let chat = a.chats.need(&a.address).unwrap();
        let sha = chat.files.upload(&blob).await.unwrap();
        let wrong = FileRef { blob: sha.clone(), size: 10, key: encode_b64(&[9; 32]), name: "a.txt".into(), mime: OCTET.into(), parts: None };
        let event = ChatEvent::Msg { id: new_id().unwrap(), ch: CHANNEL.into(), text: String::new(), reply: None, files: vec![wrong] };
        a.chats.send(&a.address, &chat, event).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.chats.file_bytes(&b.address, &sha).await, Err((422, "Файл повреждён".to_string())));
    }

    #[tokio::test]
    async fn saving_writes_the_plain_file_where_asked() {
        let (mut a, mut b) = pair("chat-file-save").await;
        a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![attach(gif(1000), "a.gif")]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let blob = b.view().items[0].files[0].blob.clone();
        let target = std::env::temp_dir().join(format!("hv-chat-saved-{}.gif", std::process::id()));
        // A path the page names is no place to save: only where the person chose in the program's own dialog.
        assert_eq!(b.chats.save_file(&b.address, &blob, &target.to_string_lossy()).await, Err("Файл нужно выбрать заново".into()));
        assert!(!target.exists());
        let read_token = crate::picked::hold(target.clone(), crate::picked::Access::Read).unwrap();
        assert!(b.chats.save_file(&b.address, &blob, &read_token).await.is_err(), "a file picked to send is not a place to save");
        let token = crate::picked::hold(target.clone(), crate::picked::Access::Write).unwrap();
        b.chats.save_file(&b.address, &blob, &token).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), gif(1000));
        // Windows takes it for a download: SmartScreen asks before it runs a program saved from the chat.
        let zone = std::fs::read_to_string(format!("{}:Zone.Identifier", target.to_string_lossy())).unwrap();
        assert!(zone.contains("[ZoneTransfer]") && zone.contains("ZoneId=3"), "{zone}");
        let _ = std::fs::remove_file(target);
    }

    #[tokio::test]
    async fn a_file_bigger_than_25_mb_goes_in_parts_and_is_saved_whole() {
        let (mut a, mut b) = pair("chat-file-big").await;
        // Two parts: 16 MB and a bit over 9 MB; a video by its first bytes.
        let mut big: Vec<u8> = b"\0\0\0\x18ftypmp42".to_vec();
        big.extend((0..MAX_FILE + 5 - big.len()).map(|i| (i % 251) as u8));
        let path = std::env::temp_dir().join(format!("hv-chat-big-{}.mp4", std::process::id()));
        std::fs::write(&path, &big).unwrap();
        let token = crate::picked::hold(path.clone(), crate::picked::Access::Read).unwrap();
        a.chats.send_message(&a.address, CHANNEL, "фильм".into(), None, vec![Attachment { token: Some(token), data: None, name: String::new() }]).await.unwrap();
        let told_up = a.told.lock().unwrap().iter().filter(|n| matches!(n, Notice::Progress(p) if p.key == format!("up:{CHANNEL}"))).count();
        assert!(told_up >= 2, "the window heard how far the send is");
        pump(&mut [&mut a, &mut b]).await;
        let file = b.view().items[0].files[0].clone();
        assert!(file.big);
        assert_eq!((file.size, file.mime.as_str(), file.name.as_str()), (big.len() as u64, "video/mp4", path.file_name().unwrap().to_str().unwrap()));
        assert_eq!(b.chats.file_bytes(&b.address, &file.blob).await, Err((413, SAVE_ONLY.to_string())), "never opened whole in the window");
        assert_eq!(b.chats.file_fingerprint(&b.address, &file.blob).await.unwrap(), fingerprint(&big));
        let target = std::env::temp_dir().join(format!("hv-chat-big-saved-{}.mp4", std::process::id()));
        let write = crate::picked::hold(target.clone(), crate::picked::Access::Write).unwrap();
        b.chats.save_file(&b.address, &file.blob, &write).await.unwrap();
        assert!(std::fs::read(&target).unwrap() == big, "saved whole, byte for byte");
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(target);
    }

    #[tokio::test]
    async fn a_file_that_cannot_be_read_or_is_too_big_sends_nothing() {
        let (mut a, mut b) = pair("chat-file-refuse-send").await;
        let logged = a.logged().await;
        let nowhere = Attachment { token: Some(crate::picked::hold("C:\\нет\\такого\\файла.png".into(), crate::picked::Access::Read).unwrap()), data: None, name: "файла.png".into() };
        // A path the page names instead of a token takes nothing.
        let named = Attachment { token: Some("C:\\Windows\\win.ini".into()), data: None, name: "win.ini".into() };
        assert_eq!(a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![named]).await, Err("Файл нужно выбрать заново".into()));
        assert!(a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![nowhere]).await.unwrap_err().starts_with("Не читается"));
        let huge = attach(vec![0; MAX_FILE + 1], "big.bin");
        assert_eq!(a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![huge]).await, Err("Файл больше 25 МБ".into()));
        let eleven = (0..11).map(|n| attach(vec![n], "x.bin")).collect();
        assert_eq!(a.chats.send_message(&a.address, CHANNEL, "".into(), None, eleven).await, Err("Не больше 10 файлов в одном сообщении".into()));
        assert_eq!(a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![]).await, Err(EMPTY.into()));
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(a.logged().await, logged, "nothing reached the group");
    }

    /// Who the app was told is typing, by channel.
    fn typists(app: &App) -> Vec<(String, String)> {
        let told = app.told.lock().unwrap();
        told.iter().filter_map(|notice| match notice {
            Notice::Typing(t) if t.address == app.address => Some((t.channel.clone(), t.user.clone())),
            _ => None,
        }).collect()
    }

    #[tokio::test]
    async fn typing_reaches_the_other_app_and_is_not_in_history() {
        let (mut a, mut b) = pair("chat-typing").await;
        let logged = a.logged().await;
        a.chats.typing(&a.address, CHANNEL).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(typists(&b), [(CHANNEL.to_string(), crate::testkit::user(1).0)]);
        assert!(typists(&a).is_empty(), "nobody is told about themselves");
        assert!(b.view().items.is_empty());
        assert_eq!(a.logged().await, logged, "a signal is not logged");
    }

    #[tokio::test]
    async fn a_signal_with_another_sender_or_garbage_is_dropped() {
        let (a, mut b) = pair("chat-typing-forged").await;
        a.chats.typing(&a.address, CHANNEL).await.unwrap();
        let event = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), b.events.recv()).await.expect("the signal comes").unwrap();
            if event["type"] == "group_signal" {
                break event;
            }
        };
        let mut forged = event.clone();
        forged["sender"] = json!(crate::testkit::user(5).0);
        b.chats.on_event(&b.address, &forged).await;
        let mut garbage = event.clone();
        garbage["message"] = json!(encode_b64(&[7; 60]));
        b.chats.on_event(&b.address, &garbage).await;
        let mut other_group = event.clone();
        other_group["group_id"] = json!(encode_b64(&[3; 16]));
        b.chats.on_event(&b.address, &other_group).await;
        assert!(typists(&b).is_empty(), "{:?}", typists(&b));
        b.chats.on_event(&b.address, &event).await;
        assert_eq!(typists(&b).len(), 1);
        // A signal sealed right, about a channel nobody may chat in.
        let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
        let staff = ChannelDef { id: "staff".into(), name: "Админская".into(), user_limit: 0, overrides: vec![hidden], kind: Default::default() };
        let mut owner = a.session;
        owner.append(&id(1), Body::ChannelCreate(staff)).await.unwrap();
        b.sync().await;
        // The server passes one signal a second from a person.
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let chat = a.chats.need(&a.address).unwrap();
        let body = json!({ "t": "typing", "ch": "staff" }).to_string().into_bytes();
        chat.engine.lock().await.as_mut().unwrap().signal(&body).await.unwrap();
        let event = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), b.events.recv()).await.expect("the signal comes").unwrap();
            if event["type"] == "group_signal" {
                break event;
            }
        };
        b.chats.on_event(&b.address, &event).await;
        assert_eq!(typists(&b).len(), 1, "nothing about a closed channel");
    }

    fn playing(app: &App) -> HashMap<UserId, String> {
        app.chats.people(&app.address).playing
    }

    #[tokio::test]
    async fn a_game_reaches_the_others_and_goes_with_them_offline() {
        let (mut a, mut b) = pair("chat-playing").await;
        let anna = crate::testkit::user(1);
        let logged = a.logged().await;
        a.chats.set_playing(Some("CS2".into())).await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(playing(&b).get(&anna).map(String::as_str), Some("CS2"));
        assert_eq!(playing(&a).get(&anna).map(String::as_str), Some("CS2"), "and we see our own");
        assert!(b.told.lock().unwrap().contains(&Notice::People(b.address.clone())));
        a.chats.set_playing(None).await;
        pump(&mut [&mut a, &mut b]).await;
        assert!(playing(&b).is_empty(), "stopped playing");
        a.chats.set_playing(Some("Dota 2".into())).await;
        pump(&mut [&mut a, &mut b]).await;
        b.chats.online(&b.address, &anna, false);
        assert!(playing(&b).is_empty(), "gone offline, the game goes with them");
        assert_eq!(a.logged().await, logged, "nothing of it is logged");
    }

    #[tokio::test]
    async fn a_game_comes_back_after_its_player_dropped_for_a_moment() {
        let (mut a, mut b) = pair("chat-playing-blip").await;
        let anna = crate::testkit::user(1);
        a.chats.set_playing(Some("CS2".into())).await;
        pump(&mut [&mut a, &mut b]).await;
        // A's stream dropped: the others heard A went; A's came back and the server says so to A as well.
        b.chats.online(&b.address, &anna, false);
        assert!(playing(&b).is_empty());
        a.chats.online(&a.address, &anna, true);
        a.chats.tick(&a.address, a.generation).await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(playing(&b).get(&anna).map(String::as_str), Some("CS2"), "told again on coming back");
    }

    #[tokio::test]
    async fn a_member_coming_in_hears_what_everyone_plays() {
        let mut sessions = serve(2).await;
        let mut a = App::open("chat-hello", 1, sessions.remove(&1).unwrap()).await;
        a.chats.set_playing(Some("CS2".into())).await;
        let mut b = App::open("chat-hello", 2, sessions.remove(&2).unwrap()).await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.chats.status(&b.address), GroupStatus::Ready);
        assert_eq!(playing(&b).get(&crate::testkit::user(1)).map(String::as_str), Some("CS2"), "asked with «hello», told at once");
    }

    #[tokio::test]
    async fn music_played_together_reaches_the_others() {
        use crate::music_word::MusicWord;
        let (mut a, mut b) = pair("chat-music").await;
        let playing = MusicWord { on: true, take: false, title: Some("Ночной трамвай".into()), artist: Some("Город спит".into()), app: Some("Spotify".into()), cover: None };
        a.chats.music(&a.address, CHANNEL, playing.clone()).await.unwrap();
        a.chats.music(&a.address, CHANNEL, MusicWord { on: false, ..Default::default() }).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let seen: Vec<ChatMusic> = b.told.lock().unwrap().iter().filter_map(|n| match n {
            Notice::Music(m) => Some(m.clone()),
            _ => None,
        }).collect();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!((seen[0].title.as_deref(), seen[0].on, seen[0].user.as_str()), (Some("Ночной трамвай"), true, crate::testkit::user(1).0.as_str()));
        assert!(!seen[1].on, "stopped for everyone");
        let too_long = MusicWord { title: Some("я".repeat(201)), ..playing.clone() };
        assert!(a.chats.music(&a.address, CHANNEL, too_long).await.is_err(), "not sent beyond the limits");
        assert!(a.chats.music(&a.address, "nowhere", playing).await.is_err());
    }

    #[test]
    fn a_files_fingerprint_is_its_sha256_as_antivirus_sites_know_it() {
        assert_eq!(fingerprint(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(fingerprint(b"").len(), 64);
    }

    #[tokio::test]
    async fn watching_together_reaches_the_others() {
        let (mut a, mut b) = pair("chat-watch").await;
        let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        let picks = serde_json::json!({ "players": "Плеер 2", "episode": "3 серия", "dub": "x".repeat(99), "script": "<b>", "season": 2 });
        a.chats.watch(&a.address, CHANNEL, Some(url.into()), true, 61_500, 1_800_000_000_000, &picks).await.unwrap();
        a.chats.watch(&a.address, CHANNEL, None, false, 0, 1_800_000_005_000, &Value::Null).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let seen: Vec<ChatWatch> = b.told.lock().unwrap().iter().filter_map(|n| match n {
            Notice::Watch(w) => Some(w.clone()),
            _ => None,
        }).collect();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!((seen[0].url.as_deref(), seen[0].playing, seen[0].pos, seen[0].user.as_str()), (Some(url), true, 61_500, crate::testkit::user(1).0.as_str()));
        assert_eq!(
            seen[0].picks.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(),
            [("dub", "x".repeat(60).as_str()), ("episode", "3 серия"), ("players", "Плеер 2")],
            "the site's picks go with it: four kinds, short words"
        );
        assert_eq!(seen[1].url, None, "stopped for everyone");
        assert_eq!(
            a.chats.watch(&a.address, CHANNEL, Some("http://plain.example/x.mp4".into()), true, 0, 0, &Value::Null).await,
            Err("Такую ссылку нельзя смотреть вместе".into())
        );
        assert!(a.chats.watch(&a.address, "nowhere", Some(url.into()), true, 0, 0, &Value::Null).await.is_err());
    }

    #[tokio::test]
    async fn a_characters_act_reaches_the_others() {
        let (mut a, mut b) = pair("chat-act").await;
        let bob = crate::testkit::user(2);
        a.chats.act(&a.address, CHANNEL, "wave", None).await.unwrap();
        a.chats.act(&a.address, CHANNEL, "hug", Some(bob.0.clone())).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let seen: Vec<ChatAct> = b.told.lock().unwrap().iter().filter_map(|n| match n {
            Notice::Act(act) => Some(act.clone()),
            _ => None,
        }).collect();
        let anna = crate::testkit::user(1).0;
        assert_eq!(seen.iter().map(|s| (s.user.as_str(), s.act.as_str(), s.to.as_deref())).collect::<Vec<_>>(), [
            (anna.as_str(), "wave", None),
            (anna.as_str(), "hug", Some(bob.0.as_str())),
        ]);
        for (act, to) in [("Wave", None), ("", None), ("hug", Some("a b".to_string()))] {
            assert_eq!(a.chats.act(&a.address, CHANNEL, act, to).await, Err("Такого действия нет".into()), "{act:?}");
        }
        assert!(a.chats.act(&a.address, "nowhere", "wave", None).await.is_err());
    }

    #[tokio::test]
    async fn remote_control_is_asked_and_granted_through_the_group() {
        use crate::remote::{Input, Remote, RemoteEvent, Screen};
        let (mut a, mut b) = pair("chat-remote").await;
        let (anna, boris) = (crate::testkit::user(1), crate::testkit::user(2));
        let (anna_remote, boris_remote) = (Remote::default(), Remote::default());
        let now = Instant::now();
        let heard = |side: &App| -> Vec<(UserId, Value)> {
            side.told.lock().unwrap().iter().filter_map(|n| match n {
                Notice::Remote { sender, body, .. } => Some((sender.clone(), body.clone())),
                _ => None,
            }).collect()
        };
        // Boris asks Anna.
        let ask = b.chats.with_remote(&b.address, |ctx, id| boris_remote.ask(ctx, id, CHANNEL, &anna, now)).unwrap().unwrap();
        b.chats.signal(&b.address, &ask).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let (sender, body) = heard(&a).pop().expect("the ask came");
        assert_eq!(sender, boris);
        let (asked, _) = a.chats.with_remote(&a.address, |ctx, _| anna_remote.on_signal(ctx, &sender, &body, now)).unwrap();
        assert!(matches!(asked, Some(RemoteEvent::Asked { ref user, .. }) if *user == boris.0), "{asked:?}");
        // Anna lets him in, mouse only.
        let screen = Screen { x: 0, y: 0, width: 1920, height: 1080 };
        let (grant, _) = a.chats.with_remote(&a.address, |ctx, id| anna_remote.answer(ctx, id, &boris, true, false, screen, now)).unwrap().unwrap();
        a.chats.signal(&a.address, &grant).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let (sender, body) = heard(&b).pop().expect("the grant came");
        let (started, _) = b.chats.with_remote(&b.address, |ctx, _| boris_remote.on_signal(ctx, &sender, &body, now)).unwrap();
        assert!(matches!(started, Some(RemoteEvent::Started { host: false, keyboard: false, .. })), "{started:?}");
        let (to, packet) = boris_remote.seal(&Input::Move { x: 10, y: 20 }, true).unwrap();
        assert_eq!(to, anna.0);
        assert_eq!(anna_remote.open(&boris, &packet, now), Some((Input::Move { x: 10, y: 20 }, screen)));
    }

    #[tokio::test]
    async fn direct_messages_are_a_room_for_two() {
        let mut sessions = serve(3).await;
        let mut a = App::open("chat-dm", 1, sessions.remove(&1).unwrap()).await;
        let mut b = App::open("chat-dm", 2, sessions.remove(&2).unwrap()).await;
        let mut c = App::open("chat-dm", 3, sessions.remove(&3).unwrap()).await;
        pump(&mut [&mut a, &mut b, &mut c]).await;
        let room = a.chats.open_dm(&a.address, &crate::testkit::user(2).0).await.unwrap();
        assert_eq!(room, Scope::dm_room(&crate::testkit::user(1), &crate::testkit::user(2)));
        assert_eq!(a.chats.open_dm(&a.address, &crate::testkit::user(1).0).await, Err(NO_PERSON.into()), "not with oneself");
        pump(&mut [&mut a, &mut b, &mut c]).await;
        assert_eq!(b.chats.dms(&b.address).into_iter().map(|d| (d.channel, d.peer)).collect::<Vec<_>>(), [(room.clone(), crate::testkit::user(1).0)], "Bob heard of it");
        assert!(b.told.lock().unwrap().contains(&Notice::Rooms(b.address.clone())));
        a.chats.send_message(&a.address, &room, "привет, Боря".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b, &mut c]).await;
        let texts = |app: &App| app.chats.view(&app.address, &room).items.into_iter().map(|i| i.text).collect::<Vec<_>>();
        assert_eq!(texts(&b), ["привет, Боря"]);
        let told = b.told.lock().unwrap().iter().any(|n| matches!(n, Notice::Message(m) if m.channel == room));
        assert!(told, "a notification of a direct message");
        b.chats.send_message(&b.address, &room, "привет!".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b, &mut c]).await;
        assert_eq!(texts(&a), ["привет, Боря", "привет!"]);
        // Carl has no part in it: no room, nothing to read, and his client can't open theirs.
        assert!(c.chats.dms(&c.address).is_empty());
        assert!(texts(&c).is_empty());
        assert_eq!(c.chats.open_room(&c.address, &room).await, Err(NO_CHANNEL.into()));
        assert!(c.chats.unread_base(&c.address).get(&room).is_none());
        assert!(a.chats.unread_base(&a.address).contains_key(&room), "unread counts come from the rooms too");
    }

    #[tokio::test]
    async fn a_burst_of_signals_all_gets_through() {
        let (mut a, mut b) = pair("chat-burst").await;
        a.chats.set_playing(Some("CS2".into())).await;
        a.chats.typing(&a.address, CHANNEL).await.unwrap();
        a.chats.set_playing(Some("Dota 2".into())).await;
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(typists(&b).len(), 1);
        assert_eq!(playing(&b).get(&crate::testkit::user(1)).map(String::as_str), Some("Dota 2"), "the last game wins");
    }

    #[tokio::test]
    async fn typing_is_sent_at_most_every_three_seconds() {
        let (mut a, mut b) = pair("chat-typing-rate").await;
        let started = Instant::now();
        for _ in 0..3 {
            a.chats.typing(&a.address, CHANNEL).await.unwrap();
            tokio::time::sleep(Duration::from_millis(1100)).await;
        }
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(typists(&b).len(), 1, "the server would pass one a second: the app sent one");
        tokio::time::sleep((started + TYPING_EVERY).saturating_duration_since(Instant::now())).await;
        a.chats.typing(&a.address, CHANNEL).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(typists(&b).len(), 2);
    }

    /// The new messages the app was told about.
    fn announced(app: &App) -> Vec<ChatMessage> {
        let told = app.told.lock().unwrap();
        told.iter().filter_map(|notice| match notice {
            Notice::Message(m) => Some(m.clone()),
            _ => None,
        }).collect()
    }

    #[tokio::test]
    async fn a_new_message_from_someone_else_is_announced_once() {
        let (mut a, mut b) = pair("chat-announce").await;
        let mention = format!("<@{}> глянь", crate::testkit::user(2).0);
        a.chats.send_message(&a.address, CHANNEL, mention.clone(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let seen = announced(&b);
        assert_eq!(seen.len(), 1);
        let first = &seen[0];
        assert_eq!((first.address.as_str(), first.channel.as_str(), first.author.as_str()), (b.address.as_str(), CHANNEL, crate::testkit::user(1).0.as_str()));
        assert_eq!((first.text.as_str(), first.mentions_me, first.poll), (mention.as_str(), true, false));
        assert!(announced(&a).is_empty(), "not our own");
        let message = first.id.clone();
        a.chats.edit(&a.address, &message, "правка".into()).await.unwrap();
        b.chats.react(&b.address, &message, "👍".into(), true).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(announced(&b).len(), 1, "edits and reactions are not new messages");
        a.chats.send_message(&a.address, CHANNEL, "".into(), None, vec![attach(gif(10), "кот.gif")]).await.unwrap();
        a.chats.poll(&a.address, CHANNEL, "Идём?".into(), vec!["да".into(), "нет".into()], false).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let seen = announced(&b);
        assert_eq!((seen[1].files.clone(), seen[1].mentions_me), (vec!["кот.gif".to_string()], false));
        assert_eq!((seen[2].text.as_str(), seen[2].poll), ("Идём?", true));
        // Opened again: what is already in the history is not news.
        b.chats.close(&b.address).await;
        b.told.lock().unwrap().clear();
        b.chats.open(Opening::new(&b.session, &id(2)), Instant::now()).await.unwrap();
        assert!(announced(&b).is_empty());
    }

    #[tokio::test]
    async fn a_server_opened_under_another_address_keeps_one_chat() {
        // The same server by its LAN address and by 127.0.0.1 (or a VPN's): one identity, one leaf, one engine.
        let (mut a, mut b) = pair("chat-two-addresses").await;
        a.chats.send_message(&a.address, CHANNEL, "по одному адресу".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        let port = b.address.rsplit_once(':').unwrap().1;
        let other = format!("localhost:{port}");
        let again = Session::open(&other, Some(b.session.server_key), &id(2)).await.unwrap();
        assert!(b.chats.open(Opening::new(&again, &id(2)), Instant::now()).await.unwrap().is_some());
        assert!(!b.chats.is_open(&b.address), "the chat under the first address went");
        let texts: Vec<String> = b.chats.view(&other, CHANNEL).items.into_iter().map(|i| i.text).collect();
        assert_eq!(texts, ["по одному адресу"], "the history is the server's, whatever the address");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn opening_the_same_server_twice_at_once_makes_one_chat() {
        // The window may open a server twice at once (a retry while the first try still waits), on two threads of
        // the app: one engine only.
        let (_a, b) = pair("chat-open-race").await;
        for round in 0..5 {
            let chats = Arc::new(Chats::new(folder(&format!("chat-open-race-{round}"), 2), Arc::new(|_| {})));
            let tries: Vec<_> = (0..4)
                .map(|_| {
                    let (chats, opening) = (chats.clone(), Opening::new(&b.session, &id(2)));
                    tokio::spawn(async move { chats.open(opening, Instant::now()).await.unwrap() })
                })
                .collect();
            let mut opened = Vec::new();
            for task in tries {
                opened.push(task.await.unwrap());
            }
            assert_eq!(opened.iter().filter(|generation| generation.is_some()).count(), 1, "round {round}: {opened:?}");
        }
    }

    #[tokio::test]
    async fn opening_the_same_server_again_keeps_its_chat() {
        // The window opens a server again each time it is picked in the list: two engines must never work on one
        // folder of the chat at once.
        let (mut a, mut b) = pair("chat-reopen").await;
        assert_eq!(a.chats.open(Opening::new(&a.session, &id(1)), Instant::now()).await, Ok(None));
        assert!(a.chats.tick(&a.address, a.generation).await, "the same chat, with its timer");
        a.chats.send_message(&a.address, CHANNEL, "всё ещё здесь".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert_eq!(b.texts(), ["всё ещё здесь"]);
        // Another identity on this PC (a .hvid imported) gets a chat of its own.
        let other = a.chats.open(Opening::new(&a.session, &id(7)), Instant::now()).await.unwrap();
        assert!(other.is_some());
        assert!(!a.chats.tick(&a.address, a.generation).await, "the old chat is gone");
    }

    #[tokio::test]
    async fn leaving_the_server_stops_the_engine_and_keeps_history() {
        let (mut a, mut b) = pair("chat-leave").await;
        a.chats.send_message(&a.address, CHANNEL, "раз".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        b.chats.close(&b.address).await;
        assert!(!b.chats.is_open(&b.address));
        assert!(b.texts().is_empty());
        assert_eq!(b.chats.send_message(&b.address, CHANNEL, "есть кто?".into(), None, vec![]).await, Err(NO_CHAT.into()));
        // What the closed chat's stream still brings goes nowhere.
        a.chats.send_message(&a.address, CHANNEL, "два".into(), None, vec![]).await.unwrap();
        pump(&mut [&mut a, &mut b]).await;
        assert!(b.texts().is_empty());
        // Opened again: the history is there at once, and the engine catches up with what it missed.
        assert!(b.chats.open(Opening::new(&b.session, &id(2)), Instant::now()).await.unwrap().is_some(), "a new chat");
        assert_eq!(b.texts(), ["раз", "два"]);
        assert_eq!(b.chats.reset(&b.address).await, Err(NOT_OWNER.into()));
    }
}
