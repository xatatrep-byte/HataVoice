mod common;

use std::time::Duration;

use common::{Client, TestServer, claim, invite, join, now, spawn, uid};
use futures_util::StreamExt;
use hv_roster::keys::encode_b64;
use hv_roster::perms::{ChannelDef, ChannelKind, ChannelOverride, Tri};
use hv_roster::{Body, RoleId};
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

/// The events of the kind `kind` seen during `wait`.
async fn events(stream: &mut Stream, kind: &str, wait: Duration) -> Vec<Value> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, stream.next()).await {
        if let Message::Text(text) = message {
            let event: Value = serde_json::from_str(&text).unwrap();
            if event["type"] == kind {
                seen.push(event);
            }
        }
    }
    seen
}

fn g() -> String {
    encode_b64(&[7; 16])
}

fn b64(bytes: &[u8]) -> String {
    encode_b64(bytes)
}

/// Owner (1), an admin (2) and two members (3, 4); «staff» is closed to everyone but admins.
async fn world(server: &TestServer) -> (Client<'_>, Client<'_>, Client<'_>, Client<'_>) {
    let owner = server.client(1);
    claim(server, &owner).await;
    let (two, three, four) = (server.client(2), server.client(3), server.client(4));
    for (who, roles) in [(&two, &["admin"][..]), (&three, &[][..]), (&four, &[][..])] {
        let key = invite(&owner, roles).await;
        assert_eq!(join(who, &key).await.0, 200);
    }
    let overrides = vec![
        ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit },
        ChannelOverride { role: RoleId::parse("admin").unwrap(), view: Tri::Allow, connect: Tri::Inherit, speak: Tri::Inherit },
    ];
    let staff = ChannelDef { id: "staff".into(), name: "Стафф".into(), user_limit: 0, overrides, kind: ChannelKind::Text };
    assert_eq!(owner.act(Body::ChannelCreate(staff)).await.0, 200);
    (owner, two, three, four)
}

fn dm(a: &Client<'_>, b: &Client<'_>) -> String {
    let (a, b) = (uid(a), uid(b));
    if a < b { format!("dm.{a}.{b}") } else { format!("dm.{b}.{a}") }
}

#[tokio::test]
async fn direct_messages_are_for_the_two_alone() {
    let server = spawn().await;
    let (_owner, two, three, four) = world(&server).await;
    let room = dm(&two, &three);
    let (mut s3, mut s4) = (listen(&three).await, listen(&four).await);

    assert_eq!(two.post("/api/group/create", &json!({ "group_id": g(), "room": room })).await.0, 200);
    assert_eq!(events(&mut s3, "room_opened", Duration::from_millis(500)).await, vec![json!({ "type": "room_opened", "room": room })]);
    assert_eq!(three.get("/api/rooms").await.1, json!({ "rooms": [room] }));
    assert_eq!(four.get("/api/rooms").await.1, json!({ "rooms": [] }));

    assert_eq!(three.post("/api/group/join", &json!({ "group_id": g(), "key_package": b64(b"kp three"), "room": room })).await.0, 200);
    let added = hv_roster::keys::sha256(b"kp three").iter().map(|b| format!("{b:02x}")).collect::<String>();
    let members = json!([uid(&two), uid(&three), uid(&four)]);
    let commit = json!({ "group_id": g(), "epoch": 0, "commit": b64(b"add"), "members": members, "welcome": { "to": [uid(&three), uid(&four)], "message": b64(b"w") }, "added": [added], "room": room });
    assert_eq!(two.post("/api/group/commit", &commit).await.0, 200);
    let backlog = three.get(&format!("/api/group?since=0&room={room}")).await.1;
    assert_eq!(backlog["members"], json!([uid(&two), uid(&three)]), "a third one is left out of the members");

    assert_eq!(three.post("/api/group/message", &json!({ "group_id": g(), "epoch": 1, "message": b64(b"hi"), "room": room })).await.0, 200);
    for (who, path) in [(&four, format!("/api/group?since=0&room={room}"))] {
        assert_eq!(who.get(&path).await.0, 403, "someone else may not read it");
    }
    assert_eq!(four.post("/api/group/join", &json!({ "group_id": g(), "key_package": b64(b"kp four"), "room": room })).await.0, 403);
    assert!(events(&mut s4, "group_entry", Duration::from_millis(300)).await.is_empty());
    assert!(events(&mut s4, "group_welcome", Duration::from_millis(100)).await.is_empty(), "no welcome for one who was let in by mistake");
    // The server's own group is another one: nothing of the room shows in it.
    assert_eq!(two.get("/api/group?since=0").await.0, 404);
}

#[tokio::test]
async fn a_closed_channel_has_a_room_for_those_who_may_see_it() {
    let server = spawn().await;
    let (owner, two, three, _four) = world(&server).await;
    let mut s1 = listen(&owner).await;
    assert_eq!(two.post("/api/group/create", &json!({ "group_id": g(), "room": "ch.staff" })).await.0, 200);
    assert_eq!(three.post("/api/group/create", &json!({ "group_id": g(), "room": "ch.staff" })).await.0, 403, "no view on the channel");
    assert_eq!(three.get("/api/group?room=ch.staff").await.0, 403);
    assert_eq!(owner.post("/api/group/join", &json!({ "group_id": g(), "key_package": b64(b"kp owner"), "room": "ch.staff" })).await.0, 200);
    assert_eq!(two.get("/api/group?since=0&room=ch.staff").await.1["pending"][0]["user"], uid(&owner));
    for bad in ["ch.general-but-open", "ch.Staff", "dm.x.y", "../group"] {
        assert_eq!(two.get(&format!("/api/group?room={bad}")).await.0, if bad.starts_with("ch.g") { 403 } else { 400 }, "{bad}");
    }
    // Two's own events of the room are tagged with it, and a reset is the owner's.
    let joined = events(&mut s1, "group_join", Duration::from_millis(200)).await;
    assert!(joined.is_empty(), "the owner asked, so the owner is not told");
    assert_eq!(two.post("/api/group/reset", &json!({ "group_id": g(), "room": "ch.staff" })).await.0, 403);
    assert_eq!(owner.post("/api/group/reset", &json!({ "group_id": g(), "room": "ch.staff" })).await.0, 200);
    let reset = events(&mut s1, "group_reset", Duration::from_millis(500)).await;
    assert_eq!(reset, vec![json!({ "type": "group_reset", "group_id": g(), "room": "ch.staff" })]);
}
