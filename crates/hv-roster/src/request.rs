//! Signed API requests, the server's hello proof and signed profiles.
//!
//! There is no session token: every request carries `Authorization: HV1 …` with the user's key,
//! the time and a one-time nonce, signed over the method, path, body and the server key. A
//! captured request can't be replayed, and a signature for one server is useless on another.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::keys::{Digest, Identity, PublicKey, Signature, decode_b64_vec, encode_b64, random_bytes, sha256};

pub const MAX_SKEW_SECS: u64 = 60;
pub const NONCE_TTL_SECS: u64 = 120;
const MAX_NONCE_LEN: usize = 64;
const SCHEME: &str = "HV1 ";
const MAX_NICKNAME_CHARS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestAuth {
    #[serde(rename = "u")]
    pub user: PublicKey,
    #[serde(rename = "t")]
    pub at: u64,
    #[serde(rename = "n")]
    pub nonce: String,
    #[serde(rename = "s")]
    pub signature: Signature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Malformed,
    BadSignature,
    /// The client's clock is off by more than a minute; `server_now` lets it say by how much.
    ClockSkew { server_now: u64 },
    Replayed,
}

/// The bytes a request signature covers.
pub fn request_message(server_key: &PublicKey, method: &str, path_and_query: &str, at: u64, nonce: &str, body: &[u8]) -> Vec<u8> {
    let body_hash: String = sha256(body).iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "hatavoice-req-v1\n{}\n{}\n{path_and_query}\n{at}\n{nonce}\n{body_hash}",
        encode_b64(&server_key.0),
        method.to_ascii_uppercase()
    )
    .into_bytes()
}

/// The `Authorization` header value for a request.
pub fn sign_request(id: &Identity, server_key: &PublicKey, method: &str, path_and_query: &str, body: &[u8], at: u64) -> Result<String, String> {
    let nonce = encode_b64(&random_bytes::<16>()?);
    let signature = id.sign(&request_message(server_key, method, path_and_query, at, &nonce, body));
    let auth = RequestAuth { user: id.public(), at, nonce, signature };
    let json = serde_json::to_vec(&auth).map_err(|e| e.to_string())?;
    Ok(format!("{SCHEME}{}", encode_b64(&json)))
}

pub fn parse_auth_header(value: &str) -> Result<RequestAuth, AuthError> {
    let encoded = value.trim().strip_prefix(SCHEME).ok_or(AuthError::Malformed)?;
    let json = decode_b64_vec(encoded).ok_or(AuthError::Malformed)?;
    let auth: RequestAuth = serde_json::from_slice(&json).map_err(|_| AuthError::Malformed)?;
    if auth.nonce.is_empty() || auth.nonce.len() > MAX_NONCE_LEN {
        return Err(AuthError::Malformed);
    }
    Ok(auth)
}

/// Remembers recent nonces so a captured request can't be sent again.
#[derive(Debug, Default)]
pub struct NonceCache {
    seen: HashMap<(PublicKey, String), u64>,
}

impl NonceCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks the time window, the signature over `message`, and that the nonce is new.
    pub fn verify(&mut self, auth: &RequestAuth, message: &[u8], now: u64) -> Result<(), AuthError> {
        self.seen.retain(|_, at| now.saturating_sub(*at) <= NONCE_TTL_SECS);
        if auth.at.abs_diff(now) > MAX_SKEW_SECS {
            return Err(AuthError::ClockSkew { server_now: now });
        }
        if !auth.user.verify(message, &auth.signature) {
            return Err(AuthError::BadSignature);
        }
        let key = (auth.user, auth.nonce.clone());
        if self.seen.contains_key(&key) {
            return Err(AuthError::Replayed);
        }
        self.seen.insert(key, now);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

/// What the server signs with its key in `/api/hello`.
pub fn hello_message(nonce: &str, roster_head: &Digest) -> Vec<u8> {
    format!("hatavoice-hello-v1\n{nonce}\n{}", encode_b64(&roster_head.0)).into_bytes()
}

/// A member's nickname, avatar color and (if any) the frame around their avatar, signed by them for one server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedProfile {
    pub user: PublicKey,
    pub nickname: String,
    pub color: String,
    /// The frame around the avatar (one of the app's, by name); none in a profile of an earlier version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    /// The 3D character, as the app's short code; none in a profile of an earlier version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    pub at: u64,
    pub signature: Signature,
}

/// The longest name of an avatar frame.
pub const MAX_FRAME_CHARS: usize = 24;
/// The longest code of a 3D character.
pub const MAX_CHARACTER_CHARS: usize = 96;

/// What is signed: a profile with no character (and no frame) is signed as by an earlier version, so all check everywhere.
fn profile_message(server_key: &PublicKey, user: &PublicKey, nickname: &str, color: &str, frame: Option<&str>, character: Option<&str>, at: u64) -> Vec<u8> {
    let fields = match (frame, character) {
        (None, None) => serde_json::json!(["hatavoice-profile-v1", server_key, user, nickname, color, at]),
        (Some(frame), None) => serde_json::json!(["hatavoice-profile-v2", server_key, user, nickname, color, frame, at]),
        (frame, Some(character)) => serde_json::json!(["hatavoice-profile-v3", server_key, user, nickname, color, frame, character, at]),
    };
    serde_json::to_vec(&fields).expect("serializing a profile cannot fail")
}

pub fn sign_profile(id: &Identity, server_key: &PublicKey, nickname: &str, color: &str, at: u64) -> SignedProfile {
    sign_profile_full(id, server_key, nickname, color, None, None, at)
}

pub fn sign_profile_framed(id: &Identity, server_key: &PublicKey, nickname: &str, color: &str, frame: Option<&str>, at: u64) -> SignedProfile {
    sign_profile_full(id, server_key, nickname, color, frame, None, at)
}

/// A profile with all there is: the frame around the avatar and the 3D character, if any.
pub fn sign_profile_full(
    id: &Identity,
    server_key: &PublicKey,
    nickname: &str,
    color: &str,
    frame: Option<&str>,
    character: Option<&str>,
    at: u64,
) -> SignedProfile {
    let nickname = nickname.trim().to_string();
    let user = id.public();
    let signature = id.sign(&profile_message(server_key, &user, &nickname, color, frame, character, at));
    SignedProfile { user, nickname, color: color.into(), frame: frame.map(str::to_string), character: character.map(str::to_string), at, signature }
}

impl SignedProfile {
    /// The signature is valid for this server and the nickname is 1–32 characters.
    pub fn verify(&self, server_key: &PublicKey) -> bool {
        let length = self.nickname.chars().count();
        let tidy = self.nickname.trim() == self.nickname && (1..=MAX_NICKNAME_CHARS).contains(&length);
        let frame_fits = self.frame.as_deref().is_none_or(|frame| {
            (1..=MAX_FRAME_CHARS).contains(&frame.len()) && frame.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
        let character_fits = self.character.as_deref().is_none_or(|code| {
            (1..=MAX_CHARACTER_CHARS).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.')
        });
        tidy && frame_fits
            && character_fits
            && self.color.len() <= 16
            && self.user.verify(
                &profile_message(server_key, &self.user, &self.nickname, &self.color, self.frame.as_deref(), self.character.as_deref(), self.at),
                &self.signature,
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn user() -> Identity {
        Identity::from_seed([1; 32])
    }

    fn server() -> PublicKey {
        Identity::from_seed([2; 32]).public()
    }

    fn signed(at: u64) -> (RequestAuth, Vec<u8>) {
        let header = sign_request(&user(), &server(), "POST", "/api/roster?from=3", b"{\"a\":1}", at).unwrap();
        let auth = parse_auth_header(&header).unwrap();
        let message = request_message(&server(), "POST", "/api/roster?from=3", auth.at, &auth.nonce, b"{\"a\":1}");
        (auth, message)
    }

    #[test]
    fn a_frame_is_signed_with_the_profile() {
        let server = Identity::from_seed([9; 32]).public();
        let framed = sign_profile_framed(&user(), &server, "Петя", "#ff8a4c", Some("neon"), NOW);
        assert!(framed.verify(&server));
        let json = serde_json::to_value(&framed).unwrap();
        assert_eq!(json["frame"], "neon");
        let mut swapped = framed.clone();
        swapped.frame = Some("crown".into());
        assert!(!swapped.verify(&server), "the frame is under the signature");
        let mut dropped = framed.clone();
        dropped.frame = None;
        assert!(!dropped.verify(&server));
        let plain = sign_profile(&user(), &server, "Петя", "pink", NOW);
        assert!(plain.verify(&server), "a profile with no frame signs as before");
        assert!(serde_json::to_value(&plain).unwrap().get("frame").is_none());
        for bad in ["", "Neon", "a b", &"x".repeat(25)] {
            let odd = sign_profile_framed(&user(), &server, "Петя", "pink", Some(bad), NOW);
            assert!(!odd.verify(&server), "{bad:?}");
        }
    }

    #[test]
    fn a_character_is_signed_with_the_profile() {
        let server = Identity::from_seed([9; 32]).public();
        let code = "c1.round.f6d1b1.ff8a4c.short.3b2a20.crown.dots";
        for frame in [None, Some("neon")] {
            let full = sign_profile_full(&user(), &server, "Петя", "#ff8a4c", frame, Some(code), NOW);
            assert!(full.verify(&server), "{frame:?}");
            assert_eq!(serde_json::to_value(&full).unwrap()["character"], code);
            let mut swapped = full.clone();
            swapped.character = Some("c1.tall.f6d1b1.ff8a4c.short.3b2a20.crown.dots".into());
            assert!(!swapped.verify(&server), "the character is under the signature");
            let mut dropped = full.clone();
            dropped.character = None;
            assert!(!dropped.verify(&server), "a character cannot be taken off by someone else");
        }
        let framed = sign_profile_framed(&user(), &server, "Петя", "pink", Some("neon"), NOW);
        assert!(serde_json::to_value(&framed).unwrap().get("character").is_none(), "no character signs as before");
        for bad in ["", "C1.round", "c1 round", &"c".repeat(97)] {
            let odd = sign_profile_full(&user(), &server, "Петя", "pink", None, Some(bad), NOW);
            assert!(!odd.verify(&server), "{bad:?}");
        }
    }

    #[test]
    fn a_signed_request_verifies_once() {
        let (auth, message) = signed(NOW);
        assert_eq!(auth.user, user().public());
        assert_eq!(auth.at, NOW);
        let mut cache = NonceCache::new();
        assert_eq!(cache.verify(&auth, &message, NOW + 5), Ok(()));
        assert_eq!(cache.verify(&auth, &message, NOW + 6), Err(AuthError::Replayed));
    }

    #[test]
    fn changed_method_path_body_or_server_breaks_the_signature() {
        let (auth, _) = signed(NOW);
        let other_server = Identity::from_seed([3; 32]).public();
        let variants = [
            request_message(&server(), "GET", "/api/roster?from=3", auth.at, &auth.nonce, b"{\"a\":1}"),
            request_message(&server(), "POST", "/api/roster?from=4", auth.at, &auth.nonce, b"{\"a\":1}"),
            request_message(&server(), "POST", "/api/roster?from=3", auth.at, &auth.nonce, b"{\"a\":2}"),
            request_message(&other_server, "POST", "/api/roster?from=3", auth.at, &auth.nonce, b"{\"a\":1}"),
            request_message(&server(), "POST", "/api/roster?from=3", auth.at + 1, &auth.nonce, b"{\"a\":1}"),
        ];
        for message in variants {
            assert_eq!(NonceCache::new().verify(&auth, &message, NOW), Err(AuthError::BadSignature));
        }
    }

    #[test]
    fn clock_skew_over_a_minute_is_reported_with_server_time() {
        let (late, message) = signed(NOW - 61);
        assert_eq!(NonceCache::new().verify(&late, &message, NOW), Err(AuthError::ClockSkew { server_now: NOW }));
        let (early, message) = signed(NOW + 61);
        assert_eq!(NonceCache::new().verify(&early, &message, NOW), Err(AuthError::ClockSkew { server_now: NOW }));
        let (edge, message) = signed(NOW - 60);
        assert_eq!(NonceCache::new().verify(&edge, &message, NOW), Ok(()));
    }

    #[test]
    fn nonces_are_forgotten_after_two_minutes() {
        let mut cache = NonceCache::new();
        let (first, message) = signed(NOW);
        cache.verify(&first, &message, NOW).unwrap();
        let (second, message) = signed(NOW + 121);
        cache.verify(&second, &message, NOW + 121).unwrap();
        assert_eq!(cache.len(), 1, "the first nonce is old enough to forget");
    }

    #[test]
    fn malformed_headers_are_rejected() {
        assert_eq!(parse_auth_header("Bearer abc"), Err(AuthError::Malformed));
        assert_eq!(parse_auth_header("HV1 !!!"), Err(AuthError::Malformed));
        let partial = crate::keys::encode_b64(br#"{"u":"x","t":1}"#);
        assert_eq!(parse_auth_header(&format!("HV1 {partial}")), Err(AuthError::Malformed));
        let long_nonce = serde_json::json!({
            "u": user().public(), "t": NOW, "n": "n".repeat(65), "s": user().sign(b"x"),
        });
        let long_nonce = crate::keys::encode_b64(long_nonce.to_string().as_bytes());
        assert_eq!(parse_auth_header(&format!("HV1 {long_nonce}")), Err(AuthError::Malformed));
    }

    #[test]
    fn hello_binds_the_nonce_and_the_journal_head() {
        let head = Digest([1; 32]);
        assert_ne!(hello_message("n1", &head), hello_message("n2", &head));
        assert_ne!(hello_message("n1", &head), hello_message("n1", &Digest([2; 32])));
    }

    #[test]
    fn profile_signature_covers_server_and_fields() {
        let profile = sign_profile(&user(), &server(), "  Петя ", "blue", NOW);
        assert_eq!(profile.nickname, "Петя");
        assert!(profile.verify(&server()));
        assert!(!profile.verify(&Identity::from_seed([3; 32]).public()), "another server");
        let mut renamed = profile.clone();
        renamed.nickname = "Вася".into();
        assert!(!renamed.verify(&server()));
        assert!(!sign_profile(&user(), &server(), "   ", "blue", NOW).verify(&server()), "empty nickname");
        assert!(!sign_profile(&user(), &server(), &"я".repeat(33), "blue", NOW).verify(&server()), "too long");
        let json = serde_json::to_string(&profile).unwrap();
        let back: SignedProfile = serde_json::from_str(&json).unwrap();
        assert!(back.verify(&server()));
    }
}
