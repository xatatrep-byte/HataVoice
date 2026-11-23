//! Files the person picked themselves — in a dialog the program opens, or by dropping them on the window — kept here
//! under one-off tokens. The page never names a path: the commands that read or write a file take a token, so a script
//! in the page (were one ever to get in) could neither read the owner's files nor write a program into their autostart.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A pick is good for this long: the person attaches a file and sends it, or saves one, within it.
const TTL: Duration = Duration::from_secs(30 * 60);
/// More picks than anyone waits on at once.
const MAX_HELD: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Picked to be read (sent, uploaded, imported).
    Read,
    /// Picked as where to save.
    Write,
}

struct Held {
    path: PathBuf,
    access: Access,
    at: Instant,
}

static HELD: LazyLock<Mutex<HashMap<String, Held>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Keeps `path` under a fresh token.
pub fn hold(path: PathBuf, access: Access) -> Result<String, String> {
    let token = hv_roster::keys::encode_b64(&hv_roster::keys::random_bytes::<16>()?);
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    held.retain(|_, h| h.at.elapsed() < TTL);
    if held.len() >= MAX_HELD {
        // The oldest goes.
        if let Some(oldest) = held.iter().min_by_key(|(_, h)| h.at).map(|(t, _)| t.clone()) {
            held.remove(&oldest);
        }
    }
    held.insert(token.clone(), Held { path, access, at: Instant::now() });
    Ok(token)
}

/// The path a token stands for, once: it is gone after. Only for what it was picked for.
pub fn take(token: &str, access: Access) -> Result<PathBuf, String> {
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    match held.remove(token) {
        Some(h) if h.access == access && h.at.elapsed() < TTL => Ok(h.path),
        Some(h) if h.access != access => {
            // A token for the other use is put back: asking wrongly takes nothing away.
            held.insert(token.to_string(), h);
            Err(GONE.into())
        }
        _ => Err(GONE.into()),
    }
}

const GONE: &str = "Файл нужно выбрать заново";

/// The path a token stands for, without taking it (the file still goes by its token if it is not changed).
pub fn peek(token: &str, access: Access) -> Result<PathBuf, String> {
    let held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    match held.get(token) {
        Some(h) if h.access == access && h.at.elapsed() < TTL => Ok(h.path.clone()),
        _ => Err(GONE.into()),
    }
}

/// The most of a picked picture or video the page may read to change it before it goes.
pub const MAX_MEDIA: u64 = 32 * 1024 * 1024;

/// Whether a file by its name is a picture or a video one can change before sending.
pub fn editable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4", ".mov", ".m4v", ".webm", ".mkv"].iter().any(|end| lower.ends_with(end))
}

/// A picked picture or video, for the page to change before it goes (the photo editor, the video trimmer): the bytes
/// of the file the person chose, never its path. Only those kinds, and not too big.
#[tauri::command]
pub async fn picked_media(token: String) -> Result<String, String> {
    let path = peek(&token, Access::Read)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !editable(&name) {
        return Err("Изменить можно только картинку или видео".into());
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_MEDIA {
        return Err("Файл слишком большой, чтобы менять его здесь".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(hv_roster::keys::encode_b64(&bytes))
}

/// The most a player gets in one answer when it asks for «the rest».
pub const PIECE: u64 = 4 * 1024 * 1024;

/// The bytes asked for (`Range: bytes=…`) of a file of `size`, as first and last; the whole file when nothing is asked,
/// at most [`PIECE`] for an open end; `None` when the ask is not one this answers.
pub fn parse_range(range: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let Some(range) = range else { return Some((0, size - 1)) };
    let spec = range.trim().strip_prefix("bytes=")?;
    let (from, to) = spec.split(',').next()?.split_once('-')?;
    let (from, to) = match (from.trim(), to.trim()) {
        ("", last) => {
            let last: u64 = last.parse().ok()?;
            (size.saturating_sub(last), size - 1)
        }
        (from, "") => {
            let from: u64 = from.parse().ok()?;
            (from, (from + PIECE - 1).min(size - 1))
        }
        (from, to) => (from.parse().ok()?, to.parse::<u64>().ok()?.min(size - 1)),
    };
    (from <= to && from < size).then_some((from, to))
}

/// A piece of a picked picture or video.
#[derive(Debug)]
pub struct Piece {
    pub bytes: Vec<u8>,
    pub from: u64,
    pub to: u64,
    pub size: u64,
    pub kind: String,
}

fn kind_of(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or_default();
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// `hvmedia` `/picked/{token}`: the piece of a picked picture or video the page's editor (its player) asks for, by
/// token, never by path; the token stays for the send.
pub fn piece_of(token: &str, range: Option<&str>) -> Result<Piece, (u16, String)> {
    use std::io::{Read, Seek, SeekFrom};
    let path = peek(token, Access::Read).map_err(|e| (404, e))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !editable(&name) {
        return Err((403, "Только картинки и видео".into()));
    }
    let mut file = std::fs::File::open(&path).map_err(|e| (404, e.to_string()))?;
    let size = file.metadata().map_err(|e| (404, e.to_string()))?.len();
    let (from, to) = parse_range(range, size).ok_or((416, "Нет такой части файла".to_string()))?;
    if range.is_none() && size > MAX_MEDIA {
        return Err((416, "Файл большой — его читают по частям".into()));
    }
    file.seek(SeekFrom::Start(from)).map_err(|e| (500, e.to_string()))?;
    let mut bytes = vec![0; (to - from + 1) as usize];
    file.read_exact(&mut bytes).map_err(|e| (500, e.to_string()))?;
    Ok(Piece { bytes, from, to, size, kind: kind_of(&name).to_string() })
}

/// Where pictures and videos changed in the page wait to be sent.
fn staged_dir() -> PathBuf {
    std::env::temp_dir().join("hatavoice-staged")
}

/// Drops changed files a day old or more (sent, or given up on).
pub fn clean_staged() {
    let Ok(entries) = std::fs::read_dir(staged_dir()) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(24 * 3600));
        if old {
            let _ = if entry.path().is_dir() { std::fs::remove_dir_all(entry.path()) } else { std::fs::remove_file(entry.path()) };
        }
    }
}

/// A picture or a video changed in the page (the photo or video editor), kept on disk to go like a picked file: the
/// bytes come as the request's body, the name (percent-encoded) in `x-name`. Only those kinds, up to 2 GB.
#[tauri::command]
pub async fn stage_media(request: tauri::ipc::Request<'_>) -> Result<Picked, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Нет файла".into());
    };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let name = percent_encoding::percent_decode_str(name).decode_utf8_lossy();
    let name = crate::chat_files::clean_name(&name);
    if !editable(&name) {
        return Err("Изменить можно только картинку или видео".into());
    }
    if bytes.is_empty() || bytes.len() as u64 > crate::chat_files::MAX_BIG_FILE {
        return Err("Файл пустой или больше 2 ГБ".into());
    }
    let dir = staged_dir();
    let unique: String = hv_roster::keys::random_bytes::<6>()?.iter().map(|b| format!("{b:02x}")).collect();
    let path = dir.join(unique).join(&name);
    let bytes = bytes.clone();
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(written.parent().unwrap_or(&written))?;
        std::fs::write(&written, bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Не записался изменённый файл: {e}"))?;
    picked(path, Access::Read)
}

/// A picked file as the page sees it: a token, a name to show, a size.
#[derive(Debug, Clone, Serialize)]
pub struct Picked {
    pub token: String,
    pub name: String,
    pub size: u64,
}

fn picked(path: PathBuf, access: Access) -> Result<Picked, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let size = if access == Access::Read { std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) } else { 0 };
    Ok(Picked { token: hold(path, access)?, name, size })
}

/// What is being picked: it sets the dialog's filter.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Any,
    /// A moderation GIF or short video.
    Gif,
    /// A server icon.
    Icon,
    /// A `.hvid` identity file.
    Identity,
}

fn filter(kind: Kind) -> Option<(&'static str, &'static [&'static str])> {
    match kind {
        Kind::Any => None,
        Kind::Gif => Some(("GIF или видео", &["gif", "mp4", "webm"])),
        Kind::Icon => Some(("Картинка", &["png", "jpg", "jpeg", "gif", "webp"])),
        Kind::Identity => Some(("Личность ХатаВойс", &["hvid"])),
    }
}

/// The type of a picture or a clip by its first bytes, among those a server takes (`server/src/media.rs`): a file is
/// uploaded only if it really is one, whatever it is called, so even a wrong pick sends nothing else.
pub fn sniff_media(bytes: &[u8]) -> Option<&'static str> {
    let starts = |prefix: &[u8]| bytes.starts_with(prefix);
    if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("image/gif")
    } else if starts(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if starts(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if starts(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        Some("video/mp4")
    } else if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("video/webm")
    } else {
        None
    }
}

/// The types each upload may be.
pub fn allowed_media(purpose: &str) -> &'static [&'static str] {
    match purpose {
        "moderation" => &["image/gif", "video/mp4", "video/webm"],
        "icon" => &["image/png", "image/jpeg", "image/gif", "image/webp"],
        _ => &[],
    }
}

/// «Мои гифки»: files used in a kick or ban before, kept here (never in the page) so they can go to another server
/// without being picked again. Only files picked by the person get in, and only GIFs and clips are read back.
pub mod gifs {
    use super::*;

    const FILE: &str = "my-gifs.json";
    const MAX: usize = 30;

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    pub struct Gif {
        pub id: String,
        pub name: String,
        pub path: PathBuf,
    }

    /// What the page sees of one: no path.
    #[derive(Debug, Clone, Serialize)]
    pub struct GifView {
        pub id: String,
        pub name: String,
    }

    pub fn load(dir: &std::path::Path) -> Vec<Gif> {
        std::fs::read(dir.join(FILE)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn save(dir: &std::path::Path, gifs: &[Gif]) {
        if let Ok(bytes) = serde_json::to_vec(gifs) {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(dir.join(FILE), bytes);
        }
    }

    /// Puts a picked file first (once), keeping the 30 latest.
    pub fn remember(dir: &std::path::Path, path: &std::path::Path) {
        let mut gifs = load(dir);
        gifs.retain(|g| g.path != path);
        let id = hv_roster::keys::random_bytes::<9>().map(|b| hv_roster::keys::encode_b64(&b)).unwrap_or_default();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        gifs.insert(0, Gif { id, name, path: path.to_path_buf() });
        gifs.truncate(MAX);
        save(dir, &gifs);
    }

    pub fn views(dir: &std::path::Path) -> Vec<GifView> {
        load(dir).into_iter().map(|g| GifView { id: g.id, name: g.name }).collect()
    }

    pub fn path_of(dir: &std::path::Path, id: &str) -> Option<PathBuf> {
        load(dir).into_iter().find(|g| g.id == id).map(|g| g.path)
    }

    /// The list the page kept before 0.14.1: a path there may have been put by anything, so only a file that really is
    /// a GIF or a clip, and small enough, is taken in.
    pub fn adopt(dir: &std::path::Path, paths: &[String]) {
        for path in paths.iter().take(MAX).rev() {
            let path = std::path::Path::new(path);
            let ok = std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= 8 * 1024 * 1024)
                && std::fs::read(path).ok().and_then(|b| sniff_media(&b)).is_some_and(|m| allowed_media("moderation").contains(&m));
            if ok {
                remember(dir, path);
            }
        }
    }
}

/// Files dropped on the window, from Windows itself: kept for reading, and told to the page by token.
pub fn dropped(paths: Vec<PathBuf>) -> Vec<Picked> {
    paths.into_iter().filter(|p| p.is_file()).filter_map(|p| picked(p, Access::Read).ok()).collect()
}

/// Opens the program's own dialog to pick files to read.
#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle, kind: Kind, multiple: bool, title: Option<String>) -> Result<Vec<Picked>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        // Over the program's window, as a dialog of it.
        #[cfg(desktop)]
        if let Some(main) = tauri::Manager::get_window(&app, "main") {
            dialog = dialog.set_parent(&main);
        }
        if let Some((name, extensions)) = filter(kind) {
            dialog = dialog.add_filter(name, extensions);
        }
        if let Some(title) = title {
            dialog = dialog.set_title(title.chars().take(100).collect::<String>());
        }
        let files = if multiple { dialog.blocking_pick_files().unwrap_or_default() } else { dialog.blocking_pick_file().into_iter().collect() };
        #[cfg(not(target_os = "android"))]
        let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
        #[cfg(target_os = "android")]
        let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| android::readable(&app, f)).collect();
        paths.into_iter().map(|p| picked(p, Access::Read)).collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the program's own dialog to pick where to save, `name` offered.
#[tauri::command]
pub async fn pick_save(app: tauri::AppHandle, kind: Kind, name: String) -> Result<Option<Picked>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(name.chars().take(200).collect::<String>());
        #[cfg(desktop)]
        if let Some(main) = tauri::Manager::get_window(&app, "main") {
            dialog = dialog.set_parent(&main);
        }
        if let Some((title, extensions)) = filter(kind) {
            dialog = dialog.add_filter(title, extensions);
        }
        #[cfg(not(target_os = "android"))]
        let path = dialog.blocking_save_file().and_then(|f| f.into_path().ok());
        #[cfg(target_os = "android")]
        let path = dialog.blocking_save_file().and_then(|f| android::writable(&app, f, &name));
        match path {
            Some(path) => picked(path, Access::Write).map(Some),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// After a command wrote what was picked to be saved: on Android the bytes go on from the program's own copy to the
/// place the person picked; elsewhere the file is already where it belongs.
pub fn written(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "android")]
    android::deliver(path)?;
    let _ = path;
    Ok(())
}

/// A name a picked file may keep in the program's own folder: no folders, no control characters, not too long.
#[cfg(any(target_os = "android", test))]
pub fn plain_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).take(120).collect();
    let name = name.trim().trim_start_matches('.').trim();
    if name.is_empty() { "файл".into() } else { name.to_string() }
}

/// Android gives a picked file as a `content://` address that only the system can open, not as a path. Read: the file is
/// copied into the program's cache once, and the copy is what the token stands for. Save: the command writes into a copy
/// in the cache, which then goes to the picked place. The page never sees either address.
#[cfg(target_os = "android")]
mod android {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{LazyLock, Mutex};

    use tauri::Manager;
    use tauri_plugin_dialog::FilePath;
    use tauri_plugin_fs::{FsExt, OpenOptions};

    /// Copies in the cache waiting to go to the place picked for them.
    static OUTBOX: LazyLock<Mutex<HashMap<PathBuf, (tauri::AppHandle, tauri::Url)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

    /// A fresh folder of its own for one picked file in the cache, so two files of one name never meet.
    fn fresh_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
        let id = hv_roster::keys::encode_b64(&hv_roster::keys::random_bytes::<9>().ok()?);
        let dir = app.path().app_cache_dir().ok()?.join("picked").join(id);
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }

    /// What the program's cache kept of picks from an earlier run goes when the program starts.
    pub fn clean(app: &tauri::AppHandle) {
        if let Ok(dir) = app.path().app_cache_dir() {
            let _ = std::fs::remove_dir_all(dir.join("picked"));
        }
    }

    pub fn readable(app: &tauri::AppHandle, file: FilePath) -> Option<PathBuf> {
        let url = match file {
            FilePath::Path(path) => return Some(path),
            FilePath::Url(url) if url.scheme() == "file" => return url.to_file_path().ok(),
            FilePath::Url(url) => url,
        };
        let name = super::plain_name(&app.path().file_name(url.as_str()).unwrap_or_default());
        let target = fresh_dir(app)?.join(name);
        let mut options = OpenOptions::new();
        options.read(true);
        let mut from = app.fs().open(FilePath::Url(url), options).ok()?;
        let mut to = std::fs::File::create(&target).ok()?;
        std::io::copy(&mut from, &mut to).ok()?;
        Some(target)
    }

    pub fn writable(app: &tauri::AppHandle, file: FilePath, name: &str) -> Option<PathBuf> {
        let url = match file {
            FilePath::Path(path) => return Some(path),
            FilePath::Url(url) if url.scheme() == "file" => return url.to_file_path().ok(),
            FilePath::Url(url) => url,
        };
        let target = fresh_dir(app)?.join(super::plain_name(name));
        OUTBOX.lock().unwrap_or_else(|e| e.into_inner()).insert(target.clone(), (app.clone(), url));
        Some(target)
    }

    pub fn deliver(path: &Path) -> Result<(), String> {
        let Some((app, url)) = OUTBOX.lock().unwrap_or_else(|e| e.into_inner()).remove(path) else { return Ok(()) };
        let mut from = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut options = OpenOptions::new();
        options.write(true).truncate(true).create(true);
        let mut to = app.fs().open(FilePath::Url(url), options).map_err(|e| format!("Не записывается: {e}"))?;
        std::io::copy(&mut from, &mut to).map_err(|e| format!("Не записывается: {e}"))?;
        let _ = std::fs::remove_file(path);
        Ok(())
    }
}

#[cfg(target_os = "android")]
pub use android::clean as clean_android_cache;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_player_gets_the_piece_it_asks_for() {
        assert_eq!(parse_range(Some("bytes=0-"), 10_000_000), Some((0, PIECE - 1)));
        assert_eq!(parse_range(Some("bytes=100-199"), 1000), Some((100, 199)));
        assert_eq!(parse_range(Some("bytes=900-5000"), 1000), Some((900, 999)), "not past the end");
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Some((900, 999)), "the last 100");
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), None, "past the end");
        assert_eq!(parse_range(Some("lines=1-2"), 1000), None);
        assert_eq!(parse_range(None, 1000), Some((0, 999)));
        let path = std::env::temp_dir().join(format!("hv-picked-piece-{}.mp4", std::process::id()));
        std::fs::write(&path, (0..=255u8).cycle().take(5000).collect::<Vec<u8>>()).unwrap();
        let token = hold(path.clone(), Access::Read).unwrap();
        let piece = piece_of(&token, Some("bytes=10-19")).unwrap();
        assert_eq!((piece.bytes, piece.from, piece.to, piece.size, piece.kind.as_str()), ((10..20).collect::<Vec<u8>>(), 10, 19, 5000, "video/mp4"));
        assert!(peek(&token, Access::Read).is_ok(), "playing leaves the token for sending");
        let exe = hold(std::env::temp_dir().join("x.exe"), Access::Read).unwrap();
        assert_eq!(piece_of(&exe, None).unwrap_err().0, 403, "only pictures and videos");
        assert_eq!(piece_of("made-up", None).unwrap_err().0, 404);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_picked_name_keeps_no_folders_or_odd_characters() {
        assert_eq!(plain_name("фото отпуска.jpg"), "фото отпуска.jpg");
        assert_eq!(plain_name("../../files/hatavoice.jks"), "fileshatavoice.jks");
        assert_eq!(plain_name("a\u{0}b:c|d.txt"), "abcd.txt");
        assert_eq!(plain_name(""), "файл");
        assert_eq!(plain_name("..."), "файл");
        assert_eq!(plain_name(&"я".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn a_token_stands_for_its_path_once_and_only_for_its_use() {
        let read = hold(PathBuf::from("C:/picked/отчёт.pdf"), Access::Read).unwrap();
        assert!(take(&read, Access::Write).is_err(), "picked to be read, not to be written");
        assert_eq!(take(&read, Access::Read).unwrap(), PathBuf::from("C:/picked/отчёт.pdf"));
        assert!(take(&read, Access::Read).is_err(), "once");
        let peeked = hold(PathBuf::from("C:/picked/photo.jpg"), Access::Read).unwrap();
        assert_eq!(peek(&peeked, Access::Read).unwrap(), PathBuf::from("C:/picked/photo.jpg"));
        assert_eq!(take(&peeked, Access::Read).unwrap(), PathBuf::from("C:/picked/photo.jpg"), "a look leaves the token");
        assert!(peek(&peeked, Access::Read).is_err());
        assert!(editable("Фото.JPG") && editable("clip.mp4") && !editable("setup.exe") && !editable("photo.jpg.exe"));
        let write = hold(PathBuf::from("C:/picked/save.png"), Access::Write).unwrap();
        assert_eq!(take(&write, Access::Write).unwrap(), PathBuf::from("C:/picked/save.png"));
    }

    #[test]
    fn a_made_up_token_or_a_path_names_nothing() {
        assert!(take("C:/Windows/System32/drivers/etc/hosts", Access::Read).is_err());
        assert!(take("", Access::Write).is_err());
    }

    #[test]
    fn only_real_pictures_and_clips_are_media() {
        assert_eq!(sniff_media(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_media(b"\0\0\0\x18ftypmp42"), Some("video/mp4"));
        assert_eq!(sniff_media(b"MZ\x90\0 a program"), None);
        assert_eq!(sniff_media(b"[ZoneTransfer] or any text"), None);
        assert!(allowed_media("moderation").contains(&"image/gif"));
        assert!(!allowed_media("moderation").contains(&"image/png"));
        assert!(allowed_media("anything").is_empty());
    }

    #[test]
    fn my_gifs_keep_what_was_picked_and_take_in_old_paths_only_if_they_are_gifs() {
        let dir = std::env::temp_dir().join(format!("hv-my-gifs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gif = dir.join("bye.gif");
        std::fs::write(&gif, b"GIF89a....").unwrap();
        let secret = dir.join("id_rsa");
        std::fs::write(&secret, b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        gifs::adopt(&dir, &[secret.to_string_lossy().into_owned(), gif.to_string_lossy().into_owned(), "C:/nope.gif".into()]);
        let views = gifs::views(&dir);
        assert_eq!(views.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["bye.gif"]);
        assert_eq!(gifs::path_of(&dir, &views[0].id), Some(gif.clone()));
        assert_eq!(gifs::path_of(&dir, "made-up"), None);
        gifs::remember(&dir, &gif);
        assert_eq!(gifs::views(&dir).len(), 1, "once");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tokens_are_not_guessable() {
        let a = hold(PathBuf::from("a"), Access::Read).unwrap();
        let b = hold(PathBuf::from("b"), Access::Read).unwrap();
        assert_ne!(a, b);
        assert!(a.len() >= 22, "128 random bits");
    }
}
