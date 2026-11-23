//! The user's personal key: kept under DPAPI on this PC, and exportable to a password-protected
//! `.hvid` file to be the same person on another PC.

use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hv_roster::keys::{decode_b64, encode_b64, random_bytes};
use hv_roster::{Identity, PublicKey};
use serde::{Deserialize, Serialize};

pub const IDENTITY_FILE: &str = "identity.bin";
/// Start of every `.hvid` file; also authenticated as associated data.
pub const HVID_MAGIC: &[u8] = b"HVID1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
/// A file that leaves this PC is guessed offline at a GPU's pace: ten characters keep that out of reach.
const MIN_PASSWORD_CHARS: usize = 10;
// Argon2id: 64 MiB, 3 passes, 1 lane (spec: Global Constraints).
const ARGON_MEMORY_KIB: u32 = 65_536;
const ARGON_PASSES: u32 = 3;

/// This PC's identity, created on first use, and whether an old one could not be decrypted (Windows reinstalled and
/// the data folder restored, or the account password reset: DPAPI keys are gone). That file is
/// kept aside as `identity.unreadable-<time>.bin` and a new identity starts, so the app still
/// opens and the user can import their `.hvid` copy.
pub fn load_or_recover(dir: &Path) -> Result<(Identity, bool), String> {
    let path = dir.join(IDENTITY_FILE);
    if path.exists() {
        let sealed = std::fs::read(&path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
        let seed: Option<[u8; 32]> = hv_host::protect::unprotect(&sealed).ok().and_then(|bytes| bytes.try_into().ok());
        if let Some(seed) = seed {
            return Ok((Identity::from_seed(seed), false));
        }
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let aside = dir.join(format!("identity.unreadable-{stamp}.bin"));
        std::fs::rename(&path, &aside).map_err(|e| format!("Не переименовывается {}: {e}", path.display()))?;
        let identity = Identity::generate()?;
        store(dir, &identity)?;
        return Ok((identity, true));
    }
    let identity = Identity::generate()?;
    store(dir, &identity)?;
    Ok((identity, false))
}

/// Writes `identity` as this PC's identity (after an import).
pub fn store(dir: &Path, identity: &Identity) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(IDENTITY_FILE);
    let sealed = hv_host::protect::protect(&identity.seed())?;
    let temp = path.with_extension("bin.tmp");
    std::fs::write(&temp, sealed)
        .and_then(|_| std::fs::rename(&temp, &path))
        .map_err(|e| format!("Не записывается {}: {e}", path.display()))
}

/// The short code shown next to a nickname when two people use the same one.
pub fn fingerprint(key: &PublicKey) -> String {
    key.user_id().0.chars().take(4).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedServerKey {
    pub address: String,
    /// Base64url of the server's key, as pinned by this client.
    pub server_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HvidContents {
    pub seed: [u8; 32],
    pub nickname: String,
    pub color: String,
    pub servers: Vec<SavedServerKey>,
}

#[derive(Serialize, Deserialize)]
struct HvidPlain {
    version: u32,
    seed: String,
    nickname: String,
    color: String,
    servers: Vec<SavedServerKey>,
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(ARGON_MEMORY_KIB, ARGON_PASSES, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

/// `HVID1 ‖ salt ‖ nonce ‖ XChaCha20-Poly1305(Argon2id(password, salt), contents)`.
pub fn export_hvid(contents: &HvidContents, password: &str) -> Result<Vec<u8>, String> {
    if password.trim().chars().count() < MIN_PASSWORD_CHARS {
        return Err("Пароль — не короче 10 символов".into());
    }
    let plain = HvidPlain {
        version: 1,
        seed: encode_b64(&contents.seed),
        nickname: contents.nickname.clone(),
        color: contents.color.clone(),
        servers: contents.servers.clone(),
    };
    let json = serde_json::to_vec(&plain).map_err(|e| e.to_string())?;
    let salt = random_bytes::<SALT_LEN>()?;
    let nonce = random_bytes::<NONCE_LEN>()?;
    let cipher = XChaCha20Poly1305::new_from_slice(&derive_key(password, &salt)?).map_err(|e| e.to_string())?;
    let sealed = cipher
        .encrypt(&XNonce::from(nonce), Payload { msg: &json, aad: HVID_MAGIC })
        .map_err(|_| "Не удалось зашифровать файл личности".to_string())?;
    Ok([HVID_MAGIC, &salt, &nonce, &sealed].concat())
}

pub fn import_hvid(bytes: &[u8], password: &str) -> Result<HvidContents, String> {
    let header = HVID_MAGIC.len() + SALT_LEN + NONCE_LEN;
    if !bytes.starts_with(HVID_MAGIC) || bytes.len() <= header {
        return Err("Это не файл личности ХатаВойс".into());
    }
    let salt = &bytes[HVID_MAGIC.len()..HVID_MAGIC.len() + SALT_LEN];
    let nonce: [u8; NONCE_LEN] = bytes[HVID_MAGIC.len() + SALT_LEN..header].try_into().expect("length checked");
    let wrong = || "Неверный пароль или повреждённый файл".to_string();
    let cipher = XChaCha20Poly1305::new_from_slice(&derive_key(password, salt)?).map_err(|e| e.to_string())?;
    let json = cipher.decrypt(&XNonce::from(nonce), Payload { msg: &bytes[header..], aad: HVID_MAGIC }).map_err(|_| wrong())?;
    let plain: HvidPlain = serde_json::from_slice(&json).map_err(|_| wrong())?;
    let seed = decode_b64::<32>(&plain.seed).ok_or_else(wrong)?;
    Ok(HvidContents { seed, nickname: plain.nickname, color: plain.color, servers: plain.servers })
}

/// Wipes this PC's key at the owner's word: its file and every copy set aside as unreadable are overwritten with
/// random bytes before they go, so what is left on the disk is noise (as far as the disk keeps no copy of its own), and
/// a new identity takes its place. Who held the old key on a server is, to the server, someone else from now on.
pub fn forget(dir: &Path) -> Result<Identity, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Не открывается {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = name == IDENTITY_FILE || name == "identity.bin.tmp" || (name.starts_with("identity.unreadable-") && name.ends_with(".bin"));
        if !ours || !entry.path().is_file() {
            continue;
        }
        let path = entry.path();
        let length = std::fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0);
        if length > 0 {
            use std::io::Write;
            let mut noise = Vec::with_capacity(length);
            while noise.len() < length {
                noise.extend_from_slice(&random_bytes::<4096>()?);
            }
            noise.truncate(length);
            let mut file = std::fs::OpenOptions::new().write(true).open(&path).map_err(|e| format!("Не открывается {}: {e}", path.display()))?;
            file.write_all(&noise).and_then(|_| file.sync_all()).map_err(|e| format!("Не затирается {}: {e}", path.display()))?;
        }
        std::fs::remove_file(&path).map_err(|e| format!("Не удаляется {}: {e}", path.display()))?;
    }
    let identity = Identity::generate()?;
    store(dir, &identity)?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forgotten_key_is_gone_from_the_disk_and_a_new_one_takes_its_place() {
        let dir = temp_dir("forget");
        let old = load_or_recover(&dir).unwrap().0;
        std::fs::write(dir.join("identity.unreadable-5.bin"), b"old sealed seed").unwrap();
        std::fs::write(dir.join("servers.json"), b"keep me").unwrap();
        let new = forget(&dir).unwrap();
        assert_ne!(old.public(), new.public());
        assert_eq!(load_or_recover(&dir).unwrap().0.public(), new.public(), "the new key is the one kept");
        assert!(!dir.join("identity.unreadable-5.bin").exists());
        assert_eq!(std::fs::read(dir.join("servers.json")).unwrap(), b"keep me", "other files stay");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hv-identity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn contents() -> HvidContents {
        HvidContents {
            seed: [9; 32],
            nickname: "Петя".into(),
            color: "pink".into(),
            servers: vec![SavedServerKey { address: "203.0.113.7:7350".into(), server_key: "AAAA".into() }],
        }
    }

    #[test]
    fn identity_survives_a_restart_and_is_protected_on_disk() {
        let dir = temp_dir("restart");
        let first = load_or_recover(&dir).unwrap().0;
        let again = load_or_recover(&dir).unwrap().0;
        assert_eq!(first.public(), again.public());
        let on_disk = std::fs::read(dir.join(IDENTITY_FILE)).unwrap();
        assert!(!on_disk.windows(32).any(|w| w == first.seed()), "the seed must not be stored in the clear");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_identity_this_windows_cannot_decrypt_is_set_aside_and_replaced() {
        let dir = temp_dir("unreadable");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(IDENTITY_FILE), b"sealed by another Windows install").unwrap();
        let (identity, lost) = load_or_recover(&dir).expect("the app still starts");
        assert!(lost, "the user is told");
        let kept: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|name| name.starts_with("identity.unreadable"))
            .collect();
        assert_eq!(kept.len(), 1, "the old file is kept, not deleted: {kept:?}");
        let (again, lost) = load_or_recover(&dir).unwrap();
        assert_eq!(again.public(), identity.public());
        assert!(!lost);
    }

    #[test]
    fn replacing_the_identity_keeps_the_new_one() {
        let dir = temp_dir("replace");
        load_or_recover(&dir).unwrap();
        store(&dir, &Identity::from_seed([5; 32])).unwrap();
        assert_eq!(load_or_recover(&dir).unwrap().0.public(), Identity::from_seed([5; 32]).public());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hvid_round_trips_and_a_wrong_password_is_refused() {
        let file = export_hvid(&contents(), "секрет-12345").unwrap();
        assert!(file.starts_with(HVID_MAGIC));
        assert!(!file.windows(8).any(|w| w == "Петя".as_bytes()), "contents are encrypted");
        assert_eq!(import_hvid(&file, "секрет-12345").unwrap(), contents());
        assert_eq!(import_hvid(&file, "секрет-124").unwrap_err(), "Неверный пароль или повреждённый файл");
        let mut broken = file.clone();
        let last = broken.len() - 1;
        broken[last] ^= 1;
        assert_eq!(import_hvid(&broken, "секрет-12345").unwrap_err(), "Неверный пароль или повреждённый файл");
        assert_eq!(import_hvid(b"PK\x03\x04 a zip", "x").unwrap_err(), "Это не файл личности ХатаВойс");
    }

    #[test]
    fn export_needs_a_real_password() {
        assert!(export_hvid(&contents(), "12345").is_err());
        assert!(export_hvid(&contents(), "123456789").is_err(), "nine are too few");
        assert!(export_hvid(&contents(), "      ").is_err());
    }

    #[test]
    fn two_exports_of_the_same_identity_differ() {
        assert_ne!(export_hvid(&contents(), "секрет-12345").unwrap(), export_hvid(&contents(), "секрет-12345").unwrap());
    }

    #[test]
    fn fingerprint_is_four_characters_of_the_user_id() {
        let key = Identity::from_seed([1; 32]).public();
        let fp = fingerprint(&key);
        assert_eq!(fp.len(), 4);
        assert!(key.user_id().0.starts_with(&fp));
    }
}
