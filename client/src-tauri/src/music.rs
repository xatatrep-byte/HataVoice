//! Music together on Windows: the programs playing sound now, what is playing in one (Windows' media controls), and
//! its sound for the call through a lane of its own (`screen_audio::Lane::Music`).

use std::collections::{HashMap, HashSet};

use serde::Serialize;

/// A program playing sound on this PC: what the start dialog lists.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SoundSource {
    pub pid: u32,
    /// As the program calls itself (its file's description), else its file's name.
    pub name: String,
    pub exe: String,
    /// Its loudest session's peak now, 0–1.
    pub level: f32,
    /// Playing now (not only open).
    pub active: bool,
}

/// What Windows' media controls say a program plays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    /// The cover as Windows gives it, `data:<type>;base64,…` (the page shrinks it before sending).
    pub cover: Option<String>,
}

/// Families of players and browsers: one of these in the media controls' app id and in the program's file name means
/// the same program (Yandex Music's file is «Яндекс Музыка.exe», its id `ru.yandex…`).
const FAMILIES: &[&[&str]] = &[
    &["spotify"],
    &["yandex", "яндекс"],
    &["vk", "вк"],
    &["chrome"],
    &["msedge", "edge"],
    &["firefox"],
    &["opera"],
    &["browser"],
    &["deezer"],
    &["itunes", "apple"],
    &["aimp"],
    &["foobar"],
    &["vlc"],
    &["winamp"],
];

/// Whether the media controls' session of app id `aumid` is the program whose file is `exe`.
pub fn session_matches(aumid: &str, exe: &str) -> bool {
    let id = aumid.trim().to_lowercase();
    let file = exe.trim().to_lowercase();
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    if id.is_empty() || stem.is_empty() {
        return false;
    }
    if id == file || id == stem {
        return true;
    }
    FAMILIES.iter().any(|family| family.iter().any(|name| id.contains(name)) && family.iter().any(|name| stem.contains(name)))
}

/// Which of the media controls' sessions (by app id) is program `exe`'s: only that one, never the one playing now
/// elsewhere (a program with no session of its own would show another program's track to the call).
pub fn chosen_session(ids: &[String], exe: &str) -> Option<usize> {
    ids.iter().position(|id| session_matches(id, exe))
}

/// `root` and every process it started, by (pid, parent) pairs: this app and its WebView2 are never offered.
pub fn descendants_of(root: u32, tree: &[(u32, u32)]) -> HashSet<u32> {
    let mut ours = HashSet::from([root]);
    loop {
        let before = ours.len();
        for &(pid, parent) in tree {
            if pid != parent && ours.contains(&parent) {
                ours.insert(pid);
            }
        }
        if ours.len() == before {
            return ours;
        }
    }
}

/// One row per program (its loudest session), those playing now first, the loudest first, then by name.
pub fn sort_sources(sources: Vec<SoundSource>) -> Vec<SoundSource> {
    let mut by_pid: HashMap<u32, SoundSource> = HashMap::new();
    for source in sources {
        by_pid
            .entry(source.pid)
            .and_modify(|seen| {
                seen.level = seen.level.max(source.level);
                seen.active |= source.active;
            })
            .or_insert(source);
    }
    let mut list: Vec<SoundSource> = by_pid.into_values().collect();
    list.sort_by(|a, b| b.active.cmp(&a.active).then(b.level.total_cmp(&a.level)).then_with(|| a.name.cmp(&b.name)));
    list
}

#[cfg(windows)]
mod win {
    use super::*;
    use base64::Engine as _;
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionMediaProperties,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::Foundation::{CloseHandle, S_OK};
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{eMultimedia, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    /// The most bytes of a cover taken from Windows (the page shrinks it to a small JPEG).
    const MAX_THUMBNAIL: u32 = 2 * 1024 * 1024;

    /// Runs `f` on a thread of its own with COM on: the commands' own threads may have it on in another mode.
    pub fn with_com<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
        std::thread::spawn(move || {
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let out = f();
            unsafe { CoUninitialize() };
            out
        })
        .join()
        .map_err(|_| "Звук программ не ответил".to_string())
    }

    fn process_tree() -> Vec<(u32, u32)> {
        let mut tree = Vec::new();
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return tree };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                tree.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(snapshot) };
        tree
    }

    /// The program's file of `pid`.
    pub fn image_path(pid: u32) -> Option<String> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let done = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size) };
        let _ = unsafe { CloseHandle(process) };
        done.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }

    /// How the program calls itself: its file's description, e.g. «Яндекс Музыка», «Spotify», «Google Chrome».
    fn description(path: &str) -> Option<String> {
        let wide = HSTRING::from(path);
        let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        unsafe { GetFileVersionInfoW(PCWSTR(wide.as_ptr()), Some(0), size, data.as_mut_ptr().cast()) }.ok()?;
        let query = |key: &str| -> Option<(*mut std::ffi::c_void, u32)> {
            let key = HSTRING::from(key);
            let mut at = std::ptr::null_mut();
            let mut len = 0u32;
            unsafe { VerQueryValueW(data.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut at, &mut len) }.as_bool().then_some((at, len))
        };
        let (translation, len) = query("\\VarFileInfo\\Translation")?;
        if len < 4 {
            return None;
        }
        let pair = unsafe { std::slice::from_raw_parts(translation as *const u16, 2) };
        let (text, len) = query(&format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", pair[0], pair[1]))?;
        let chars = unsafe { std::slice::from_raw_parts(text as *const u16, len as usize) };
        let name = String::from_utf16_lossy(chars).trim_end_matches('\0').trim().to_string();
        (!name.is_empty()).then_some(name)
    }

    pub fn file_name(path: &str) -> String {
        std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    pub fn sources() -> Result<Vec<SoundSource>, String> {
        let ours = descendants_of(std::process::id(), &process_tree());
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| format!("Нет звука в Windows: {e}"))?;
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) }.map_err(|e| format!("Нет устройства вывода звука: {e}"))?;
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
        let sessions = unsafe { manager.GetSessionEnumerator() }.map_err(|e| e.to_string())?;
        let count = unsafe { sessions.GetCount() }.map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        for i in 0..count {
            let Ok(control) = (unsafe { sessions.GetSession(i) }) else { continue };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
            if unsafe { control2.IsSystemSoundsSession() } == S_OK {
                continue;
            }
            let Ok(pid) = (unsafe { control2.GetProcessId() }) else { continue };
            if pid == 0 || ours.contains(&pid) {
                continue;
            }
            let active = unsafe { control.GetState() }.is_ok_and(|state| state == AudioSessionStateActive);
            let level = control.cast::<IAudioMeterInformation>().ok().and_then(|meter| unsafe { meter.GetPeakValue() }.ok()).unwrap_or(0.0);
            let Some(path) = image_path(pid) else { continue };
            let exe = file_name(&path);
            let name = description(&path).unwrap_or_else(|| exe.trim_end_matches(".exe").to_string());
            found.push(SoundSource { pid, name, exe, level, active });
        }
        Ok(sort_sources(found))
    }

    fn read_thumbnail(props: &GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
        let kind = stream.ContentType().ok().map(|k| k.to_string()).filter(|k| k.starts_with("image/")).unwrap_or_else(|| "image/jpeg".into());
        let size = u32::try_from(stream.Size().ok()?).ok()?.min(MAX_THUMBNAIL);
        if size == 0 {
            return None;
        }
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        let got = reader.LoadAsync(size).ok()?.join().ok()?;
        let mut bytes = vec![0u8; got as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    fn playing_now(session: &GlobalSystemMediaTransportControlsSession) -> bool {
        session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .is_ok_and(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
    }

    pub fn now_playing(exe: &str) -> Option<NowPlaying> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.join().ok()?;
        let sessions: Vec<GlobalSystemMediaTransportControlsSession> = (&manager.GetSessions().ok()?).into_iter().collect();
        let ids: Vec<String> = sessions.iter().map(|s| s.SourceAppUserModelId().map(|id| id.to_string()).unwrap_or_default()).collect();
        // The picked program's own session, or nothing: what another program plays is not the call's to see.
        let session = sessions.into_iter().nth(chosen_session(&ids, exe)?)?;
        let props = session.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
        let title = props.Title().map(|t| t.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|a| a.to_string()).unwrap_or_default();
        if title.is_empty() && artist.is_empty() {
            return None;
        }
        Some(NowPlaying { title, artist, playing: playing_now(&session), cover: read_thumbnail(&props) })
    }
}

/// The programs playing sound on this PC now, this app left out.
#[tauri::command]
pub async fn music_sources() -> Result<Vec<SoundSource>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| win::with_com(win::sources)).await.map_err(|e| e.to_string())??
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// What `music_now` says once the program is gone: the page stops the music for everyone.
pub const MUSIC_GONE: &str = "Программа с музыкой закрылась";

/// What program `pid` plays, as Windows' media controls say; `MUSIC_GONE` once the program is closed.
#[tauri::command]
pub async fn music_now(pid: u32) -> Result<Option<NowPlaying>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            win::with_com(move || match win::image_path(pid) {
                None => Err(MUSIC_GONE.to_string()),
                Some(path) => Ok(win::now_playing(&win::file_name(&path))),
            })
        })
        .await
        .map_err(|e| e.to_string())??
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Ok(None)
    }
}

/// The sound of program `pid` (and what it started) goes to the page as music.
#[tauri::command]
pub async fn music_start(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    if cfg!(not(windows)) {
        return Err("Музыку можно включать только с ПК на Windows".into());
    }
    crate::screen_audio::start_lane(app, crate::screen_audio::AudioFrom::Process { pid }, crate::screen_audio::Lane::Music).await
}

#[tauri::command]
pub fn music_stop() {
    crate::screen_audio::stop_lane(crate::screen_audio::Lane::Music);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_is_found_among_the_media_controls() {
        assert!(session_matches("Spotify.exe", "Spotify.exe"));
        assert!(session_matches("Chrome", "chrome.exe"));
        assert!(session_matches("ru.yandex.desktop.music", "Яндекс Музыка.exe"));
        assert!(session_matches("MSEdge", "msedge.exe"));
        assert!(session_matches("Yandex.Browser.ABC", "browser.exe"));
        assert!(!session_matches("Spotify.exe", "chrome.exe"));
        assert!(!session_matches("", "chrome.exe"));
    }

    #[test]
    fn what_plays_is_read_only_from_the_program_picked() {
        let ids = ["Zen".to_string(), "Spotify.exe".to_string()];
        assert_eq!(chosen_session(&ids, "Spotify.exe"), Some(1));
        // A program the media controls do not know: nothing, never what another program plays (the live check showed a
        // browser's track for a program that has no session).
        assert_eq!(chosen_session(&ids, "powershell.exe"), None);
        assert_eq!(chosen_session(&[], "Spotify.exe"), None);
    }

    #[test]
    fn this_app_and_what_it_started_are_left_out() {
        // (pid, parent): 10 is us, 11 and 12 our WebView2, 13 a child of 12; 20 another program.
        let tree = [(10, 1), (11, 10), (12, 10), (13, 12), (20, 1), (21, 20)];
        let ours = descendants_of(10, &tree);
        for pid in [10, 11, 12, 13] {
            assert!(ours.contains(&pid), "{pid}");
        }
        assert!(!ours.contains(&20) && !ours.contains(&21));
    }

    #[test]
    fn the_programs_playing_now_come_first() {
        let source = |pid, name: &str, level, active| SoundSource { pid, name: name.into(), exe: format!("{name}.exe"), level, active };
        let sorted = sort_sources(vec![source(1, "Б", 0.0, false), source(2, "А", 0.2, true), source(3, "В", 0.6, true), source(2, "А", 0.4, true)]);
        assert_eq!(sorted.iter().map(|s| s.pid).collect::<Vec<_>>(), vec![3, 2, 1], "loudest first, one row per program");
        assert_eq!(sorted[1].level, 0.4, "a program's loudest session");
    }

    #[cfg(windows)]
    #[test]
    fn windows_lists_the_programs_with_sound_and_reads_the_media_controls() {
        let sources = win::with_com(win::sources).expect("a thread").expect("the sessions");
        assert!(sources.iter().all(|s| s.pid != std::process::id()), "never this program");
        assert!(sources.iter().all(|s| !s.exe.is_empty() && (0.0..=1.0).contains(&s.level)));
        // Whatever plays here, asking for a program that is not there answers nothing (or the one playing), never fails.
        let _ = win::with_com(|| win::now_playing("no-such-player.exe")).expect("a thread");
    }
}
