mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Client, TestServer, claim, dead_livekit, fake_livekit, invite, join, now, spawn_with, uid};
use futures_util::StreamExt;
use hatavoice_server::LiveKitConfig;
use hatavoice_server::calls::{CallStore, Commit, Created, Joined, KEPT_COMMITS, PRUNE_GRACE};
use hv_roster::keys::encode_b64;
use hv_roster::perms::{ChannelDef, ChannelOverride, Tri};
use hv_roster::{Body, RoleId, UserId};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Stream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const NOT_IN_CALL: &str = "Ты не в этом звонке";

async fn listen(client: &Client<'_>) -> Stream {
    let mut request = format!("ws://{}/api/events", client.server.addr).into_client_request().unwrap();
    let header = client.auth("GET", "/api/events", b"", now());
    request.headers_mut().insert("authorization", header.parse().unwrap());
    let (stream, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    // The server subscribes the stream just after the upgrade; let it finish before anything is sent.
    tokio::time::sleep(Duration::from_millis(50)).await;
    stream
}

/// Reads events until one matches; panics after 12 seconds.
async fn wait_for(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    loop {
        let message = tokio::time::timeout_at(deadline, stream.next()).await.expect("no such event in time");
        match message {
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

/// The call events seen during `wait`.
async fn call_events(stream: &mut Stream, wait: Duration) -> Vec<Value> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, stream.next()).await {
        if let Message::Text(text) = message {
            let event: Value = serde_json::from_str(&text).unwrap();
            if event["type"].as_str().is_some_and(|t| t.starts_with("call_")) {
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

fn b64(bytes: &[u8]) -> String {
    encode_b64(bytes)
}

fn group() -> String {
    b64(&[7; 16])
}

fn ids(people: &[&Client<'_>]) -> Vec<String> {
    people.iter().map(|p| uid(p)).collect()
}

fn user(n: u8) -> String {
    common::id(n).public().user_id().0
}

async fn call_create(who: &Client<'_>) -> (u16, Value) {
    who.post("/api/call/general/create", &json!({ "group_id": group() })).await
}

async fn call_join(who: &Client<'_>, key_package: &str) -> (u16, Value) {
    who.post("/api/call/general/join", &json!({ "group_id": group(), "key_package": key_package })).await
}

async fn call_leave(who: &Client<'_>) -> (u16, Value) {
    who.post("/api/call/general/leave", &json!({ "group_id": group() })).await
}

async fn call_commit(who: &Client<'_>, epoch: u64, commit: &str, members: &[&Client<'_>], welcome: Option<(&[&Client<'_>], &str)>) -> (u16, Value) {
    let welcome = welcome.map_or(Value::Null, |(to, message)| json!({ "to": ids(to), "message": message }));
    let body = json!({ "group_id": group(), "epoch": epoch, "commit": commit, "members": ids(members), "welcome": welcome });
    who.post("/api/call/general/commit", &body).await
}

/// Owner (1), members 2, 3 and 4; channels `general` and `locked` (@все can't connect).
async fn world(server: &TestServer) -> (Client<'_>, Client<'_>, Client<'_>, Client<'_>) {
    let owner = server.client(1);
    claim(server, &owner).await;
    let channel = |id: &str, overrides| Body::ChannelCreate(ChannelDef { id: id.into(), name: id.into(), user_limit: 0, overrides, kind: Default::default() });
    ok(owner.act(channel("general", vec![])).await).await;
    let no_connect = ChannelOverride { role: RoleId::everyone(), view: Tri::Inherit, connect: Tri::Deny, speak: Tri::Inherit };
    ok(owner.act(channel("locked", vec![no_connect])).await).await;
    let (two, three, four) = (server.client(2), server.client(3), server.client(4));
    for who in [&two, &three, &four] {
        let key = invite(&owner, &[]).await;
        ok(join(who, &key).await).await;
    }
    (owner, two, three, four)
}

/// 1, 2 and 3 sit in `general`; 4 is not in any room; 2 is also in `locked`; 1, 5 and 6 are in `club`.
async fn start() -> TestServer {
    let rooms = vec![
        ("general", vec![user(1), user(2), user(3)]),
        ("locked", vec![user(2)]),
        ("club", vec![user(1), user(5), user(6)]),
    ];
    let (livekit, _) = fake_livekit(rooms).await;
    spawn_with(livekit).await
}

#[tokio::test]
async fn first_create_starts_the_call_at_epoch_zero() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    assert_eq!(ok(call_create(&one).await).await, json!({ "epoch": 0 }));
    let call = ok(two.get("/api/call/general").await).await;
    assert_eq!((call["group_id"].as_str(), call["epoch"].as_u64()), (Some(group().as_str()), Some(0)));
    assert_eq!(call["commits"], json!([]));
}

#[tokio::test]
async fn second_create_gets_exists_with_the_group() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    ok(call_create(&one).await).await;
    let other = b64(&[9; 16]);
    let (status, body) = two.post("/api/call/general/create", &json!({ "group_id": other })).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["exists"], true);
    assert_eq!(body["group_id"], group(), "the newcomer must join the first group, not its own");
    assert_eq!(body["epoch"], 0);
}

#[tokio::test]
async fn join_reaches_the_call_members_as_an_event() {
    let server = start().await;
    let (one, two, three, _) = world(&server).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);
    ok(call_create(&one).await).await;
    let key_package = b64(b"a key package");
    assert_eq!(ok(call_join(&two, &key_package).await).await, json!({}));
    let event = wait_for(&mut s1, |e| e["type"] == "call_join").await;
    assert_eq!(event, json!({ "type": "call_join", "channel": "general", "group_id": group(), "user": uid(&two), "key_package": key_package }));
    // The joiner knows already, and someone who isn't in the call has no business with it.
    assert!(call_events(&mut s2, Duration::from_millis(400)).await.is_empty());
    assert!(call_events(&mut s3, Duration::from_millis(400)).await.is_empty());
}

#[tokio::test]
async fn one_commit_per_epoch() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp")).await).await;
    let commit = b64(b"first");
    assert_eq!(ok(call_commit(&one, 0, &commit, &[&one, &two], None).await).await, json!({ "epoch": 1 }));
    let (status, body) = call_commit(&one, 0, &b64(b"second"), &[&one], None).await;
    assert_eq!((status, body), (409, json!({ "conflict": true, "epoch": 1 })));
    let call = ok(one.get("/api/call/general").await).await;
    assert_eq!(call["epoch"], 1);
    assert_eq!(call["commits"], json!([{ "epoch": 0, "commit": commit }]), "the refused commit is not kept");
}

#[tokio::test]
async fn welcome_goes_only_to_its_addressee() {
    let server = start().await;
    let (one, two, three, _) = world(&server).await;
    let (mut s2, mut s3) = (listen(&two).await, listen(&three).await);
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    ok(call_join(&three, &b64(b"kp3")).await).await;
    let welcome = b64(b"welcome for two");
    ok(call_commit(&one, 0, &b64(b"add"), &[&one, &two, &three], Some((&[&two], &welcome))).await).await;
    let event = wait_for(&mut s2, |e| e["type"] == "call_welcome").await;
    assert_eq!(event, json!({ "type": "call_welcome", "channel": "general", "welcome": welcome }));
    let seen = call_events(&mut s3, Duration::from_millis(500)).await;
    assert!(seen.iter().all(|e| e["type"] != "call_welcome"), "{seen:?}");
}

#[tokio::test]
async fn commit_reaches_members_but_not_its_sender() {
    let server = start().await;
    let (one, two, three, _) = world(&server).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    ok(call_join(&three, &b64(b"kp3")).await).await;
    let add = b64(b"add two and three");
    ok(call_commit(&one, 0, &add, &[&one, &two, &three], None).await).await;
    for stream in [&mut s2, &mut s3] {
        let event = wait_for(stream, |e| e["type"] == "call_commit").await;
        assert_eq!(event, json!({ "type": "call_commit", "channel": "general", "group_id": group(), "epoch": 0, "commit": add }));
    }
    // Two removes three; the sender applies its own commit.
    let remove = b64(b"remove three");
    ok(call_commit(&two, 1, &remove, &[&one, &two], None).await).await;
    let event = wait_for(&mut s1, |e| e["type"] == "call_commit" && e["epoch"] == 1).await;
    assert_eq!(event["commit"], remove);
    let seen = call_events(&mut s1, Duration::from_millis(400)).await;
    assert!(seen.is_empty(), "the sender of the first commit got something: {seen:?}");
    assert!(call_events(&mut s2, Duration::from_millis(400)).await.is_empty(), "the sender of the second commit");
}

#[tokio::test]
async fn a_removed_member_gets_the_commit_that_removed_it_and_nothing_after() {
    let server = start().await;
    let (one, two, three, _) = world(&server).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    ok(call_join(&three, &b64(b"kp3")).await).await;
    ok(call_commit(&one, 0, &b64(b"add two and three"), &[&one, &two, &three], None).await).await;
    for stream in [&mut s2, &mut s3] {
        wait_for(stream, |e| e["type"] == "call_commit" && e["epoch"] == 0).await;
    }

    // One removes three, who may still sit in the room (LiveKit reconnected it, the journal changed for a
    // moment). As in MLS, three gets the commit: all it can learn from it is that it was removed, and so it
    // knows to join anew instead of keeping keys nobody uses.
    let remove = b64(b"remove three");
    ok(call_commit(&one, 1, &remove, &[&one, &two], None).await).await;
    for stream in [&mut s2, &mut s3] {
        let event = wait_for(stream, |e| e["type"] == "call_commit").await;
        assert_eq!(event, json!({ "type": "call_commit", "channel": "general", "group_id": group(), "epoch": 1, "commit": remove }));
    }

    // After that three hears nothing of the group.
    ok(call_commit(&two, 2, &b64(b"next"), &[&one, &two], None).await).await;
    wait_for(&mut s1, |e| e["type"] == "call_commit" && e["epoch"] == 2).await;
    let seen = call_events(&mut s3, Duration::from_millis(400)).await;
    assert!(seen.is_empty(), "the removed member got {seen:?}");
}

#[tokio::test]
async fn a_member_who_leaves_is_dropped_and_an_empty_call_is_forgotten() {
    let server = start().await;
    let (one, two, three, four) = world(&server).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    ok(call_commit(&one, 0, &b64(b"add two"), &[&one, &two], None).await).await;
    ok(call_join(&three, &b64(b"kp3")).await).await;

    // Two leaves: it is out of the group, so it can no longer commit, and the call goes on.
    assert_eq!(ok(call_leave(&two).await).await, json!({}));
    assert_eq!(call_commit(&two, 1, &b64(b"c"), &[&one, &two], None).await.0, 403);
    assert_eq!(ok(one.get("/api/call/general").await).await["epoch"], 1);
    // Leaving needs no seat in the room (LiveKit may have dropped the leaver already): 4 sits in none.
    assert_eq!(ok(call_leave(&four).await).await, json!({}));
    // But it needs the journal's right to the channel, like every call route.
    assert_eq!(server.client(9).post("/api/call/general/leave", &json!({})).await.0, 403);
    assert_eq!(two.post("/api/call/locked/leave", &json!({})).await.0, 403);

    // The last member leaves: nobody holds the group, the call is forgotten at once, not after the
    // grace, and the one who was waiting to join starts over.
    ok(call_leave(&one).await).await;
    let event = wait_for(&mut s3, |e| e["type"] == "call_reset").await;
    assert_eq!(event, json!({ "type": "call_reset", "channel": "general", "group_id": group() }));
    for (name, stream) in [("1", &mut s1), ("2", &mut s2)] {
        let seen = call_events(stream, Duration::from_millis(300)).await;
        assert!(seen.iter().all(|e| e["type"] != "call_reset"), "{name} left and knows it: {seen:?}");
    }
    assert_eq!(call_leave(&one).await.0, 404, "there is no call to leave");
    assert_eq!(ok(call_create(&three).await).await, json!({ "epoch": 0 }), "the next one starts afresh");
}

#[tokio::test]
async fn a_listed_member_who_joins_again_is_dropped_first() {
    let server = start().await;
    let (one, two, three, _) = world(&server).await;
    let (mut s1, mut s2, mut s3) = (listen(&one).await, listen(&two).await, listen(&three).await);
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    ok(call_commit(&one, 0, &b64(b"add two"), &[&one, &two], None).await).await;

    // Two comes back without its group (it restarted): asking to join says it holds none any more.
    let again = b64(b"kp2 again");
    ok(call_join(&two, &again).await).await;
    wait_for(&mut s1, |e| e["type"] == "call_join" && e["key_package"] == again).await;
    assert_eq!(call_commit(&two, 1, &b64(b"c"), &[&one, &two], None).await.0, 403, "two is out of the group");
    // A commit that adds it again puts it back.
    ok(call_commit(&one, 1, &b64(b"add two again"), &[&one, &two], None).await).await;
    ok(call_commit(&two, 2, &b64(b"c"), &[&one, &two], None).await).await;

    // Both come back: once the last listed member asks to join, nobody holds the group. The call is
    // forgotten, that joiner is told so (404) and the others waiting start over.
    ok(call_join(&three, &b64(b"kp3")).await).await;
    ok(call_join(&one, &b64(b"kp1 again")).await).await;
    let (status, body) = call_join(&two, &b64(b"kp2 once more")).await;
    assert_eq!((status, body["error"].as_str()), (404, Some("Звонка нет")));
    for stream in [&mut s1, &mut s3] {
        let event = wait_for(stream, |e| e["type"] == "call_reset").await;
        assert_eq!(event, json!({ "type": "call_reset", "channel": "general", "group_id": group() }));
    }
    let seen = call_events(&mut s2, Duration::from_millis(300)).await;
    assert!(seen.iter().all(|e| e["type"] != "call_reset"), "two has its answer: {seen:?}");
    assert_eq!(ok(call_create(&two).await).await, json!({ "epoch": 0 }));

    // The same in the store: the only member asking to join leaves nothing behind.
    let store = CallStore::default();
    let (u1, u3, t0) = (UserId("u1".into()), UserId("u3".into()), Instant::now());
    store.create("general", group(), u1.clone(), t0);
    assert_eq!(store.join("general", &u3, &group()), Some(Joined::Queued { tell: vec![u1.clone()] }));
    assert_eq!(store.join("general", &u1, &group()), Some(Joined::Forgotten { waiting: vec![u3] }));
    assert!(store.since("general", 0).is_none());
}

#[tokio::test]
async fn a_late_leave_from_an_earlier_call_leaves_the_next_one_alone() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    let (mut s1, mut s2) = (listen(&one).await, listen(&two).await);
    // One was alone in the first call and left it: it is forgotten at once.
    ok(call_create(&one).await).await;
    ok(call_leave(&one).await).await;
    // Back in the channel, one starts the next call, and two asks to join it.
    let next = b64(&[8; 16]);
    ok(one.post("/api/call/general/create", &json!({ "group_id": next })).await).await;
    ok(two.post("/api/call/general/join", &json!({ "group_id": next, "key_package": b64(b"kp2") })).await).await;

    // Only now does the relay get the first leave again (it was still on its way when one came back). It is
    // about the first call: the next one goes on, with one in it.
    assert_eq!(ok(call_leave(&one).await).await, json!({}));
    assert_eq!(ok(two.get("/api/call/general").await).await["group_id"], next);
    let add = json!({ "group_id": next, "epoch": 0, "commit": b64(b"add two"), "members": ids(&[&one, &two]), "welcome": null });
    ok(one.post("/api/call/general/commit", &add).await).await;
    for (name, stream) in [("1", &mut s1), ("2", &mut s2)] {
        let seen = call_events(stream, Duration::from_millis(300)).await;
        assert!(seen.iter().all(|e| e["type"] != "call_reset"), "{name} was told to start over: {seen:?}");
    }
}

#[tokio::test]
async fn a_join_or_commit_for_another_group_changes_nothing() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    let mut s1 = listen(&one).await;
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    wait_for(&mut s1, |e| e["type"] == "call_join").await;
    ok(call_commit(&one, 0, &b64(b"add two"), &[&one, &two], None).await).await;

    let other = b64(&[8; 16]);
    // Asking into a group that is not the call's: no such call. Two is not queued, nor taken off the list.
    let join = json!({ "group_id": other, "key_package": b64(b"kp2 again") });
    let (status, body) = two.post("/api/call/general/join", &join).await;
    assert_eq!((status, body["error"].as_str()), (404, Some("Звонка нет")));
    // A commit for that group is not this call's either.
    let stray = json!({ "group_id": other, "epoch": 1, "commit": b64(b"c"), "members": ids(&[&one, &two]), "welcome": null });
    assert_eq!(two.post("/api/call/general/commit", &stray).await.0, 404);
    assert_eq!(ok(one.get("/api/call/general").await).await["epoch"], 1);

    // Two is still in the call's own group, and nobody heard of the stray join.
    ok(call_commit(&two, 1, &b64(b"c"), &[&one, &two], None).await).await;
    let seen = call_events(&mut s1, Duration::from_millis(300)).await;
    assert!(seen.iter().all(|e| e["type"] != "call_join"), "{seen:?}");
}

#[tokio::test]
async fn people_outside_the_room_or_without_connect_are_refused() {
    let server = start().await;
    let (one, two, three, four) = world(&server).await;

    // 4 belongs to the server but sits in no room.
    let (status, body) = call_create(&four).await;
    assert_eq!((status, body["error"].as_str()), (403, Some(NOT_IN_CALL)));
    ok(call_create(&one).await).await;
    assert_eq!(call_join(&four, &b64(b"kp")).await.0, 403);
    assert_eq!(four.get("/api/call/general").await.0, 403);
    assert_eq!(call_commit(&four, 0, &b64(b"c"), &[&four], None).await.0, 403);

    // 2 is in the `locked` room, but the journal gives @все no right to connect there.
    let kp = json!({ "key_package": b64(b"kp") });
    assert_eq!(two.post("/api/call/locked/create", &json!({ "group_id": group() })).await.0, 403);
    assert_eq!(two.post("/api/call/locked/join", &kp).await.0, 403);
    assert_eq!(two.get("/api/call/locked").await.0, 403);

    // Strangers and channels that don't exist.
    assert_eq!(server.client(9).post("/api/call/general/create", &json!({ "group_id": group() })).await.0, 403);
    assert_eq!(one.post("/api/call/nowhere/create", &json!({ "group_id": group() })).await.0, 403);

    // 3 is in the room and may connect, but is not in the group: it can't commit, whatever it lists.
    let (status, body) = call_commit(&three, 0, &b64(b"hijack"), &[&three], None).await;
    assert_eq!((status, body["error"].as_str()), (403, Some(NOT_IN_CALL)));
    // And a member can't commit itself out of the list it sends.
    assert_eq!(call_commit(&one, 0, &b64(b"c"), &[&two], None).await.0, 403);
    let call = ok(one.get("/api/call/general").await).await;
    assert_eq!((call["epoch"].as_u64(), call["commits"].as_array().map(Vec::len)), (Some(0), Some(0)));
}

#[tokio::test]
async fn without_a_call_there_is_nothing_to_join_or_fetch() {
    let server = start().await;
    let (one, ..) = world(&server).await;
    let (status, body) = one.get("/api/call/general").await;
    assert_eq!((status, body["error"].as_str()), (404, Some("Звонка нет")));
    assert_eq!(call_join(&one, &b64(b"kp")).await.0, 404);
    assert_eq!(call_commit(&one, 0, &b64(b"c"), &[&one], None).await.0, 404);
}

#[tokio::test]
async fn since_returns_the_missed_commits() {
    let server = start().await;
    let (one, two, three, _) = world(&server).await;
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp2")).await).await;
    ok(call_join(&three, &b64(b"kp3")).await).await;
    let everyone = [&one, &two, &three];
    for epoch in 0..3u64 {
        ok(call_commit(&one, epoch, &b64(format!("commit {epoch}").as_bytes()), &everyone, None).await).await;
    }
    let epochs = |call: &Value| -> Vec<u64> { call["commits"].as_array().unwrap().iter().map(|c| c["epoch"].as_u64().unwrap()).collect() };
    let call = ok(three.get("/api/call/general?since=1").await).await;
    assert_eq!(call["epoch"], 3);
    assert_eq!(call["group_id"], group());
    assert_eq!(epochs(&call), [1, 2]);
    assert_eq!(call["commits"][0]["commit"], b64(b"commit 1"));
    assert_eq!(epochs(&ok(three.get("/api/call/general").await).await), [0, 1, 2], "no `since` means everything kept");
    assert_eq!(epochs(&ok(three.get("/api/call/general?since=3").await).await), Vec::<u64>::new());
}

#[test]
fn only_the_last_commits_are_kept() {
    let store = CallStore::default();
    let (a, now) = (UserId("a".into()), Instant::now());
    store.create("general", group(), a.clone(), now);
    let total = KEPT_COMMITS as u64 + 6;
    for epoch in 0..total {
        let commit = Commit { group: group(), epoch, data: format!("c{epoch}"), members: vec![a.clone()] };
        assert_eq!(store.commit("general", &a, commit, now).map(|accepted| accepted.epoch), Ok(epoch + 1));
    }
    let backlog = store.since("general", 0).unwrap();
    assert_eq!(backlog.epoch, total);
    assert_eq!(backlog.commits.len(), KEPT_COMMITS);
    assert_eq!(backlog.commits.first().map(|c| c.0), Some(6), "the oldest were dropped");
    assert_eq!(backlog.commits.last().map(|c| c.0), Some(total - 1));
}

#[test]
fn empty_rooms_forget_their_call_after_the_grace() {
    let store = CallStore::default();
    let (u1, u2, u3) = (UserId("u1".into()), UserId("u2".into()), UserId("u3".into()));
    let t0 = Instant::now();
    assert_eq!(store.create("general", group(), u1.clone(), t0), Created::Started);
    store.join("general", &u2, &group());

    // Someone of the group is in the room: it stays however late it is.
    let with_member = HashMap::from([("general".to_string(), vec![u1.0.clone(), u3.0.clone()])]);
    assert!(store.prune(&with_member, t0 + PRUNE_GRACE * 10).is_empty());

    // A waiting joiner is not in the group. Before the grace nothing goes, after it the call does,
    // and everyone it concerns (the group and those waiting) is named.
    let only_waiting = HashMap::from([("general".to_string(), vec![u2.0.clone()])]);
    assert!(store.prune(&only_waiting, t0 + PRUNE_GRACE - Duration::from_millis(1)).is_empty());
    assert_eq!(store.prune(&only_waiting, t0 + PRUNE_GRACE), vec![("general".to_string(), group(), vec![u1.clone(), u2.clone()])]);
    assert!(store.prune(&HashMap::new(), t0 + PRUNE_GRACE * 2).is_empty(), "forgotten once");
    assert!(store.since("general", 0).is_none());
    assert_eq!(store.create("general", group(), u3.clone(), t0 + PRUNE_GRACE * 2), Created::Started, "the next one starts afresh");

    // A change restarts the wait: a commit's new member may not show in the room yet.
    let t1 = t0 + PRUNE_GRACE * 3;
    let commit = Commit { group: group(), epoch: 0, data: "c".into(), members: vec![u3.clone(), u1.clone()] };
    store.commit("general", &u3, commit, t1).unwrap();
    assert!(store.prune(&HashMap::new(), t1 + PRUNE_GRACE - Duration::from_millis(1)).is_empty());
    assert_eq!(store.prune(&HashMap::new(), t1 + PRUNE_GRACE), vec![("general".to_string(), group(), vec![u3, u1])]);
}

#[test]
fn a_call_changed_after_the_poll_is_kept() {
    let store = CallStore::default();
    let u1 = UserId("u1".into());
    let polled = Instant::now();
    // The watcher polls LiveKit, then spends seconds on moderation; a call made meanwhile is newer
    // than the snapshot, so the snapshot (which cannot show its people) must not condemn it.
    let created = polled + Duration::from_secs(1);
    store.create("general", group(), u1.clone(), created);
    assert!(store.prune(&HashMap::new(), polled).is_empty());
    // Judged by the next poll, with nobody in the room, it goes after the grace.
    assert!(store.prune(&HashMap::new(), created + PRUNE_GRACE - Duration::from_millis(1)).is_empty());
    assert_eq!(store.prune(&HashMap::new(), created + PRUNE_GRACE), vec![("general".to_string(), group(), vec![u1])]);
}

#[tokio::test]
async fn oversized_bodies_are_refused() {
    let server = start().await;
    let (one, ..) = world(&server).await;
    ok(call_create(&one).await).await;
    // "AAAA…" is canonical base64url, so only the size can be wrong.
    ok(call_commit(&one, 0, &"A".repeat(200 * 1024), &[&one], None).await).await;
    let (status, _) = call_commit(&one, 1, &"A".repeat(300 * 1024), &[&one], None).await;
    assert_eq!(status, 413);
    assert_eq!(ok(one.get("/api/call/general").await).await["epoch"], 1, "the big one was not taken");
}

#[tokio::test]
async fn oversized_join_is_refused() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    ok(call_create(&one).await).await;
    // A key package is a few KB, and joining is open to everyone in the room: a smaller limit than a commit's.
    ok(call_join(&two, &"A".repeat(15 * 1024)).await).await;
    let (status, _) = call_join(&two, &"A".repeat(17 * 1024)).await;
    assert_eq!(status, 413);
}

/// Owner (1) and admins 5 and 6 may connect to `club`; @все may not. 2 and 3 are plain members.
async fn club(server: &TestServer) -> (Client<'_>, Client<'_>, Client<'_>, Client<'_>, Client<'_>) {
    let (one, two, three, _) = world(server).await;
    let admin = RoleId::parse("admin").unwrap();
    let overrides = vec![
        ChannelOverride { role: RoleId::everyone(), view: Tri::Inherit, connect: Tri::Deny, speak: Tri::Inherit },
        ChannelOverride { role: admin, view: Tri::Inherit, connect: Tri::Allow, speak: Tri::Inherit },
    ];
    ok(one.act(Body::ChannelCreate(ChannelDef { id: "club".into(), name: "club".into(), user_limit: 0, overrides, kind: Default::default() })).await).await;
    let (five, six) = (server.client(5), server.client(6));
    for who in [&five, &six] {
        let key = invite(&one, &["admin"]).await;
        ok(join(who, &key).await).await;
    }
    (one, two, three, five, six)
}

#[tokio::test]
async fn routing_skips_people_without_access() {
    let server = start().await;
    let (one, two, three, five, six) = club(&server).await;
    let (mut s2, mut s3, mut s5, mut s6) = (listen(&two).await, listen(&three).await, listen(&five).await, listen(&six).await);
    ok(one.post("/api/call/club/create", &json!({ "group_id": group() })).await).await;

    // One names 5 (may connect), 2 (a member who may not), a stranger to the journal and 3 (may not).
    // Only 5 is let in: the others get nothing and do not become members of the call.
    let commit = b64(b"add five");
    let welcome = b64(b"welcome");
    let ghost = "not-a-user-of-this-server".to_string();
    let body = json!({
        "group_id": group(),
        "epoch": 0,
        "commit": commit,
        "members": [uid(&one), uid(&five), uid(&two), ghost, uid(&three)],
        "welcome": { "to": [uid(&five), uid(&two), uid(&three)], "message": welcome },
    });
    ok(one.post("/api/call/club/commit", &body).await).await;
    let event = wait_for(&mut s5, |e| e["type"] == "call_commit").await;
    assert_eq!(event["commit"], commit);
    wait_for(&mut s5, |e| e["type"] == "call_welcome").await;
    for (name, stream) in [("2", &mut s2), ("3", &mut s3)] {
        let seen = call_events(stream, Duration::from_millis(400)).await;
        assert!(seen.is_empty(), "{name} has no access to the channel and got {seen:?}");
    }

    // A newcomer's key package goes to the members of the call: 1 and 5, not to 2 or 3.
    let key_package = b64(b"kp of six");
    ok(six.post("/api/call/club/join", &json!({ "group_id": group(), "key_package": key_package })).await).await;
    wait_for(&mut s5, |e| e["type"] == "call_join").await;
    assert!(call_events(&mut s6, Duration::from_millis(300)).await.is_empty());
    for (name, stream) in [("2", &mut s2), ("3", &mut s3)] {
        let seen = call_events(stream, Duration::from_millis(400)).await;
        assert!(seen.is_empty(), "{name} became a member of the call: {seen:?}");
    }
}

#[tokio::test]
async fn a_member_list_longer_than_the_server_is_refused() {
    let server = start().await;
    let (one, ..) = world(&server).await;
    ok(call_create(&one).await).await;
    // The journal has four members; five names cannot all be members.
    let names: Vec<String> = (0..5).map(|n| format!("user-{n}")).collect();
    let body = json!({ "group_id": group(), "epoch": 0, "commit": b64(b"c"), "members": names, "welcome": null });
    let (status, response) = one.post("/api/call/general/commit", &body).await;
    assert_eq!((status, response["error"].as_str()), (400, Some("Слишком много участников")));
    assert_eq!(ok(one.get("/api/call/general").await).await["epoch"], 0);
    // As many names as there are members is fine, whoever they are.
    let mut members = ids(&[&one]);
    members.extend((0..3).map(|n| format!("user-{n}")));
    let body = json!({ "group_id": group(), "epoch": 0, "commit": b64(b"c"), "members": members, "welcome": null });
    ok(one.post("/api/call/general/commit", &body).await).await;
}

#[tokio::test]
async fn malformed_bodies_are_refused() {
    let server = start().await;
    let (one, two, ..) = world(&server).await;
    for group_id in [b64(&[1; 15]), b64(&[1; 17]), "not base64!".into(), String::new()] {
        let (status, _) = one.post("/api/call/general/create", &json!({ "group_id": group_id })).await;
        assert_eq!(status, 400, "group {group_id:?}");
    }
    assert_eq!(one.post("/api/call/general/create", &json!("nonsense")).await.0, 400);
    ok(call_create(&one).await).await;
    for key_package in ["", "not base64!"] {
        assert_eq!(call_join(&two, key_package).await.0, 400, "key package {key_package:?}");
    }
    assert_eq!(call_commit(&one, 0, "", &[&one], None).await.0, 400);
    assert_eq!(call_commit(&one, 0, "not base64!", &[&one], None).await.0, 400);
    assert_eq!(call_commit(&one, 0, &b64(b"c"), &[&one], Some((&[&two], "not base64!"))).await.0, 400);
    assert_eq!(one.post("/api/call/general/commit", &json!({ "group_id": group(), "epoch": 0, "commit": b64(b"c") })).await.0, 400, "members are missing");
    // Every request after `create` names the group it is about.
    let unnamed = json!({ "epoch": 0, "commit": b64(b"c"), "members": ids(&[&one]), "welcome": null });
    assert_eq!(one.post("/api/call/general/commit", &unnamed).await.0, 400, "commit without a group");
    assert_eq!(two.post("/api/call/general/join", &json!({ "key_package": b64(b"kp") })).await.0, 400, "join without a group");
    assert_eq!(one.post("/api/call/general/leave", &json!({})).await.0, 400, "leave without a group");
    assert_eq!(one.post("/api/call/general/leave", &json!({ "group_id": b64(&[1; 15]) })).await.0, 400, "a group of the wrong size");
    let call = ok(one.get("/api/call/general").await).await;
    assert_eq!(call["epoch"], 0, "nothing of that was accepted");
}

/// A LiveKit with one room, `general`, that the test can empty or silence while it runs.
struct Room {
    people: Mutex<Vec<String>>,
    failing: AtomicBool,
}

async fn switchable_livekit(people: Vec<String>) -> (LiveKitConfig, Arc<Room>) {
    use axum::Json;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::post;
    let room = Arc::new(Room { people: Mutex::new(people), failing: AtomicBool::new(false) });
    let rooms = {
        let room = room.clone();
        post(move || {
            let room = room.clone();
            async move {
                if room.failing.load(Ordering::Relaxed) {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
                let count = room.people.lock().unwrap().len();
                Json(json!({ "rooms": [{ "name": "general", "num_participants": count }] })).into_response()
            }
        })
    };
    let participants = {
        let room = room.clone();
        post(move || {
            let room = room.clone();
            async move {
                if room.failing.load(Ordering::Relaxed) {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
                let people: Vec<Value> = room.people.lock().unwrap().iter().map(|p| json!({ "identity": p, "name": "" })).collect();
                Json(json!({ "participants": people })).into_response()
            }
        })
    };
    let router = axum::Router::new()
        .route("/twirp/livekit.RoomService/ListRooms", rooms)
        .route("/twirp/livekit.RoomService/ListParticipants", participants);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (LiveKitConfig { internal_url: format!("http://{addr}"), ..LiveKitConfig::dev() }, room)
}

#[tokio::test]
async fn a_room_that_empties_resets_its_call_but_a_silent_livekit_does_not() {
    let (livekit, room) = switchable_livekit(vec![user(1), user(2), user(3)]).await;
    let server = spawn_with(livekit).await;
    let (one, two, three, _) = world(&server).await;
    let (mut s1, mut s2) = (listen(&one).await, listen(&two).await);
    ok(call_create(&one).await).await;
    ok(call_join(&two, &b64(b"kp")).await).await;

    // LiveKit stops answering for longer than the grace and a few polls. Not hearing from it is not
    // the same as the room being empty, and the people are still talking: the call stays.
    room.failing.store(true, Ordering::Relaxed);
    assert_eq!(call_join(&three, &b64(b"kp3")).await.0, 403, "nobody can be shown to be in the room");
    let seen = call_events(&mut s2, Duration::from_secs(PRUNE_GRACE.as_secs() + 3)).await;
    assert!(seen.is_empty(), "the call was reset while LiveKit was silent: {seen:?}");
    assert_eq!(one.get("/api/call/general").await.0, 200);

    // The room really empties: both the member and the one waiting are told to start over.
    room.failing.store(false, Ordering::Relaxed);
    room.people.lock().unwrap().clear();
    for stream in [&mut s1, &mut s2] {
        let event = wait_for(stream, |e| e["type"] == "call_reset").await;
        assert_eq!(event, json!({ "type": "call_reset", "channel": "general", "group_id": group() }));
    }
    assert_eq!(one.get("/api/call/general").await.0, 403, "and the call is gone");
}

#[tokio::test]
async fn a_silent_livekit_is_not_an_empty_one() {
    let (livekit, _) = fake_livekit(vec![("general", vec![user(1)])]).await;
    let answer = hatavoice_server::occupancy::snapshot(&livekit).await;
    assert!(answer.complete);
    assert_eq!(answer.rooms["general"].len(), 1);
    let dead = hatavoice_server::occupancy::snapshot(&dead_livekit().await).await;
    assert!(!dead.complete);
    assert!(dead.rooms.is_empty());
    assert!(!hatavoice_server::occupancy::in_room(&livekit, "general", &user(2)).await);
    assert!(hatavoice_server::occupancy::in_room(&livekit, "general", &user(1)).await);
    assert!(!hatavoice_server::occupancy::in_room(&dead_livekit().await, "general", &user(1)).await);
}
