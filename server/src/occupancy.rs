//! Who is in which channel, asked from LiveKit's RoomService. Best effort: when LiveKit is down
//! or slow the channels are simply shown as empty.

use std::collections::HashMap;
use std::time::Duration;

use livekit_api::access_token::{AccessToken, VideoGrants};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::LiveKitConfig;

const TIMEOUT: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Occupant {
    pub identity: String,
    #[serde(default)]
    pub name: String,
    /// What LiveKit currently lets them do; absent when it did not say.
    #[serde(default, skip_serializing)]
    pub permission: Option<OccupantPermission>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct OccupantPermission {
    #[serde(default, alias = "canPublish")]
    pub can_publish: bool,
}

#[derive(Deserialize)]
struct RoomList {
    #[serde(default)]
    rooms: Vec<RoomInfo>,
}

#[derive(Deserialize)]
struct RoomInfo {
    name: String,
    #[serde(default, alias = "numParticipants")]
    num_participants: u32,
}

#[derive(Deserialize)]
struct ParticipantList {
    #[serde(default)]
    participants: Vec<Occupant>,
}

pub(crate) fn admin_token(livekit: &LiveKitConfig, grants: VideoGrants) -> Option<String> {
    AccessToken::with_api_key(&livekit.api_key, &livekit.api_secret)
        .with_ttl(Duration::from_secs(60))
        .with_grants(grants)
        .to_jwt()
        .ok()
}

pub(crate) async fn room_service<T: DeserializeOwned>(
    client: &reqwest::Client,
    livekit: &LiveKitConfig,
    method: &str,
    token: &str,
    body: serde_json::Value,
) -> Option<T> {
    let url = format!("{}/twirp/livekit.RoomService/{method}", livekit.internal_url.trim_end_matches('/'));
    let response = client.post(url).bearer_auth(token).json(&body).send().await.ok()?;
    response.error_for_status().ok()?.json().await.ok()
}

/// What LiveKit said about its rooms, and whether it said all of it.
pub struct Snapshot {
    /// Channel id → people in it, for every channel that has someone.
    pub rooms: HashMap<String, Vec<Occupant>>,
    /// False when LiveKit failed to answer in full (down, slow, a room that could not be listed):
    /// `rooms` then lacks people who may well be there, and nothing may be concluded from a room's absence.
    pub complete: bool,
}

/// Channel id → people in it, for every channel that has someone.
pub async fn occupancy(livekit: &LiveKitConfig) -> HashMap<String, Vec<Occupant>> {
    snapshot(livekit).await.rooms
}

/// Is `identity` in LiveKit room `room` right now? One room, one request; any failure means no.
pub async fn in_room(livekit: &LiveKitConfig, room: &str, identity: &str) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(TIMEOUT).build() else {
        return false;
    };
    let grants = VideoGrants { room_admin: true, room: room.into(), ..Default::default() };
    let Some(token) = admin_token(livekit, grants) else {
        return false;
    };
    let body = serde_json::json!({ "room": room });
    let list = room_service::<ParticipantList>(&client, livekit, "ListParticipants", &token, body).await;
    list.is_some_and(|list| list.participants.iter().any(|p| p.identity == identity))
}

/// [`occupancy`] that also says whether LiveKit answered in full.
pub async fn snapshot(livekit: &LiveKitConfig) -> Snapshot {
    let mut result = Snapshot { rooms: HashMap::new(), complete: false };
    let Ok(client) = reqwest::Client::builder().timeout(TIMEOUT).build() else {
        return result;
    };
    let Some(token) = admin_token(livekit, VideoGrants { room_list: true, ..Default::default() }) else {
        return result;
    };
    let Some(list) = room_service::<RoomList>(&client, livekit, "ListRooms", &token, serde_json::json!({})).await
    else {
        return result;
    };

    let lookups = list.rooms.into_iter().filter(|r| r.num_participants > 0).map(|room| {
        let client = &client;
        async move {
            let grants = VideoGrants { room_admin: true, room: room.name.clone(), ..Default::default() };
            let token = admin_token(livekit, grants)?;
            let body = serde_json::json!({ "room": room.name });
            let list = room_service::<ParticipantList>(client, livekit, "ListParticipants", &token, body).await?;
            Some((room.name, list.participants))
        }
    });
    let lookups = futures_util::future::join_all(lookups).await;
    result.complete = lookups.iter().all(Option::is_some);
    for (room, people) in lookups.into_iter().flatten() {
        result.rooms.insert(room, people);
    }
    result
}
