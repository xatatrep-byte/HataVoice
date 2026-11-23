mod common;

use common::{Client, claim, fake_livekit, invite, join, now, spawn_with, uid};
use hv_roster::perms::{ChannelDef, ChannelOverride, Tri};
use hv_roster::{Body, RoleId};
use livekit_api::access_token::TokenVerifier;
use serde_json::{Value, json};

async fn ok(result: (u16, Value)) -> Value {
    assert!(result.0 == 200 || result.0 == 204, "{} {}", result.0, result.1);
    result.1
}

fn general(overrides: Vec<ChannelOverride>) -> ChannelDef {
    ChannelDef { id: "general".into(), name: "Общий".into(), user_limit: 0, overrides, kind: Default::default() }
}

/// Owner, an admin, a moderator and a member; the member sits in `general`.
struct World<'a> {
    owner: Client<'a>,
    admin: Client<'a>,
    moderator: Client<'a>,
    member: Client<'a>,
}

async fn world(server: &common::TestServer) -> World<'_> {
    let owner = server.client(1);
    claim(server, &owner).await;
    ok(owner.act(Body::ChannelCreate(general(vec![]))).await).await;
    ok(owner.act(Body::ChannelCreate(ChannelDef { id: "games".into(), name: "Игры".into(), user_limit: 0, overrides: vec![], kind: Default::default() })).await)
        .await;
    let (admin, moderator, member) = (server.client(2), server.client(3), server.client(4));
    for (who, roles) in [(&admin, vec!["admin"]), (&moderator, vec!["moderator"]), (&member, vec![])] {
        let key = invite(&owner, &roles).await;
        ok(join(who, &key).await).await;
    }
    World { owner, admin, moderator, member }
}

fn member_in_general() -> Vec<(&'static str, Vec<String>)> {
    vec![("general", vec![common::id(4).public().user_id().0])]
}

fn logged(log: &std::sync::Mutex<Vec<String>>, line: &str) -> bool {
    log.lock().unwrap().iter().any(|l| l == line)
}

async fn moderate(by: &Client<'_>, command: Value) -> (u16, Value) {
    by.post("/api/moderation", &command).await
}

#[tokio::test]
async fn mute_is_enforced_by_livekit_and_survives_rejoin() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let member = uid(&w.member);

    ok(moderate(&w.moderator, json!({ "action": "mute", "user": member, "minutes": 15, "reason": "Кричит" })).await).await;
    assert!(logged(&log, &format!("UpdateParticipant general {member} can_publish=false")), "{:?}", log.lock().unwrap());
    assert!(logged(&log, &format!("MutePublishedTrack general {member}")));

    let token = ok(w.member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    let dev = hatavoice_server::LiveKitConfig::dev();
    let claims = TokenVerifier::with_api_key(&dev.api_key, &dev.api_secret).verify(token["token"].as_str().unwrap()).unwrap();
    assert!(!claims.video.can_publish(), "rejoining does not lift the mute");

    let state = ok(w.owner.get("/api/state").await).await;
    let mute = &state["mutes"][&member];
    assert_eq!(mute["reason"], "Кричит");
    assert_eq!(mute["by"], uid(&w.moderator));
    assert!(mute["until"].as_u64().unwrap().abs_diff(now() + 15 * 60) <= 2);

    ok(moderate(&w.moderator, json!({ "action": "unmute", "user": member })).await).await;
    assert!(logged(&log, &format!("UpdateParticipant general {member} can_publish=true")));
    let state = ok(w.owner.get("/api/state").await).await;
    assert!(state["mutes"].get(&member).is_none());
}

#[tokio::test]
async fn mute_until_lifted_has_no_end() {
    let (livekit, _) = fake_livekit(vec![]).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    ok(moderate(&w.admin, json!({ "action": "mute", "user": uid(&w.member), "minutes": null })).await).await;
    let state = ok(w.owner.get("/api/state").await).await;
    assert_eq!(state["mutes"][uid(&w.member)]["until"], Value::Null);
}

#[tokio::test]
async fn moderation_respects_rights_and_hierarchy() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let mute = |user: String| json!({ "action": "mute", "user": user, "minutes": 5 });
    assert_eq!(moderate(&w.member, mute(uid(&w.moderator))).await.0, 403, "no right");
    assert_eq!(moderate(&w.moderator, mute(uid(&w.admin))).await.0, 403, "higher rank");
    assert_eq!(moderate(&w.admin, mute(uid(&w.owner))).await.0, 403, "the owner");
    assert_eq!(moderate(&w.moderator, mute(uid(&w.moderator))).await.0, 403, "yourself");
    let odd = json!({ "action": "mute", "user": uid(&w.member), "minutes": 7 });
    assert_eq!(moderate(&w.moderator, odd).await.0, 400, "only the offered durations");
    let long = json!({ "action": "mute", "user": uid(&w.member), "minutes": 5, "reason": "я".repeat(201) });
    assert_eq!(moderate(&w.moderator, long).await.0, 400);
    assert_eq!(moderate(&w.moderator, json!({ "action": "fly", "user": uid(&w.member) })).await.0, 400);
    assert!(log.lock().unwrap().iter().all(|l| !l.starts_with("UpdateParticipant")), "nothing was enforced");
}

#[tokio::test]
async fn move_and_disconnect_remove_from_the_room() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let member = uid(&w.member);
    ok(moderate(&w.moderator, json!({ "action": "move", "user": member, "channel": "games" })).await).await;
    assert!(logged(&log, &format!("RemoveParticipant general {member}")));
    let (status, _) = moderate(&w.moderator, json!({ "action": "move", "user": member, "channel": "nope" })).await;
    assert_eq!(status, 404);

    log.lock().unwrap().clear();
    ok(moderate(&w.moderator, json!({ "action": "disconnect", "user": member })).await).await;
    assert!(logged(&log, &format!("RemoveParticipant general {member}")));
}

#[tokio::test]
async fn kick_and_ban_throw_people_out_of_calls() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let member = w.member.id.public().user_id();
    ok(w.admin.act(Body::Kick { user: member.clone(), reason: "Хватит".into(), media: None }).await).await;
    assert!(logged(&log, &format!("RemoveParticipant general {}", member.0)), "{:?}", log.lock().unwrap());

    log.lock().unwrap().clear();
    ok(w.admin.act(Body::Ban { user: member.clone(), until: None, reason: String::new(), media: None }).await).await;
    assert!(logged(&log, &format!("RemoveParticipant general {}", member.0)), "a ban also throws out");
}

#[tokio::test]
async fn losing_connect_or_speak_takes_effect_at_once() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let member = uid(&w.member);
    let no_speaking = ChannelOverride { role: RoleId::everyone(), view: Tri::Inherit, connect: Tri::Inherit, speak: Tri::Deny };
    ok(w.owner.act(Body::ChannelUpdate(general(vec![no_speaking]))).await).await;
    assert!(logged(&log, &format!("UpdateParticipant general {member} can_publish=false")), "{:?}", log.lock().unwrap());

    let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
    ok(w.owner.act(Body::ChannelUpdate(general(vec![hidden]))).await).await;
    assert!(logged(&log, &format!("RemoveParticipant general {member}")));
}

#[tokio::test]
async fn audit_log_needs_its_right_and_keeps_signatures() {
    let (livekit, _) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    ok(moderate(&w.moderator, json!({ "action": "mute", "user": uid(&w.member), "minutes": 5, "reason": "Шум" })).await).await;
    ok(w.admin.act(Body::Kick { user: w.member.id.public().user_id(), reason: "Хватит".into(), media: None }).await).await;

    assert_eq!(w.moderator.get("/api/audit").await.0, 403, "moderators can't read the audit log by default");
    let log = ok(w.owner.get("/api/audit").await).await;
    let entries = log["entries"].as_array().unwrap();
    let mute = entries.iter().find(|e| e["kind"] == "mute").unwrap();
    assert_eq!(mute["actor"], uid(&w.moderator));
    assert_eq!(mute["target"], uid(&w.member));
    assert!(mute["auth"].as_str().unwrap().starts_with("HV1 "), "the signed request is kept");
    let sent: Value = serde_json::from_str(mute["request_body"].as_str().expect("the signed bytes are kept")).unwrap();
    assert_eq!(sent, json!({ "action": "mute", "user": uid(&w.member), "minutes": 5, "reason": "Шум" }));
    let kick = entries.iter().find(|e| e["kind"] == "kick").unwrap();
    assert_eq!(kick["detail"]["reason"], "Хватит");
    assert!(kick["signature"].is_string());
    assert!(entries.windows(2).all(|p| p[0]["at"].as_u64() >= p[1]["at"].as_u64()), "newest first");

    let only_mutes = ok(w.owner.get(&format!("/api/audit?kind=mute&user={}", uid(&w.member))).await).await;
    assert!(only_mutes["entries"].as_array().unwrap().iter().all(|e| e["kind"] == "mute"));
}

/// Waits up to 5 s (more than two LiveKit polls) for `line` in the log.
async fn eventually_logged(log: &std::sync::Mutex<Vec<String>>, line: &str) -> bool {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        if logged(log, line) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn a_kicked_person_who_comes_back_with_an_old_pass_is_thrown_out_again() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let member = w.member.id.public().user_id();
    ok(w.admin.act(Body::Kick { user: member.clone(), reason: "Хватит".into(), media: None }).await).await;
    log.lock().unwrap().clear();
    // The fake LiveKit still lists them: a modified client reconnected with its last pass.
    assert!(eventually_logged(&log, &format!("RemoveParticipant general {}", member.0)).await, "{:?}", log.lock().unwrap());
}

#[tokio::test]
async fn a_muted_person_whose_client_still_publishes_loses_the_right_again() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let member = uid(&w.member);
    ok(moderate(&w.moderator, json!({ "action": "mute", "user": member, "minutes": null, "reason": "" })).await).await;
    log.lock().unwrap().clear();
    assert!(
        eventually_logged(&log, &format!("UpdateParticipant general {member} can_publish=false")).await,
        "{:?}",
        log.lock().unwrap()
    );
}

#[tokio::test]
async fn the_voice_proxy_turns_away_a_pass_the_journal_no_longer_allows() {
    let (livekit, _log) = fake_livekit(vec![]).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let token = ok(w.member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    let pass = token["token"].as_str().unwrap().to_string();
    let validate = |pass: &str| reqwest::get(server.url(&format!("/rtc/validate?access_token={pass}")));
    assert_ne!(validate(&pass).await.unwrap().status(), 403, "a member's pass goes through");

    let member = w.member.id.public().user_id();
    ok(w.admin.act(Body::Ban { user: member, until: None, reason: String::new(), media: None }).await).await;
    let refused = validate(&pass).await.unwrap();
    assert_eq!(refused.status(), 403);
    assert_eq!(refused.text().await.unwrap(), "Этот пропуск больше не действует");
    assert_eq!(validate("garbage").await.unwrap().status(), 403);
}

#[tokio::test]
async fn a_muted_persons_old_pass_that_can_publish_is_turned_away() {
    let (livekit, _log) = fake_livekit(vec![]).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let before = ok(w.member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    let member = uid(&w.member);
    ok(moderate(&w.moderator, json!({ "action": "mute", "user": member, "minutes": 15, "reason": "" })).await).await;
    let after = ok(w.member.post("/api/voice/token", &json!({ "channel": "general" })).await).await;
    let validate = |pass: &str| reqwest::get(server.url(&format!("/rtc/validate?access_token={pass}")));
    assert_eq!(validate(before["token"].as_str().unwrap()).await.unwrap().status(), 403, "issued before the mute");
    assert_ne!(validate(after["token"].as_str().unwrap()).await.unwrap().status(), 403, "issued muted");
}

#[tokio::test]
async fn moving_someone_who_is_not_in_a_call_is_refused() {
    let (livekit, log) = fake_livekit(member_in_general()).await;
    let server = spawn_with(livekit).await;
    let w = world(&server).await;
    let (status, body) = moderate(&w.owner, json!({ "action": "move", "user": uid(&w.admin), "channel": "games" })).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Он сейчас не в голосовом канале");
    assert!(!logged(&log, &format!("RemoveParticipant general {}", uid(&w.admin))));
}
