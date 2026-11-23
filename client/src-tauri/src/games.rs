//! «Играет в …»: every 15 s the running programs are matched against known games. Only the
//! game's title leaves this PC, never the process list.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager};

const CHECK_EVERY: Duration = Duration::from_secs(15);

/// Programs a stream is made with: while one runs, the window may hide what a stream must not show.
const STREAMING_APPS: &[&str] = &[
    "obs64.exe",
    "obs32.exe",
    "obs.exe",
    "streamlabs obs.exe",
    "streamlabs desktop.exe",
    "xsplit.core.exe",
    "xsplitbroadcaster.exe",
    "twitchstudio.exe",
    "prismlivestudio.exe",
    "meld studio.exe",
];

/// A program to stream with runs among `exe_names`.
pub fn streaming(exe_names: &[String]) -> bool {
    exe_names.iter().any(|name| STREAMING_APPS.contains(&name.to_lowercase().as_str()))
}

/// Built-in list: exe name (lower case) → game title.
pub fn known_games() -> HashMap<String, String> {
    serde_json::from_str(include_str!("../games.json")).expect("games.json is valid JSON")
}

/// The game among `exe_names`; games the user added (exe → title) win over the built-in list.
pub fn match_game(exe_names: &[String], known: &HashMap<String, String>, custom: &[(String, String)]) -> Option<String> {
    let running: Vec<String> = exe_names.iter().map(|name| name.to_lowercase()).collect();
    let own = custom.iter().find(|(exe, _)| running.contains(&exe.to_lowercase())).map(|(_, title)| title.clone());
    own.or_else(|| running.iter().find_map(|exe| known.get(exe).cloned()))
}

/// Exe names of the running processes, lower case.
#[cfg(windows)]
pub fn running_exes() -> Vec<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let mut names = Vec::new();
    // SAFETY: plain Win32 calls on a snapshot we own; the entry is sized as the API requires.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return names;
        };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            names.push(String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase());
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    names
}

#[cfg(not(windows))]
pub fn running_exes() -> Vec<String> {
    Vec::new()
}

/// «Показывать, во что я играю», the user's own games, and whether a program to stream with runs.
pub struct GameWatch {
    enabled: AtomicBool,
    custom: Mutex<Vec<(String, String)>>,
    streaming: AtomicBool,
}

impl Default for GameWatch {
    fn default() -> Self {
        Self { enabled: AtomicBool::new(true), custom: Mutex::default(), streaming: AtomicBool::new(false) }
    }
}

#[tauri::command]
pub fn games_enable(watch: tauri::State<'_, GameWatch>, enabled: bool) {
    watch.enabled.store(enabled, Ordering::Relaxed);
}

/// OBS (or another program to stream with) runs now, as of the last check.
#[tauri::command]
pub fn streaming_status(watch: tauri::State<'_, GameWatch>) -> bool {
    watch.streaming.load(Ordering::Relaxed)
}

#[derive(serde::Deserialize)]
pub struct CustomGame {
    exe: String,
    title: String,
}

#[tauri::command]
pub fn games_custom(watch: tauri::State<'_, GameWatch>, games: Vec<CustomGame>) {
    let list = games.into_iter().filter(|g| !g.exe.trim().is_empty() && !g.title.trim().is_empty());
    *watch.custom.lock().unwrap_or_else(|e| e.into_inner()) = list.map(|g| (g.exe.trim().to_string(), g.title.trim().to_string())).collect();
}

/// Checks every 15 s and tells the open servers when the game changes (or a server is added), and the window
/// when a program to stream with starts or stops (`streaming`, true or false).
pub fn spawn_game_watch(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let known = known_games();
        let mut sent: Option<(Option<String>, Vec<String>)> = None;
        loop {
            let watch = app.state::<GameWatch>();
            let exes = tauri::async_runtime::spawn_blocking(running_exes).await.unwrap_or_default();
            let streams = streaming(&exes);
            if watch.streaming.swap(streams, Ordering::Relaxed) != streams {
                let _ = app.emit("streaming", streams);
            }
            let game = if watch.enabled.load(Ordering::Relaxed) {
                let custom = watch.custom.lock().unwrap_or_else(|e| e.into_inner()).clone();
                match_game(&exes, &known, &custom)
            } else {
                None
            };
            let addresses = crate::commands::open_addresses(&app).await;
            let now = (game, addresses);
            if sent.as_ref() != Some(&now) {
                crate::commands::send_presence(&app, now.0.clone()).await;
                sent = Some(now);
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exes(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn finds_a_known_game_case_insensitively() {
        let known = known_games();
        assert_eq!(match_game(&exes(&["explorer.exe", "CS2.EXE"]), &known, &[]), Some("Counter-Strike 2".into()));
        assert_eq!(match_game(&exes(&["explorer.exe", "chrome.exe"]), &known, &[]), None);
    }

    #[test]
    fn obs_and_its_kin_are_told_apart_from_games() {
        assert!(streaming(&exes(&["explorer.exe", "OBS64.EXE"])));
        assert!(streaming(&exes(&["Streamlabs OBS.exe"])));
        assert!(!streaming(&exes(&["explorer.exe", "cs2.exe", "obs-browser-page.exe"])));
    }

    #[test]
    fn custom_games_win_over_the_built_in_list() {
        let known = known_games();
        let custom = vec![("cs2.exe".to_string(), "Контра с друзьями".to_string()), ("mygame.exe".into(), "Моя игра".into())];
        assert_eq!(match_game(&exes(&["cs2.exe"]), &known, &custom), Some("Контра с друзьями".into()));
        assert_eq!(match_game(&exes(&["MyGame.exe"]), &known, &custom), Some("Моя игра".into()));
    }

    #[test]
    fn games_json_is_valid_and_has_200_entries() {
        let known = known_games();
        assert!(known.len() >= 200, "only {} games", known.len());
        assert!(known.keys().all(|exe| exe.ends_with(".exe") && *exe == exe.to_lowercase()));
        assert!(known.values().all(|title| !title.trim().is_empty()));
        for generic in ["javaw.exe", "game.exe", "launcher.exe", "steam.exe", "shootergame.exe"] {
            assert!(!known.contains_key(generic), "{generic} would match too much");
        }
    }

    #[test]
    fn this_pc_lists_its_own_process() {
        let running = running_exes();
        assert!(!running.is_empty());
        assert!(running.iter().all(|exe| *exe == exe.to_lowercase()));
    }
}
