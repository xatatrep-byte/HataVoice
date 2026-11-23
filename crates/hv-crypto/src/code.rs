//! What members of a call can compare out loud, and how the call's key material is labelled.

/// Exporter label for the per-sender frame keys.
pub const MEDIA_LABEL: &str = "HataVoice media v1";
/// LiveKit keeps this many keys per sender; the key index is `epoch % KEYRING`.
pub const KEYRING: u64 = 16;

/// Exporter context for a sender's frame key: leaf index, then epoch, both big-endian.
pub fn media_context(leaf: u32, epoch: u64) -> [u8; 12] {
    let mut context = [0u8; 12];
    context[..4].copy_from_slice(&leaf.to_be_bytes());
    context[4..].copy_from_slice(&epoch.to_be_bytes());
    context
}

/// Six groups of five digits from the epoch authenticator, for members to read out to each other:
/// a man in the middle holds different group state and so shows different digits.
/// Empty when there is less than 30 bytes to take them from.
pub fn call_code(authenticator: &[u8]) -> String {
    if authenticator.len() < 30 {
        return String::new();
    }
    let (chunks, _) = authenticator[..30].as_chunks::<5>();
    chunks
        .iter()
        .map(|chunk| {
            let value = chunk.iter().fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte));
            format!("{:05}", value % 100_000)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_code_is_six_groups_of_five_digits() {
        assert_eq!(call_code(&[0u8; 32]), "00000 00000 00000 00000 00000 00000");
        // 0x0001020304 = 16909060 -> 09060, 0x0506070809 = 21575960585 -> 60585, ...
        let counting: Vec<u8> = (0..32).collect();
        assert_eq!(call_code(&counting), "09060 60585 12110 63635 15160 66685");
    }

    #[test]
    fn call_code_ignores_bytes_past_the_first_thirty() {
        let mut long = vec![5u8; 32];
        let code = call_code(&long);
        long[30] = 200;
        long[31] = 100;
        assert_eq!(call_code(&long), code);
    }

    #[test]
    fn call_code_is_empty_without_enough_material() {
        assert_eq!(call_code(&[]), "");
        assert_eq!(call_code(&[1u8; 29]), "");
        assert_ne!(call_code(&[1u8; 30]), "");
    }

    #[test]
    fn media_context_is_leaf_then_epoch_big_endian() {
        assert_eq!(media_context(3, 7), [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 7]);
        assert_eq!(media_context(0x0102_0304, 0x0506_0708_090a_0b0c), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
}
