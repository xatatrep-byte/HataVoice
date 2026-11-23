//! The action log as the server sends it, checked here: a journal line must be an entry of the
//! journal this client verified itself, a command line must carry its author's signature over
//! the exact body that was sent. Lines that fail are shown as unconfirmed; what is shown of a
//! confirmed line (the reason, say) comes from the signed data, not from the server's copy.

use hv_roster::keys::encode_b64;
use hv_roster::request::{MAX_SKEW_SECS, parse_auth_header, request_message};
use hv_roster::{PublicKey, Roster};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Moderation commands are always posted here; the signature covers the path.
const MODERATION_PATH: &str = "/api/moderation";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub at: u64,
    pub actor: String,
    pub kind: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub detail: Value,
    #[serde(default, skip_serializing)]
    pub auth: Option<String>,
    #[serde(default, skip_serializing)]
    pub signature: Option<String>,
    #[serde(default, skip_serializing)]
    pub request_body: Option<String>,
    /// Set here, never taken from the server.
    #[serde(default)]
    pub verified: bool,
}

/// The journal entry this line claims to be, if the verified journal has it as claimed.
fn journal_body(entry: &AuditEntry, roster: &Roster) -> Option<Value> {
    let signature = entry.signature.as_ref()?;
    roster.entries().iter().find_map(|e| {
        let body = serde_json::to_value(&e.body).ok()?;
        let same = encode_b64(&e.signature.0) == *signature && e.author.user_id().0 == entry.actor && body["type"] == entry.kind.as_str();
        same.then_some(body)
    })
}

/// The command this line claims to be, if its author really signed exactly that.
fn signed_command(entry: &AuditEntry, server_key: &PublicKey) -> Option<Value> {
    let auth = parse_auth_header(entry.auth.as_ref()?).ok()?;
    let body = entry.request_body.as_ref()?;
    if auth.user.user_id().0 != entry.actor || auth.at.abs_diff(entry.at) > MAX_SKEW_SECS {
        return None;
    }
    let message = request_message(server_key, "POST", MODERATION_PATH, auth.at, &auth.nonce, body.as_bytes());
    if !auth.user.verify(&message, &auth.signature) {
        return None;
    }
    let command: Value = serde_json::from_str(body).ok()?;
    (command["action"] == entry.kind.as_str() && command["user"].as_str() == entry.target.as_deref()).then_some(command)
}

pub fn verify_entries(entries: Vec<AuditEntry>, roster: &Roster, server_key: &PublicKey) -> Vec<AuditEntry> {
    entries
        .into_iter()
        .map(|mut entry| {
            let signed = journal_body(&entry, roster).or_else(|| signed_command(&entry, server_key));
            entry.verified = signed.is_some();
            if let Some(detail) = signed {
                entry.detail = detail;
            }
            entry
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use hv_roster::keys::encode_b64;
    use hv_roster::request::sign_request;
    use hv_roster::{Body, Identity, Roster, sign_entry, sign_genesis, sign_join};
    use serde_json::json;

    use super::*;

    const T0: u64 = 1_800_000_000;

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn server() -> Identity {
        id(100)
    }

    /// Owner 1 and member 2; member 2 was kicked by the owner. Returns the kick's signature.
    fn roster() -> (Roster, String) {
        let mut r = Roster::new();
        r.apply(sign_genesis(&id(1), &server(), "Хата", T0)).unwrap();
        let invite = Identity::generate().unwrap();
        let body = Body::InviteCreate { invite: invite.public(), roles: vec![], max_uses: None, expires_at: None };
        let entry = sign_entry(&r, &id(1), T0, body);
        r.apply(entry).unwrap();
        let join = sign_join(&r, &id(2), &invite, T0);
        r.apply(join).unwrap();
        let kick = sign_entry(&r, &id(1), T0, Body::Kick { user: id(2).public().user_id(), reason: "Хватит".into(), media: None });
        let signature = encode_b64(&kick.signature.0);
        r.apply(kick).unwrap();
        (r, signature)
    }

    fn line(actor: u8, kind: &str, target: Option<u8>) -> AuditEntry {
        AuditEntry {
            at: T0,
            actor: id(actor).public().user_id().0,
            kind: kind.into(),
            target: target.map(|n| id(n).public().user_id().0),
            detail: json!({}),
            auth: None,
            signature: None,
            request_body: None,
            verified: false,
        }
    }

    fn command(signer: u8, actor: u8, body: &str) -> AuditEntry {
        let header = sign_request(&id(signer), &server().public(), "POST", "/api/moderation", body.as_bytes(), T0).unwrap();
        AuditEntry { auth: Some(header), request_body: Some(body.into()), ..line(actor, "mute", Some(2)) }
    }

    #[test]
    fn journal_lines_are_checked_against_the_verified_journal() {
        let (roster, kick) = roster();
        let genuine = AuditEntry { signature: Some(kick.clone()), ..line(1, "kick", Some(2)) };
        let forged_signature = AuditEntry { signature: Some(encode_b64(&[7u8; 64])), ..line(1, "kick", Some(2)) };
        let wrong_author = AuditEntry { signature: Some(kick.clone()), ..line(2, "kick", Some(2)) };
        let wrong_kind = AuditEntry { signature: Some(kick), ..line(1, "ban", Some(2)) };
        let checked = verify_entries(vec![genuine, forged_signature, wrong_author, wrong_kind], &roster, &server().public());
        assert_eq!(checked.iter().map(|e| e.verified).collect::<Vec<_>>(), [true, false, false, false]);
    }

    #[test]
    fn commands_are_checked_against_their_own_signature() {
        let (roster, _) = roster();
        let target = id(2).public().user_id().0;
        let body = json!({ "action": "mute", "user": target, "minutes": 5, "reason": "Шум" }).to_string();
        let genuine = command(1, 1, &body);
        let tampered = AuditEntry { request_body: Some(body.replace("Шум", "Мат")), ..command(1, 1, &body) };
        let someone_else = command(3, 1, &body);
        let unsigned = line(1, "mute", Some(2));
        let other_action = AuditEntry { kind: "unmute".into(), ..command(1, 1, &body) };
        let checked = verify_entries(vec![genuine, tampered, someone_else, unsigned, other_action], &roster, &server().public());
        assert_eq!(checked.iter().map(|e| e.verified).collect::<Vec<_>>(), [true, false, false, false, false]);
    }
}
