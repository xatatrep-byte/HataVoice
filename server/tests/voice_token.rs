//! The LiveKit pass itself; who gets one and with which rights is tested in `state_api.rs`.

use hatavoice_server::{LiveKitConfig, TokenRequest, issue_token};
use livekit_api::access_token::{Claims, TokenVerifier};

fn config() -> LiveKitConfig {
    LiveKitConfig {
        internal_url: "http://127.0.0.1:7880".into(),
        public_url: Some("wss://lk.example".into()),
        api_key: "testkey".into(),
        api_secret: "testsecret-testsecret-testsecret-0001".into(),
    }
}

fn request(room: &str, identity: &str, can_publish: bool) -> TokenRequest {
    TokenRequest { room: room.into(), identity: identity.into(), can_publish, can_share_screen: true }
}

fn claims(config: &LiveKitConfig, token: &str) -> Claims {
    TokenVerifier::with_api_key(&config.api_key, &config.api_secret).verify(token).unwrap()
}

#[test]
fn issues_a_verifiable_token_for_the_requested_room() {
    let token = issue_token(&config(), &request("lobby", "dev-123", true)).unwrap();
    assert_eq!(token.url, "wss://lk.example");
    let claims = claims(&config(), &token.token);
    assert_eq!(claims.sub, "dev-123");
    assert_eq!(claims.name, "", "LiveKit never learns a nickname");
    assert_eq!(claims.video.room, "lobby");
    assert!(claims.video.room_join);
    assert!(claims.video.can_publish());
    assert!(claims.video.can_subscribe());
    assert!(claims.video.can_update_own_metadata(), "clients publish their deafen state");
    assert!(!claims.video.room_admin);
    assert!(!claims.video.hidden);
}

#[test]
fn the_camera_and_the_screen_are_sources_only_with_the_right() {
    let with = claims(&config(), &issue_token(&config(), &request("lobby", "a", true)).unwrap().token);
    assert_eq!(with.video.can_publish_sources, ["microphone", "camera", "screen_share", "screen_share_audio", "unknown"]);
    let without = TokenRequest { can_share_screen: false, ..request("lobby", "a", true) };
    let without = claims(&config(), &issue_token(&config(), &without).unwrap().token);
    assert_eq!(without.video.can_publish_sources, ["microphone"], "the voice only");
}

#[test]
fn a_listener_cannot_publish() {
    let token = issue_token(&config(), &request("stage", "a", false)).unwrap();
    assert!(!claims(&config(), &token.token).video.can_publish());
}

#[test]
fn without_a_public_livekit_url_clients_are_told_to_use_this_server() {
    let config = LiveKitConfig { public_url: None, ..config() };
    assert_eq!(issue_token(&config, &request("lobby", "a", true)).unwrap().url, "");
}

#[test]
fn rejects_empty_fields_and_bad_rooms() {
    for bad in [request("", "a", true), request("lobby", "", true), request("../etc", "a", true)] {
        let error = issue_token(&config(), &bad).unwrap_err();
        assert!(!error.is_empty());
    }
}
