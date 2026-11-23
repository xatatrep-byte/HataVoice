//! Tauri commands for identity and servers. The key lives here in Rust; the UI only asks.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use hv_roster::keys::{decode_b64, encode_b64};
use hv_roster::{Body, Identity, InviteLink, MediaRef, PublicKey, RoleId};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::bridge::Bridge;
use crate::call::SharedSessions;
use crate::identity::{self, HvidContents, SavedServerKey};
use crate::chat::Chats;
use crate::session::{Link, ServerError, Session, unix_now};

/// This PC's identity (its seed; an `Identity` is rebuilt for each use).
pub struct AppIdentity {
    dir: PathBuf,
    seed: RwLock<[u8; 32]>,
    /// The previous identity file could not be decrypted and a new identity was started.
    lost_previous: bool,
}

impl AppIdentity {
    pub fn load(dir: PathBuf) -> Result<Self, String> {
        let (identity, lost_previous) = identity::load_or_recover(&dir)?;
        Ok(Self { dir, seed: RwLock::new(identity.seed()), lost_previous })
    }

    pub fn get(&self) -> Identity {
        Identity::from_seed(*self.seed.read().unwrap_or_else(|e| e.into_inner()))
    }

    fn replace(&self, identity: &Identity) -> Result<(), String> {
        identity::store(&self.dir, identity)?;
        *self.seed.write().unwrap_or_else(|e| e.into_inner()) = identity.seed();
        Ok(())
    }
}

/// Where this PC's key lies, for «Показать файл ключа».
#[tauri::command]
pub fn identity_file(identity: tauri::State<'_, AppIdentity>) -> String {
    identity.dir.join(identity::IDENTITY_FILE).display().to_string()
}

/// «Удалить ключ с этого ПК»: the key is wiped and a new one starts; the window then reloads, as the open sessions
/// belonged to the old one.
#[tauri::command]
pub async fn identity_forget(identity: tauri::State<'_, AppIdentity>, sessions: tauri::State<'_, Sessions>) -> Result<(), String> {
    sessions.0.lock().await.clear();
    let fresh = identity::forget(&identity.dir)?;
    *identity.seed.write().unwrap_or_else(|e| e.into_inner()) = fresh.seed();
    Ok(())
}

/// Open servers by address. Shared with the call engine, whose requests go through these sessions.
#[derive(Default)]
pub struct Sessions(pub Arc<tokio::sync::Mutex<HashMap<String, Session>>>);

/// The event stream of each open server.
#[derive(Default)]
pub struct EventStreams(std::sync::Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

/// Starts (or restarts) the event stream of `address`; events reach the UI as `server-event`, except a call's and
/// the server group's messages, which are for their engines alone.
fn watch(app: &tauri::AppHandle, address: &str, server_key: PublicKey, seed: [u8; 32]) {
    use tauri::Emitter;
    let (event_app, sync_app) = (app.clone(), app.clone());
    let (event_address, sync_address) = (address.to_string(), address.to_string());
    let task = tauri::async_runtime::spawn(crate::events::run_events(
        address.to_string(),
        server_key,
        seed,
        move |event| {
            let (app, address) = (event_app.clone(), event_address.clone());
            async move {
                let kind = event["type"].as_str().unwrap_or_default();
                if kind == "roster" {
                    sync(&app, &address).await;
                }
                // Out of the server: its chat has nothing more to read or send.
                if kind == "kicked" || kind == "banned" {
                    app.state::<crate::chat::Chats>().close(&address).await;
                }
                // After a gap in the stream the chat and the call may have missed entries too.
                if kind.starts_with("group_") || kind == "resync" || kind == "room_opened" {
                    crate::chat::on_server_event(&app, &address, &event).await;
                    if kind != "resync" {
                        return;
                    }
                }
                if kind.starts_with("call_") || kind == "resync" {
                    crate::call::on_server_event(&app, &address, &event).await;
                    if kind != "resync" {
                        return;
                    }
                }
                if kind == "online"
                    && let (Some(user), Some(online)) = (event["user"].as_str(), event["online"].as_bool())
                {
                    app.state::<Chats>().online(&address, &hv_roster::UserId(user.to_string()), online);
                }
                let _ = app.emit("server-event", serde_json::json!({ "address": address, "event": event }));
            }
        },
        move || {
            let (app, address) = (sync_app.clone(), sync_address.clone());
            async move { sync(&app, &address).await }
        },
    ));
    let streams = app.state::<EventStreams>();
    if let Some(old) = streams.0.lock().unwrap_or_else(|e| e.into_inner()).insert(address.to_string(), task) {
        old.abort();
    }
}

/// The server at `address` is gone for good: its event stream stops, its session and chat close. Returns its key, if
/// it was open, so what this PC kept of it can go too.
pub(crate) async fn close_server(app: &tauri::AppHandle, address: &str) -> Option<PublicKey> {
    if let Some(stream) = app.state::<EventStreams>().0.lock().unwrap_or_else(|e| e.into_inner()).remove(address) {
        stream.abort();
    }
    let session = app.state::<Sessions>().0.lock().await.remove(address);
    app.state::<Chats>().close(address).await;
    session.map(|s| s.server_key)
}

/// Turns a saved server key from the window into a key.
pub(crate) fn saved_key(text: &str) -> Result<PublicKey, String> {
    parse_key(text)
}

const NOT_OPEN: &str = "Сервер ещё не открыт — выбери его в списке";

/// The way to an open server, for a request made without holding the open sessions.
pub(crate) async fn link_of(sessions: &SharedSessions, address: &str) -> Result<Link, String> {
    sessions.lock().await.get(address).map(Session::link).ok_or_else(|| NOT_OPEN.into())
}

/// Reads the journal entries of `address` we don't have yet. The open sessions are held only to look and to apply,
/// never while the server is asked: a server that has gone silent holds up nothing else.
async fn sync_journal(sessions: &SharedSessions, address: &str, id: &Identity) -> Result<(), ServerError> {
    let Some((link, from)) = sessions.lock().await.get(address).map(|s| (s.link(), s.roster().len())) else { return Ok(()) };
    let entries = link.journal_from(id, from).await?;
    match sessions.lock().await.get_mut(address) {
        // A server opened anew meanwhile under another key has a journal of its own.
        Some(session) if session.server_key == link.server_key => session.take_entries(entries),
        _ => Ok(()),
    }
}

/// Signs `body` as the next journal entry of `address` and posts it, the open sessions held only while signing; if
/// someone wrote first, catches up and signs again.
async fn append_entry(sessions: &SharedSessions, address: &str, id: &Identity, body: Body) -> Result<u64, ServerError> {
    #[derive(Deserialize)]
    struct Appended {
        seq: u64,
    }
    for _ in 0..crate::session::APPEND_ATTEMPTS {
        let (link, entry) = {
            let open = sessions.lock().await;
            let session = open.get(address).ok_or_else(|| ServerError::Refused(NOT_OPEN.into()))?;
            (session.link(), session.next_entry(id, body.clone()))
        };
        match link.request::<Appended>(id, "POST", "/api/roster", Some(&entry)).await {
            Ok(appended) => {
                // After leaving, the journal is for members only: there is nothing to read.
                if !matches!(body, Body::Leave) {
                    sync_journal(sessions, address, id).await?;
                }
                return Ok(appended.seq);
            }
            Err(ServerError::Conflict) => sync_journal(sessions, address, id).await?,
            Err(error) => return Err(error),
        }
    }
    Err(ServerError::Conflict)
}

async fn sync(app: &tauri::AppHandle, address: &str) {
    let id = app.state::<AppIdentity>().get();
    let sessions = app.state::<Sessions>();
    match sync_journal(&sessions.0, address, &id).await {
        // A call and the chat on this server check people against the journal just read: kicks and bans count at
        // once.
        Ok(()) => {
            let roster = sessions.0.lock().await.get(address).map(|session| session.roster().clone());
            if let Some(roster) = roster {
                app.state::<crate::call::Calls>().journal_read(address, &roster);
                app.state::<crate::chat::Chats>().journal_read(address, &roster).await;
            }
        }
        Err(e) => eprintln!("journal sync failed for {address}: {}", e.message()),
    }
}

pub(crate) fn text(error: ServerError) -> String {
    error.message()
}

fn parse_key(text: &str) -> Result<PublicKey, String> {
    decode_b64::<32>(text).map(PublicKey).ok_or_else(|| "Испорчен сохранённый ключ сервера".into())
}

#[derive(Serialize)]
pub struct IdentityInfo {
    user_id: String,
    fingerprint: String,
    lost_previous: bool,
}

#[tauri::command]
pub fn identity_info(identity: tauri::State<'_, AppIdentity>) -> IdentityInfo {
    let key = identity.get().public();
    IdentityInfo { user_id: key.user_id().0, fingerprint: identity::fingerprint(&key), lost_previous: identity.lost_previous }
}

/// Async, and the password's key made off Tauri's thread: Argon2 takes seconds on a phone, and the window would stand still.
#[tauri::command]
pub async fn identity_export(
    identity: tauri::State<'_, AppIdentity>,
    token: String,
    password: String,
    nickname: String,
    color: String,
    servers: Vec<SavedServerKey>,
) -> Result<(), String> {
    let contents = HvidContents { seed: identity.get().seed(), nickname, color, servers };
    let file = tauri::async_runtime::spawn_blocking(move || identity::export_hvid(&contents, &password)).await.map_err(|e| e.to_string())??;
    // Where the person chose in the program's own dialog (`pick_save`), never a path the page names.
    let path = crate::picked::take(&token, crate::picked::Access::Write)?;
    std::fs::write(&path, file).map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
    crate::picked::written(&path)
}

/// A picture the page made (the drawing board's snapshot, an edited photo), written where the person chose in the
/// program's own dialog (`pick_save`). Only a picture: PNG or JPEG by its first bytes.
#[tauri::command]
pub async fn save_picture(token: String, data: String) -> Result<(), String> {
    let bytes = hv_roster::keys::decode_b64_vec(&data).ok_or_else(|| "Испорченная картинка".to_string())?;
    let png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
    let jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
    if !(png || jpeg) || bytes.len() > 64 * 1024 * 1024 {
        return Err("Это не картинка".into());
    }
    let path = crate::picked::take(&token, crate::picked::Access::Write)?;
    std::fs::write(&path, bytes).map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
    crate::picked::written(&path)
}

#[derive(Serialize)]
pub struct ImportedIdentity {
    nickname: String,
    color: String,
    servers: Vec<SavedServerKey>,
}

/// Replaces this PC's identity with the one in the file; open sessions belonged to the old one.
#[tauri::command]
pub async fn identity_import(
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    chats: tauri::State<'_, crate::chat::Chats>,
    token: String,
    password: String,
) -> Result<ImportedIdentity, String> {
    let path = crate::picked::take(&token, crate::picked::Access::Read)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
    let contents = identity::import_hvid(&bytes, &password)?;
    identity.replace(&Identity::from_seed(contents.seed))?;
    sessions.0.lock().await.clear();
    chats.close_all().await;
    Ok(ImportedIdentity { nickname: contents.nickname, color: contents.color, servers: contents.servers })
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileArg {
    nickname: String,
    color: String,
    #[serde(default)]
    frame: Option<String>,
    #[serde(default)]
    character: Option<String>,
}

#[derive(Serialize)]
pub struct OpenedServer {
    address: String,
    server_key: String,
    name: String,
}

async fn keep(app: &tauri::AppHandle, session: Session, id: &Identity, profile: Option<ProfileArg>) -> Result<OpenedServer, String> {
    // The nickname goes through the server's group, once its keys are here.
    if let Some(ProfileArg { nickname, color, frame, character }) = profile {
        app.state::<Chats>().set_profile(nickname, color, frame, character).await;
    }
    let opened = OpenedServer {
        address: session.address.clone(),
        server_key: encode_b64(&session.server_key.0),
        name: session.roster().server_name().to_string(),
    };
    // The window reaches the server's signaling and media only through the bridge.
    app.state::<Arc<Bridge>>().allow(&session.address, session.server_key);
    watch(app, &session.address, session.server_key, id.seed());
    crate::chat::start(app, &session, id);
    app.state::<Sessions>().0.lock().await.insert(session.address.clone(), session);
    Ok(opened)
}

/// Connects to a saved server; `server_key` is the key pinned for it (none on first use).
#[tauri::command]
pub async fn server_open(
    app: tauri::AppHandle,
    identity: tauri::State<'_, AppIdentity>,
    address: String,
    server_key: Option<String>,
    profile: Option<ProfileArg>,
) -> Result<OpenedServer, String> {
    let pinned = server_key.as_deref().map(parse_key).transpose()?;
    let id = identity.get();
    let session = Session::open(&address, pinned, &id).await.map_err(text)?;
    keep(&app, session, &id, profile).await
}

/// An invite as the window needs it to tell what to do with it. The secret stays in `link`.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct FoundInvite {
    link: String,
    address: String,
    server_key: String,
}

/// `text` when it is an invite and nothing else.
fn invite_in(text: &str) -> Option<FoundInvite> {
    let link = text.trim();
    let parsed = InviteLink::parse(link).ok()?;
    Some(FoundInvite { link: link.to_string(), address: parsed.address, server_key: hv_roster::keys::encode_b64(&parsed.server_key.0) })
}

/// An invite copied to the clipboard, so it need not be pasted. Whatever else is in the clipboard stays here: the window
/// learns only of an invite.
#[tauri::command]
pub fn invite_from_clipboard() -> Option<FoundInvite> {
    #[cfg(desktop)]
    {
        let text = arboard::Clipboard::new().ok()?.get_text().ok()?;
        invite_in(&text)
    }
    #[cfg(not(desktop))]
    None
}

/// How the tunnel to a server is doing, for a server reached by its key.
#[derive(Serialize)]
pub struct P2pState {
    connected: bool,
    direct: bool,
    rtt_ms: Option<u32>,
}

#[tauri::command]
pub fn p2p_state(address: String) -> Option<P2pState> {
    let tunnel = crate::server_check::tunnel_of(&address)?;
    hv_p2p::Dialer::global().state(&tunnel).map(|s| P2pState { connected: s.connected, direct: s.direct, rtt_ms: s.rtt_ms })
}

/// A server's own address does not answer: from now on its traffic goes through `tunnel`.
#[tauri::command]
pub fn server_use_tunnel(address: String, tunnel: String) -> bool {
    crate::server_check::route_through_tunnel(&address, &tunnel)
}

/// The server, its welcome and who invited — before joining.
#[tauri::command]
pub async fn invite_preview(app: tauri::AppHandle, link: String) -> Result<crate::session::InvitePreview, String> {
    preview_through(&app.state::<Arc<Bridge>>(), &InviteLink::parse(&link)?).await.map_err(text)
}

/// The join screen shows the server's icon through `hvmedia` before anyone has joined, so the window may
/// reach the server as soon as it has proven the key in the link.
async fn preview_through(bridge: &Bridge, link: &InviteLink) -> Result<crate::session::InvitePreview, ServerError> {
    let preview = crate::session::preview_invite(link).await?;
    bridge.allow(&link.address, link.server_key);
    Ok(preview)
}

#[tauri::command]
pub async fn server_join(
    app: tauri::AppHandle,
    identity: tauri::State<'_, AppIdentity>,
    link: String,
    profile: Option<ProfileArg>,
) -> Result<OpenedServer, String> {
    let link = InviteLink::parse(&link)?;
    let id = identity.get();
    let session = Session::join(&link, &id, unix_now()).await.map_err(text)?;
    keep(&app, session, &id, profile).await
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelArg {
    id: String,
    name: String,
}

#[derive(Serialize)]
pub struct Claimed {
    address: String,
    server_key: String,
    /// The owner should save a copy of their identity: without it a reinstall loses the server.
    backup_suggested: bool,
}

impl Claimed {
    fn new(address: &str, server_key: &PublicKey) -> Self {
        Self { address: address.to_string(), server_key: encode_b64(&server_key.0), backup_suggested: true }
    }
}

/// Makes this PC's identity the owner of the server hosted here. Without `channels` the old
/// channel list of an existing server is carried over.
#[tauri::command]
pub async fn host_claim(
    app: tauri::AppHandle,
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    server_name: String,
    channels: Option<Vec<ChannelArg>>,
) -> Result<Claimed, String> {
    let dir = crate::host_dir(&app)?;
    let config = crate::host::read_config(&dir)?.ok_or("Свой сервер ещё не создан")?;
    let address = format!("127.0.0.1:{}", config.api_port);
    let channels = match channels {
        Some(list) => list,
        None => legacy_channels(&address).await?,
    };
    let pairs: Vec<(String, String)> = channels.into_iter().map(|c| (c.id, c.name)).collect();
    let id = identity.get();
    let session = Session::claim(&address, &id, &server_name, &pairs).await.map_err(text)?;
    let claimed = Claimed::new(&address, &session.server_key);
    app.state::<Arc<Bridge>>().allow(&address, session.server_key);
    watch(&app, &address, session.server_key, id.seed());
    crate::chat::start(&app, &session, &id);
    sessions.0.lock().await.insert(address, session);
    Ok(claimed)
}

async fn legacy_channels(address: &str) -> Result<Vec<ChannelArg>, String> {
    #[derive(Deserialize)]
    struct List {
        channels: Vec<ChannelArg>,
    }
    let url = crate::server_check::server_url(address, "/api/host/legacy-channels")?;
    let client = crate::tls::loopback_client(std::time::Duration::from_secs(10)).map_err(text)?;
    let response = client.get(url).send().await.map_err(|e| format!("Свой сервер не отвечает: {e}"))?;
    if !response.status().is_success() {
        return Ok(Vec::new());
    }
    Ok(response.json::<List>().await.map(|l| l.channels).unwrap_or_default())
}

/// What the UI needs to join a LiveKit room.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceToken {
    pub url: String,
    pub token: String,
}

/// The pass is the server's, the address is the bridge's: the window cannot open the server's own
/// LiveKit address, and would not be talking to a checked server if it could.
fn through_bridge(token: VoiceToken, bridge: &Bridge, address: &str) -> VoiceToken {
    VoiceToken { url: bridge.url(address), ..token }
}

#[tauri::command]
pub async fn voice_token(
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    bridge: tauri::State<'_, Arc<Bridge>>,
    address: String,
    channel: String,
) -> Result<VoiceToken, String> {
    let id = identity.get();
    let body = serde_json::json!({ "channel": channel });
    let link = link_of(&sessions.0, &address).await?;
    let token = link.request(&id, "POST", "/api/voice/token", Some(&body)).await.map_err(text)?;
    Ok(through_bridge(token, &bridge, &address))
}

/// Everything the UI shows about an open server.
#[tauri::command]
pub async fn server_state(
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    chats: tauri::State<'_, Chats>,
    address: String,
) -> Result<crate::server_state::ServerStateView, String> {
    let id = identity.get();
    let link = link_of(&sessions.0, &address).await?;
    let remote: crate::server_state::RemoteState = link.request(&id, "GET", "/api/state", None).await.map_err(text)?;
    let open = sessions.0.lock().await;
    let session = open.get(&address).ok_or(NOT_OPEN)?;
    let people = chats.people(&address);
    Ok(crate::server_state::build_view(session.roster(), &remote, &id.public().user_id(), &session.address, &session.server_key, &people))
}

/// «Играет в …» for every open server (`None` clears it).
#[tauri::command]
pub async fn presence_set(app: tauri::AppHandle, activity: Option<String>) -> Result<(), String> {
    send_presence(&app, activity).await;
    Ok(())
}

pub(crate) async fn send_presence(app: &tauri::AppHandle, activity: Option<String>) {
    app.state::<Chats>().set_playing(activity).await;
}


pub(crate) async fn open_addresses(app: &tauri::AppHandle) -> Vec<String> {
    let mut addresses: Vec<String> = app.state::<Sessions>().0.lock().await.keys().cloned().collect();
    addresses.sort();
    addresses
}

#[derive(Serialize)]
pub struct Posted {
    seq: u64,
}

/// Any journal entry: roles, channels, profile, settings, kick, ban, unban, leave, owner transfer.
#[tauri::command]
pub async fn server_post(
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    chats: tauri::State<'_, crate::chat::Chats>,
    address: String,
    body: Body,
) -> Result<Posted, String> {
    let id = identity.get();
    let leaving = matches!(body, Body::Leave);
    let seq = append_entry(&sessions.0, &address, &id, body).await.map_err(text)?;
    // Out of the server: the chat stops, its history stays on this PC.
    if leaving {
        chats.close(&address).await;
    }
    Ok(Posted { seq })
}

#[derive(Serialize)]
pub struct Invite {
    link: String,
}

/// A new invite link; `share_address` is how friends reach this server.
#[tauri::command]
pub async fn invite_create(
    chats: tauri::State<'_, Chats>,
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    address: String,
    share_address: String,
    roles: Vec<RoleId>,
    max_uses: Option<u32>,
    expires_minutes: Option<u32>,
) -> Result<Invite, String> {
    let id = identity.get();
    let server_key = link_of(&sessions.0, &address).await?.server_key;
    let (invite, body) = crate::session::new_invite(roles, max_uses, expires_minutes).map_err(text)?;
    append_entry(&sessions.0, &address, &id, body).await.map_err(text)?;
    // Our nickname rides in the link: the newcomer sees who invited them before they are in the group.
    let by = chats.nickname();
    let link = InviteLink { address: share_address.trim().to_string(), server_key, secret: invite.seed(), by }.to_link();
    Ok(Invite { link })
}

/// Mute, unmute, move or disconnect someone; the server checks rights and enforces it.
#[tauri::command]
pub async fn moderate(
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    address: String,
    command: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = identity.get();
    let link = link_of(&sessions.0, &address).await?;
    link.request(&id, "POST", "/api/moderation", Some(&command)).await.map_err(text)
}

/// Bigger than any purpose allows; such a file is refused before it is read into memory.
const MAX_UPLOAD_BYTES: u64 = 8 * 1024 * 1024;

/// Uploads a GIF/video for a kick or ban (`moderation`) or the server icon (`icon`).
#[tauri::command]
pub async fn media_upload(
    app: tauri::AppHandle,
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    address: String,
    token: String,
    purpose: String,
) -> Result<MediaRef, String> {
    if !matches!(purpose.as_str(), "moderation" | "icon") {
        return Err("Неизвестное назначение файла".into());
    }
    // A file the person picked in the program's own dialog (`pick_files`), never a path the page names.
    let path = crate::picked::take(&token, crate::picked::Access::Read)?;
    let bytes = read_media(&path, &purpose)?;
    let id = identity.get();
    let link = link_of(&sessions.0, &address).await?;
    let media = link.upload(&id, bytes, &purpose).await.map_err(text)?;
    if purpose == "moderation" {
        crate::picked::gifs::remember(&crate::data_dir(&app)?, &path);
    }
    Ok(media)
}

/// A picture or a clip from disk, only if it really is one of the types `purpose` takes and not too big.
fn read_media(path: &std::path::Path, purpose: &str) -> Result<Vec<u8>, String> {
    let size = std::fs::metadata(path).map_err(|e| format!("Не читается {}: {e}", path.display()))?.len();
    if size > MAX_UPLOAD_BYTES {
        return Err("Файл больше 8 МБ".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
    match crate::picked::sniff_media(&bytes) {
        Some(mime) if crate::picked::allowed_media(purpose).contains(&mime) => Ok(bytes),
        _ if purpose == "icon" => Err("Иконка — PNG, JPEG, GIF или WebP".into()),
        _ => Err("Для модерации — GIF, MP4 или WebM".into()),
    }
}

/// «Мои гифки»: names and ids, never paths.
#[tauri::command]
pub fn my_gifs(app: tauri::AppHandle, legacy: Option<Vec<String>>) -> Result<Vec<crate::picked::gifs::GifView>, String> {
    let dir = crate::data_dir(&app)?;
    if let Some(paths) = legacy {
        crate::picked::gifs::adopt(&dir, &paths);
    }
    Ok(crate::picked::gifs::views(&dir))
}

/// Uploads one of «Мои гифки» to `address` for a kick or ban.
#[tauri::command]
pub async fn my_gif_upload(
    app: tauri::AppHandle,
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    address: String,
    id: String,
) -> Result<MediaRef, String> {
    let dir = crate::data_dir(&app)?;
    let path = crate::picked::gifs::path_of(&dir, &id).ok_or("Этой гифки больше нет в списке")?;
    let bytes = read_media(&path, "moderation")?;
    let me = identity.get();
    let link = link_of(&sessions.0, &address).await?;
    let media = link.upload(&me, bytes, "moderation").await.map_err(text)?;
    crate::picked::gifs::remember(&dir, &path);
    Ok(media)
}

/// `/api/audit` with filters; anything but letters, digits, `_` and `-` is refused.
fn audit_path(user: Option<&str>, kind: Option<&str>, before: Option<u64>) -> Result<String, String> {
    let mut query = Vec::new();
    for (name, value) in [("user", user), ("kind", kind)] {
        if let Some(value) = value {
            if value.is_empty() || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                return Err("Неверный фильтр журнала".into());
            }
            query.push(format!("{name}={value}"));
        }
    }
    if let Some(before) = before {
        query.push(format!("before={before}"));
    }
    Ok(if query.is_empty() { "/api/audit".into() } else { format!("/api/audit?{}", query.join("&")) })
}

/// The action log, newest first, each line checked against signatures (`verified`); `before`
/// pages further back.
#[tauri::command]
pub async fn audit(
    identity: tauri::State<'_, AppIdentity>,
    sessions: tauri::State<'_, Sessions>,
    address: String,
    user: Option<String>,
    kind: Option<String>,
    before: Option<u64>,
) -> Result<Vec<crate::audit::AuditEntry>, String> {
    #[derive(Deserialize)]
    struct Log {
        entries: Vec<crate::audit::AuditEntry>,
    }
    let path = audit_path(user.as_deref(), kind.as_deref(), before)?;
    let id = identity.get();
    // Bring the journal up to date first, so the newest entries can be confirmed too.
    sync_journal(&sessions.0, &address, &id).await.map_err(text)?;
    let log: Log = link_of(&sessions.0, &address).await?.request(&id, "GET", &path, None).await.map_err(text)?;
    let open = sessions.0.lock().await;
    let session = open.get(&address).ok_or(NOT_OPEN)?;
    Ok(crate::audit::verify_entries(log.entries, session.roster(), &session.server_key))
}

/// The nickname, color, frame and character, signed again for every open server and sent through its group.
#[tauri::command]
pub async fn profile_set(
    chats: tauri::State<'_, Chats>,
    nickname: String,
    color: String,
    frame: Option<String>,
    character: Option<String>,
) -> Result<(), String> {
    chats.set_profile(nickname, color, frame, character).await;
    Ok(())
}

/// Loads the identity at startup (DPAPI-protected file in the app data folder).
pub fn setup(app: &tauri::App) -> Result<(), String> {
    let dir = crate::data_dir(app)?;
    hv_host::protect::set_dir(&dir);
    app.manage(crate::chat::Chats::new(dir.clone(), crate::chat::to_window(app.handle().clone())));
    app.manage(AppIdentity::load(dir)?);
    app.manage(Sessions::default());
    app.manage(EventStreams::default());
    app.manage(crate::games::GameWatch::default());
    crate::games::spawn_game_watch(app.handle().clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_invite_leaves_the_clipboard() {
        let key = "BGwCQJk5fbdsbHJwgR4S09E6-tqr9WbExYFeSv5kIuU";
        let link = format!("hatavoice://203.0.113.7:7350/#v=1&sk={key}&inv=OiJrgzQCJtoewfIkdwIyJKWLHCepw676cQdvCFrSz3M");
        assert_eq!(
            invite_in(&format!("  {link}
")),
            Some(FoundInvite { link: link.clone(), address: "203.0.113.7:7350".into(), server_key: key.into() })
        );
        for other in ["мой пароль от почты", "https://example.com/#v=1", "hatavoice://nothing", &format!("смотри: {link}"), ""] {
            assert_eq!(invite_in(other), None, "{other}");
        }
    }

    #[tokio::test]
    async fn the_voice_pass_points_the_window_at_the_bridge() {
        let bridge = Bridge::start().await.unwrap();
        let token = VoiceToken { url: "ws://192.168.1.5:7880".into(), token: "pass".into() };
        let token = through_bridge(token, &bridge, "127.0.0.1:7350");
        assert_eq!(token.url, bridge.url("127.0.0.1:7350"));
        assert_eq!(token.token, "pass");
    }

    #[test]
    fn owner_is_asked_to_back_up_after_claiming() {
        let key = Identity::from_seed([1; 32]).public();
        let reply = serde_json::to_value(Claimed::new("127.0.0.1:7350", &key)).unwrap();
        assert_eq!(reply["backup_suggested"], true);
        assert_eq!(reply["server_key"], encode_b64(&key.0));
    }

    #[tokio::test]
    async fn a_proven_invite_lets_the_window_show_the_server_icon() {
        const PNG: &[u8] = include_bytes!("../icons/32x32.png");
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let address = crate::tls::test_server::serve(store).await.to_string();
        let owner_id = Identity::from_seed([1; 32]);
        let mut owner = Session::claim(&address, &owner_id, "Хата", &[("general".into(), "Общий".into())]).await.unwrap();
        let icon = owner.upload(&owner_id, PNG.to_vec(), "icon").await.unwrap();
        let profile = hv_roster::ServerProfile { name: "Хата".into(), icon: Some(icon.clone()), ..Default::default() };
        owner.append(&owner_id, Body::ServerProfile(profile)).await.unwrap();
        let link = InviteLink::parse(&owner.create_invite(&owner_id, &address, vec![], Some(1), None).await.unwrap()).unwrap();
        let bridge = Bridge::start().await.unwrap();
        let icon_path = format!("/{address}/{}", icon.sha256);
        assert!(crate::bridge::media(&bridge, &icon_path).await.is_err(), "closed before any invite");

        let preview = preview_through(&bridge, &link).await.unwrap();
        assert_eq!(preview.icon.unwrap().sha256, icon.sha256);
        let (bytes, mime) = crate::bridge::media(&bridge, &icon_path).await.unwrap();
        assert_eq!((bytes.as_slice(), mime.as_str()), (PNG, "image/png"));

        // A link with a key the server does not hold must not take the address over.
        let forged = InviteLink { address: link.address.clone(), server_key: Identity::from_seed([5; 32]).public(), secret: link.secret, by: None };
        assert!(preview_through(&bridge, &forged).await.is_err());
        assert_eq!(crate::bridge::media(&bridge, &icon_path).await.unwrap().0, PNG);
    }

    /// A real server whose journal reads hang for as long as `hang` is set: a server that went silent mid-request.
    async fn server_that_can_hang() -> (String, Arc<std::sync::atomic::AtomicBool>) {
        use std::sync::atomic::{AtomicBool, Ordering};
        let hang = Arc::new(AtomicBool::new(false));
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let channels = Arc::new(hatavoice_server::channels::ChannelStore::open(None).unwrap());
        let app = hatavoice_server::host_app(hatavoice_server::LiveKitConfig::dev(), None, channels, store.clone());
        let flag = hang.clone();
        let app = app.layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
            let hangs = flag.load(Ordering::SeqCst) && request.method() == "GET" && request.uri().path() == "/api/roster";
            async move {
                if hangs {
                    std::future::pending::<()>().await;
                }
                next.run(request).await
            }
        }));
        (crate::tls::test_server::serve_app(app, store.server_identity()).await.to_string(), hang)
    }

    #[tokio::test]
    async fn a_server_gone_silent_holds_up_no_other_request() {
        let owner = Identity::from_seed([1; 32]);
        let (stuck, hang) = server_that_can_hang().await;
        let (other, _) = server_that_can_hang().await;
        let sessions = Sessions::default();
        for address in [&stuck, &other] {
            let session = Session::claim(address, &owner, "Хата", &[("general".into(), "Общий".into())]).await.unwrap();
            sessions.0.lock().await.insert(address.clone(), session);
        }
        hang.store(true, std::sync::atomic::Ordering::SeqCst);
        let syncing = tokio::spawn({
            let (sessions, stuck, owner) = (sessions.0.clone(), stuck.clone(), Identity::from_seed(owner.seed()));
            async move { sync_journal(&sessions, &stuck, &owner).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!syncing.is_finished(), "the journal read is still on its way");

        // Meanwhile the other server, and even the silent one's other routes, are reached as usual.
        for address in [&other, &stuck] {
            let reached = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let link = link_of(&sessions.0, address).await.unwrap();
                link.request::<serde_json::Value>(&owner, "GET", "/api/state", None).await
            });
            assert!(reached.await.expect("held up by the journal read of another request").is_ok(), "{address}");
        }
        syncing.abort();
    }

    #[tokio::test]
    async fn journal_reads_at_the_same_time_both_succeed() {
        let owner = Identity::from_seed([1; 32]);
        let (address, _) = server_that_can_hang().await;
        let mut writer = Session::claim(&address, &owner, "Хата", &[("general".into(), "Общий".into())]).await.unwrap();
        let reader = Session::open(&address, Some(writer.server_key), &owner).await.unwrap();
        let sessions = Sessions::default();
        sessions.0.lock().await.insert(address.clone(), reader);
        // Two entries the open session has not read yet.
        for id in ["games", "media"] {
            let channel = hv_roster::ChannelDef { id: id.into(), name: id.into(), user_limit: 0, overrides: vec![], kind: Default::default() };
            writer.append(&owner, Body::ChannelCreate(channel)).await.unwrap();
        }

        // Both read from the same place; whichever applies second finds the entries there already.
        let (first, second) = tokio::join!(sync_journal(&sessions.0, &address, &owner), sync_journal(&sessions.0, &address, &owner));
        assert_eq!((first, second), (Ok(()), Ok(())));
        let open = sessions.0.lock().await;
        assert_eq!(open[&address].roster().len(), writer.roster().len());
    }

    #[test]
    fn audit_filters_become_a_safe_query() {
        assert_eq!(audit_path(None, None, None).unwrap(), "/api/audit");
        assert_eq!(audit_path(Some("u_AB-c"), Some("kick"), Some(42)).unwrap(), "/api/audit?user=u_AB-c&kind=kick&before=42");
        assert!(audit_path(Some("x&kind=ban"), None, None).is_err());
    }
}
