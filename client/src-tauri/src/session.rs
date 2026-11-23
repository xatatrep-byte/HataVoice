//! A connection to one server: its key pinned through `hello`, the signed journal fetched and
//! checked here (never trusted from the server), and every request signed with our key.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hv_roster::keys::{encode_b64, random_bytes};
use hv_roster::request::{hello_message, sign_request};
use hv_roster::{Body, ChannelDef, Digest, Entry, Identity, InviteLink, MediaRef, PublicKey, RoleId, Roster, Signature, sign_entry, sign_join_after};
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::server_check::server_url;
use crate::tls::{Pin, http_client, send};

const TIMEOUT: Duration = Duration::from_secs(10);
pub const APPEND_ATTEMPTS: usize = 3;

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerError {
    Unreachable(String),
    /// Our clock is off from the server's by this many minutes (positive: we are behind).
    ClockSkew { minutes: i64 },
    JoinNeeded,
    Unclaimed,
    /// The server answered with a different key than the one pinned for this address.
    KeyChanged,
    /// The server answers in plain HTTP: it predates TLS and cannot be reached any more.
    OldServer,
    /// The server already belongs to another identity (our claim was refused).
    OwnedByOther,
    Banned { until: Option<u64> },
    Conflict,
    Refused(String),
}

impl ServerError {
    pub fn message(&self) -> String {
        match self {
            ServerError::Unreachable(e) => format!("Сервер недоступен: {e}"),
            ServerError::ClockSkew { minutes } => format!(
                "Часы на этом ПК расходятся с сервером на {} мин — включи синхронизацию времени в Windows",
                minutes.unsigned_abs().max(1)
            ),
            ServerError::JoinNeeded => "Ты не участник этого сервера — попроси ссылку-приглашение у владельца".into(),
            ServerError::Unclaimed => "Сервер ещё не настроен владельцем".into(),
            ServerError::KeyChanged => {
                "Сервер по этому адресу подменён или переустановлен — подключение остановлено".into()
            }
            ServerError::OldServer => "Сервер на старой версии ХатаВойс — попроси хоста обновить".into(),
            ServerError::OwnedByOther => "Владелец этого сервера — другая личность. Импортируй свою копию (.hvid)".into(),
            ServerError::Banned { .. } => "Ты забанен на этом сервере".into(),
            ServerError::Conflict => "Журнал сервера изменился — повтори".into(),
            ServerError::Refused(message) => message.clone(),
        }
    }
}

/// Turns an error answer into what went wrong; `client_now` measures a clock difference.
pub fn error_from(status: u16, body: &Value, client_now: u64) -> ServerError {
    let text = body["error"].as_str().map(String::from);
    let flag = |name: &str| body[name].as_bool() == Some(true);
    match status {
        401 if flag("clock_skew") => {
            let server = body["server_time"].as_u64().unwrap_or(client_now) as i64;
            let seconds = server - client_now as i64;
            let minutes = (seconds as f64 / 60.0).round() as i64;
            ServerError::ClockSkew { minutes: if minutes == 0 { seconds.signum() } else { minutes } }
        }
        403 if flag("join_needed") => ServerError::JoinNeeded,
        403 if flag("banned") => ServerError::Banned { until: body["until"].as_u64() },
        503 if flag("unclaimed") => ServerError::Unclaimed,
        409 if flag("conflict") => ServerError::Conflict,
        409 if text.as_deref() == Some("Сервер уже принадлежит другой личности") => ServerError::OwnedByOther,
        _ => ServerError::Refused(text.unwrap_or_else(|| format!("Сервер ответил ошибкой {status}"))),
    }
}

#[derive(Debug, Deserialize)]
struct Hello {
    server_key: PublicKey,
    owner: Option<PublicKey>,
    roster_len: u64,
    roster_head: Digest,
    proof: Signature,
}

fn url(address: &str, path_and_query: &str) -> Result<String, ServerError> {
    let base = server_url(address, "/").map_err(ServerError::Refused)?;
    base.join(path_and_query).map(|u| u.to_string()).map_err(|e| ServerError::Refused(e.to_string()))
}

/// The server's `hello`, its proof checked. The key in it must be the pinned one; without a pin, `http` must
/// be a fresh client, and the key must be the one its handshake met (the TLS certificate and the proof come
/// from the same server).
async fn hello(address: &str, http: &reqwest::Client, pin: &Pin) -> Result<Hello, ServerError> {
    let nonce = encode_b64(&random_bytes::<16>().map_err(ServerError::Refused)?);
    let response = send(http.get(url(address, &format!("/api/hello?nonce={nonce}"))?), pin).await?;
    let hello: Hello = response.json().await.map_err(|e| ServerError::Refused(format!("Это не сервер ХатаВойс: {e}")))?;
    if !hello.server_key.verify(&hello_message(&nonce, &hello.roster_head), &hello.proof) {
        return Err(ServerError::Refused("Сервер не подтвердил свой ключ".into()));
    }
    // The answer came back, so the handshake went through; `seen` is empty only on a reused connection,
    // which is why a pinned client must not be asked for it.
    let key_matches = match pin.expected {
        Some(expected) => expected == hello.server_key,
        None => pin.seen() == Some(hello.server_key),
    };
    if !key_matches {
        return Err(ServerError::KeyChanged);
    }
    Ok(hello)
}

/// What an invite link leads to, shown before joining.
#[derive(Debug, Clone, Serialize)]
pub struct InvitePreview {
    pub address: String,
    pub server_name: String,
    pub description: String,
    pub welcome: String,
    pub icon: Option<MediaRef>,
    /// The nickname the inviter put in the link, if any.
    pub inviter_name: Option<String>,
    pub inviter_fingerprint: String,
    /// Still usable: not revoked, not expired, uses left.
    pub valid: bool,
}

/// Checks that the server proves the key in the link, then reads the invite.
pub async fn preview_invite(link: &InviteLink) -> Result<InvitePreview, ServerError> {
    #[derive(Deserialize)]
    struct Info {
        server_name: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        welcome: String,
        icon: Option<MediaRef>,
        inviter: String,
        valid: bool,
    }
    let server = Session::pinned_to(&link.address, link.server_key)?;
    server.greet().await?;
    let path = format!("/api/invite?key={}", encode_b64(&link.identity().public().0));
    let response = send(server.http.get(url(&link.address, &path)?), &server.pin).await?;
    let status = response.status();
    let json: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(error_from(status.as_u16(), &json, unix_now()));
    }
    let info: Info = serde_json::from_value(json).map_err(|e| ServerError::Refused(format!("Непонятный ответ сервера: {e}")))?;
    Ok(InvitePreview {
        address: link.address.clone(),
        server_name: info.server_name,
        description: info.description,
        welcome: info.welcome,
        icon: info.icon,
        // The server knows no nickname: the inviter put theirs in the link.
        inviter_name: link.by.clone(),
        inviter_fingerprint: info.inviter.chars().take(4).collect(),
        valid: info.valid,
    })
}

#[derive(Debug)]
pub struct Session {
    pub address: String,
    pub server_key: PublicKey,
    roster: Roster,
    /// Talks to the holder of `server_key` only; one client for the whole session, so connections are reused.
    http: reqwest::Client,
    pin: Pin,
}

impl Session {
    /// A session with an empty journal that reaches `address` and only the holder of `server_key`.
    fn pinned_to(address: &str, server_key: PublicKey) -> Result<Session, ServerError> {
        let pin = Pin::to(server_key);
        let http = http_client(&pin, TIMEOUT)?;
        Ok(Session { address: address.to_string(), server_key, roster: Roster::new(), http, pin })
    }

    /// The client behind this session, pinned to `server_key`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the app sends everything through the signed requests below"))]
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    async fn greet(&self) -> Result<Hello, ServerError> {
        hello(&self.address, &self.http, &self.pin).await
    }

    /// Reads the journal, which must be one we may read and the one of the key we are talking to.
    async fn load(mut self, id: &Identity) -> Result<Session, ServerError> {
        self.sync(id).await?;
        if self.roster.server_key() != Some(self.server_key) {
            return Err(ServerError::KeyChanged);
        }
        Ok(self)
    }

    /// Connects to a server we are a member of; `pinned` is the key saved for this address. Without it the
    /// key is learned from the server, and believed only if its journal, checked end to end, has us in it.
    pub async fn open(address: &str, pinned: Option<PublicKey>, id: &Identity) -> Result<Session, ServerError> {
        let session = match pinned {
            Some(key) => {
                let session = Session::pinned_to(address, key)?;
                session.greet().await?;
                session
            }
            None => {
                let pin = Pin::learn();
                let hello = hello(address, &http_client(&pin, TIMEOUT)?, &pin).await?;
                Session::pinned_to(address, hello.server_key)?
            }
        };
        let session = session.load(id).await?;
        // Our join cannot be written without our key, so a server that never saw us cannot show it.
        if pinned.is_none() && session.roster.member(&id.public().user_id()).is_none() {
            return Err(ServerError::JoinNeeded);
        }
        Ok(session)
    }

    /// Fetches and checks the journal entries we don't have yet.
    pub async fn sync(&mut self, id: &Identity) -> Result<(), ServerError> {
        let entries = self.link().journal_from(id, self.roster.len()).await?;
        self.take_entries(entries)
    }

    /// Checks and applies journal entries read from the server. An entry another read has applied meanwhile must be
    /// the very one we hold: a server that shows two reads two different journals is caught here.
    pub fn take_entries(&mut self, entries: Vec<Entry>) -> Result<(), ServerError> {
        let forged = |why: String| ServerError::Refused(format!("Сервер прислал поддельный журнал: {why}"));
        for entry in entries {
            match usize::try_from(entry.seq).ok().and_then(|seq| self.roster.entries().get(seq)) {
                Some(known) if *known == entry => {}
                Some(_) => return Err(forged("две разные записи под одним номером".into())),
                None => self.roster.apply(entry).map_err(|e| forged(e.to_string()))?,
            }
        }
        Ok(())
    }

    /// `body` signed as the next journal entry, ready to post.
    pub fn next_entry(&self, id: &Identity, body: Body) -> Value {
        serde_json::to_value(sign_entry(&self.roster, id, unix_now(), body)).expect("entry serializes")
    }

    /// Joins with an invite link: the server must prove the key in the link.
    pub async fn join(link: &InviteLink, id: &Identity, now: u64) -> Result<Session, ServerError> {
        let session = Session::pinned_to(&link.address, link.server_key)?;
        let mut last = ServerError::Conflict;
        for _ in 0..APPEND_ATTEMPTS {
            let hello = session.greet().await?;
            let entry = sign_join_after(hello.roster_len, hello.roster_head, id, &link.identity(), now);
            let body = serde_json::to_value(&entry).expect("entry serializes");
            match session.request::<Value>(id, "POST", "/api/roster", Some(&body)).await {
                Ok(_) => return session.load(id).await,
                Err(ServerError::Conflict) => last = ServerError::Conflict,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    }

    /// Claims the server on this PC for `id` (genesis, then the given channels). Claiming a
    /// server we already own just opens it. The server runs on this PC, so its key is learned.
    pub async fn claim(address: &str, id: &Identity, name: &str, channels: &[(String, String)]) -> Result<Session, ServerError> {
        let pin = Pin::learn();
        let hello = hello(address, &http_client(&pin, TIMEOUT)?, &pin).await?;
        match hello.owner {
            Some(owner) if owner == id.public() => {
                // `hello` only asserts who the owner is: the key learned here is kept only if the checked journal agrees.
                let session = Session::open(address, Some(hello.server_key), id).await?;
                return if session.roster.owner() == Some(id.public()) { Ok(session) } else { Err(ServerError::OwnedByOther) };
            }
            Some(_) => return Err(ServerError::OwnedByOther),
            None => {}
        }
        let session = Session::pinned_to(address, hello.server_key)?;
        let body = Body::Genesis { server_name: name.to_string(), owner: id.public(), server_key: hello.server_key };
        let genesis = serde_json::to_value(sign_entry(&Roster::new(), id, unix_now(), body)).expect("entry serializes");
        session.request::<Value>(id, "POST", "/api/roster", Some(&genesis)).await?;
        let mut session = session.load(id).await?;
        for (channel_id, channel_name) in channels {
            let channel = ChannelDef { id: channel_id.clone(), name: channel_name.clone(), user_limit: 0, overrides: Vec::new(), kind: Default::default() };
            session.append(id, Body::ChannelCreate(channel)).await?;
        }
        Ok(session)
    }

    /// Signs `body` as the next journal entry and posts it; if someone wrote first, catches up
    /// and signs again.
    pub async fn append(&mut self, id: &Identity, body: Body) -> Result<u64, ServerError> {
        #[derive(Deserialize)]
        struct Appended {
            seq: u64,
        }
        for _ in 0..APPEND_ATTEMPTS {
            let entry = self.next_entry(id, body.clone());
            match self.request::<Appended>(id, "POST", "/api/roster", Some(&entry)).await {
                Ok(appended) => {
                    // After leaving, the journal is for members only: there is nothing to read.
                    if !matches!(body, Body::Leave) {
                        self.sync(id).await?;
                    }
                    return Ok(appended.seq);
                }
                Err(ServerError::Conflict) => self.sync(id).await?,
                Err(error) => return Err(error),
            }
        }
        Err(ServerError::Conflict)
    }

    /// Writes a new invite and returns the link to share; `share_address` is where friends
    /// reach this server (not necessarily the address we use ourselves).
    #[cfg_attr(not(test), expect(dead_code, reason = "the app writes invites without holding the session"))]
    pub async fn create_invite(
        &mut self,
        id: &Identity,
        share_address: &str,
        roles: Vec<RoleId>,
        max_uses: Option<u32>,
        expires_minutes: Option<u32>,
    ) -> Result<String, ServerError> {
        let (invite, body) = new_invite(roles, max_uses, expires_minutes)?;
        self.append(id, body).await?;
        Ok(InviteLink { address: share_address.to_string(), server_key: self.server_key, secret: invite.seed(), by: None }.to_link())
    }

    /// Uploads a moderation GIF/video or the server icon; the server checks type and size.
    #[cfg_attr(not(test), expect(dead_code, reason = "the app uploads through a `Link`, without the session"))]
    pub async fn upload(&self, id: &Identity, bytes: Vec<u8>, purpose: &str) -> Result<MediaRef, ServerError> {
        self.link().upload(id, bytes, purpose).await
    }

    /// Any other signed API call.
    pub async fn request<T: DeserializeOwned>(&self, id: &Identity, method: &str, path: &str, body: Option<&Value>) -> Result<T, ServerError> {
        self.link().request(id, method, path, body).await
    }

    pub fn roster(&self) -> &Roster {
        &self.roster
    }

    /// What signed requests to this server need, for use without the session: the open sessions are not held
    /// while a request is under way.
    pub fn link(&self) -> Link {
        Link { address: self.address.clone(), server_key: self.server_key, http: self.http.clone(), pin: self.pin.clone() }
    }
}

/// A new invite's own identity (its seed is the link's secret) and the journal entry that writes it.
pub fn new_invite(roles: Vec<RoleId>, max_uses: Option<u32>, expires_minutes: Option<u32>) -> Result<(Identity, Body), ServerError> {
    let invite = Identity::generate().map_err(ServerError::Refused)?;
    let expires_at = expires_minutes.map(|minutes| unix_now() + u64::from(minutes) * 60);
    let body = Body::InviteCreate { invite: invite.public(), roles, max_uses, expires_at };
    Ok((invite, body))
}

/// A way to one server, cheap to copy: its address, the client pinned to its key (connections are shared with
/// the session it came from) and that key, which signed requests name.
#[derive(Debug, Clone)]
pub struct Link {
    pub address: String,
    pub server_key: PublicKey,
    http: reqwest::Client,
    pin: Pin,
}

impl Link {
    /// The journal entries from number `from` on, as the server has them; they are checked when applied.
    pub async fn journal_from(&self, id: &Identity, from: u64) -> Result<Vec<Entry>, ServerError> {
        #[derive(Deserialize)]
        struct Journal {
            entries: Vec<Entry>,
        }
        let journal: Journal = self.request(id, "GET", &format!("/api/roster?from={from}"), None).await?;
        Ok(journal.entries)
    }

    /// Uploads a moderation GIF/video or the server icon; the server checks type and size.
    pub async fn upload(&self, id: &Identity, bytes: Vec<u8>, purpose: &str) -> Result<MediaRef, ServerError> {
        let path = format!("/api/media?purpose={purpose}");
        self.signed_raw(id, "POST", &path, bytes, "application/octet-stream").await
    }

    /// Any signed API call whose answer is read as `T`.
    pub async fn request<T: DeserializeOwned>(&self, id: &Identity, method: &str, path: &str, body: Option<&Value>) -> Result<T, ServerError> {
        let bytes = body.map(|b| serde_json::to_vec(b).expect("JSON serializes")).unwrap_or_default();
        self.signed_raw(id, method, path, bytes, "application/json").await
    }

    async fn signed_raw<T: DeserializeOwned>(
        &self,
        id: &Identity,
        method: &str,
        path: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<T, ServerError> {
        let now = unix_now();
        let (status, text) = self.exchange(id, method, path, bytes, content_type, now).await?;
        let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(error_from(status, &json, now));
        }
        serde_json::from_value(json).map_err(|e| ServerError::Refused(format!("Непонятный ответ сервера: {e}")))
    }

    /// The status and JSON body of any answer, errors included, for callers that tell answers apart by more
    /// than success (the call relay's two kinds of 409). Err only when the server did not answer, or answered
    /// with something that is not JSON.
    pub async fn request_raw(&self, id: &Identity, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), ServerError> {
        let bytes = body.map(|b| serde_json::to_vec(b).expect("JSON serializes")).unwrap_or_default();
        let (status, text) = self.exchange(id, method, path, bytes, "application/json", unix_now()).await?;
        let json = serde_json::from_str(&text).map_err(|e| ServerError::Refused(format!("Непонятный ответ сервера: {e}")))?;
        Ok((status, json))
    }

    /// A signed request with a raw body whose answer is read as bytes, at most `limit` of them (files of the chat).
    pub async fn exchange_bytes(&self, id: &Identity, method: &str, path: &str, body: Vec<u8>, limit: usize) -> Result<(u16, Vec<u8>), ServerError> {
        let response = self.respond(id, method, path, body, "application/octet-stream", unix_now()).await?;
        let status = response.status().as_u16();
        let bytes = crate::bridge::read_capped(response, limit).await.map_err(ServerError::Unreachable)?;
        Ok((status, bytes))
    }

    async fn exchange(
        &self,
        id: &Identity,
        method: &str,
        path: &str,
        bytes: Vec<u8>,
        content_type: &str,
        now: u64,
    ) -> Result<(u16, String), ServerError> {
        let response = self.respond(id, method, path, bytes, content_type, now).await?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|e| ServerError::Unreachable(e.to_string()))?;
        Ok((status, text))
    }

    async fn respond(
        &self,
        id: &Identity,
        method: &str,
        path: &str,
        bytes: Vec<u8>,
        content_type: &str,
        now: u64,
    ) -> Result<reqwest::Response, ServerError> {
        let header = sign_request(id, &self.server_key, method, path, &bytes, now).map_err(ServerError::Refused)?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| ServerError::Refused(e.to_string()))?;
        let request = self
            .http
            .request(method, url(&self.address, path)?)
            .header("authorization", header)
            .header("content-type", content_type)
            .body(bytes);
        send(request, &self.pin).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use hv_roster::{Body, Identity, InviteLink, Roster, sign_entry, sign_genesis};
    use serde_json::{Value, json};

    use super::*;
    use crate::tls::test_server;

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    async fn spawn_server() -> String {
        let roster = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        test_server::serve(roster).await.to_string()
    }

    async fn claimed(address: &str) -> Session {
        Session::claim(address, &id(1), "Хата", &[("general".into(), "Общий".into())]).await.unwrap()
    }

    #[tokio::test]
    async fn claim_then_invite_then_join_end_to_end() {
        let address = spawn_server().await;
        let mut owner = claimed(&address).await;
        assert_eq!(owner.roster().owner(), Some(id(1).public()));
        assert_eq!(owner.roster().channels()[0].name, "Общий");

        let invite = Identity::generate().unwrap();
        let body = Body::InviteCreate { invite: invite.public(), roles: vec![], max_uses: Some(1), expires_at: None };
        owner.append(&id(1), body).await.unwrap();
        let link = InviteLink { address: address.clone(), server_key: owner.server_key, secret: invite.seed(), by: None };
        let friend = Session::join(&link, &id(2), unix_now()).await.unwrap();
        assert!(friend.roster().member(&id(2).public().user_id()).is_some());

        owner.sync(&id(1)).await.unwrap();
        assert!(owner.roster().member(&id(2).public().user_id()).is_some(), "the owner sees the newcomer after a sync");
    }

    #[tokio::test]
    async fn claiming_your_own_server_twice_just_opens_it() {
        let address = spawn_server().await;
        let first = claimed(&address).await;
        let again = Session::claim(&address, &id(1), "Хата", &[]).await.unwrap();
        assert_eq!(again.roster().len(), first.roster().len());
        let stranger = Session::claim(&address, &id(5), "Моя", &[]).await.unwrap_err();
        assert_eq!(stranger.message(), "Владелец этого сервера — другая личность. Импортируй свою копию (.hvid)");
    }

    #[tokio::test]
    async fn another_version_of_an_entry_we_hold_is_caught() {
        let address = spawn_server().await;
        let mut owner = claimed(&address).await;
        // The journal as it was before its last entry, and a different last entry written on top of it.
        let last = owner.roster().len() - 1;
        let mut before = Roster::new();
        for entry in &owner.roster().entries()[..last as usize] {
            before.apply(entry.clone()).unwrap();
        }
        let channel = ChannelDef { id: "other".into(), name: "Другой".into(), user_limit: 0, overrides: vec![], kind: Default::default() };
        let other = sign_entry(&before, &id(1), unix_now(), Body::ChannelCreate(channel));
        assert_eq!(other.seq, last);

        let error = owner.take_entries(vec![other]).unwrap_err();
        assert!(error.message().contains("две разные записи"), "{}", error.message());
        // The very entry we hold, read once more, is no news.
        let same = owner.roster().entries()[last as usize].clone();
        owner.take_entries(vec![same]).unwrap();
        assert_eq!(owner.roster().len(), last + 1);
    }

    #[tokio::test]
    async fn open_pins_the_server_key() {
        let address = spawn_server().await;
        let owner = claimed(&address).await;
        assert!(Session::open(&address, Some(owner.server_key), &id(1)).await.is_ok());
        let wrong = Session::open(&address, Some(id(77).public()), &id(1)).await.unwrap_err();
        assert_eq!(wrong, ServerError::KeyChanged);
        assert!(wrong.message().contains("подменён"));
    }

    #[tokio::test]
    async fn a_server_with_another_key_is_reported_as_changed() {
        let address = spawn_server().await;
        claimed(&address).await;
        let error = Session::open(&address, Some(id(77).public()), &id(1)).await.unwrap_err();
        assert_eq!(error, ServerError::KeyChanged);
        let link = InviteLink { address, server_key: id(77).public(), secret: [5; 32], by: None };
        assert_eq!(preview_invite(&link).await.unwrap_err(), ServerError::KeyChanged);
        assert_eq!(Session::join(&link, &id(2), unix_now()).await.unwrap_err(), ServerError::KeyChanged);
    }

    #[tokio::test]
    async fn a_session_notices_when_the_server_behind_its_address_is_replaced() {
        let first = spawn_server().await;
        let mut session = claimed(&first).await;
        let other = spawn_server().await;
        claimed(&other).await;
        // Same session (same pinned key), new server behind the address.
        session.address = other;
        assert_eq!(session.sync(&id(1)).await.unwrap_err(), ServerError::KeyChanged);
        let moved = session.request::<Value>(&id(1), "POST", "/api/voice/token", Some(&json!({ "channel": "general" }))).await;
        assert_eq!(moved.unwrap_err(), ServerError::KeyChanged);
    }

    #[tokio::test]
    async fn opening_by_address_learns_the_key_only_for_a_member() {
        let address = spawn_server().await;
        let owner = claimed(&address).await;
        let member = Session::open(&address, None, &id(1)).await.unwrap();
        assert_eq!(member.server_key, owner.server_key);
        assert_eq!(member.roster().owner(), Some(id(1).public()));
        assert_eq!(Session::open(&address, None, &id(9)).await.unwrap_err(), ServerError::JoinNeeded);
    }

    #[tokio::test]
    async fn the_session_client_is_pinned_to_the_server_key() {
        let address = spawn_server().await;
        let owner = claimed(&address).await;
        let url = format!("https://{address}/health");
        assert!(owner.http().get(&url).send().await.unwrap().status().is_success());

        let stranger = spawn_server().await;
        claimed(&stranger).await;
        assert!(owner.http().get(format!("https://{stranger}/health")).send().await.is_err(), "another server's key is refused");
    }

    #[tokio::test]
    async fn the_server_can_be_greeted_again_over_the_same_connection() {
        // A repeated `hello` (a join that lost a race) rides the open connection: no new handshake to look at.
        let address = spawn_server().await;
        let owner = claimed(&address).await;
        for _ in 0..3 {
            assert_eq!(owner.greet().await.unwrap().server_key, owner.server_key);
        }
    }

    #[tokio::test]
    async fn an_old_plain_http_server_is_named_as_such() {
        let channels = Arc::new(hatavoice_server::channels::ChannelStore::open(None).unwrap());
        let roster = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let key = roster.server_key();
        let app = hatavoice_server::host_app(hatavoice_server::LiveKitConfig::dev(), None, channels, roster);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await });

        let error = Session::open(&address, None, &id(1)).await.unwrap_err();
        assert_eq!(error, ServerError::OldServer);
        assert_eq!(error.message(), "Сервер на старой версии ХатаВойс — попроси хоста обновить");
        assert_eq!(Session::open(&address, Some(key), &id(1)).await.unwrap_err(), ServerError::OldServer);
        assert_eq!(Session::claim(&address, &id(1), "Хата", &[]).await.unwrap_err(), ServerError::OldServer);
        let link = InviteLink { address, server_key: key, secret: [5; 32], by: None };
        assert_eq!(preview_invite(&link).await.unwrap_err(), ServerError::OldServer);
    }

    #[tokio::test]
    async fn a_dead_address_is_unreachable_not_changed() {
        let address = test_server::closed_address().await;
        for pinned in [None, Some(id(77).public())] {
            let error = Session::open(&address, pinned, &id(1)).await.unwrap_err();
            assert!(matches!(error, ServerError::Unreachable(_)), "{error:?}");
        }
    }

    #[tokio::test]
    async fn stranger_gets_join_needed_and_an_unclaimed_server_says_so() {
        let address = spawn_server().await;
        assert_eq!(Session::open(&address, None, &id(9)).await.unwrap_err(), ServerError::Unclaimed);
        claimed(&address).await;
        let stranger = Session::open(&address, None, &id(9)).await.unwrap_err();
        assert_eq!(stranger, ServerError::JoinNeeded);
        assert!(stranger.message().contains("ссылку-приглашение"));
    }

    #[tokio::test]
    async fn append_retries_after_someone_else_wrote_first() {
        let address = spawn_server().await;
        let mut first = claimed(&address).await;
        let mut second = Session::open(&address, None, &id(1)).await.unwrap();
        let channel = |id: &str| Body::ChannelCreate(hv_roster::ChannelDef { id: id.into(), name: id.into(), user_limit: 0, overrides: vec![], kind: Default::default() });
        first.append(&id(1), channel("games")).await.unwrap();
        second.append(&id(1), channel("media")).await.unwrap();
        let ids: Vec<&str> = second.roster().channels().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["general", "games", "media"]);
    }

    #[tokio::test]
    async fn invite_link_lets_a_friend_join() {
        let address = spawn_server().await;
        let mut owner = claimed(&address).await;
        let moderator = vec![hv_roster::RoleId::parse("moderator").unwrap()];
        let link = owner.create_invite(&id(1), &address, moderator, Some(1), Some(60)).await.unwrap();
        let parsed = InviteLink::parse(&link).unwrap();
        assert_eq!(parsed.address, address);
        assert_eq!(parsed.server_key, owner.server_key);
        let invite = owner.roster().invite(&parsed.identity().public()).unwrap().clone();
        assert!(invite.expires_at.unwrap().abs_diff(unix_now() + 3600) <= 5);
        let friend = Session::join(&parsed, &id(2), unix_now()).await.unwrap();
        assert_eq!(friend.roster().member(&id(2).public().user_id()).unwrap().roles[0].0, "moderator");
        assert!(Session::join(&parsed, &id(3), unix_now()).await.is_err(), "a single-use link works once");
    }

    #[tokio::test]
    async fn an_invite_shows_the_server_and_who_invited_before_joining() {
        let address = spawn_server().await;
        let mut owner = claimed(&address).await;
        let link = owner.create_invite(&id(1), &address, vec![], Some(1), None).await.unwrap();
        let link = InviteLink { by: Some("Аня".into()), ..InviteLink::parse(&link).unwrap() };
        let preview = preview_invite(&link).await.unwrap();
        assert_eq!(preview.server_name, "Хата");
        assert_eq!(preview.inviter_name.as_deref(), Some("Аня"), "the nickname comes from the link, not the server");
        let nameless = preview_invite(&InviteLink { by: None, ..link.clone() }).await.unwrap();
        assert_eq!(nameless.inviter_name, None);
        assert_eq!(preview.inviter_fingerprint, crate::identity::fingerprint(&id(1).public()));
        assert!(preview.valid);

        let forged = InviteLink { server_key: id(5).public(), ..link };
        assert_eq!(preview_invite(&forged).await.unwrap_err(), ServerError::KeyChanged);
    }

    #[tokio::test]
    async fn leaving_succeeds_although_the_journal_is_closed_to_us_afterwards() {
        let address = spawn_server().await;
        let mut owner = claimed(&address).await;
        let link = owner.create_invite(&id(1), &address, vec![], None, None).await.unwrap();
        let mut friend = Session::join(&InviteLink::parse(&link).unwrap(), &id(2), unix_now()).await.unwrap();
        friend.append(&id(2), Body::Leave).await.expect("leaving is not an error");
        owner.sync(&id(1)).await.unwrap();
        assert!(owner.roster().member(&id(2).public().user_id()).is_none());
    }

    #[tokio::test]
    async fn kick_with_a_gif_reaches_the_server() {
        let address = spawn_server().await;
        let mut owner = claimed(&address).await;
        let link = owner.create_invite(&id(1), &address, vec![], None, None).await.unwrap();
        Session::join(&InviteLink::parse(&link).unwrap(), &id(2), unix_now()).await.unwrap();
        owner.sync(&id(1)).await.unwrap();

        let mut gif = b"GIF89a".to_vec();
        gif.resize(2048, 3);
        let media = owner.upload(&id(1), gif, "moderation").await.unwrap();
        assert_eq!((media.mime.as_str(), media.size), ("image/gif", 2048));
        let kick = Body::Kick { user: id(2).public().user_id(), reason: "Хватит".into(), media: Some(media.clone()) };
        owner.append(&id(1), kick).await.unwrap();
        assert!(owner.roster().member(&id(2).public().user_id()).is_none());
        let refused = owner.upload(&id(1), b"MZ not a gif".to_vec(), "moderation").await.unwrap_err();
        assert_eq!(refused.message(), "Такой тип файла не поддерживается");
    }

    #[tokio::test]
    async fn signed_requests_reach_the_api() {
        let address = spawn_server().await;
        let owner = claimed(&address).await;
        let token: Value = owner.request(&id(1), "POST", "/api/voice/token", Some(&json!({ "channel": "general" }))).await.unwrap();
        assert!(token["token"].as_str().is_some_and(|t| !t.is_empty()));
        let refused = owner.request::<Value>(&id(1), "POST", "/api/voice/token", Some(&json!({ "channel": "nope" }))).await;
        assert_eq!(refused.unwrap_err().message(), "Такого канала нет");
    }

    /// A server with its own key (100) and a journal (owner: 1) that it serves without asking who is reading;
    /// with `forged` an entry of it is tampered with.
    async fn journal_server(forged: bool) -> String {
        journal_server_owned_by(forged, 1, 1).await
    }

    /// The same, but the journal belongs to `journal_owner` while `hello` names `hello_owner`.
    async fn journal_server_owned_by(forged: bool, journal_owner: u8, hello_owner: u8) -> String {
        use axum::extract::Query;
        use axum::routing::get;
        let owner = id(journal_owner);
        let server = id(100);
        let mut roster = Roster::new();
        roster.apply(sign_genesis(&owner, &server, "Хата", unix_now())).unwrap();
        let invite = Body::InviteCreate { invite: id(3).public(), roles: vec![], max_uses: Some(1), expires_at: None };
        roster.apply(sign_entry(&roster, &owner, unix_now(), invite)).unwrap();
        let head = roster.head();
        let mut entries = roster.entries().to_vec();
        if forged {
            entries[1].body = Body::InviteCreate { invite: id(3).public(), roles: vec![], max_uses: None, expires_at: None };
        }
        let hello = get(move |Query(q): Query<std::collections::HashMap<String, String>>| async move {
            let nonce = q["nonce"].clone();
            let proof = id(100).sign(&hv_roster::request::hello_message(&nonce, &head));
            axum::Json(json!({
                "server_key": id(100).public(), "owner": id(hello_owner).public(), "name": "Хата",
                "roster_len": 2, "roster_head": head, "proof": proof,
            }))
        });
        let journal = get(move || async move { axum::Json(json!({ "entries": entries })) });
        let router = axum::Router::new().route("/api/hello", hello).route("/api/roster", journal);
        test_server::serve_app(router, &id(100)).await.to_string()
    }

    #[tokio::test]
    async fn a_forged_entry_from_the_server_is_rejected() {
        let address = journal_server(true).await;
        let error = Session::open(&address, None, &id(1)).await.unwrap_err();
        assert!(matches!(error, ServerError::Refused(_)));
        assert!(error.message().contains("поддельн"), "{}", error.message());
    }

    #[tokio::test]
    async fn claim_does_not_trust_hello_about_the_owner() {
        // `hello` says we own the server, but its journal, signed end to end, belongs to someone else:
        // a squatter on the port must not get its key saved as ours.
        let address = journal_server_owned_by(false, 2, 1).await;
        assert_eq!(Session::claim(&address, &id(1), "Хата", &[]).await.unwrap_err(), ServerError::OwnedByOther);
        // The same server, honest about its owner, is one we own.
        let honest = journal_server_owned_by(false, 1, 1).await;
        assert_eq!(Session::claim(&honest, &id(1), "Хата", &[]).await.unwrap().roster().owner(), Some(id(1).public()));
    }

    #[tokio::test]
    async fn a_key_is_not_learned_from_a_server_that_does_not_know_us() {
        // A rogue server may answer anyone with a well-formed journal; only one that holds our own join is believed.
        let address = journal_server(false).await;
        assert_eq!(Session::open(&address, None, &id(9)).await.unwrap_err(), ServerError::JoinNeeded);
        let owner = Session::open(&address, None, &id(1)).await.unwrap();
        assert_eq!(owner.server_key, id(100).public());
        // With the key already pinned (saved, or from an invite) nothing is being learned.
        assert!(Session::open(&address, Some(id(100).public()), &id(9)).await.is_ok());
    }

    #[test]
    fn clock_skew_becomes_a_readable_message() {
        let body = json!({ "error": "Часы…", "clock_skew": true, "server_time": 1_000 + 180 });
        let error = error_from(401, &body, 1_000);
        assert_eq!(error, ServerError::ClockSkew { minutes: 3 });
        assert_eq!(
            error.message(),
            "Часы на этом ПК расходятся с сервером на 3 мин — включи синхронизацию времени в Windows"
        );
        let slight = error_from(401, &json!({ "clock_skew": true, "server_time": 1_000 - 70 }), 1_000);
        assert_eq!(slight, ServerError::ClockSkew { minutes: -1 });
        assert!(slight.message().contains("на 1 мин"));
    }

    #[test]
    fn other_refusals_keep_the_servers_words() {
        assert_eq!(error_from(403, &json!({ "error": "Нет доступа к каналу" }), 0).message(), "Нет доступа к каналу");
        assert_eq!(error_from(403, &json!({ "error": "x", "banned": true, "until": 5 }), 0), ServerError::Banned { until: Some(5) });
        assert_eq!(error_from(409, &json!({ "error": "x", "conflict": true }), 0), ServerError::Conflict);
        assert_eq!(error_from(500, &Value::Null, 0).message(), "Сервер ответил ошибкой 500");
    }
}
