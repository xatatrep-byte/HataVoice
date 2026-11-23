//! The worked examples in docs/protocol.md, pinned: if the wire format changes, this fails and
//! the document must change with it. Keys are seeds [1; 32] (owner) and [2; 32] (server).

use hv_roster::keys::encode_b64;
use hv_roster::request::{parse_auth_header, request_message};
use hv_roster::{Identity, sign_genesis};

const AT: u64 = 1_800_000_000;
const OWNER_KEY: &str = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w";
const SERVER_KEY: &str = "gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q";
const NONCE: &str = "bm9uY2UtMQ";
const REQUEST_SIGNATURE: &str = "55UaTvyyvmsEb07d_hDXnpYiUtyE5dnTH_W_IueuPrHRepCdyw0t5JJOGbBYFflCdnolurp-rd_tcA4L1Y0fDg";

fn owner() -> Identity {
    Identity::from_seed([1; 32])
}

fn server() -> Identity {
    Identity::from_seed([2; 32])
}

#[test]
fn keys_match_the_document() {
    assert_eq!(encode_b64(&owner().public().0), OWNER_KEY);
    assert_eq!(owner().public().user_id().0, "gr2q7gf5lh6pzfdnurnkvputhm");
    assert_eq!(encode_b64(&server().public().0), SERVER_KEY);
}

#[test]
fn genesis_matches_the_document() {
    let entry = sign_genesis(&owner(), &server(), "Хата", AT);
    let signed = format!(
        "{{\"domain\":\"hatavoice-roster-v1\",\"seq\":0,\"prev\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"at\":1800000000,\
         \"author\":\"{OWNER_KEY}\",\"body\":{{\"type\":\"genesis\",\"server_name\":\"Хата\",\"owner\":\"{OWNER_KEY}\",\"server_key\":\"{SERVER_KEY}\"}}}}"
    );
    assert_eq!(String::from_utf8(entry.signed_bytes()).unwrap(), signed);
    assert_eq!(
        encode_b64(&entry.signature.0),
        "uKbYd2QXjU8gkOPokfLuTFZ4T3NdPO4-WXjh8IVZsFlXs8h-94ysmuubqPDgG_i6zKRkK1cZqQUzahX0bUulAQ"
    );
    assert_eq!(
        encode_b64(&entry.server_signature.unwrap().0),
        "P0B150AY7nygVMQIDe5Lh0xST9TbFC_eaVwXx7bRsnrCa3s8sHO8U7Rbext57oHN4TpQUUgi_zqno379hEMKDA"
    );
    assert_eq!(encode_b64(&entry.hash().0), "oUC7NFM7apyvZoGM2EMKPQ-I-1LGCGl-hRaHo0aQibU");
}

#[test]
fn signed_request_matches_the_document() {
    let message = request_message(&server().public(), "GET", "/api/roster?from=0", AT, NONCE, b"");
    let expected = format!(
        "hatavoice-req-v1\n{SERVER_KEY}\nGET\n/api/roster?from=0\n1800000000\n{NONCE}\n\
         e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(String::from_utf8(message.clone()).unwrap(), expected);
    assert_eq!(encode_b64(&owner().sign(&message).0), REQUEST_SIGNATURE);

    let header = "HV1 eyJ1IjoiaW9qajNYUUo4Wlg5VXRzdFBMcGRjc3BuQ2I4ZGxCSWI4M1NJQWJRUGIxdyIsInQiOjE4MDAwMDAwMDAsIm4iOiJibTl1WTJVdE1RIiwicyI6IjU1VWFUdnl5dm1zRWIwN2RfaERYbnBZaVV0eUU1ZG5USF9XX0l1ZXVQckhSZXBDZHl3MHQ1SkpPR2JCWUZmbENkbm9sdXJwLXJkX3RjQTRMMVkwZkRnIn0";
    let auth = parse_auth_header(header).unwrap();
    assert_eq!((auth.user, auth.at, auth.nonce.as_str()), (owner().public(), AT, NONCE));
    assert_eq!(encode_b64(&auth.signature.0), REQUEST_SIGNATURE);
    assert!(owner().public().verify(&message, &auth.signature));
}
