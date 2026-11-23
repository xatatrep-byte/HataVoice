mod common;

use std::time::Duration;

use common::{Client, claim, fake_livekit, invite, join, now, spawn_with, uid};
use futures_util::StreamExt;
use hv_roster::perms::{ChannelDef, ChannelOverride, Tri};
use hv_roster::{Body, MediaRef, RoleId};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Stream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(client: &Client<'_>) -> Result<Stream, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://{}/api/events", client.server.addr).into_client_request().unwrap();
    let header = client.auth("GET", "/api/events", b"", now());
    request.headers_mut().insert("authorization", header.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.map(|(stream, _)| stream)
}

/// Reads events until one matches; panics after 6 seconds.
async fn wait_for(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
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

/// Every event seen during `wait`.
async fn collect(stream: &mut Stream, wait: Duration) -> Vec<Value> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, stream.next()).await {
        if let Message::Text(text) = message {
            seen.push(serde_json::from_str(&text).unwrap());
        }
    }
    seen
}

async fn ok(result: (u16, Value)) -> Value {
    assert!(result.0 == 200 || result.0 == 204, "{} {}", result.0, result.1);
    result.1
}

fn channel(id: &str, overrides: Vec<ChannelOverride>) -> Body {
    Body::ChannelCreate(ChannelDef { id: id.into(), name: id.into(), user_limit: 0, overrides, kind: Default::default() })
}

/// Owner (1), admin (2), member (4), neighbour (5); channels general, games and a hidden staff.
async fn world(server: &common::TestServer) -> (Client<'_>, Client<'_>, Client<'_>, Client<'_>) {
    let owner = server.client(1);
    claim(server, &owner).await;
    ok(owner.act(channel("general", vec![])).await).await;
    ok(owner.act(channel("games", vec![])).await).await;
    let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
    ok(owner.act(channel("staff", vec![hidden])).await).await;
    let (admin, member, neighbour) = (server.client(2), server.client(4), server.client(5));
    for (who, roles) in [(&admin, vec!["admin"]), (&member, vec![]), (&neighbour, vec![])] {
        let key = invite(&owner, &roles).await;
        ok(join(who, &key).await).await;
    }
    (owner, admin, member, neighbour)
}

fn rooms() -> Vec<(&'static str, Vec<String>)> {
    let id = |n: u8| common::id(n).public().user_id().0;
    vec![("general", vec![id(4), id(5)]), ("staff", vec![id(1)])]
}

#[tokio::test]
async fn members_get_journal_and_online_events() {
    let (livekit, _) = fake_livekit(vec![]).await;
    let server = spawn_with(livekit).await;
    let (owner, _, member, _) = world(&server).await;
    let mut stream = connect(&owner).await.unwrap();
    ok(owner.act(channel("media", vec![])).await).await;
    let event = wait_for(&mut stream, |e| e["type"] == "roster").await;
    assert!(event["seq"].as_u64().unwrap() > 0);

    let user = uid(&member);
    let member_stream = connect(&member).await.unwrap();
    let event = wait_for(&mut stream, |e| e["type"] == "online" && e["user"] == user.as_str()).await;
    assert_eq!(event["online"], true);
    let second = connect(&member).await.unwrap();
    drop(second);
    let state = ok(owner.get("/api/state").await).await;
    assert!(state["online"].as_array().unwrap().contains(&json!(user)), "{state}");
    drop(member_stream);
    let event = wait_for(&mut stream, |e| e["type"] == "online" && e["user"] == user.as_str() && e["online"] == false).await;
    assert_eq!(event["online"], false, "gone once the last stream of theirs closed");
    let state = ok(owner.get("/api/state").await).await;
    assert!(!state["online"].as_array().unwrap().contains(&json!(user)), "{state}");
}

#[tokio::test]
async fn strangers_cannot_open_the_stream() {
    let (livekit, _) = fake_livekit(vec![]).await;
    let server = spawn_with(livekit).await;
    world(&server).await;
    let refused = connect(&server.client(9)).await.unwrap_err();
    match refused {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 403),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn the_kicked_person_gets_the_reason_then_the_stream_closes() {
    let (livekit, _) = fake_livekit(rooms()).await;
    let server = spawn_with(livekit).await;
    let (_, admin, member, _) = world(&server).await;
    let mut stream = connect(&member).await.unwrap();
    let gif = MediaRef { sha256: "ab".repeat(32), mime: "image/gif".into(), size: 10 };
    let kick = Body::Kick { user: member.id.public().user_id(), reason: "Хватит".into(), media: Some(gif) };
    ok(admin.act(kick).await).await;
    let event = wait_for(&mut stream, |e| e["type"] == "kicked").await;
    assert_eq!(event["reason"], "Хватит");
    assert_eq!(event["by"], uid(&admin));
    assert_eq!(event["media"]["mime"], "image/gif");
    let rest = collect(&mut stream, Duration::from_millis(500)).await;
    assert!(rest.is_empty(), "nothing after the kick: {rest:?}");
    let next = tokio::time::timeout(Duration::from_secs(2), stream.next()).await.unwrap();
    assert!(matches!(next, None | Some(Ok(Message::Close(_))) | Some(Err(_))), "the stream is closed: {next:?}");
}

#[tokio::test]
async fn channel_neighbours_see_the_kick_notice_with_the_gif() {
    let (livekit, _) = fake_livekit(rooms()).await;
    let server = spawn_with(livekit).await;
    let (_, admin, member, neighbour) = world(&server).await;
    let mut stream = connect(&neighbour).await.unwrap();
    let gif = MediaRef { sha256: "cd".repeat(32), mime: "video/mp4".into(), size: 10 };
    let ban = Body::Ban { user: member.id.public().user_id(), until: None, reason: "Читы".into(), media: Some(gif) };
    ok(admin.act(ban).await).await;
    let notice = wait_for(&mut stream, |e| e["type"] == "moderation_notice").await;
    assert_eq!(notice["user"], uid(&member));
    assert_eq!(notice["kind"], "ban");
    assert_eq!(notice["reason"], "Читы");
    assert_eq!(notice["media"]["mime"], "video/mp4");
}

#[tokio::test]
async fn occupancy_of_hidden_channels_is_not_sent() {
    let (livekit, _) = fake_livekit(rooms()).await;
    let server = spawn_with(livekit).await;
    let (owner, _, member, _) = world(&server).await;
    let mut member_stream = connect(&member).await.unwrap();
    let mut owner_stream = connect(&owner).await.unwrap();
    let seen = collect(&mut member_stream, Duration::from_secs(4)).await;
    let channels: Vec<&str> = seen.iter().filter(|e| e["type"] == "occupancy").filter_map(|e| e["channel"].as_str()).collect();
    assert!(channels.contains(&"general"), "{seen:?}");
    assert!(!channels.contains(&"staff"));
    let staff = wait_for(&mut owner_stream, |e| e["type"] == "occupancy" && e["channel"] == "staff").await;
    assert_eq!(staff["people"], json!([uid(&owner)]));
}

#[tokio::test]
async fn moved_people_are_told_where_to_go() {
    let (livekit, _) = fake_livekit(rooms()).await;
    let server = spawn_with(livekit).await;
    let (_, admin, member, _) = world(&server).await;
    let mut stream = connect(&member).await.unwrap();
    ok(admin.post("/api/moderation", &json!({ "action": "move", "user": uid(&member), "channel": "games" })).await).await;
    let moved = wait_for(&mut stream, |e| e["type"] == "moved").await;
    assert_eq!((moved["channel"].as_str(), moved["by"].as_str()), (Some("games"), Some(uid(&admin).as_str())));
    ok(admin.post("/api/moderation", &json!({ "action": "mute", "user": uid(&member), "minutes": 5 })).await).await;
    let mute = wait_for(&mut stream, |e| e["type"] == "mute").await;
    assert_eq!(mute["user"], uid(&member));
}

#[tokio::test]
async fn leaving_the_server_ends_the_stream() {
    let (livekit, _) = fake_livekit(rooms()).await;
    let server = spawn_with(livekit).await;
    let (_, _, member, _) = world(&server).await;
    let mut stream = connect(&member).await.unwrap();
    ok(member.act(Body::Leave).await).await;
    let end = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(_))) => continue,
                other => return other,
            }
        }
    })
    .await
    .expect("an ex-member keeps getting events");
    assert!(matches!(end, None | Some(Ok(Message::Close(_))) | Some(Err(_))), "{end:?}");
}
