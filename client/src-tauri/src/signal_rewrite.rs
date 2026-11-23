//! A call over a tunnel: the server tells WebRTC where its media is, in addresses this PC cannot reach. On the way from
//! the server to the window (`bridge`) each such address is replaced by the tunnel's local UDP port. The rest of the
//! LiveKit signal passes untouched, and media stays encrypted end to end whichever way it goes.

use std::net::SocketAddr;

// The fields of LiveKit's protobuf messages that carry addresses.
const RESPONSE_ANSWER: u64 = 2;
const RESPONSE_OFFER: u64 = 3;
const RESPONSE_TRICKLE: u64 = 4;
const REQUEST_OFFER: u64 = 1;
const REQUEST_ANSWER: u64 = 2;
const REQUEST_TRICKLE: u64 = 3;
const DESCRIPTION_SDP: u64 = 2;
const TRICKLE_CANDIDATE: u64 = 1;

fn read_varint(data: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *data.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// What to do with a length-delimited field.
enum Change {
    Keep,
    Replace(Vec<u8>),
    /// The whole message is of no use: nothing goes on.
    Drop,
}

/// A message with `change` applied to its length-delimited fields; every other field is carried over byte for byte.
/// None when it is not protobuf at all, or a change dropped it.
fn rewrite_fields(message: &[u8], mut change: impl FnMut(u64, &[u8]) -> Change) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(message.len());
    let mut at = 0;
    while at < message.len() {
        let start = at;
        let key = read_varint(message, &mut at)?;
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => {
                read_varint(message, &mut at)?;
            }
            1 => at = at.checked_add(8)?,
            5 => at = at.checked_add(4)?,
            2 => {
                let length = usize::try_from(read_varint(message, &mut at)?).ok()?;
                let end = at.checked_add(length)?;
                let value = message.get(at..end)?;
                at = end;
                match change(field, value) {
                    Change::Keep => {}
                    Change::Drop => return None,
                    Change::Replace(new) => {
                        write_varint(&mut out, key);
                        write_varint(&mut out, new.len() as u64);
                        out.extend_from_slice(&new);
                        continue;
                    }
                }
            }
            _ => return None,
        }
        out.extend_from_slice(message.get(start..at)?);
    }
    Some(out)
}

/// `candidate:… udp <priority> <ip> <port> typ …` going to the tunnel; None for a TCP one, which it does not carry.
fn candidate_through_tunnel(candidate: &str, tunnel: SocketAddr) -> Option<String> {
    let mut parts: Vec<&str> = candidate.split(' ').collect();
    if parts.len() < 8 || !parts[2].eq_ignore_ascii_case("udp") {
        return None;
    }
    let (ip, port) = (tunnel.ip().to_string(), tunnel.port().to_string());
    parts[4] = &ip;
    parts[5] = &port;
    Some(parts.join(" "))
}

/// An SDP with its candidates going to the tunnel, one for each media section; the first is enough.
pub fn rewrite_sdp(sdp: &str, tunnel: SocketAddr) -> String {
    let newline = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines = Vec::new();
    let mut placed = false;
    for line in sdp.split(newline) {
        if line.starts_with("m=") {
            placed = false;
        }
        match line.strip_prefix("a=") {
            Some(rest) if rest.starts_with("candidate:") => {
                if placed {
                    continue;
                }
                if let Some(changed) = candidate_through_tunnel(rest, tunnel) {
                    lines.push(format!("a={changed}"));
                    placed = true;
                }
            }
            _ => lines.push(line.to_string()),
        }
    }
    lines.join(newline)
}

/// An SDP with no candidates: the server has nothing to do with this PC's own addresses, and is not told them.
fn without_candidates(sdp: &str) -> String {
    let newline = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    sdp.split(newline).filter(|line| !line.starts_with("a=candidate:")).collect::<Vec<_>>().join(newline)
}

/// A trickled candidate (`{"candidate":"candidate:…", …}`) going to the tunnel; None for one to drop.
fn rewrite_trickle(json: &str, tunnel: SocketAddr) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(json).ok()?;
    let candidate = value.get("candidate")?.as_str()?;
    // The last, empty one says that there are no more.
    if candidate.is_empty() {
        return Some(json.to_string());
    }
    let changed = candidate_through_tunnel(candidate, tunnel)?;
    value["candidate"] = serde_json::Value::String(changed);
    Some(value.to_string())
}

fn rewrite_description(description: &[u8], rewrite: impl Fn(&str) -> String) -> Option<Vec<u8>> {
    rewrite_fields(description, |field, value| {
        if field != DESCRIPTION_SDP {
            return Change::Keep;
        }
        match std::str::from_utf8(value) {
            Ok(sdp) => Change::Replace(rewrite(sdp).into_bytes()),
            Err(_) => Change::Keep,
        }
    })
}

/// A frame of LiveKit's signal to the server, with this PC's addresses left out: over a tunnel the server's only way here
/// is the tunnel, and it learns no IP. None when nothing is left of the frame (a trickled candidate).
pub fn rewrite_request(frame: &[u8]) -> Option<Vec<u8>> {
    let mut dropped = false;
    let out = rewrite_fields(frame, |field, value| match field {
        REQUEST_OFFER | REQUEST_ANSWER => match rewrite_description(value, without_candidates) {
            Some(new) => Change::Replace(new),
            None => Change::Keep,
        },
        REQUEST_TRICKLE => {
            dropped = true;
            Change::Drop
        }
        _ => Change::Keep,
    });
    match out {
        Some(out) => Some(out),
        None if dropped => None,
        None => Some(frame.to_vec()),
    }
}

/// A frame of LiveKit's signal from the server, with its addresses going to the `tunnel`. None when it says nothing of use
/// over a tunnel (a TCP candidate).
pub fn rewrite_signal(frame: &[u8], tunnel: SocketAddr) -> Option<Vec<u8>> {
    let mut changed = false;
    let out = rewrite_fields(frame, |field, value| match field {
        RESPONSE_ANSWER | RESPONSE_OFFER => match rewrite_description(value, |sdp| rewrite_sdp(sdp, tunnel)) {
            Some(new) => {
                changed = true;
                Change::Replace(new)
            }
            None => Change::Keep,
        },
        RESPONSE_TRICKLE => {
            changed = true;
            let inner = rewrite_fields(value, |field, value| {
                if field != TRICKLE_CANDIDATE {
                    return Change::Keep;
                }
                let Ok(json) = std::str::from_utf8(value) else { return Change::Keep };
                match rewrite_trickle(json, tunnel) {
                    Some(new) => Change::Replace(new.into_bytes()),
                    None => Change::Drop,
                }
            });
            match inner {
                Some(new) => Change::Replace(new),
                None => Change::Drop,
            }
        }
        _ => Change::Keep,
    });
    match out {
        Some(out) => Some(out),
        // Not a message of this shape, or a dropped candidate: anything else passes as it came.
        None if changed => None,
        None => Some(frame.to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tunnel() -> SocketAddr {
        "192.168.0.9:5000".parse().unwrap()
    }

    fn field(number: u64, value: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_varint(&mut out, number << 3 | 2);
        write_varint(&mut out, value.len() as u64);
        out.extend_from_slice(value);
        out
    }

    const SDP: &str = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=candidate:1 1 udp 2130706431 192.168.0.5 7882 typ host\r\na=candidate:2 1 udp 2130706431 203.0.113.7 7882 typ srflx raddr 192.168.0.5 rport 7882\r\na=candidate:3 1 tcp 1671430143 192.168.0.5 7881 typ host tcptype passive\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=candidate:4 1 tcp 1671430143 192.168.0.5 7881 typ host tcptype passive\r\na=candidate:5 1 udp 2130706431 192.168.0.5 7882 typ host\r\n";

    #[test]
    fn an_sdp_points_at_the_tunnel() {
        let sdp = rewrite_sdp(SDP, tunnel());
        assert!(!sdp.contains("192.168.0.5 "), "{sdp}");
        assert!(!sdp.contains("203.0.113.7 "), "{sdp}");
        assert!(!sdp.contains(" tcp "), "{sdp}");
        assert_eq!(sdp.matches("a=candidate:").count(), 2, "one for each media section: {sdp}");
        assert!(sdp.contains("a=candidate:1 1 udp 2130706431 192.168.0.9 5000 typ host"), "{sdp}");
        assert!(sdp.contains("a=candidate:5 1 udp 2130706431 192.168.0.9 5000 typ host"), "{sdp}");
        assert!(sdp.contains("a=mid:0\r\n"), "the rest stays: {sdp}");
    }

    #[test]
    fn an_offer_in_a_signal_points_at_the_tunnel_and_the_rest_stays() {
        let description = [field(1, b"offer"), field(2, SDP.as_bytes())].concat();
        let frame = [field(RESPONSE_OFFER, &description), vec![0x48, 0x07]].concat();
        let out = rewrite_signal(&frame, tunnel()).unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("192.168.0.9 5000"), "{text}");
        assert!(!text.contains("192.168.0.5 7882 typ host"), "{text}");
        assert!(text.contains("offer"));
        assert_eq!(&out[out.len() - 2..], &[0x48, 0x07], "a field it does not know of is carried over");
    }

    #[test]
    fn a_trickled_candidate_points_at_the_tunnel_and_a_tcp_one_goes() {
        let udp = r#"{"candidate":"candidate:1 1 udp 2130706431 192.168.0.5 7882 typ host","sdpMid":"0"}"#;
        let frame = field(RESPONSE_TRICKLE, &[field(TRICKLE_CANDIDATE, udp.as_bytes()), vec![0x10, 0x01]].concat());
        let out = rewrite_signal(&frame, tunnel()).unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("192.168.0.9 5000"), "{text}");
        assert!(text.contains("sdpMid"), "{text}");
        assert_eq!(&out[out.len() - 2..], &[0x10, 0x01]);

        let tcp = r#"{"candidate":"candidate:3 1 tcp 1671430143 192.168.0.5 7881 typ host tcptype passive"}"#;
        assert_eq!(rewrite_signal(&field(RESPONSE_TRICKLE, &field(TRICKLE_CANDIDATE, tcp.as_bytes())), tunnel()), None);

        let last = r#"{"candidate":"","sdpMid":"0"}"#;
        assert!(rewrite_signal(&field(RESPONSE_TRICKLE, &field(TRICKLE_CANDIDATE, last.as_bytes())), tunnel()).is_some());
    }

    #[test]
    fn this_pcs_addresses_do_not_reach_the_server() {
        let description = [field(1, b"offer"), field(2, SDP.as_bytes())].concat();
        let out = rewrite_request(&field(REQUEST_OFFER, &description)).unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(!text.contains("a=candidate"), "{text}");
        assert!(!text.contains("192.168.0.5 "), "{text}");
        assert!(text.contains("a=mid:0\r\n"), "{text}");

        let trickle = field(REQUEST_TRICKLE, &field(TRICKLE_CANDIDATE, br#"{"candidate":"candidate:1 1 udp 1 192.168.0.5 7882 typ host"}"#));
        assert_eq!(rewrite_request(&trickle), None);

        let other = field(9, b"mute");
        assert_eq!(rewrite_request(&other).unwrap(), other);
        assert_eq!(rewrite_request(b"\xff\xff\xff not protobuf").unwrap(), b"\xff\xff\xff not protobuf");
    }

    #[test]
    fn other_messages_and_noise_pass_as_they_came() {
        let join = field(1, b"whatever the join says");
        assert_eq!(rewrite_signal(&join, tunnel()).unwrap(), join);
        assert_eq!(rewrite_signal(b"\xff\xff\xff not protobuf", tunnel()).unwrap(), b"\xff\xff\xff not protobuf");
        assert_eq!(rewrite_signal(b"", tunnel()).unwrap(), b"");
    }

    #[test]
    fn long_lengths_survive() {
        let mut out = Vec::new();
        write_varint(&mut out, 300);
        let mut at = 0;
        assert_eq!(read_varint(&out, &mut at), Some(300));
        assert_eq!(at, 2);
    }
}
