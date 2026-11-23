mod common;

use common::{claim, invite, join, spawn};
use hatavoice_server::media::sniff;
use serde_json::Value;

fn gif(size: usize) -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.resize(size, 7);
    bytes
}

fn png(size: usize) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.resize(size, 1);
    bytes
}

fn mp4(size: usize) -> Vec<u8> {
    let mut bytes = vec![0, 0, 0, 0x20, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'];
    bytes.resize(size, 2);
    bytes
}

fn hex_sha(bytes: &[u8]) -> String {
    hv_roster::keys::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn sniffs_real_formats_by_their_magic_bytes() {
    assert_eq!(sniff(&gif(100)), Some("image/gif"));
    assert_eq!(sniff(b"GIF87a...."), Some("image/gif"));
    assert_eq!(sniff(&png(100)), Some("image/png"));
    assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
    assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
    assert_eq!(sniff(&mp4(100)), Some("video/mp4"));
    assert_eq!(sniff(&[0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42]), Some("video/webm"));
    assert_eq!(sniff(b"MZ\x90\0this is a program"), None);
    assert_eq!(sniff(b""), None);
    assert_eq!(sniff(b"RIFF\x10\0\0\0WAVEfmt "), None, "a RIFF that isn't WebP");
}

#[tokio::test]
async fn upload_returns_a_hash_and_download_gives_the_same_bytes() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let bytes = gif(5000);
    let (status, media) = owner.post_bytes("/api/media?purpose=moderation", bytes.clone()).await;
    assert_eq!(status, 200, "{media}");
    assert_eq!(media["sha256"], hex_sha(&bytes));
    assert_eq!(media["mime"], "image/gif");
    assert_eq!(media["size"], 5000);

    // Not signed: whoever got the hash (even someone just kicked) can see it.
    let response = reqwest::get(server.url(&format!("/api/media/{}", hex_sha(&bytes)))).await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "image/gif");
    assert_eq!(response.bytes().await.unwrap().as_ref(), bytes.as_slice());

    let missing = reqwest::get(server.url(&format!("/api/media/{}", "0".repeat(64)))).await.unwrap();
    assert_eq!(missing.status(), 404);
    let junk = reqwest::get(server.url("/api/media/..%2F..%2Fsecrets.json")).await.unwrap();
    assert_eq!(junk.status(), 400);
}

#[tokio::test]
async fn icons_are_small_images() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let (status, media) = owner.post_bytes("/api/media?purpose=icon", png(50_000)).await;
    assert_eq!((status, media["mime"].as_str()), (200, Some("image/png")));
}

#[tokio::test]
async fn bad_files_are_refused_and_not_written() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("moderation", gif(9 * 1024 * 1024), "Файл больше 8 МБ"),
        ("moderation", b"MZ\x90\0pretend gif".to_vec(), "Такой тип файла не поддерживается"),
        ("moderation", Vec::new(), "Пустой файл"),
        ("moderation", png(1000), "Для модерации — GIF, MP4 или WebM"),
        ("icon", png(2 * 1024 * 1024), "Иконка — до 1 МБ"),
        ("icon", mp4(1000), "Иконка — PNG, JPEG, GIF или WebP"),
        ("avatar", gif(10), "Неизвестное назначение файла"),
    ];
    for (purpose, bytes, message) in cases {
        let sha = hex_sha(&bytes);
        let (status, body) = owner.post_bytes(&format!("/api/media?purpose={purpose}"), bytes).await;
        assert_eq!((status, body["error"].as_str()), (400, Some(message)), "{purpose}");
        let stored = reqwest::get(server.url(&format!("/api/media/{sha}"))).await.unwrap();
        assert_eq!(stored.status(), 404, "a refused file is not kept");
    }
}

#[tokio::test]
async fn strangers_cannot_upload() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let (status, body): (u16, Value) = server.client(9).post_bytes("/api/media?purpose=moderation", gif(100)).await;
    assert_eq!((status, body["join_needed"].as_bool()), (403, Some(true)));
    let friend = server.client(2);
    let key = invite(&owner, &[]).await;
    assert_eq!(join(&friend, &key).await.0, 200);
    assert_eq!(friend.post_bytes("/api/media?purpose=moderation", gif(100)).await.0, 200, "any member may");
}

#[tokio::test]
async fn a_stranger_cannot_make_the_server_read_a_huge_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let path = "/api/media?purpose=moderation";
    let huge = gif(17 * 1024 * 1024);
    let header = server.client(9).auth("POST", path, &huge, common::now());
    // Announce 17 MB, send 1 KB and stall: the answer must not wait for the rest.
    let mut socket = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    let head = format!(
        "POST {path} HTTP/1.1\r\nhost: {}\r\nauthorization: {header}\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\n\r\n",
        server.addr,
        huge.len()
    );
    socket.write_all(head.as_bytes()).await.unwrap();
    socket.write_all(&huge[..1024]).await.unwrap();
    let mut answer = vec![0u8; 512];
    let read = tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut answer))
        .await
        .expect("the server waited for a stranger's 17 MB")
        .unwrap();
    let text = String::from_utf8_lossy(&answer[..read]);
    assert!(text.starts_with("HTTP/1.1 403"), "{text}");
    assert!(text.contains("join_needed"), "{text}");
}

#[tokio::test]
async fn a_member_cannot_flood_the_disk_with_uploads() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    for n in 0..hatavoice_server::media::UPLOADS_PER_MINUTE {
        let (status, body) = owner.post_bytes("/api/media?purpose=moderation", gif(100 + n)).await;
        assert_eq!(status, 200, "{body}");
    }
    let flood = gif(5000);
    let (status, body): (u16, Value) = owner.post_bytes("/api/media?purpose=moderation", flood.clone()).await;
    assert_eq!((status, body["error"].as_str()), (429, Some("Слишком много файлов — подожди минуту")));
    let stored = reqwest::get(server.url(&format!("/api/media/{}", hex_sha(&flood)))).await.unwrap();
    assert_eq!(stored.status(), 404, "not kept");
}
