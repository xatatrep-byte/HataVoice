mod common;

use common::{Client, claim, dead_livekit, fake_livekit, invite, join, now, spawn_with, uid};
use hv_roster::perms::{ChannelDef, ChannelOverride, Permission, Tri};
use hv_roster::request::sign_profile;
use hv_roster::{Body, RoleId};
use livekit_api::access_token::TokenVerifier;
use serde_json::{Value, json};

fn channel(id: &str, limit: u32, overrides: Vec<ChannelOverride>) -> Body {
    Body::ChannelCreate(ChannelDef { id: id.into(), name: id.into(), user_limit: limit, overrides, kind: Default::default() })
}

fn everyone(view: Tri, speak: Tri) -> ChannelOverride {
    ChannelOverride { role: RoleId::everyone(), view, connect: Tri::Inherit, speak }
}

async fn ok(result: (u16, Value)) -> Value {
    assert_eq!(result.0, 200, "{}", result.1);
    result.1
}

/// A claimed server with channels `general` (open), `staff` (hidden from @все),
/// `stage` (@все can't speak) and `small` (limit 2); `member` and `moderator` joined.
async fn setup<'a>(server: &'a common::TestServer) -> (Client<'a>, Client<'a>, Client<'a>) {
    let owner = server.client(1);
    claim(server, &owner).await;
    ok(owner.act(channel("general", 0, vec![])).await).await;
    ok(owner.act(channel("staff", 0, vec![everyone(Tri::Deny, Tri::Inherit)])).await).await;
    ok(owner.act(channel("stage", 0, vec![everyone(Tri::Inherit, Tri::Deny)])).await).await;
    ok(owner.act(channel("small", 2, vec![])).await).await;
    let member = server.client(2);
    let key = invite(&owner, &[]).await;
    ok(join(&member, &key).await).await;
    let moderator = server.client(3);
    let key = invite(&owner, &["moderator"]).await;
    ok(join(&moderator, &key).await).await;
    (owner, member, moderator)
}

fn claims(server: &common::TestServer, token: &Value) -> livekit_api::access_token::Claims {
    let _ = server;
    let dev = hatavoice_server::LiveKitConfig::dev();
    TokenVerifier::with_api_key(&dev.api_key, &dev.api_secret).verify(token["token"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn state_lists_only_channels_you_may_see() {
    let owner_id = common::id(1).public().user_id().0;
    let member_id = common::id(2).public().user_id().0;
    let (livekit, _) = fake_livekit(vec![("general", vec![member_id.clone()]), ("staff", vec![owner_id.clone()])]).await;
    let server = spawn_with(livekit).await;
    let (owner, member, _) = setup(&server).await;

    let state = ok(member.get("/api/state").await).await;
    assert_eq!(state["occupancy"]["general"], json!([member_id]));
    assert!(state["occupancy"].get("staff").is_none(), "hidden channel");
    assert!(state["server_time"].as_u64().unwrap().abs_diff(now()) <= 2);
    let state = ok(owner.get("/api/state").await).await;
    assert_eq!(state["occupancy"]["staff"], json!([owner_id]));
}

#[tokio::test]
async fn strangers_get_no_state() {
    let server = spawn_with(dead_livekit().await).await;
    setup(&server).await;
    let (status, body) = server.client(9).get("/api/state").await;
    assert_eq!(status, 403);
    assert_eq!(body["join_needed"], true);
}

#[tokio::test]
async fn profiles_and_presence_are_gone() {
    let server = spawn_with(dead_livekit().await).await;
    let (_, member, _) = setup(&server).await;
    let profile = sign_profile(&member.id, &server.server_key, "Петя", "pink", now());
    let (status, body) = member.send("PUT", "/api/profile", &serde_json::to_value(&profile).unwrap()).await;
    assert_eq!((status, body["error"].as_str()), (410, Some("Обнови ХатаВойс")));
    let (status, body) = member.send("PUT", "/api/presence", &json!({ "activity": "CS2" })).await;
    assert_eq!((status, body["error"].as_str()), (410, Some("Обнови ХатаВойс")));
    let state = ok(member.get("/api/state").await).await;
    assert!(state.get("profiles").is_none() && state.get("presence").is_none(), "{state}");
    assert_eq!(state["online"], json!([]), "nobody has the event stream open");
}

#[tokio::test]
async fn profiles_kept_by_an_earlier_version_are_removed() {
    let dir = std::env::temp_dir().join(format!("hv-profiles-gone-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("profiles.json"), r#"[{"nickname":"BEACONnick"}]"#).unwrap();
    let store = std::sync::Arc::new(hatavoice_server::roster_store::RosterStore::open(Some(&dir)).unwrap());
    let _server = common::spawn_store(dead_livekit().await, store).await;
    assert!(!dir.join("profiles.json").exists(), "the server forgets the nicknames it kept");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn token_follows_connect_and_speak_rights() {
    let server = spawn_with(dead_livekit().await).await;
    let (owner, member, _) = setup(&server).await;
    let token = ok(member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    let general = claims(&server, &token);
    assert!(general.video.can_publish());
    assert_eq!(general.video.room, "general");
    assert!(general.exp as u64 <= now() + 5 * 60 + 5, "short-lived token");

    let stage = claims(&server, &ok(member.post("/api/voice/token", &json!({ "channel": "stage" })).await).await);
    assert!(!stage.video.can_publish(), "@все may not speak on the stage");
    let owner_stage = claims(&server, &ok(owner.post("/api/voice/token", &json!({ "channel": "stage" })).await).await);
    assert!(owner_stage.video.can_publish());

    let (status, body) = member.post("/api/voice/token", &json!({ "channel": "staff" })).await;
    assert_eq!((status, body["error"].as_str()), (403, Some("Нет доступа к каналу")));
    let (status, _) = member.post("/api/voice/token", &json!({ "channel": "nope" })).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn full_channel_admits_only_movers_and_those_already_inside() {
    let inside = common::id(4).public().user_id().0;
    let (livekit, _) = fake_livekit(vec![("small", vec![inside, "someone".into()])]).await;
    let server = spawn_with(livekit).await;
    let (owner, member, moderator) = setup(&server).await;
    let (status, body) = member.post("/api/voice/token", &json!({ "channel": "small" })).await;
    assert_eq!((status, body["error"].as_str()), (403, Some("Канал заполнен (2/2)")));
    ok(moderator.post("/api/voice/token", &json!({ "channel": "small" })).await).await;

    let returning = server.client(4);
    let key = invite(&owner, &[]).await;
    ok(join(&returning, &key).await).await;
    ok(returning.post("/api/voice/token", &json!({ "channel": "small" })).await).await;
    let _ = Permission::MoveMembers;
}

#[tokio::test]
async fn the_camera_and_the_screen_need_the_stream_right() {
    let server = spawn_with(dead_livekit().await).await;
    let (owner, member, _) = setup(&server).await;
    let sources = |token: &Value| claims(&server, token).video.can_publish_sources;
    let pass = ok(member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    // `unknown` is music played together (its track is named "music"): streaming too.
    assert_eq!(sources(&pass), ["microphone", "camera", "screen_share", "screen_share_audio", "unknown"], "@все may stream by default");
    // The owner takes the right from everyone.
    let everyone = hv_roster::perms::default_roles().into_iter().find(|r| r.id == RoleId::everyone()).unwrap();
    let everyone = hv_roster::RoleDef { permissions: hv_roster::Permissions::of(&[Permission::Connect, Permission::Speak]), ..everyone };
    ok(owner.act(Body::RoleUpdate(everyone)).await).await;
    let pass = ok(member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    assert_eq!(sources(&pass), ["microphone"], "without the right: the voice only");
    let pass = ok(owner.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    assert_eq!(sources(&pass).len(), 5, "the owner has every right");
}

#[tokio::test]
async fn the_voice_pass_has_the_user_id_and_no_name() {
    let server = spawn_with(dead_livekit().await).await;
    let (_, member, _) = setup(&server).await;
    let pass = claims(&server, &ok(member.post("/api/voice/token", &json!({ "channel": "general" })).await).await);
    assert_eq!(pass.sub, uid(&member));
    assert_eq!(pass.name, "", "LiveKit is told no nickname");
}

#[tokio::test]
async fn channels_are_listed_even_when_livekit_is_down() {
    let server = spawn_with(dead_livekit().await).await;
    let (owner, _, _) = setup(&server).await;
    let state = ok(owner.get("/api/state").await).await;
    assert_eq!(state["occupancy"], json!({}));
}

#[tokio::test]
async fn the_old_open_endpoints_are_gone() {
    let server = spawn_with(dead_livekit().await).await;
    let channels = reqwest::get(server.url("/api/channels")).await.unwrap();
    assert_eq!(channels.status(), 404);
}
