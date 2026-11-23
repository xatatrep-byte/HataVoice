mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Client, TestServer, claim, invite, join, now, spawn, spawn_store, uid};
use futures_util::StreamExt;
use hatavoice_server::LiveKitConfig;
use hatavoice_server::roster_store::RosterStore;
use hv_roster::keys::encode_b64;
use hv_roster::{Body, UserId};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Stream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn listen(client: &Client<'_>) -> Stream {
    let mut request = format!("ws://{}/api/events", client.server.addr).into_client_request().unwrap();
    let header = client.auth("GET", "/api/events", b"", now());
    request.headers_mut().insert("authorization", header.parse().unwrap());
    let (stream, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    stream
}

async fn wait_for(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, stream.next()).await.expect("no such event in time") {
            Some(Ok(Message::Text(text))) => {
                let event: Value = serde_json::from_str(&text).unwrap();
                if wanted(&event) {
                    return event;
                }
            }
            Some(Ok(_)) => {}
            other => panic!("stream ended: {other:?}"),
        }
    }
}

/// The group events seen during `wait`.
async fn group_events(stream: &mut Stream, wait: Duration) -> Vec<Value> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, stream.next()).await {
        if let Message::Text(text) = message {
            let event: Value = serde_json::from_str(&text).unwrap();
            if event["type"].as_str().is_some_and(|t| t.starts_with("group_")) {
                seen.push(event);
            }
        }
    }
    seen
}

async fn ok(result: (u16, Value)) -> Value {
    assert_eq!(result.0, 200, "{}", result.1);
    result.1
}

fn g() -> String {
    encode_b64(&[7; 16])
}

fn b64(bytes: &[u8]) -> String {
    encode_b64(bytes)
}

fn ids(people: &[&Client<'_>]) -> Vec<String> {
    people.iter().map(|p| uid(p)).collect()
}

async fn create(who: &Client<'_>) -> (u16, Value) {
    who.post("/api/group/create", &json!({ "group_id": g() })).await
}

async fn ask(who: &Client<'_>, key_package: &str) -> (u16, Value) {
    who.post("/api/group/join", &json!({ "group_id": g(), "key_package": key_package })).await
}

async fn commit(who: &Client<'_>, epoch: u64, data: &str, members: &[&Client<'_>], welcome: Option<(&[&Client<'_>], &str)>) -> (u16, Value) {
    commit_adding(who, epoch, data, members, welcome, &[]).await
}

/// SHA-256 (hex) of a request's KeyPackage, as it is in `/api/group/join` (base64url).
fn kp_hash(key_package: &str) -> String {
    hv_roster::keys::sha256(&hv_roster::keys::decode_b64_vec(key_package).unwrap()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A commit that names the KeyPackages it adds.
async fn commit_adding(
    who: &Client<'_>,
    epoch: u64,
    data: &str,
    members: &[&Client<'_>],
    welcome: Option<(&[&Client<'_>], &str)>,
    added: &[&str],
) -> (u16, Value) {
    let welcome = welcome.map_or(Value::Null, |(to, message)| json!({ "to": ids(to), "message": message }));
    let added: Vec<String> = added.iter().map(|kp| kp_hash(kp)).collect();
    let body = json!({ "group_id": g(), "epoch": epoch, "commit": data, "members": ids(members), "welcome": welcome, "added": added });
    who.post("/api/group/commit", &body).await
}

async fn message(who: &Client<'_>, epoch: u64, data: &str) -> (u16, Value) {
    who.post("/api/group/message", &json!({ "group_id": g(), "epoch": epoch, "message": data })).await
}

/// Owner (1) and members 2, 3 and 4.
async fn world(server: &TestServer) -> (Client<'_>, Client<'_>, Client<'_>, Client<'_>) {
    let owner = server.client(1);
    claim(server, &owner).await;
    let (two, three, four) = (server.client(2), server.client(3), server.client(4));
    for who in [&two, &three, &four] {
        let key = invite(&owner, &[]).await;
        ok(join(who, &key).await).await;
    }
    (owner, two, three, four)
}

/// One and two in the group, at epoch 1.
async fn pair<'a>(one: &Client<'a>, two: &Client<'a>) {
    ok(create(one).await).await;
    ok(ask(two, &b64(b"kp two")).await).await;
    ok(commit_adding(one, 0, &b64(b"add two"), &[one, two], Some((&[two], &b64(b"welcome two"))), &[&b64(b"kp two")]).await).await;
}

#[tokio::test]
async fn members_create_join_commit_and_message() {
    let server = spawn().await;
    let (one, two, three, _) = world(&server).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);

    assert_eq!(ok(create(&one).await).await, json!({ "epoch": 0 }));
    let (status, body) = two.post("/api/group/create", &json!({ "group_id": b64(&[9; 16]) })).await;
    assert_eq!((status, body), (409, json!({ "exists": true, "group_id": g(), "epoch": 0 })));

    let key_package = b64(b"kp two");
    assert_eq!(ok(ask(&two, &key_package).await).await, json!({}));
    let event = wait_for(&mut s1, |e| e["type"] == "group_join").await;
    assert_eq!(event, json!({ "type": "group_join", "group_id": g(), "user": uid(&two), "key_package": key_package, "online": [uid(&one)] }));

    let welcome = b64(b"welcome two");
    let add = b64(b"add two");
    assert_eq!(ok(commit(&one, 0, &add, &[&one, &two], Some((&[&two], &welcome))).await).await, json!({ "epoch": 1, "seq": 1 }));
    let event = wait_for(&mut s2, |e| e["type"] == "group_welcome").await;
    assert_eq!(event, json!({ "type": "group_welcome", "group_id": g(), "epoch": 1, "message": welcome }));

    let sent = ok(message(&two, 1, &b64(b"hello")).await).await;
    assert_eq!(sent["seq"], 2);
    let event = wait_for(&mut s1, |e| e["type"] == "group_entry" && e["entry"]["kind"] == "message").await;
    assert_eq!(event["group_id"], g());
    assert_eq!(event["entry"]["seq"], 2);
    assert_eq!(event["entry"]["sender"], uid(&two));
    assert_eq!(event["entry"]["data"], b64(b"hello"));
    assert_eq!(event["entry"]["at"], sent["at"]);
    // The sender knows its own message, and someone outside the group hears nothing of it.
    assert!(group_events(&mut s2, Duration::from_millis(300)).await.iter().all(|e| e["entry"]["kind"] != "message"));
    assert!(group_events(&mut s3, Duration::from_millis(300)).await.is_empty());

    let backlog = ok(one.get("/api/group?since=0").await).await;
    assert_eq!((backlog["group_id"].as_str(), backlog["epoch"].as_u64()), (Some(g().as_str()), Some(1)));
    assert_eq!(backlog["members"], json!(ids(&[&one, &two])));
    let mut online: Vec<String> = serde_json::from_value(backlog["online"].clone()).unwrap();
    online.sort();
    let mut expected = ids(&[&one, &two]);
    expected.sort();
    assert_eq!(online, expected);
    assert_eq!(backlog["entries"].as_array().unwrap().len(), 2);
    assert_eq!(backlog["more"], false);
}

#[tokio::test]
async fn strangers_and_the_kicked_are_refused() {
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    pair(&one, &two).await;
    let stranger = server.client(9);
    assert_eq!(stranger.get("/api/group?since=0").await.0, 403);
    assert_eq!(ask(&stranger, &b64(b"kp")).await.0, 403);
    ok(one.act(Body::Kick { user: UserId(uid(&two)), reason: String::new(), media: None }).await).await;
    assert_eq!(message(&two, 1, &b64(b"after the kick")).await.0, 403);
    assert_eq!(two.get("/api/group?since=0").await.0, 403);
}

#[tokio::test]
async fn members_must_be_journal_members() {
    let server = spawn().await;
    let (one, ..) = world(&server).await;
    ok(create(&one).await).await;
    let mut members = ids(&[&one]);
    members.push("not-a-member".into());
    let body = json!({ "group_id": g(), "epoch": 0, "commit": b64(b"c"), "members": members, "welcome": null });
    ok(one.post("/api/group/commit", &body).await).await;
    assert_eq!(ok(one.get("/api/group?since=0").await).await["members"], json!(ids(&[&one])));

    let names: Vec<String> = (0..6).map(|n| format!("user-{n}")).collect();
    let body = json!({ "group_id": g(), "epoch": 1, "commit": b64(b"c"), "members": names, "welcome": null });
    let (status, response) = one.post("/api/group/commit", &body).await;
    assert_eq!((status, response["error"].as_str()), (400, Some("Слишком много участников")));
}

#[tokio::test]
async fn message_of_another_epoch_gets_409() {
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    pair(&one, &two).await;
    let (status, body) = message(&two, 0, &b64(b"late")).await;
    assert_eq!((status, body), (409, json!({ "conflict": true, "epoch": 1 })));
    let (status, body) = commit(&one, 0, &b64(b"again"), &[&one, &two], None).await;
    assert_eq!((status, body), (409, json!({ "conflict": true, "epoch": 1 })));
    let other = json!({ "group_id": b64(&[9; 16]), "epoch": 1, "message": b64(b"m") });
    assert_eq!(two.post("/api/group/message", &other).await.0, 404);
}

#[tokio::test]
async fn too_many_messages_get_429() {
    let server = spawn().await;
    let (one, ..) = world(&server).await;
    ok(create(&one).await).await;
    for n in 0..30 {
        ok(message(&one, 0, &b64(format!("m{n}").as_bytes())).await).await;
    }
    assert_eq!(message(&one, 0, &b64(b"one too many")).await.0, 429);
}

#[tokio::test]
async fn oversized_and_malformed_bodies_are_refused() {
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    pair(&one, &two).await;
    // "AAAA…" is canonical base64url, so only the size can be wrong.
    assert_eq!(message(&one, 1, &"A".repeat(60 * 1024)).await.0, 200);
    assert_eq!(message(&one, 1, &"A".repeat(90 * 1024)).await.0, 413);
    assert_eq!(ask(&two, &"A".repeat(17 * 1024)).await.0, 413);
    assert_eq!(message(&one, 1, "not base64!").await.0, 400);
    assert_eq!(one.post("/api/group/message", &json!({ "group_id": "short", "epoch": 1, "message": b64(b"m") })).await.0, 400);
    assert_eq!(one.post("/api/group/create", &json!({ "group_id": b64(&[1; 15]) })).await.0, 400);
}

#[tokio::test]
async fn only_the_owner_resets() {
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    pair(&one, &two).await;
    let mut s2 = listen(&two).await;
    let fresh = b64(&[8; 16]);
    assert_eq!(two.post("/api/group/reset", &json!({ "group_id": fresh })).await.0, 403);
    ok(one.post("/api/group/reset", &json!({ "group_id": fresh })).await).await;
    let event = wait_for(&mut s2, |e| e["type"] == "group_reset").await;
    assert_eq!(event, json!({ "type": "group_reset", "group_id": fresh }));
    let backlog = ok(two.get("/api/group?since=0").await).await;
    assert_eq!((backlog["group_id"].as_str(), backlog["epoch"].as_u64()), (Some(fresh.as_str()), Some(0)));
    assert_eq!(backlog["members"], json!(ids(&[&one])));
}

#[tokio::test]
async fn since_shows_my_welcome_and_the_requests() {
    let server = spawn().await;
    let (one, two, three, _) = world(&server).await;
    pair(&one, &two).await;
    ok(ask(&three, &b64(b"kp three")).await).await;
    let for_two = ok(two.get("/api/group?since=0").await).await;
    assert_eq!(for_two["welcome"], json!({ "epoch": 1, "message": b64(b"welcome two") }));
    assert_eq!(for_two["pending"], json!([{ "user": uid(&three), "key_package": b64(b"kp three") }]));
    assert_eq!(ok(one.get("/api/group?since=0").await).await["welcome"], Value::Null);
    let after = ok(two.get("/api/group?since=1").await).await;
    assert_eq!(after["entries"], json!([]));
    assert_eq!(server.client(9).get("/api/group?since=0").await.0, 403);
}

#[tokio::test]
async fn without_a_group_there_is_nothing_to_join() {
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    let (status, body) = one.get("/api/group?since=0").await;
    assert_eq!((status, body["error"].as_str()), (404, Some("Группы нет")));
    assert_eq!(ask(&two, &b64(b"kp")).await.0, 404);
}

#[tokio::test]
async fn the_group_survives_a_server_restart() {
    let dir = std::env::temp_dir().join(format!("hv-group-api-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    {
        let store = Arc::new(RosterStore::open(Some(&dir)).unwrap());
        let server = spawn_store(LiveKitConfig::dev(), store).await;
        let (one, two, ..) = world(&server).await;
        pair(&one, &two).await;
        ok(message(&two, 1, &b64(b"kept")).await).await;
    }
    let store = Arc::new(RosterStore::open(Some(&dir)).unwrap());
    let server = spawn_store(LiveKitConfig::dev(), store).await;
    let backlog = ok(server.client(2).get("/api/group?since=0").await).await;
    assert_eq!(backlog["epoch"], 1);
    assert_eq!(backlog["entries"][1]["data"], b64(b"kept"));
    let _ = std::fs::remove_dir_all(&dir);
}

async fn signal(who: &Client<'_>, epoch: u64, data: &str) -> (u16, Value) {
    who.post("/api/group/signal", &json!({ "group_id": g(), "epoch": epoch, "message": data })).await
}

#[tokio::test]
async fn a_signal_reaches_online_members_only_and_is_not_kept() {
    let server = spawn().await;
    let (one, two, three, _) = world(&server).await;
    pair(&one, &two).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);
    let before = ok(one.get("/api/group?since=0").await).await["entries"].as_array().unwrap().len();
    assert_eq!(ok(signal(&two, 1, &b64(b"typing")).await).await, json!({}));
    let event = wait_for(&mut s1, |e| e["type"] == "group_signal").await;
    assert_eq!(event, json!({ "type": "group_signal", "group_id": g(), "sender": uid(&two), "message": b64(b"typing") }));
    assert!(group_events(&mut s3, Duration::from_millis(300)).await.is_empty(), "not in the group");
    assert!(group_events(&mut s2, Duration::from_millis(100)).await.is_empty(), "not back to its sender");
    let after = ok(one.get("/api/group?since=0").await).await["entries"].as_array().unwrap().len();
    assert_eq!(after, before, "a signal is not logged");
}

#[tokio::test]
async fn a_signal_from_outside_the_group_or_another_epoch_is_refused() {
    let server = spawn().await;
    let (one, two, three, _) = world(&server).await;
    pair(&one, &two).await;
    assert_eq!(signal(&three, 1, &b64(b"typing")).await.0, 403);
    let (status, body) = signal(&two, 0, &b64(b"typing")).await;
    assert_eq!((status, body), (409, json!({ "conflict": true, "epoch": 1 })));
    let big = b64(&vec![1u8; 2048]);
    assert_eq!(signal(&two, 1, &big).await.0, 413);
    assert_eq!(server.client(9).post("/api/group/signal", &json!({ "group_id": g(), "epoch": 1, "message": b64(b"x") })).await.0, 403);
}

#[tokio::test]
async fn signals_beyond_five_in_five_seconds_are_dropped() {
    // A short burst gets through («hello», a game and «typing» at once); a flood does not.
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    pair(&one, &two).await;
    let mut s1 = listen(&one).await;
    for n in 0..7u8 {
        assert_eq!(ok(signal(&two, 1, &b64(&[n])).await).await, json!({}));
    }
    let seen = group_events(&mut s1, Duration::from_millis(500)).await;
    assert_eq!(seen.len(), 5, "{seen:?}");
    tokio::time::sleep(Duration::from_millis(5100)).await;
    ok(signal(&two, 1, &b64(b"later")).await).await;
    assert_eq!(group_events(&mut s1, Duration::from_millis(500)).await.len(), 1);
}

#[tokio::test]
async fn a_request_goes_only_with_the_commit_that_adds_its_key_package() {
    // Two asked again (a restart) while one was committing with its older KeyPackage: the newer request must stay
    // until a commit adds that one.
    let server = spawn().await;
    let (one, two, ..) = world(&server).await;
    ok(create(&one).await).await;
    let (old, new) = (b64(b"kp two, old"), b64(b"kp two, new"));
    ok(ask(&two, &old).await).await;
    ok(ask(&two, &new).await).await;
    ok(commit_adding(&one, 0, &b64(b"add old"), &[&one, &two], Some((&[&two], &b64(b"welcome old"))), &[&old]).await).await;
    let pending = ok(one.get("/api/group?since=0").await).await["pending"].clone();
    assert_eq!(pending, json!([{ "user": uid(&two), "key_package": new }]), "the newer request is still there");
    ok(commit_adding(&one, 1, &b64(b"add new"), &[&one, &two], Some((&[&two], &b64(b"welcome new"))), &[&new]).await).await;
    assert_eq!(ok(one.get("/api/group?since=0").await).await["pending"], json!([]));
    // A commit that only removes leaves every request alone.
    ok(ask(&two, &b64(b"kp two, again")).await).await;
    ok(commit(&one, 2, &b64(b"remove two"), &[&one], None).await).await;
    assert_eq!(ok(one.get("/api/group?since=0").await).await["pending"].as_array().unwrap().len(), 1);
}

async fn withdraw(who: &Client<'_>) -> (u16, Value) {
    who.post("/api/group/withdraw", &json!({ "group_id": g() })).await
}

#[tokio::test]
async fn a_member_withdraws_its_own_request() {
    // A request left from an earlier run, by someone already in the group with a working leaf: putting it in would
    // push that leaf out. The person takes it back.
    let server = spawn().await;
    let (one, two, three, _) = world(&server).await;
    pair(&one, &two).await;
    ok(ask(&two, &b64(b"kp two, stale")).await).await;
    ok(ask(&three, &b64(b"kp three")).await).await;
    assert_eq!(ok(withdraw(&two).await).await, json!({}));
    let pending = ok(one.get("/api/group?since=0").await).await["pending"].clone();
    assert_eq!(pending, json!([{ "user": uid(&three), "key_package": b64(b"kp three") }]), "only its own request goes");
    assert_eq!(ok(withdraw(&two).await).await, json!({}), "nothing to take back is fine");
    let other = two.post("/api/group/withdraw", &json!({ "group_id": b64(&[9; 16]) })).await;
    assert_eq!(other.0, 404);
}
