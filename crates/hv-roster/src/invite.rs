//! Invite links: `hatavoice://<address>/#v=1&sk=<server key>&inv=<invite secret>[&by=<nickname>]`.
//!
//! The server key pins the server: a client only talks to a server that proves this key. The
//! invite secret is the seed of the invite key; it lives only in the fragment, which never
//! reaches the server, so the server can't let anyone in with somebody else's invite. `by` is the nickname of
//! whoever made the link (base64url): the newcomer sees it before they are in the group that knows the nicknames.

use crate::keys::{Identity, PublicKey, decode_b64, decode_b64_vec, encode_b64};

pub const SCHEME: &str = "hatavoice://";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteLink {
    pub address: String,
    pub server_key: PublicKey,
    pub secret: [u8; 32],
    /// The inviter's nickname, as they put it in the link; `None` when there is none or it is no nickname.
    pub by: Option<String>,
}

/// The longest nickname a link carries, as profiles have it.
const MAX_BY: usize = 32;

fn nickname(value: &str) -> Option<String> {
    let text = String::from_utf8(decode_b64_vec(value)?).ok()?;
    let text = text.trim();
    (!text.is_empty() && text.chars().count() <= MAX_BY).then(|| text.to_string())
}

impl InviteLink {
    pub fn to_link(&self) -> String {
        let by = self.by.as_ref().map(|by| format!("&by={}", encode_b64(by.as_bytes()))).unwrap_or_default();
        format!(
            "{SCHEME}{}/#v=1&sk={}&inv={}{by}",
            self.address,
            encode_b64(&self.server_key.0),
            encode_b64(&self.secret)
        )
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let bad = || "Это не приглашение ХатаВойс".to_string();
        let rest = text.trim().strip_prefix(SCHEME).ok_or_else(bad)?;
        let (address, fragment) = rest.split_once('#').ok_or_else(bad)?;
        let address = address.trim_end_matches('/');
        if address.is_empty() || address.contains(['/', ' ', '?', '@']) {
            return Err(bad());
        }

        let (mut version, mut server_key, mut secret, mut by, mut old) = (None, None, None, None, false);
        for pair in fragment.split('&') {
            match pair.split_once('=') {
                Some(("v", value)) => version = Some(value),
                Some(("sk", value)) => server_key = Some(value),
                Some(("inv", value)) => secret = Some(value),
                Some(("by", value)) => by = nickname(value),
                Some(("o" | "i", _)) => old = true,
                _ => {}
            }
        }
        if version.is_none() && old {
            return Err("Это ссылка от старой версии ХатаВойс — попроси у владельца новую".into());
        }
        match version {
            Some("1") => {}
            Some(_) => return Err("Ссылка от более новой версии ХатаВойс — обнови программу".into()),
            None => return Err(bad()),
        }
        let server_key = server_key
            .and_then(decode_b64::<32>)
            .map(PublicKey)
            .ok_or_else(|| "В приглашении испорчен ключ сервера".to_string())?;
        let secret = secret
            .and_then(decode_b64::<32>)
            .ok_or_else(|| "В приглашении испорчен ключ приглашения".to_string())?;
        Ok(Self { address: address.to_string(), server_key, secret, by })
    }

    /// The invite key that signs the join.
    pub fn identity(&self) -> Identity {
        Identity::from_seed(self.secret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> PublicKey {
        Identity::from_seed([1; 32]).public()
    }

    fn link(address: &str, secret: u8) -> InviteLink {
        InviteLink { address: address.into(), server_key: server(), secret: [secret; 32], by: None }
    }

    #[test]
    fn a_link_carries_the_inviters_nickname() {
        let invite = InviteLink { by: Some("Аня".into()), ..link("h:1", 3) };
        let text = invite.to_link();
        assert!(text.contains("&by="), "{text}");
        assert!(!text.contains("Аня"), "the nickname is base64url in the link");
        assert_eq!(InviteLink::parse(&text), Ok(invite));
        assert_eq!(InviteLink::parse(&link("h:1", 3).to_link()).unwrap().by, None);
        assert!(!link("h:1", 3).to_link().contains("by="), "no nickname, no parameter");
        let plain = link("h:1", 3).to_link();
        let long = format!("{plain}&by={}", encode_b64("я".repeat(33).as_bytes()));
        assert_eq!(InviteLink::parse(&long).unwrap().by, None, "longer than 32 characters");
        let broken = format!("{plain}&by={}", encode_b64(&[0xff, 0xfe]));
        assert_eq!(InviteLink::parse(&broken).unwrap().by, None, "not UTF-8");
        let blank = format!("{plain}&by={}", encode_b64(b"   "));
        assert_eq!(InviteLink::parse(&blank).unwrap().by, None, "only spaces");
    }

    #[test]
    fn v1_link_round_trips() {
        let invite = link("203.0.113.7:7350", 42);
        let text = invite.to_link();
        assert!(text.starts_with("hatavoice://203.0.113.7:7350/#v=1&sk="), "{text}");
        assert!(text.contains("&inv="));
        assert_eq!(InviteLink::parse(&text), Ok(invite));
    }

    #[test]
    fn accepts_ipv6_hostnames_whitespace_and_a_missing_slash() {
        let invite = link("[2001:db8::1]:7350", 7);
        assert_eq!(InviteLink::parse(&format!("  {}\n", invite.to_link())), Ok(invite.clone()));
        let no_slash = invite.to_link().replace("/#", "#");
        assert_eq!(InviteLink::parse(&no_slash), Ok(invite));
        let named = link("hata.duckdns.org:7350", 9);
        assert_eq!(InviteLink::parse(&named.to_link()), Ok(named));
    }

    #[test]
    fn rejects_plain_addresses_and_broken_links() {
        assert!(InviteLink::parse("203.0.113.7:7350").is_err());
        assert!(InviteLink::parse("hatavoice://203.0.113.7:7350/").is_err());
        let good = link("h:1", 1).to_link();
        assert!(InviteLink::parse(&good.replace("v=1", "v=2")).is_err(), "unknown version");
        assert!(InviteLink::parse(&good.replace("sk=", "sk=xx")).is_err(), "broken server key");
        assert!(InviteLink::parse(&good.replace("inv=", "inv=xx")).is_err(), "broken invite key");
        assert!(InviteLink::parse(&good.replace("&inv=", "&x=")).is_err(), "no invite key");
        assert!(InviteLink::parse(&good.replace("h:1", "")).is_err(), "no address");
    }

    #[test]
    fn old_links_explain_what_to_do() {
        let old = "hatavoice://203.0.113.7:7350/#o=aaaaaaaaaaaaaaaaaaaaaaaaaa&i=AAAA";
        let error = InviteLink::parse(old).unwrap_err();
        assert!(error.contains("старой версии"), "{error}");
    }
}
