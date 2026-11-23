//! What the server does to people in LiveKit rooms: take away or give back the right to speak,
//! mute their tracks, throw them out. The client can't undo any of it.

use std::time::Duration;

use livekit_api::access_token::VideoGrants;
use serde::Deserialize;

use crate::LiveKitConfig;
use crate::occupancy::{admin_token, room_service};

const TIMEOUT: Duration = Duration::from_secs(3);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())
}

async fn call<T: serde::de::DeserializeOwned>(lk: &LiveKitConfig, room: &str, method: &str, body: serde_json::Value) -> Result<T, String> {
    let grants = VideoGrants { room_admin: true, room: room.into(), ..Default::default() };
    let token = admin_token(lk, grants).ok_or("Не удалось выписать токен LiveKit")?;
    room_service(&client()?, lk, method, &token, body)
        .await
        .ok_or_else(|| format!("LiveKit не выполнил {method}"))
}

/// Sets what `identity` may do in `room`; everything but publishing stays as our tokens grant it.
pub async fn update_can_publish(lk: &LiveKitConfig, room: &str, identity: &str, can_publish: bool) -> Result<(), String> {
    let body = serde_json::json!({
        "room": room,
        "identity": identity,
        "permission": {
            "can_subscribe": true,
            "can_publish": can_publish,
            "can_publish_data": true,
            "can_update_metadata": true,
        },
    });
    call::<serde_json::Value>(lk, room, "UpdateParticipant", body).await.map(|_| ())
}

#[derive(Deserialize)]
struct ParticipantInfo {
    #[serde(default)]
    tracks: Vec<TrackInfo>,
}

#[derive(Deserialize)]
struct TrackInfo {
    sid: String,
    #[serde(default, rename = "type")]
    kind: serde_json::Value,
}

/// Mutes every audio track `identity` publishes in `room`.
pub async fn mute_tracks(lk: &LiveKitConfig, room: &str, identity: &str) -> Result<(), String> {
    let info: ParticipantInfo = call(lk, room, "GetParticipant", serde_json::json!({ "room": room, "identity": identity })).await?;
    // Twirp JSON gives the enum as "AUDIO" or as 0.
    let audio = |t: &&TrackInfo| t.kind == "AUDIO" || t.kind == 0;
    for track in info.tracks.iter().filter(audio) {
        let body = serde_json::json!({ "room": room, "identity": identity, "track_sid": track.sid, "muted": true });
        call::<serde_json::Value>(lk, room, "MutePublishedTrack", body).await?;
    }
    Ok(())
}

pub async fn remove_participant(lk: &LiveKitConfig, room: &str, identity: &str) -> Result<(), String> {
    call::<serde_json::Value>(lk, room, "RemoveParticipant", serde_json::json!({ "room": room, "identity": identity }))
        .await
        .map(|_| ())
}

/// The rooms `identity` is in right now (best effort: empty when LiveKit doesn't answer).
pub async fn rooms_of(lk: &LiveKitConfig, identity: &str) -> Vec<String> {
    crate::occupancy::occupancy(lk)
        .await
        .into_iter()
        .filter(|(_, people)| people.iter().any(|p| p.identity == identity))
        .map(|(room, _)| room)
        .collect()
}
