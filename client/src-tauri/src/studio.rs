//! The studio's files: recordings and snapshots go to «Видео\ХатаВойс», or to a folder the person chose, named by the
//! time the window gives (Rust checks it and picks the folder). The recording comes in pieces with their place in the
//! file, as raw bodies.
//!
//! The folder is chosen only in Windows' own dialog, opened from here: the page never names a path to write to.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// The folder of the studio's files under the user's videos.
const FOLDER: &str = "ХатаВойс";
/// The folder the person chose, as its path, in the app's data folder.
const CHOICE: &str = "studio-folder.txt";
/// The furthest a piece may land in a file: 256 GB.
const MAX_POSITION: u64 = 256 << 30;

/// The recording being written, if any.
#[derive(Default)]
pub struct Studio {
    recording: Mutex<Option<(PathBuf, File)>>,
}

/// A name the window may give: the local time as `YYYY-MM-DD HH-MM-SS`.
pub fn valid_stamp(stamp: &str) -> bool {
    let b = stamp.as_bytes();
    b.len() == 19
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b' ',
            13 | 16 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// A path in `folder` for `stamp` and `extension` that is not taken yet.
pub fn free_path(folder: &Path, stamp: &str, extension: &str) -> PathBuf {
    let mut path = folder.join(format!("{stamp}.{extension}"));
    let mut n = 2;
    while path.exists() {
        path = folder.join(format!("{stamp} ({n}).{extension}"));
        n += 1;
    }
    path
}

/// The chosen folder as written down: a whole path to a folder that is there. Anything else (a folder since removed, a
/// disk not plugged in, a damaged file) falls back to the usual one.
pub fn chosen_from(text: &str) -> Option<PathBuf> {
    let path = PathBuf::from(text.trim());
    (path.is_absolute() && path.is_dir()).then_some(path)
}

fn choice_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join(CHOICE))
}

fn chosen(app: &AppHandle) -> Option<PathBuf> {
    chosen_from(&std::fs::read_to_string(choice_file(app).ok()?).ok()?)
}

#[cfg(not(target_os = "android"))]
fn usual_folder(app: &AppHandle) -> Result<PathBuf, String> {
    let videos = app.path().video_dir().map_err(|e| format!("Не нашёл папку «Видео»: {e}"))?;
    Ok(videos.join(FOLDER))
}

/// On a phone: «Фильмы/ХатаВойс» in the shared storage, where the gallery finds them (Android lets an app write its own
/// files there without asking); the app's own folder if that cannot be made.
#[cfg(target_os = "android")]
fn usual_folder(app: &AppHandle) -> Result<PathBuf, String> {
    let shared = std::env::var_os("EXTERNAL_STORAGE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/storage/emulated/0"));
    let movies = shared.join("Movies").join(FOLDER);
    // Android lets an app make only media files in the shared folders: the test is one too (a file of no such kind is
    // refused even where recordings would be taken, and they would all go to the app's hidden folder).
    let test = movies.join("hatavoice-check.mp4");
    if std::fs::create_dir_all(&movies).is_ok() && File::create(&test).is_ok() {
        let _ = std::fs::remove_file(&test);
        return Ok(movies);
    }
    let videos = app.path().video_dir().map_err(|e| format!("Не нашёл папку для видео: {e}"))?;
    Ok(videos.join(FOLDER))
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = match chosen(app) {
        Some(folder) => folder,
        None => usual_folder(app)?,
    };
    std::fs::create_dir_all(&folder).map_err(|e| format!("Не удалось создать папку {}: {e}", folder.display()))?;
    Ok(folder)
}

/// Where the studio's files go, and whether the person chose it.
#[derive(Serialize)]
pub struct StudioFolder {
    path: String,
    chosen: bool,
}

fn studio_folder_now(app: &AppHandle) -> Result<StudioFolder, String> {
    let chosen = chosen(app).is_some();
    Ok(StudioFolder { path: folder(app)?.display().to_string(), chosen })
}

/// Where recordings, snapshots and replays are saved now.
#[tauri::command]
pub fn studio_folder(app: AppHandle) -> Result<StudioFolder, String> {
    studio_folder_now(&app)
}

/// The folder the person picks in the system's own dialog; nothing when they changed their mind.
#[cfg(desktop)]
fn pick_in_dialog(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("Куда сохранять записи, снимки и повторы");
    if let Ok(now) = folder(app) {
        dialog = dialog.set_directory(now);
    }
    let Some(picked) = dialog.blocking_pick_folder() else { return Ok(None) };
    picked.into_path().map(Some).map_err(|e| e.to_string())
}

/// A phone has no folders to pick: files stay in the app's own.
#[cfg(mobile)]
fn pick_in_dialog(_app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Err("На телефоне записи лежат в папке программы".into())
}

/// Asks in the system's own dialog where to save from now on; nothing when the person changed their mind. Async: the
/// dialog waits for the person and must not hold the main thread.
#[tauri::command]
pub async fn studio_pick_folder(app: AppHandle) -> Result<Option<StudioFolder>, String> {
    let Some(path) = pick_in_dialog(&app)? else { return Ok(None) };
    // A folder we may not write to is better found now than at the end of a recording.
    let test = path.join(".hatavoice-check");
    File::create(&test)
        .and_then(|_| std::fs::remove_file(&test))
        .map_err(|e| format!("В папку {} нельзя записывать: {e}", path.display()))?;
    let file = choice_file(&app)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Не удалось запомнить папку: {e}"))?;
    }
    std::fs::write(file, path.display().to_string()).map_err(|e| format!("Не удалось запомнить папку: {e}"))?;
    studio_folder_now(&app).map(Some)
}

/// Back to «Видео\ХатаВойс».
#[tauri::command]
pub fn studio_folder_reset(app: AppHandle) -> Result<StudioFolder, String> {
    let file = choice_file(&app)?;
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| format!("Не удалось забыть папку: {e}"))?;
    }
    studio_folder_now(&app)
}

/// Opens the folder of the studio's files in Explorer.
#[tauri::command]
pub fn studio_open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let folder = folder(&app)?;
    app.opener().open_path(folder.display().to_string(), None::<&str>).map_err(|e| format!("Не удалось открыть папку: {e}"))
}

fn raw(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("Ожидались байты".into()),
    }
}

/// Starts a recording: a new MP4 named by `stamp`. Its path.
#[tauri::command]
pub fn studio_record_open(app: AppHandle, studio: tauri::State<'_, Studio>, stamp: String) -> Result<String, String> {
    if !valid_stamp(&stamp) {
        return Err("Неверное имя записи".into());
    }
    let mut slot = studio.recording.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return Err("Запись уже идёт".into());
    }
    let path = free_path(&folder(&app)?, &stamp, "mp4");
    let file = File::create(&path).map_err(|e| format!("Не удалось создать файл: {e}"))?;
    *slot = Some((path.clone(), file));
    Ok(path.display().to_string())
}

/// A piece of the recording at its place (`x-position`).
#[tauri::command]
pub fn studio_record_write(studio: tauri::State<'_, Studio>, request: Request<'_>) -> Result<(), String> {
    let position: u64 = request
        .headers()
        .get("x-position")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .filter(|p| *p <= MAX_POSITION)
        .ok_or("Неверное место в файле")?;
    let bytes = raw(&request)?;
    let mut slot = studio.recording.lock().unwrap_or_else(|e| e.into_inner());
    let (_, file) = slot.as_mut().ok_or("Запись не идёт")?;
    file.seek(SeekFrom::Start(position)).and_then(|_| file.write_all(&bytes)).map_err(|e| format!("Не удалось записать: {e}"))
}

/// The recording is over: the file is closed. Its path.
#[tauri::command]
pub fn studio_record_close(studio: tauri::State<'_, Studio>) -> Option<String> {
    let (path, file) = studio.recording.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    let _ = file.sync_all();
    Some(path.display().to_string())
}

/// A PNG of the frame, named by `x-stamp`. Its path.
#[tauri::command]
pub fn studio_snapshot(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let stamp = request.headers().get("x-stamp").and_then(|v| v.to_str().ok()).filter(|s| valid_stamp(s)).ok_or("Неверное имя снимка")?.to_string();
    let bytes = raw(&request)?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Это не PNG".into());
    }
    let path = free_path(&folder(&app)?, &stamp, "png");
    std::fs::write(&path, bytes).map_err(|e| format!("Не удалось сохранить снимок: {e}"))?;
    Ok(path.display().to_string())
}

/// A saved replay: an MP4 made whole in the window, named by `x-stamp`. Its path.
#[tauri::command]
pub fn studio_save_clip(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let stamp = request.headers().get("x-stamp").and_then(|v| v.to_str().ok()).filter(|s| valid_stamp(s)).ok_or("Неверное имя файла")?.to_string();
    let bytes = raw(&request)?;
    if bytes.get(4..8) != Some(b"ftyp".as_slice()) {
        return Err("Это не MP4".into());
    }
    let path = free_path(&folder(&app)?, &format!("{stamp} повтор"), "mp4");
    std::fs::write(&path, bytes).map_err(|e| format!("Не удалось сохранить повтор: {e}"))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_times_and_never_overwrite() {
        assert!(valid_stamp("2026-10-29 21-55-00"));
        for bad in ["2026-10-29 21:55:00", "../../evil", "2026-10-29 21-55-0", "2026-10-29_21-55-00", "２０２６-10-29 21-55-00"] {
            assert!(!valid_stamp(bad), "{bad}");
        }
        let dir = std::env::temp_dir().join(format!("hv-studio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = free_path(&dir, "2026-10-29 21-55-00", "mp4");
        assert_eq!(first.file_name().unwrap(), "2026-10-29 21-55-00.mp4");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(free_path(&dir, "2026-10-29 21-55-00", "mp4").file_name().unwrap(), "2026-10-29 21-55-00 (2).mp4");
        std::fs::remove_file(first).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn a_chosen_folder_counts_only_while_it_is_there() {
        let dir = std::env::temp_dir().join(format!("hv-studio-choice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(chosen_from(&format!("  {}\r\n", dir.display())), Some(dir.clone()));
        for bad in ["", "relative\\folder", "..\\..\\Windows"] {
            assert_eq!(chosen_from(bad), None, "{bad}");
        }
        std::fs::remove_dir(&dir).unwrap();
        assert_eq!(chosen_from(&dir.display().to_string()), None, "a folder since removed");
    }
}
