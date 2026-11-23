//! Updating from a friend's server: it offers an installer, we take it only if it carries the publisher's signature and
//! a later version than ours, and run it. The installer closes this program, replaces it and opens it again.

use hv_roster::keys::PublicKey;
use hv_roster::release;
use serde::Serialize;

use crate::commands::{AppIdentity, Sessions, link_of};

/// The publisher's public key. Its secret half stays on the publisher's PC.
const PUBLISHER: &str = include_str!("../../../packaging/release.pub");
/// No installer is anywhere near this big: a server cannot make us read more.
const MAX_INSTALLER: usize = 200 * 1024 * 1024;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn publisher() -> Result<PublicKey, String> {
    let text = PUBLISHER.trim();
    if text.len() != 64 {
        return Err("Ключ издателя испорчен".into());
    }
    let mut key = [0; 32];
    for (i, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| "Ключ издателя испорчен".to_string())?;
    }
    Ok(PublicKey(key))
}

#[derive(Serialize)]
pub struct Offer {
    pub version: String,
    pub size: u64,
}

/// Windows runs the installer a server has, Android its package; other systems update from their own packages.
const CAN_INSTALL: bool = cfg!(any(windows, target_os = "android"));
/// No Android package is anywhere near this big either.
#[cfg(target_os = "android")]
const MAX_PACKAGE: usize = 400 * 1024 * 1024;
/// Where the checked package waits for Android's installer, in the app's cache (`Native.kt` looks there).
#[cfg(target_os = "android")]
const PACKAGE_DIR: &str = "updates";
#[cfg(target_os = "android")]
const PACKAGE_NAME: &str = "HataVoice-update.apk";
/// What a phone asks a server for, and a PC.
const INFO: &str = if cfg!(target_os = "android") { "/api/update/android" } else { "/api/update" };

/// The installer of an update lies in the temporary folder until the new version starts and takes it away.
pub fn clean_leftovers() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("HataVoice-setup-") && name.ends_with(".exe") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// What this server offers, if it is newer than this program. Any failure (an old server, none to give) is no offer.
#[tauri::command]
pub async fn update_check(identity: tauri::State<'_, AppIdentity>, sessions: tauri::State<'_, Sessions>, address: String) -> Result<Option<Offer>, String> {
    if !CAN_INSTALL {
        return Ok(None);
    }
    let id = identity.get();
    let Ok(link) = link_of(&sessions.0, &address).await else { return Ok(None) };
    let Ok((status, answer)) = link.request_raw(&id, "GET", INFO, None).await else { return Ok(None) };
    if status != 200 {
        return Ok(None);
    }
    let (Some(version), Some(size)) = (answer["version"].as_str(), answer["size"].as_u64()) else { return Ok(None) };
    Ok(release::is_newer(version, VERSION).then(|| Offer { version: version.to_string(), size }))
}

/// Takes the installer from the server, checks it, and hands over to it. Does not come back on success: the program quits.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, identity: tauri::State<'_, AppIdentity>, sessions: tauri::State<'_, Sessions>, address: String) -> Result<(), String> {
    if !CAN_INSTALL {
        return Err("На этой системе обновление ставится из пакета".into());
    }
    let id = identity.get();
    let link = link_of(&sessions.0, &address).await?;
    #[cfg(target_os = "android")]
    {
        // The seal first (small): a server that has nothing signed gets nothing downloaded.
        let (status, seal) = link.exchange_bytes(&id, "GET", "/api/update/android/seal", Vec::new(), 4096).await.map_err(crate::commands::text)?;
        if status != 200 {
            return Err("Сервер не отдал версию для Android".into());
        }
        release::verify(&seal, &publisher()?, VERSION).map_err(|e| e.to_string())?;
        let (status, package) = link.exchange_bytes(&id, "GET", "/api/update/android/file", Vec::new(), MAX_PACKAGE).await.map_err(crate::commands::text)?;
        if status != 200 {
            return Err("Сервер не отдал версию для Android".into());
        }
        release::verify_digest(&package, &seal, &publisher()?, VERSION).map_err(|e| e.to_string())?;
        // Android's installer takes it from here (the page asks `Native.kt`); it checks again that the package is signed
        // by the same key as the app on the phone, and asks the person.
        use tauri::Manager;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join(PACKAGE_DIR);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(PACKAGE_NAME), &package).map_err(|e| format!("Не записывается обновление: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let (status, file) = link.exchange_bytes(&id, "GET", "/api/update/file", Vec::new(), MAX_INSTALLER).await.map_err(crate::commands::text)?;
        if status != 200 {
            return Err("Сервер не отдал установщик".into());
        }
        let version = release::verify(&file, &publisher()?, VERSION).map_err(|e| e.to_string())?;

        // A folder of its own with a name nobody knows beforehand, made fresh: nothing else can have put a file there, or
        // swap the checked installer for another between writing it and starting it.
        let folder = std::env::temp_dir().join(format!("HataVoice-update-{}", hv_roster::keys::encode_b64(&hv_roster::keys::random_bytes::<12>()?)));
        std::fs::create_dir(&folder).map_err(|e| format!("Не создаётся {}: {e}", folder.display()))?;
        let path = folder.join(format!("HataVoice-setup-{version}.exe"));
        std::fs::write(&path, &file).map_err(|e| format!("Не записывается {}: {e}", path.display()))?;
        // «/UPDATE»: the installer asks nothing then and keeps the folder and shortcuts; started by hand, it is a wizard.
        std::process::Command::new(&path).arg("/UPDATE").spawn().map_err(|e| format!("Установщик не запустился: {e}"))?;
        app.exit(0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_publishers_key_is_in_the_program() {
        assert!(publisher().is_ok());
    }
}
