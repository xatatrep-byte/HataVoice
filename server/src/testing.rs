//! Test doubles other crates' tests share (the `testing` feature): a fake LiveKit RoomService.

use std::sync::Arc;

use serde_json::Value;

use crate::LiveKitConfig;

/// A fake LiveKit RoomService: `rooms` lists who (LiveKit identities) sits in which room.
/// Calls other than listing are recorded in the returned log as `"Method room identity"`.
pub async fn fake_livekit(rooms: Vec<(&str, Vec<String>)>) -> (LiveKitConfig, Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::Json;
    use axum::routing::post;
    let rooms: Vec<(String, Vec<String>)> = rooms.into_iter().map(|(r, p)| (r.to_string(), p)).collect();
    let rooms = Arc::new(rooms);
    let log = Arc::new(std::sync::Mutex::new(Vec::new()));
    let list = {
        let rooms = rooms.clone();
        post(move || {
            let rooms = rooms.clone();
            async move {
                let list: Vec<Value> = rooms
                    .iter()
                    .map(|(name, people)| serde_json::json!({ "name": name, "num_participants": people.len() }))
                    .collect();
                Json(serde_json::json!({ "rooms": list }))
            }
        })
    };
    let participants = {
        let rooms = rooms.clone();
        post(move |Json(body): Json<Value>| {
            let rooms = rooms.clone();
            async move {
                let people: Vec<Value> = rooms
                    .iter()
                    .find(|(name, _)| body["room"] == name.as_str())
                    // Everyone is shown as able to publish, the way a client that ignores a mute would be.
                    .map(|(_, people)| people.iter().map(|p| serde_json::json!({ "identity": p, "name": "", "permission": { "can_publish": true } })).collect())
                    .unwrap_or_default();
                Json(serde_json::json!({ "participants": people }))
            }
        })
    };
    let mut router = axum::Router::new()
        .route("/twirp/livekit.RoomService/ListRooms", list)
        .route("/twirp/livekit.RoomService/ListParticipants", participants);
    for method in ["UpdateParticipant", "MutePublishedTrack", "RemoveParticipant", "GetParticipant"] {
        let log = log.clone();
        let handler = post(move |Json(body): Json<Value>| {
            let log = log.clone();
            async move {
                let room = body["room"].as_str().unwrap_or("");
                let identity = body["identity"].as_str().unwrap_or("");
                let extra = body["permission"]["can_publish"].as_bool().map(|p| format!(" can_publish={p}")).unwrap_or_default();
                log.lock().unwrap().push(format!("{method} {room} {identity}{extra}"));
                Json(serde_json::json!({ "tracks": [{ "sid": "TR_mic", "type": "AUDIO", "source": "MICROPHONE" }] }))
            }
        });
        router = router.route(&format!("/twirp/livekit.RoomService/{method}"), handler);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (LiveKitConfig { internal_url: format!("http://{addr}"), ..LiveKitConfig::dev() }, log)
}

/// LiveKit config pointing at a port where nothing listens.
pub async fn dead_livekit() -> LiveKitConfig {
    let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    LiveKitConfig { internal_url: format!("http://{free}"), ..LiveKitConfig::dev() }
}
