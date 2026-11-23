mod common;

use common::{claim, invite, join, now, spawn};
use hv_roster::request::hello_message;
use hv_roster::{Body, Digest, Identity, PublicKey, Roster, Signature, sign_entry};
use serde_json::Value;

async fn hello(server: &common::TestServer, nonce: &str) -> Value {
    reqwest::get(server.url(&format!("/api/hello?nonce={nonce}"))).await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn hello_proves_the_server_key() {
    let server = spawn().await;
    let body = hello(&server, "n-123").await;
    let key: PublicKey = serde_json::from_value(body["server_key"].clone()).unwrap();
    assert_eq!(key, server.server_key);
    let head: Digest = serde_json::from_value(body["roster_head"].clone()).unwrap();
    let proof: Signature = serde_json::from_value(body["proof"].clone()).unwrap();
    assert!(key.verify(&hello_message("n-123", &head), &proof));
    assert_eq!(body["roster_len"], 0);
    assert_eq!(body["owner"], Value::Null, "not claimed yet");

    let bad = reqwest::get(server.url(&format!("/api/hello?nonce={}", "x".repeat(65)))).await.unwrap();
    assert_eq!(bad.status(), 400);
}

#[tokio::test]
async fn genesis_only_from_this_pc_and_only_once() {
    let server = spawn().await;
    let owner = server.client(1);
    let body = Body::Genesis { server_name: "Хата".into(), owner: owner.id.public(), server_key: server.server_key };
    let entry = sign_entry(&Roster::new(), &owner.id, now(), body);
    let bytes = serde_json::to_vec(&entry).unwrap();
    let from_a_web_page = reqwest::Client::new()
        .post(server.url("/api/roster"))
        .header("authorization", owner.auth("POST", "/api/roster", &bytes, now()))
        .header("origin", "https://evil.example")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(from_a_web_page.status(), 403);

    claim(&server, &owner).await;
    let roster = owner.roster().await;
    assert_eq!(roster.owner(), Some(owner.id.public()));
    assert_eq!(roster.server_key(), Some(server.server_key));
    assert_eq!(hello(&server, "a").await["owner"], serde_json::to_value(owner.id.public()).unwrap());
}

#[tokio::test]
async fn a_different_owner_cannot_claim_an_existing_server() {
    let server = spawn().await;
    claim(&server, &server.client(1)).await;
    let other = server.client(2);
    let body = Body::Genesis { server_name: "Моя".into(), owner: other.id.public(), server_key: server.server_key };
    let (status, response) = other.post_entry(&sign_entry(&Roster::new(), &other.id, now(), body)).await;
    assert_eq!(status, 409);
    assert_eq!(response["error"], "Сервер уже принадлежит другой личности");
}

#[tokio::test]
async fn unsigned_or_replayed_requests_get_401() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;

    let unsigned = reqwest::get(server.url("/api/roster?from=0")).await.unwrap();
    assert_eq!(unsigned.status(), 401);
    let body: Value = unsigned.json().await.unwrap();
    assert_eq!(body["error"], "Обнови ХатаВойс: этот сервер требует новую версию");

    let header = owner.auth("GET", "/api/roster?from=0", b"", now());
    let send = || reqwest::Client::new().get(server.url("/api/roster?from=0")).header("authorization", header.clone()).send();
    assert_eq!(send().await.unwrap().status(), 200);
    assert_eq!(send().await.unwrap().status(), 401, "the same request again");
}

#[tokio::test]
async fn wrong_clock_gets_401_with_server_time() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let header = owner.auth("GET", "/api/roster?from=0", b"", now() - 600);
    let response = reqwest::Client::new().get(server.url("/api/roster?from=0")).header("authorization", header).send().await.unwrap();
    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    let server_time = body["server_time"].as_u64().unwrap();
    assert!(server_time.abs_diff(now()) <= 2);
    assert_eq!(body["clock_skew"], true);
}

#[tokio::test]
async fn strangers_are_told_to_get_an_invite() {
    let server = spawn().await;
    claim(&server, &server.client(1)).await;
    let (status, body) = server.client(9).get("/api/roster?from=0").await;
    assert_eq!(status, 403);
    assert_eq!(body["join_needed"], true);
}

#[tokio::test]
async fn an_unclaimed_server_says_so() {
    let server = spawn().await;
    let (status, body) = server.client(9).get("/api/roster?from=0").await;
    assert_eq!(status, 503);
    assert_eq!(body["unclaimed"], true);
}

#[tokio::test]
async fn join_by_invite_then_read_the_journal() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let key = invite(&owner, &["moderator"]).await;

    let friend = server.client(2);
    let info: Value = reqwest::get(server.url(&format!("/api/invite?key={}", hv_roster::keys::encode_b64(&key.public().0))))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["server_name"], "Хата");
    assert_eq!(info["inviter"], serde_json::to_value(owner.id.public().user_id()).unwrap());
    assert_eq!(info["valid"], true);

    let (status, body) = join(&friend, &key).await;
    assert_eq!(status, 200, "{body}");
    let roster = friend.roster().await;
    assert_eq!(roster.len(), 3);
    assert_eq!(roster.member(&friend.id.public().user_id()).unwrap().roles[0].0, "moderator");
    assert_eq!(friend.get("/api/roster?from=2").await.1["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_bad_entry_is_refused_and_not_stored() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let roster = owner.roster().await;
    let mut entry = sign_entry(&roster, &owner.id, now(), Body::InviteRevoke { invite: Identity::generate().unwrap().public() });
    let (status, body) = owner.post_entry(&entry).await;
    assert_eq!(status, 400, "revoking an unknown invite");
    assert_eq!(body["error"], "Приглашение не найдено");

    entry.seq = 7;
    let (status, _) = owner.post_entry(&entry).await;
    assert_eq!(status, 409, "someone else wrote first / out of order");
    assert_eq!(owner.roster().await.len(), 1);

    let stranger = server.client(5);
    let forged = sign_entry(&roster, &owner.id, now(), Body::InviteRevoke { invite: owner.id.public() });
    let (status, _) = stranger.post_entry(&forged).await;
    assert_eq!(status, 403, "posting someone else's entry");
}

#[test]
fn journal_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("hv-roster-store-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let key = {
        let store = hatavoice_server::roster_store::RosterStore::open(Some(&dir)).unwrap();
        let body = Body::Genesis { server_name: "Хата".into(), owner: owner.public(), server_key: store.server_key() };
        store.append(sign_entry(&Roster::new(), &owner, now(), body), now()).unwrap();
        store.server_key()
    };
    let reopened = hatavoice_server::roster_store::RosterStore::open(Some(&dir)).unwrap();
    assert_eq!(reopened.server_key(), key, "the server key is kept");
    assert_eq!(reopened.read(|r| r.len()), 1);
    let on_disk = std::fs::read(dir.join("server_key.bin")).unwrap();
    assert_ne!(on_disk.len(), 32, "the key is stored protected, not as raw bytes");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn the_invite_preview_has_no_inviter_name() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let key = invite(&owner, &[]).await;
    let info: Value = reqwest::get(server.url(&format!("/api/invite?key={}", hv_roster::keys::encode_b64(&key.public().0))))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(info.get("inviter_name").is_none(), "the nickname travels in the link: {info}");
    assert_eq!(info["inviter"], owner.id.public().user_id().0);
}

fn store_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("hv-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn claim_on_disk(dir: &std::path::Path) {
    let owner = Identity::from_seed([1; 32]);
    let store = hatavoice_server::roster_store::RosterStore::open(Some(dir)).unwrap();
    let body = Body::Genesis { server_name: "Хата".into(), owner: owner.public(), server_key: store.server_key() };
    store.append(sign_entry(&Roster::new(), &owner, now(), body), now()).unwrap();
}

#[test]
fn a_line_torn_by_a_power_cut_is_dropped() {
    let dir = store_dir("torn");
    claim_on_disk(&dir);
    let path = dir.join("roster.jsonl");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("{\"seq\":1,\"prev\":\"AAAA");
    std::fs::write(&path, text).unwrap();
    let reopened = hatavoice_server::roster_store::RosterStore::open(Some(&dir)).expect("starts despite the torn tail");
    assert_eq!(reopened.read(|r| r.len()), 1);
    assert!(std::fs::read_to_string(&path).unwrap().ends_with("}\n"), "the torn tail is cut off");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_journal_without_its_server_key_does_not_start_with_a_new_one() {
    let dir = store_dir("lostkey");
    claim_on_disk(&dir);
    std::fs::remove_file(dir.join("server_key.bin")).unwrap();
    let error = hatavoice_server::roster_store::RosterStore::open(Some(&dir)).err().expect("refuses to start");
    assert!(error.contains("server_key.bin"), "{error}");
    assert!(!dir.join("server_key.bin").exists(), "no new key that every client would reject");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_server_key_that_does_not_match_the_journal_is_refused() {
    let dir = store_dir("wrongkey");
    claim_on_disk(&dir);
    let other = hv_host::protect::protect(&Identity::from_seed([7; 32]).seed()).unwrap();
    std::fs::write(dir.join("server_key.bin"), other).unwrap();
    let error = hatavoice_server::roster_store::RosterStore::open(Some(&dir)).err().expect("refuses to start");
    assert!(error.contains("не тот, что в журнале"), "{error}");
    std::fs::remove_dir_all(&dir).unwrap();
}
