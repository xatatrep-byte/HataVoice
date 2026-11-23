//! Identity keys (Ed25519), user ids and signatures.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

const B64: data_encoding::Encoding = data_encoding::BASE64URL_NOPAD;

/// A user's long-term key pair. The secret never leaves the device (except in an encrypted export).
pub struct Identity {
    signing: ed25519_dalek::SigningKey,
}

/// Ed25519 public key.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicKey(pub [u8; 32]);

/// Ed25519 signature.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Signature(pub [u8; 64]);

/// SHA-256 hash, e.g. of a roster entry.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Digest(pub [u8; 32]);

impl fmt::Debug for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Digest({}…)", &encode_b64(&self.0)[..8])
    }
}

/// Stable user id derived from the public key: base32 of the first 16 bytes of its SHA-256.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct UserId(pub String);

impl Identity {
    pub fn generate() -> Result<Self, String> {
        Ok(Self::from_seed(random_bytes()?))
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self { signing: ed25519_dalek::SigningKey::from_bytes(&seed) }
    }

    pub fn seed(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    pub fn public(&self) -> PublicKey {
        PublicKey(self.signing.verifying_key().to_bytes())
    }

    pub fn sign(&self, message: &[u8]) -> Signature {
        use ed25519_dalek::Signer;
        Signature(self.signing.sign(message).to_bytes())
    }
}

impl PublicKey {
    /// Strict verification: rejects malleable signatures and weak keys.
    pub fn verify(&self, message: &[u8], signature: &Signature) -> bool {
        let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&self.0) else {
            return false;
        };
        let signature = ed25519_dalek::Signature::from_bytes(&signature.0);
        key.verify_strict(message, &signature).is_ok()
    }

    pub fn user_id(&self) -> UserId {
        let hash = sha256(&self.0);
        UserId(data_encoding::BASE32_NOPAD.encode(&hash[..16]).to_lowercase())
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(data).into()
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| format!("Нет источника случайности: {e}"))?;
    Ok(buf)
}

/// Lowercase base32 without padding: what a 3D character's code in a profile may hold.
pub fn encode_b32(bytes: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(bytes).to_lowercase()
}

pub fn decode_b32<const N: usize>(text: &str) -> Option<[u8; N]> {
    data_encoding::BASE32_NOPAD.decode(text.to_uppercase().as_bytes()).ok()?.try_into().ok()
}

pub fn encode_b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn decode_b64<const N: usize>(text: &str) -> Option<[u8; N]> {
    B64.decode(text.as_bytes()).ok()?.try_into().ok()
}

pub fn decode_b64_vec(text: &str) -> Option<Vec<u8>> {
    B64.decode(text.as_bytes()).ok()
}

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "UserId({})", self.0)
    }
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({})", encode_b64(&self.0))
    }
}

impl fmt::Debug for Signature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Signature({}…)", &encode_b64(&self.0)[..8])
    }
}

macro_rules! b64_serde {
    ($ty:ident, $len:expr) => {
        impl Serialize for $ty {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&encode_b64(&self.0))
            }
        }
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = String::deserialize(d)?;
                decode_b64::<$len>(&text)
                    .map($ty)
                    .ok_or_else(|| serde::de::Error::custom(concat!("invalid ", stringify!($ty))))
            }
        }
    };
}
b64_serde!(PublicKey, 32);
b64_serde!(Signature, 64);
b64_serde!(Digest, 32);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_verify_only_for_the_right_key_and_message() {
        let alice = Identity::generate().unwrap();
        let bob = Identity::generate().unwrap();
        let sig = alice.sign(b"hello");
        assert!(alice.public().verify(b"hello", &sig));
        assert!(!alice.public().verify(b"hellO", &sig));
        assert!(!bob.public().verify(b"hello", &sig));
    }

    #[test]
    fn seed_round_trip_gives_the_same_key() {
        let a = Identity::generate().unwrap();
        let b = Identity::from_seed(a.seed());
        assert_eq!(a.public(), b.public());
    }

    #[test]
    fn user_id_is_stable_26_char_base32() {
        let key = Identity::from_seed([7u8; 32]).public();
        let id = key.user_id();
        assert_eq!(id, key.user_id());
        assert_eq!(id.0.len(), 26);
        assert!(id.0.chars().all(|c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)));
        assert_ne!(id, Identity::from_seed([8u8; 32]).public().user_id());
    }

    #[test]
    fn keys_and_signatures_serialize_as_base64url() {
        let id = Identity::from_seed([1u8; 32]);
        let json = serde_json::to_string(&id.public()).unwrap();
        let back: PublicKey = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id.public());

        let sig = id.sign(b"x");
        let back: Signature = serde_json::from_str(&serde_json::to_string(&sig).unwrap()).unwrap();
        assert_eq!(back, sig);

        assert!(serde_json::from_str::<PublicKey>("\"too-short\"").is_err());
    }

    #[test]
    fn garbage_public_key_never_verifies() {
        let sig = Identity::generate().unwrap().sign(b"m");
        assert!(!PublicKey([0u8; 32]).verify(b"m", &sig));
    }
}
