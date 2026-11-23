//! Secrets at rest. Under Windows, DPAPI (`CryptProtectData`, current-user scope): only this Windows account on this PC can
//! read them back. Elsewhere, sealed with a key in a file only this account may read: on a phone that is the app's own
//! sandbox, on a desktop as strong as the account's password and the disk's encryption.

#[cfg(windows)]
pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` points at `data` for the duration of the call; `output` is freed in `take`.
    unsafe { CryptProtectData(&input, windows::core::PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        .map_err(|e| format!("Не удалось защитить ключ средствами Windows: {e}"))?;
    Ok(take(output))
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`.
    unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        .map_err(|e| format!("Ключ не расшифровывается в этой учётной записи Windows: {e}"))?;
    Ok(take(output))
}

/// Copies a DPAPI output buffer and frees it with `LocalFree`.
#[cfg(windows)]
fn take(blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    if blob.pbData.is_null() {
        return Vec::new();
    }
    // SAFETY: DPAPI returned `cbData` bytes at `pbData`, allocated with LocalAlloc.
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    unsafe { LocalFree(Some(HLOCAL(blob.pbData.cast()))) };
    bytes
}

/// Where the key lives on a system with no DPAPI; asked before the first secret. Elsewhere it does nothing.
#[cfg(windows)]
pub fn set_dir(_dir: &std::path::Path) {}

#[cfg(not(windows))]
pub use sealed::{protect, set_dir, unprotect};

#[cfg(not(windows))]
mod sealed {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};

    const MAGIC: &[u8] = b"HVS1";
    const KEY_FILE: &str = "device.key";
    const NONCE: usize = 24;

    static DIR: OnceLock<PathBuf> = OnceLock::new();

    pub fn set_dir(dir: &Path) {
        let _ = DIR.set(dir.to_path_buf());
    }

    fn key_file() -> PathBuf {
        let dir = DIR.get().cloned().or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/hatavoice")));
        dir.unwrap_or_else(std::env::temp_dir).join(KEY_FILE)
    }

    fn device_key() -> Result<[u8; 32], String> {
        let path = key_file();
        if let Ok(bytes) = std::fs::read(&path)
            && let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice())
        {
            return Ok(key);
        }
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|e| format!("Нет источника случайности: {e}"))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Readable by this account alone from the moment it exists.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
        file.write_all(&key).map_err(|e| e.to_string())?;
        Ok(key)
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut nonce = [0; NONCE];
        getrandom::fill(&mut nonce).map_err(|e| format!("Нет источника случайности: {e}"))?;
        let cipher = XChaCha20Poly1305::new(&device_key()?.into());
        let sealed = cipher
            .encrypt(&XNonce::from(nonce), Payload { msg: data, aad: MAGIC })
            .map_err(|_| "Не удалось защитить ключ".to_string())?;
        Ok([MAGIC, &nonce, &sealed].concat())
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let broken = || "Не удалось прочитать ключ на этом устройстве".to_string();
        let rest = data.strip_prefix(MAGIC).ok_or_else(broken)?;
        if rest.len() < NONCE {
            return Err(broken());
        }
        let (nonce, sealed) = rest.split_at(NONCE);
        let nonce: [u8; NONCE] = nonce.try_into().map_err(|_| broken())?;
        let cipher = XChaCha20Poly1305::new(&device_key()?.into());
        cipher.decrypt(&XNonce::from(nonce), Payload { msg: sealed, aad: MAGIC }).map_err(|_| broken())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn sealed_data_round_trips_and_the_key_is_this_accounts_alone() {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("hv-protect-{}", std::process::id()));
            set_dir(&dir);
            let secret = b"seed of a personal key, 32 bytes";
            let sealed = protect(secret).unwrap();
            assert!(!sealed.windows(secret.len()).any(|w| w == secret));
            assert_eq!(unprotect(&sealed).unwrap(), secret);
            assert_ne!(protect(secret).unwrap(), sealed, "a new nonce each time");

            let mode = std::fs::metadata(key_file()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);

            let mut bent = sealed.clone();
            *bent.last_mut().unwrap() ^= 1;
            assert!(unprotect(&bent).is_err());
            assert!(unprotect(b"nothing").is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn protected_data_round_trips_and_differs_from_plain() {
        let secret = b"seed of a personal key, 32 bytes";
        let sealed = protect(secret).unwrap();
        assert_ne!(sealed.as_slice(), secret.as_slice());
        assert!(!sealed.windows(secret.len()).any(|w| w == secret), "the plain bytes must not appear");
        assert_eq!(unprotect(&sealed).unwrap(), secret);
    }

    #[test]
    fn garbage_is_refused() {
        assert!(unprotect(b"definitely not a DPAPI blob").is_err());
        assert!(unprotect(&[]).is_err());
    }
}
