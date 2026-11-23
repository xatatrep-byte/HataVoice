//! Test helpers: an in-process server with an in-memory journal, and signed requests to it.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use hatavoice_server::LiveKitConfig;
use hatavoice_server::channels::ChannelStore;
use hatavoice_server::roster_store::RosterStore;
// Each test file takes only what it needs from here.
#[allow(unused_imports)]
pub use hatavoice_server::testing::{dead_livekit, fake_livekit};
use hv_roster::request::sign_request;
use hv_roster::{Body, Entry, Identity, PublicKey, Roster, sign_entry};
use serde_json::Value;

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

pub fn id(n: u8) -> Identity {
    Identity::from_seed([n; 32])
}

pub struct TestServer {
    pub addr: SocketAddr,
    pub server_key: PublicKey,
    pub store: Arc<RosterStore>,
}

pub async fn spawn() -> TestServer {
    spawn_with(LiveKitConfig::dev()).await
}

pub async fn spawn_with(livekit: LiveKitConfig) -> TestServer {
    let store = Arc::new(RosterStore::open(None).unwrap());
    spawn_store(livekit, store).await
}

pub async fn spawn_store(livekit: LiveKitConfig, store: Arc<RosterStore>) -> TestServer {
    let channels = Arc::new(ChannelStore::open(None).unwrap());
    let app = hatavoice_server::host_app(livekit, None, channels, store.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestServer { addr, server_key: store.server_key(), store }
}

pub fn uid(client: &Client<'_>) -> String {
    client.id.public().user_id().0
}

pub struct Client<'a> {
    pub id: Identity,
    pub server: &'a TestServer,
    http: reqwest::Client,
}

impl TestServer {
    pub fn client(&self, n: u8) -> Client<'_> {
        Client { id: id(n), server: self, http: reqwest::Client::new() }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }
}

async fn read(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    let text = response.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

impl Client<'_> {
    pub fn auth(&self, method: &str, path: &str, body: &[u8], at: u64) -> String {
        sign_request(&self.id, &self.server.server_key, method, path, body, at).unwrap()
    }

    pub async fn get(&self, path: &str) -> (u16, Value) {
        let header = self.auth("GET", path, b"", now());
        read(self.http.get(self.server.url(path)).header("authorization", header).send().await.unwrap()).await
    }

    pub async fn send(&self, method: &str, path: &str, body: &Value) -> (u16, Value) {
        let bytes = serde_json::to_vec(body).unwrap();
        let header = self.auth(method, path, &bytes, now());
        let request = self
            .http
            .request(method.parse().unwrap(), self.server.url(path))
            .header("authorization", header)
            .header("content-type", "application/json")
            .body(bytes);
        read(request.send().await.unwrap()).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        self.send("POST", path, body).await
    }

    /// A signed POST with a raw (file) body.
    pub async fn post_bytes(&self, path: &str, bytes: Vec<u8>) -> (u16, Value) {
        let header = self.auth("POST", path, &bytes, now());
        let request = self
            .http
            .post(self.server.url(path))
            .header("authorization", header)
            .header("content-type", "application/octet-stream")
            .body(bytes);
        read(request.send().await.unwrap()).await
    }

    pub async fn post_entry(&self, entry: &Entry) -> (u16, Value) {
        self.post("/api/roster", &serde_json::to_value(entry).unwrap()).await
    }

    /// The server's journal as this client sees it.
    pub async fn roster(&self) -> Roster {
        let (status, body) = self.get("/api/roster?from=0").await;
        assert_eq!(status, 200, "{body}");
        let entries: Vec<Entry> = serde_json::from_value(body["entries"].clone()).unwrap();
        Roster::from_entries(entries).unwrap()
    }

    /// Signs `body` as the next entry of the current journal and posts it.
    pub async fn act(&self, body: Body) -> (u16, Value) {
        let roster = self.roster().await;
        self.post_entry(&sign_entry(&roster, &self.id, now(), body)).await
    }
}

/// Claims an empty server for `owner` from this PC, the way the host client does.
pub async fn claim(server: &TestServer, owner: &Client<'_>) {
    let body = Body::Genesis { server_name: "Хата".into(), owner: owner.id.public(), server_key: server.server_key };
    let entry = sign_entry(&Roster::new(), &owner.id, now(), body);
    let (status, response) = owner.post_entry(&entry).await;
    assert_eq!(status, 200, "{response}");
}

/// A new invite created by `by` with the given roles; returns the invite key.
pub async fn invite(by: &Client<'_>, roles: &[&str]) -> Identity {
    let invite = Identity::generate().unwrap();
    let roles = roles.iter().map(|r| hv_roster::RoleId::parse(r).unwrap()).collect();
    let body = Body::InviteCreate { invite: invite.public(), roles, max_uses: None, expires_at: None };
    let (status, response) = by.act(body).await;
    assert_eq!(status, 200, "{response}");
    invite
}

/// `who` joins with `invite` (fetching the journal head through `hello`, as a stranger must).
pub async fn join(who: &Client<'_>, invite: &Identity) -> (u16, Value) {
    let hello: Value = reqwest::get(who.server.url("/api/hello?nonce=join")).await.unwrap().json().await.unwrap();
    // A stranger can't read the journal; its length and head come from hello.
    let seq = hello["roster_len"].as_u64().unwrap();
    let prev: hv_roster::Digest = serde_json::from_value(hello["roster_head"].clone()).unwrap();
    let entry = hv_roster::sign_join_after(seq, prev, &who.id, invite, now());
    who.post_entry(&entry).await
}
