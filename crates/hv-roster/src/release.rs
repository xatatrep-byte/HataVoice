//! A release of the program: an installer that says which version it is and carries the publisher's signature at its
//! very end. A friend's server only hands the file on; the program runs it only if the signature is the publisher's and
//! the version is newer than its own, so neither a server nor anyone on the way can slip in another program or an old one.
//!
//! The end of the file: `installer | version | version length (1 byte) | signature (64 bytes) | MAGIC`.
//! NSIS checks only the bytes its header counts, so what follows them does not disturb the installer.

use crate::keys::{Identity, PublicKey, Signature, sha256};

const MAGIC: &[u8; 8] = b"HVREL1\0\0";
const CONTEXT: &[u8] = b"hatavoice-release-v1\0";
const MAX_VERSION: usize = 32;

/// How much of the end of a file holds everything [`tail_version`] needs.
pub const TAIL: usize = MAX_VERSION + 1 + 64 + MAGIC.len();

fn message(version: &str, installer: &[u8]) -> Vec<u8> {
    let mut message = CONTEXT.to_vec();
    message.extend_from_slice(version.as_bytes());
    message.push(0);
    message.extend_from_slice(&sha256(installer));
    message
}

/// The numbers of a plain `1.2.3` version; nothing else counts as one.
fn numbers(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut out = [0; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// Is `candidate` a later version than `current`? Anything that is not a plain version is not.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    matches!((numbers(candidate), numbers(current)), (Some(a), Some(b)) if a > b)
}

/// The version an end of a file says it is, and where its signature starts counted from the end. Says nothing about
/// whether that is true.
fn parse_tail(file: &[u8]) -> Option<(&str, &[u8], usize)> {
    let end = file.len().checked_sub(MAGIC.len())?;
    if &file[end..] != MAGIC {
        return None;
    }
    let signature_at = end.checked_sub(64)?;
    let length_at = signature_at.checked_sub(1)?;
    let length = file[length_at] as usize;
    if length == 0 || length > MAX_VERSION {
        return None;
    }
    let version_at = length_at.checked_sub(length)?;
    let version = std::str::from_utf8(&file[version_at..length_at]).ok()?;
    numbers(version)?;
    Some((version, &file[signature_at..end], version_at))
}

/// The version the end of a file says it is (not proof of anything: for a server that only hands it on).
pub fn tail_version(tail: &[u8]) -> Option<String> {
    parse_tail(tail).map(|(version, ..)| version.to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReleaseError {
    /// No version and signature at the end of the file.
    NotARelease,
    /// Signed by someone else, or changed after signing.
    BadSignature,
    /// Honest, but no later than what runs here.
    NotNewer,
}

impl std::fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotARelease => "Это не установщик ХатаВойс",
            Self::BadSignature => "Подпись установщика не сходится: файл подменён или испорчен",
            Self::NotNewer => "Эта версия не новее твоей",
        })
    }
}

/// Checks a whole file against the publisher's key and the version that runs here; gives the version it holds.
pub fn verify(file: &[u8], publisher: &PublicKey, current: &str) -> Result<String, ReleaseError> {
    let (version, signature, version_at) = parse_tail(file).ok_or(ReleaseError::NotARelease)?;
    let signature = Signature(signature.try_into().map_err(|_| ReleaseError::NotARelease)?);
    if !publisher.verify(&message(version, &file[..version_at]), &signature) {
        return Err(ReleaseError::BadSignature);
    }
    if !is_newer(version, current) {
        return Err(ReleaseError::NotNewer);
    }
    Ok(version.to_string())
}

/// An installer with its version and signature at the end: done once, on the publisher's PC.
pub fn seal(installer: &[u8], version: &str, publisher: &Identity) -> Result<Vec<u8>, String> {
    if numbers(version).is_none() || version.len() > MAX_VERSION {
        return Err(format!("Not a version: {version}"));
    }
    if parse_tail(installer).is_some() {
        return Err("This file is sealed already".into());
    }
    let signature = publisher.sign(&message(version, installer));
    let mut file = installer.to_vec();
    file.extend_from_slice(version.as_bytes());
    file.push(version.len() as u8);
    file.extend_from_slice(&signature.0);
    file.extend_from_slice(MAGIC);
    Ok(file)
}

/// The seal of a package that cannot carry one at its end (an Android APK: its own signature covers the whole file): a
/// small file of its own, the package's SHA-256 sealed as an installer is. Done once, on the publisher's PC.
pub fn seal_digest(package: &[u8], version: &str, publisher: &Identity) -> Result<Vec<u8>, String> {
    use sha2::Digest;
    seal(&sha2::Sha256::digest(package), version, publisher)
}

/// A package against its seal (`seal_digest`): the version it holds, if the seal is the publisher's, the version is newer
/// than `current`, and the seal is for these very bytes.
pub fn verify_digest(package: &[u8], seal: &[u8], publisher: &PublicKey, current: &str) -> Result<String, ReleaseError> {
    use sha2::Digest;
    let version = verify(seal, publisher, current)?;
    let (_, _, at) = parse_tail(seal).ok_or(ReleaseError::NotARelease)?;
    if seal[..at] != sha2::Sha256::digest(package)[..] {
        return Err(ReleaseError::BadSignature);
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_with_a_seal_of_its_own_passes_only_with_its_own_bytes() {
        let package = vec![0x50, 0x4B, 3, 4, 9, 9, 9];
        let seal = seal_digest(&package, "0.16.0", &publisher()).unwrap();
        assert_eq!(verify_digest(&package, &seal, &publisher().public(), "0.15.1"), Ok("0.16.0".to_string()));
        assert_eq!(tail_version(&seal[seal.len().saturating_sub(TAIL)..]), Some("0.16.0".to_string()));
        // Another package under the same seal, an old version, another publisher.
        assert_eq!(verify_digest(b"PK another", &seal, &publisher().public(), "0.15.1"), Err(ReleaseError::BadSignature));
        assert_eq!(verify_digest(&package, &seal, &publisher().public(), "0.16.0"), Err(ReleaseError::NotNewer));
        assert_eq!(verify_digest(&package, &seal, &Identity::from_seed([8; 32]).public(), "0.15.1"), Err(ReleaseError::BadSignature));
        assert_eq!(verify_digest(&package, b"junk", &publisher().public(), "0.15.1"), Err(ReleaseError::NotARelease));
    }

    fn publisher() -> Identity {
        Identity::from_seed([7; 32])
    }

    #[test]
    fn a_sealed_newer_release_passes() {
        let file = seal(b"installer bytes", "0.7.0", &publisher()).unwrap();
        assert_eq!(verify(&file, &publisher().public(), "0.6.1"), Ok("0.7.0".to_string()));
        assert_eq!(tail_version(&file[file.len().saturating_sub(TAIL)..]), Some("0.7.0".to_string()));
    }

    #[test]
    fn someone_elses_signature_does_not() {
        let file = seal(b"installer bytes", "0.7.0", &Identity::from_seed([8; 32])).unwrap();
        assert_eq!(verify(&file, &publisher().public(), "0.6.1"), Err(ReleaseError::BadSignature));
    }

    #[test]
    fn a_changed_byte_does_not() {
        let mut file = seal(b"installer bytes", "0.7.0", &publisher()).unwrap();
        file[3] ^= 1;
        assert_eq!(verify(&file, &publisher().public(), "0.6.1"), Err(ReleaseError::BadSignature));
    }

    #[test]
    fn a_changed_version_does_not() {
        let mut file = seal(b"installer bytes", "0.7.0", &publisher()).unwrap();
        // The file claims 0.9.0 now: the bytes it was signed with said 0.7.0.
        let at = file.len() - 8 - 64 - 1 - "0.7.0".len();
        file[at + 2] = b'9';
        assert_eq!(verify(&file, &publisher().public(), "0.6.1"), Err(ReleaseError::BadSignature));
    }

    #[test]
    fn an_old_or_the_same_version_does_not() {
        let file = seal(b"installer bytes", "0.6.0", &publisher()).unwrap();
        assert_eq!(verify(&file, &publisher().public(), "0.6.0"), Err(ReleaseError::NotNewer));
        assert_eq!(verify(&file, &publisher().public(), "0.10.0"), Err(ReleaseError::NotNewer));
    }

    #[test]
    fn a_plain_file_is_no_release() {
        assert_eq!(verify(b"MZ just a program", &publisher().public(), "0.1.0"), Err(ReleaseError::NotARelease));
        assert_eq!(verify(b"", &publisher().public(), "0.1.0"), Err(ReleaseError::NotARelease));
        assert_eq!(tail_version(b"short"), None);
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.6.0", "0.6.0"));
        assert!(!is_newer("0.5.9", "0.6.0"));
        assert!(!is_newer("0.7.0-beta", "0.6.0"));
        assert!(!is_newer("0.7", "0.6.0"));
        assert!(!is_newer("0.7.0.1", "0.6.0"));
        assert!(!is_newer("", "0.6.0"));
    }

    #[test]
    fn sealing_twice_is_refused() {
        let file = seal(b"installer bytes", "0.7.0", &publisher()).unwrap();
        assert!(seal(&file, "0.7.1", &publisher()).is_err());
    }
}
