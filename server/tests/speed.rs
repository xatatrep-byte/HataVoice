mod common;

use common::{claim, now, spawn};
use hatavoice_server::speed::{MAX_TEST_BYTES, TESTS_PER_MINUTE};

#[tokio::test]
async fn a_member_measures_the_way_to_the_server_both_ways() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;

    let (status, pong) = owner.get("/api/speed/ping").await;
    assert_eq!(status, 200, "{pong}");

    let path = "/api/speed/down?bytes=300000";
    let header = owner.auth("GET", path, b"", now());
    let response = reqwest::Client::new().get(server.url(path)).header("authorization", header).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = response.bytes().await.unwrap();
    assert_eq!(bytes.len(), 300_000);
    assert!(bytes.windows(4).take(1000).any(|w| w != [0, 0, 0, 0]), "not a run of zeros a link could squeeze");

    let (status, took) = owner.post_bytes("/api/speed/up", vec![7; 400_000]).await;
    assert_eq!(status, 200, "{took}");
    assert_eq!(took["bytes"], 400_000);
}

#[tokio::test]
async fn strangers_get_nothing_and_nobody_asks_for_more_than_the_cap() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    let stranger = server.client(9);
    let (status, _) = stranger.get("/api/speed/ping").await;
    assert_eq!(status, 403);
    let path = format!("/api/speed/down?bytes={}", MAX_TEST_BYTES + 1);
    let (status, _) = owner.get(&path).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn a_member_tests_only_so_often() {
    let server = spawn().await;
    let owner = server.client(1);
    claim(&server, &owner).await;
    for _ in 0..TESTS_PER_MINUTE {
        assert_eq!(owner.get("/api/speed/down?bytes=1000").await.0, 200);
    }
    assert_eq!(owner.get("/api/speed/down?bytes=1000").await.0, 429);
}
