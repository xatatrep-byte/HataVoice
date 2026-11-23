//! The worked examples of the call wire format in docs/protocol.md, pinned: if the format changes, this
//! fails and the document must change with it. The identity is the seed [1; 32], the call group id is
//! [7; 16], the channel is "general" and the leaf's signature key is [9; 32].

use hv_crypto::code::{KEYRING, MEDIA_LABEL, call_code, media_context};
use hv_crypto::credential::{CRED_DOMAIN, CallCredential};
use hv_crypto::group::CIPHERSUITE;
use hv_roster::Identity;
use hv_roster::keys::encode_b64;

const GROUP: [u8; 16] = [7; 16];
const CHANNEL: &str = "general";
const LEAF_KEY: [u8; 32] = [9; 32];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn identity() -> Identity {
    Identity::from_seed([1; 32])
}

fn credential() -> CallCredential {
    CallCredential::sign(&identity(), GROUP, CHANNEL, LEAF_KEY)
}

#[test]
fn call_credential_matches_the_document() {
    let credential = credential();
    assert_eq!(
        hex(&CallCredential::proof_message(&GROUP, CHANNEL, &LEAF_KEY)),
        "68617461766f6963652d63616c6c2d637265642d76310a0707070707070707070707070707070767656e6572616c0909090909090909090909090909090909090909090909090909090909090909"
    );
    assert_eq!(encode_b64(&credential.proof.0), "57LOK-EuZD5ZB8pPSGbpzUa6lEAzQVvtMBZAsqmw8dEeH57R3DzkGM4sf5V0nn8odX9d2G5waIj-dSjcSsbWDg");
    assert_eq!(
        hex(&credential.to_bytes()),
        "018a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c070707070707070707070707070707070767656e6572616c0909090909090909090909090909090909090909090909090909090909090909e7b2ce2be12e643e5907ca4f4866e9cd46ba944033415bed301640b2a9b0f1d11e1f9ed1dc3ce418ce2c7f95749e7f28757f5dd86e706888fe7528dc4ac6d60e"
    );
    assert_eq!(
        encode_b64(&credential.to_bytes()),
        "AYqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29cBwcHBwcHBwcHBwcHBwcHBwdnZW5lcmFsCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQnnss4r4S5kPlkHyk9IZunNRrqUQDNBW-0wFkCyqbDx0R4fntHcPOQYzix_lXSefyh1f13YbnBoiP51KNxKxtYO"
    );
}

#[test]
fn call_credential_layout_and_rule_follow_the_document() {
    // Built by hand from the document's layout, not by the library: 0x01 ‖ ik ‖ group ‖ len ‖ channel ‖ sig ‖ proof.
    let ik = identity().public();
    let mut message = b"hatavoice-call-cred-v1\n".to_vec();
    message.extend_from_slice(&GROUP);
    message.extend_from_slice(CHANNEL.as_bytes());
    message.extend_from_slice(&LEAF_KEY);
    let proof = identity().sign(&message);

    let mut bytes = vec![0x01];
    bytes.extend_from_slice(&ik.0);
    bytes.extend_from_slice(&GROUP);
    bytes.push(u8::try_from(CHANNEL.len()).unwrap());
    bytes.extend_from_slice(CHANNEL.as_bytes());
    bytes.extend_from_slice(&LEAF_KEY);
    bytes.extend_from_slice(&proof.0);
    assert_eq!(bytes, credential().to_bytes());
    assert_eq!(bytes.len(), 1 + 32 + 16 + 1 + CHANNEL.len() + 32 + 64);

    // What a member does with a leaf: parse, check the proof and the call, take the person.
    let parsed = CallCredential::from_bytes(&bytes).unwrap();
    assert_eq!(parsed.check(&GROUP, CHANNEL, &LEAF_KEY).unwrap().0, "gr2q7gf5lh6pzfdnurnkvputhm");
    assert!(parsed.check(&[8; 16], CHANNEL, &LEAF_KEY).is_err());
    assert!(parsed.check(&GROUP, "afk", &LEAF_KEY).is_err());
    assert!(parsed.check(&GROUP, CHANNEL, &[10; 32]).is_err());
}

#[test]
fn ciphersuite_is_the_one_the_document_names() {
    // RFC 9420 codepoint of the draft X-Wing suite: 0x004D.
    assert_eq!(format!("{CIPHERSUITE:?}"), "MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519");
    assert_eq!(u16::from(CIPHERSUITE), 0x004D);
}

#[test]
fn call_code_matches_the_document() {
    let counting: Vec<u8> = (0..32).collect();
    assert_eq!(call_code(&counting), "09060 60585 12110 63635 15160 66685");
}

#[test]
fn media_context_matches_the_document() {
    assert_eq!(hex(&media_context(3, 7)), "000000030000000000000007");
    assert_eq!(MEDIA_LABEL, "HataVoice media v1");
    // The key index in LiveKit's ring of keys.
    assert_eq!(KEYRING, 16);
    assert_eq!([0u64, 1, 15, 16, 17].map(|epoch| epoch % KEYRING), [0, 1, 15, 0, 1]);
    assert_eq!(CRED_DOMAIN, b"hatavoice-call-cred-v1\n");
}
