use std::time::Duration;

use livekit_api::access_token::{AccessToken, VideoGrants};
use serde::{Deserialize, Serialize};

/// Long enough to connect; LiveKit refreshes the token of a connected participant itself.
const TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ID_LEN: usize = 64;

#[derive(Debug, Clone)]
pub struct LiveKitConfig {
    /// Where this server reaches LiveKit; `/rtc` requests are proxied there.
    pub internal_url: String,
    /// Signaling URL for clients when LiveKit is exposed separately. `None` means clients
    /// use this server's own address and go through the proxy.
    pub public_url: Option<String>,
    pub api_key: String,
    pub api_secret: String,
}

impl LiveKitConfig {
    /// Credentials of `livekit-server --dev`, for local development only.
    pub fn dev() -> Self {
        Self {
            internal_url: "http://127.0.0.1:7880".into(),
            public_url: None,
            api_key: "devkey".into(),
            api_secret: "secret".into(),
        }
    }

    /// Reads `LIVEKIT_INTERNAL_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`,
    /// using dev values for any that are unset.
    pub fn from_env() -> Self {
        let dev = Self::dev();
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let config = Self {
            internal_url: var("LIVEKIT_INTERNAL_URL").unwrap_or(dev.internal_url),
            public_url: var("LIVEKIT_URL"),
            api_key: var("LIVEKIT_API_KEY").unwrap_or(dev.api_key),
            api_secret: var("LIVEKIT_API_SECRET").unwrap_or(dev.api_secret),
        };
        if config.api_secret == Self::dev().api_secret {
            tracing::warn!("using LiveKit dev credentials; set LIVEKIT_API_KEY/LIVEKIT_API_SECRET outside development");
        }
        config
    }
}

/// What the server decided to let a member do in a channel.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenRequest {
    pub room: String,
    pub identity: String,
    /// False when the channel forbids speaking or the member is muted.
    pub can_publish: bool,
    /// The member's roles give `stream`: the screen and its sound may be published, not only the mic.
    pub can_share_screen: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenResponse {
    /// LiveKit signaling URL; empty means "the address you reached this server at".
    pub url: String,
    pub token: String,
}

fn check_id(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{kind} не указан"));
    }
    if value.len() > MAX_ID_LEN {
        return Err(format!("{kind} длиннее {MAX_ID_LEN} символов"));
    }
    if !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("{kind}: допустимы только латиница, цифры, «-» и «_»"));
    }
    Ok(())
}

fn sources(video: bool) -> Vec<String> {
    let mut sources = vec!["microphone".to_string()];
    if video {
        // `unknown`: music played together, a track named "music" (LiveKit has no source of its own for it).
        sources.extend(["camera".to_string(), "screen_share".to_string(), "screen_share_audio".to_string(), "unknown".to_string()]);
    }
    sources
}

pub fn issue_token(config: &LiveKitConfig, request: &TokenRequest) -> Result<TokenResponse, String> {
    check_id("Канал", &request.room)?;
    check_id("Идентификатор", &request.identity)?;
    let token = AccessToken::with_api_key(&config.api_key, &config.api_secret)
        // No name: the app names people by their id from the server group, LiveKit never learns a nickname.
        .with_identity(&request.identity)
        .with_ttl(TOKEN_TTL)
        .with_grants(VideoGrants {
            room_join: true,
            room: request.room.clone(),
            can_publish: Some(request.can_publish),
            // What may be published at all: the camera and the screen only with the `stream` right (as Discord's «Видео»).
            can_publish_sources: sources(request.can_share_screen),
            can_subscribe: Some(true),
            // Clients publish their deafen state as an attribute.
            can_update_own_metadata: Some(true),
            ..Default::default()
        })
        .to_jwt()
        .map_err(|e| format!("Не удалось выписать токен: {e}"))?;

    Ok(TokenResponse {
        url: config.public_url.clone().unwrap_or_default(),
        token,
    })
}
