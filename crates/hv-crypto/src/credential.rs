//! The proof that a call's temporary signature key belongs to a person.
//!
//! Every call group member signs with a key made just for that call. The credential in its leaf
//! node ties that key to the member's long-term identity key, for this group and channel only,
//! so a credential can't be lifted into another call and the server can't invent members.

use hv_roster::{Identity, PublicKey, Signature, UserId};

use crate::CallError;

pub const CRED_DOMAIN: &[u8] = b"hatavoice-call-cred-v1\n";

const VERSION: u8 = 1;
const MAX_CHANNEL_LEN: usize = 64;
/// Version, identity key, group id and the channel length byte.
const HEAD_LEN: usize = 1 + 32 + 16 + 1;
/// Leaf signature key and proof.
const TAIL_LEN: usize = 32 + 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallCredential {
    pub ik: PublicKey,
    pub group: [u8; 16],
    pub channel: String,
    /// The leaf's MLS signature public key.
    pub sig: [u8; 32],
    pub proof: Signature,
}

fn bad<T>(why: &str) -> Result<T, CallError> {
    Err(CallError::BadCredential(why.into()))
}

impl CallCredential {
    /// `channel` is a roster channel id, which the roster already limits to 1–64 bytes.
    pub fn sign(id: &Identity, group: [u8; 16], channel: &str, sig: [u8; 32]) -> Self {
        assert!((1..=MAX_CHANNEL_LEN).contains(&channel.len()), "channel id must be 1-64 bytes");
        let proof = id.sign(&Self::proof_message(&group, channel, &sig));
        Self { ik: id.public(), group, channel: channel.to_string(), sig, proof }
    }

    pub fn proof_message(group: &[u8; 16], channel: &str, sig: &[u8; 32]) -> Vec<u8> {
        let mut message = Vec::with_capacity(CRED_DOMAIN.len() + 16 + channel.len() + 32);
        message.extend_from_slice(CRED_DOMAIN);
        message.extend_from_slice(group);
        message.extend_from_slice(channel.as_bytes());
        message.extend_from_slice(sig);
        message
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let channel_len = u8::try_from(self.channel.len()).expect("channel id is at most 64 bytes");
        let mut bytes = Vec::with_capacity(HEAD_LEN + self.channel.len() + TAIL_LEN);
        bytes.push(VERSION);
        bytes.extend_from_slice(&self.ik.0);
        bytes.extend_from_slice(&self.group);
        bytes.push(channel_len);
        bytes.extend_from_slice(self.channel.as_bytes());
        bytes.extend_from_slice(&self.sig);
        bytes.extend_from_slice(&self.proof.0);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CallError> {
        if bytes.len() < HEAD_LEN {
            return bad("too short");
        }
        if bytes[0] != VERSION {
            return bad("unknown version");
        }
        let channel_len = usize::from(bytes[HEAD_LEN - 1]);
        if !(1..=MAX_CHANNEL_LEN).contains(&channel_len) {
            return bad("channel length out of range");
        }
        // Exact length: nothing may hide after the proof.
        if bytes.len() != HEAD_LEN + channel_len + TAIL_LEN {
            return bad("wrong length");
        }
        let channel_end = HEAD_LEN + channel_len;
        let Ok(channel) = std::str::from_utf8(&bytes[HEAD_LEN..channel_end]) else {
            return bad("channel is not UTF-8");
        };
        Ok(Self {
            ik: PublicKey(bytes[1..33].try_into().expect("fixed slice")),
            group: bytes[33..49].try_into().expect("fixed slice"),
            channel: channel.to_string(),
            sig: bytes[channel_end..channel_end + 32].try_into().expect("fixed slice"),
            proof: Signature(bytes[channel_end + 32..].try_into().expect("fixed slice")),
        })
    }

    /// The proof is valid, the group and channel are this call's, and `sig` is the key the leaf signs with.
    /// Ok is the person the leaf belongs to.
    pub fn check(&self, group: &[u8; 16], channel: &str, leaf_signature_key: &[u8]) -> Result<UserId, CallError> {
        if self.group != *group {
            return bad("another call");
        }
        if self.channel != channel {
            return bad("another channel");
        }
        if self.sig.as_slice() != leaf_signature_key {
            return bad("not the leaf's signature key");
        }
        if !self.ik.verify(&Self::proof_message(&self.group, &self.channel, &self.sig), &self.proof) {
            return bad("proof does not verify");
        }
        Ok(self.ik.user_id())
    }
}

#[cfg(test)]
mod tests {
    use hv_roster::{Identity, Signature};

    use super::*;
    use crate::CallError;

    fn credential() -> CallCredential {
        CallCredential::sign(&Identity::from_seed([1u8; 32]), [7u8; 16], "general", [9u8; 32])
    }

    fn is_bad(result: Result<impl std::fmt::Debug, CallError>) -> bool {
        matches!(result, Err(CallError::BadCredential(_)))
    }

    /// Bytes laid out as the spec says, with the version and channel under the test's control.
    fn raw(version: u8, channel: &[u8]) -> Vec<u8> {
        let mut bytes = vec![version];
        bytes.extend_from_slice(&[1u8; 32]);
        bytes.extend_from_slice(&[7u8; 16]);
        bytes.push(channel.len() as u8);
        bytes.extend_from_slice(channel);
        bytes.extend_from_slice(&[9u8; 32]);
        bytes.extend_from_slice(&[0u8; 64]);
        bytes
    }

    #[test]
    fn credential_round_trips_through_bytes() {
        let cred = credential();
        let bytes = cred.to_bytes();
        assert_eq!(bytes[0], 1);
        assert_eq!(bytes.len(), 1 + 32 + 16 + 1 + 7 + 32 + 64);
        assert_eq!(CallCredential::from_bytes(&bytes), Ok(cred));
    }

    #[test]
    fn credential_check_accepts_its_own_call() {
        let expected = Identity::from_seed([1u8; 32]).public().user_id();
        assert_eq!(credential().check(&[7u8; 16], "general", &[9u8; 32]), Ok(expected));
    }

    #[test]
    fn credential_check_refuses_another_group_channel_or_leaf_key() {
        let cred = credential();
        assert!(is_bad(cred.check(&[8u8; 16], "general", &[9u8; 32])));
        assert!(is_bad(cred.check(&[7u8; 16], "afk", &[9u8; 32])));
        assert!(is_bad(cred.check(&[7u8; 16], "general", &[10u8; 32])));
        assert!(is_bad(cred.check(&[7u8; 16], "general", &[9u8; 31])));
    }

    #[test]
    fn tampered_proof_is_refused() {
        let mut cred = credential();
        cred.proof = Signature({
            let mut bytes = cred.proof.0;
            bytes[10] ^= 1;
            bytes
        });
        assert!(is_bad(cred.check(&[7u8; 16], "general", &[9u8; 32])));
    }

    #[test]
    fn proof_of_another_identity_is_refused() {
        let mut cred = credential();
        cred.ik = Identity::from_seed([2u8; 32]).public();
        assert!(is_bad(cred.check(&[7u8; 16], "general", &[9u8; 32])));
    }

    #[test]
    fn malformed_credentials_are_refused() {
        assert!(is_bad(CallCredential::from_bytes(&[])));
        assert!(is_bad(CallCredential::from_bytes(&raw(2, b"general"))));
        assert!(is_bad(CallCredential::from_bytes(&raw(1, b""))));
        assert!(is_bad(CallCredential::from_bytes(&raw(1, &[b'a'; 65]))));
        assert!(is_bad(CallCredential::from_bytes(&raw(1, &[0xff, 0xfe]))));

        let good = raw(1, b"general");
        assert!(CallCredential::from_bytes(&good).is_ok());
        assert!(CallCredential::from_bytes(&raw(1, &[b'a'; 64])).is_ok());
        for cut in 0..good.len() {
            assert!(is_bad(CallCredential::from_bytes(&good[..cut])), "cut at {cut}");
        }
        let mut longer = good;
        longer.push(0);
        assert!(is_bad(CallCredential::from_bytes(&longer)));
    }
}
