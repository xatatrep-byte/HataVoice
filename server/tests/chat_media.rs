mod common;

use std::sync::Arc;

use common::{TestServer, claim, invite, join, spawn, spawn_store};
use hatavoice_server::LiveKitConfig;
use hatavoice_server::chat_media::{MAX_BLOB, UPLOADS_PER_MINUTE};
use hatavoice_server::roster_store::RosterStore;
use serde_json::Value;

fn blob(size: usize, fill: u8) -> Vec<u8> {
    vec![fill; size]
}

fn hex_sha(bytes: &[u8]) -> String {
    hv_roster::keys::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The owner (1) and a member (2).
async fn world(server: &TestServer) {
    let owner = server.client(1);
    claim(server, &owner).await;
    let ticket = invite(&owner, &[]).await;
    assert_eq!(join(&server.client(2), &ticket).await.0, 200);
}

#[tokio::test]
async fn a_member_uploads_and_downloads_a_blob() {
    let server = spawn().await;
    world(&server).await;
    let bytes = blob(70_000, 9);
    let (status, body) = server.client(2).post_bytes("/api/chat-media", bytes.clone()).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((body["sha256"].as_str(), body["size"].as_u64()), (Some(hex_sha(&bytes).as_str()), Some(70_000)));
    let path = format!("/api/chat-media/{}", hex_sha(&bytes));
    let owner = server.client(1);
    let header = owner.auth("GET", &path, b"", common::now());
    let response = reqwest::Client::new().get(server.url(&path)).header("authorization", header).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/octet-stream");
    assert_eq!(response.bytes().await.unwrap().to_vec(), bytes);
    let (status, body) = owner.get(&format!("/api/chat-media/{}", "0".repeat(64))).await;
    assert_eq!((status, body["error"].as_str()), (404, Some("Файл не найден")));
}

#[tokio::test]
async fn a_stranger_can_do_neither() {
    let server = spawn().await;
    world(&server).await;
    let bytes = blob(1000, 3);
    assert_eq!(server.client(2).post_bytes("/api/chat-media", bytes.clone()).await.0, 200);
    let stranger = server.client(9);
    assert_eq!(stranger.post_bytes("/api/chat-media", blob(1000, 4)).await.0, 403);
    assert_eq!(stranger.get(&format!("/api/chat-media/{}", hex_sha(&bytes))).await.0, 403);
    let unsigned = reqwest::get(server.url(&format!("/api/chat-media/{}", hex_sha(&bytes)))).await.unwrap();
    assert_eq!(unsigned.status(), 401);
}

#[tokio::test]
async fn a_blob_over_the_limit_is_refused() {
    let server = spawn().await;
    world(&server).await;
    let member = server.client(2);
    assert_eq!(member.post_bytes("/api/chat-media", blob(MAX_BLOB, 1)).await.0, 200, "exactly the limit");
    let (status, body) = member.post_bytes("/api/chat-media", blob(MAX_BLOB + 1, 2)).await;
    assert_eq!((status, body["error"].as_str()), (413, Some("Файл больше 25 МБ")));
    let (status, body) = member.post_bytes("/api/chat-media", Vec::new()).await;
    assert_eq!((status, body["error"].as_str()), (400, Some("Пустой файл")));
}

#[tokio::test]
async fn an_upload_over_the_limit_in_a_minute_waits() {
    let server = spawn().await;
    world(&server).await;
    let member = server.client(2);
    for n in 0..UPLOADS_PER_MINUTE {
        assert_eq!(member.post_bytes("/api/chat-media", blob(10, n as u8)).await.0, 200);
    }
    let (status, body): (u16, Value) = member.post_bytes("/api/chat-media", blob(10, 200)).await;
    assert_eq!((status, body["error"].as_str()), (429, Some("Слишком много файлов — подожди минуту")));
    assert_eq!(server.client(1).post_bytes("/api/chat-media", blob(10, 201)).await.0, 200, "the limit is per person");
}

#[tokio::test]
async fn blobs_outlive_a_restart() {
    let dir = std::env::temp_dir().join(format!("hv-chat-media-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let bytes = blob(5000, 7);
    {
        let store = Arc::new(RosterStore::open(Some(&dir)).unwrap());
        let server = spawn_store(LiveKitConfig::dev(), store).await;
        world(&server).await;
        assert_eq!(server.client(2).post_bytes("/api/chat-media", bytes.clone()).await.0, 200);
    }
    let store = Arc::new(RosterStore::open(Some(&dir)).unwrap());
    let server = spawn_store(LiveKitConfig::dev(), store).await;
    let path = format!("/api/chat-media/{}", hex_sha(&bytes));
    let header = server.client(2).auth("GET", &path, b"", common::now());
    let response = reqwest::Client::new().get(server.url(&path)).header("authorization", header).send().await.unwrap();
    assert_eq!(response.bytes().await.unwrap().to_vec(), bytes);
    assert!(dir.join("chat-media").join(hex_sha(&bytes)).exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_bad_hash_is_refused() {
    let server = spawn().await;
    world(&server).await;
    for bad in ["abc", "..%2F..%2Fsecrets.json", &"G".repeat(64)] {
        let (status, body) = server.client(2).get(&format!("/api/chat-media/{bad}")).await;
        assert_eq!((status, body["error"].as_str()), (400, Some("Испорчена ссылка на файл")), "{bad}");
    }
}
