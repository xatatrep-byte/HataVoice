//! Updates through the owner's own server: the installer the owner ran last keeps a copy of itself next to the program,
//! and this server hands that copy to its members. It only hands it on: the program of each friend checks the
//! publisher's signature and refuses anything else, so the server needs no trust here.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use hv_roster::release;
use serde_json::json;

use crate::AppState;
use crate::api::{MAX_BODY, signed};
use crate::auth::{error, member_only};
use crate::group_api::RateLimit;

/// Where the installer leaves its copy, next to the server's own file.
pub const INSTALLER: &str = "update/HataVoice-setup.exe";
/// The Android package and its seal (`hv_roster::release::seal_digest`), left there by the installer when one was built.
pub const ANDROID_PACKAGE: &str = "update/HataVoice-android.apk";
pub const ANDROID_SEAL: &str = "update/HataVoice-android.seal";
/// No seal is anywhere near this big.
const MAX_SEAL: u64 = 4096;
/// An installer can be fetched this often by one person: it is big, and this PC's upload is its owner's.
pub const FETCHES_PER_HOUR: usize = 6;

pub fn fetch_limit() -> RateLimit {
    RateLimit::per(FETCHES_PER_HOUR, Duration::from_secs(3600))
}

fn installer_path() -> Option<PathBuf> {
    beside_exe(INSTALLER)
}

fn beside_exe(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(name))
}

/// The Android package's version (from its seal) and size, without reading the package.
pub fn describe_android(package: &Path, seal: &Path) -> Option<(String, u64)> {
    if std::fs::metadata(seal).ok()?.len() > MAX_SEAL {
        return None;
    }
    let seal = std::fs::read(seal).ok()?;
    let version = release::tail_version(&seal[seal.len().saturating_sub(release::TAIL)..])?;
    Some((version, std::fs::metadata(package).ok()?.len()))
}

/// `GET /api/update/android` (members only) → `{"version", "size"}`, or 404 when this server has no Android package.
pub async fn android_info(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    match beside_exe(ANDROID_PACKAGE).zip(beside_exe(ANDROID_SEAL)).and_then(|(package, seal)| describe_android(&package, &seal)) {
        Some((version, size)) => Json(json!({ "version": version, "size": size })).into_response(),
        None => error(StatusCode::NOT_FOUND, "На этом сервере нет версии для Android"),
    }
}

/// `GET /api/update/android/seal` (members only): the package's seal, small, checked by the phone before the package.
pub async fn android_seal(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    match beside_exe(ANDROID_SEAL).filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= MAX_SEAL)) {
        Some(path) => match tokio::fs::read(&path).await {
            Ok(bytes) => ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response(),
            Err(_) => error(StatusCode::NOT_FOUND, "На этом сервере нет версии для Android"),
        },
        None => error(StatusCode::NOT_FOUND, "На этом сервере нет версии для Android"),
    }
}

/// `GET /api/update/android/file` (members only): the package as it is, as often as an installer.
pub async fn android_file(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if !state.update_rate.allow(&who.user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много скачиваний, попробуй позже");
    }
    let Some(path) = beside_exe(ANDROID_PACKAGE) else {
        return error(StatusCode::NOT_FOUND, "На этом сервере нет версии для Android");
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/vnd.android.package-archive")], bytes).into_response(),
        Err(_) => error(StatusCode::NOT_FOUND, "На этом сервере нет версии для Android"),
    }
}

/// What the file says about itself, without reading all of it: its version and size.
pub fn describe(path: &Path) -> Option<(String, u64)> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let tail = release::TAIL as u64;
    file.seek(SeekFrom::Start(size.saturating_sub(tail))).ok()?;
    let mut bytes = Vec::with_capacity(release::TAIL);
    file.read_to_end(&mut bytes).ok()?;
    Some((release::tail_version(&bytes)?, size))
}

/// The version this server can hand out, for the status its owner sees.
pub fn offered_version() -> Option<String> {
    describe(&installer_path()?).map(|(version, _)| version)
}

/// `GET /api/update` (members only) → `{"version", "size"}`, or 404 when this server has no installer to give.
pub async fn info(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    match installer_path().and_then(|path| describe(&path)) {
        Some((version, size)) => Json(json!({ "version": version, "size": size })).into_response(),
        None => error(StatusCode::NOT_FOUND, "На этом сервере нет установщика"),
    }
}

/// `GET /api/update/file` (members only): the installer as it is.
pub async fn file(State(state): State<AppState>, request: Request) -> Response {
    let (_, _, who) = match signed(&state, request, MAX_BODY).await {
        Ok(signed) => signed,
        Err(response) => return response,
    };
    if let Err(response) = member_only(&state, &who) {
        return response;
    }
    if !state.update_rate.allow(&who.user, Instant::now()) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Слишком много скачиваний, попробуй позже");
    }
    let Some(path) = installer_path() else {
        return error(StatusCode::NOT_FOUND, "На этом сервере нет установщика");
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response(),
        Err(_) => error(StatusCode::NOT_FOUND, "На этом сервере нет установщика"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hv_roster::keys::Identity;

    #[test]
    fn an_android_package_is_described_by_its_seal() {
        let dir = std::env::temp_dir().join(format!("hv-update-android-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (package, seal) = (dir.join("a.apk"), dir.join("a.seal"));
        std::fs::write(&package, vec![1; 5000]).unwrap();
        std::fs::write(&seal, release::seal_digest(&[1; 5000], "0.16.0", &Identity::from_seed([1; 32])).unwrap()).unwrap();
        assert_eq!(describe_android(&package, &seal), Some(("0.16.0".to_string(), 5000)));
        std::fs::write(&seal, b"not a seal").unwrap();
        assert_eq!(describe_android(&package, &seal), None);
        std::fs::write(&seal, vec![0; 10_000]).unwrap();
        assert_eq!(describe_android(&package, &seal), None, "too big to be a seal");
        assert_eq!(describe_android(&dir.join("missing.apk"), &seal), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_sealed_installer_describes_itself() {
        let dir = std::env::temp_dir().join(format!("hv-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("setup.exe");
        let sealed = release::seal(&vec![7; 100_000], "1.2.3", &Identity::from_seed([1; 32])).unwrap();
        std::fs::write(&path, &sealed).unwrap();
        assert_eq!(describe(&path), Some(("1.2.3".to_string(), sealed.len() as u64)));

        std::fs::write(&path, b"a plain file").unwrap();
        assert_eq!(describe(&path), None);
        assert_eq!(describe(&dir.join("missing.exe")), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
