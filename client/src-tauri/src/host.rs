//! Hosting your own server from the client: hatavoice-server runs as a child process
//! with its data in the app data folder, so it survives restarts of the client and the PC.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use hv_host::HostConfig;
use serde::Serialize;

use crate::tls::loopback_client;

#[cfg(windows)]
const SERVER_EXE: &str = "hatavoice-server.exe";
#[cfg(windows)]
const LIVEKIT_EXE: &str = "livekit-server.exe";
#[cfg(not(any(windows, target_os = "android")))]
const SERVER_EXE: &str = "hatavoice-server";
#[cfg(not(any(windows, target_os = "android")))]
const LIVEKIT_EXE: &str = "livekit-server";
// On a phone both are packed as libraries: Android unpacks only those, and starts programs only from their folder.
#[cfg(target_os = "android")]
const SERVER_EXE: &str = "libhvserver.so";
#[cfg(target_os = "android")]
const LIVEKIT_EXE: &str = "liblivekit.so";
/// This program's own library on Android, whose folder holds the server too.
#[cfg(any(target_os = "android", test))]
const OWN_LIBRARY: &str = "libhatavoice_lib.so";
const STOP_TIMEOUT: Duration = Duration::from_secs(6);
/// There once the owner turned the server off themselves. Without it the server comes back with the program (after an
/// update, a restart of the PC): a mark that is only there while the server should run is lost too easily, and then
/// friends find it off for no reason (it happened in 0.14.1).
const OFF_FLAG: &str = "server.off";
/// What versions before 0.14.2 kept while the server was on; read no more, removed when met.
const OLD_ON_FLAG: &str = "server.on";

pub fn remember_on(dir: &Path, on: bool) {
    let off = dir.join(OFF_FLAG);
    let _ = std::fs::remove_file(dir.join(OLD_ON_FLAG));
    let _ = if on { std::fs::remove_file(off) } else { std::fs::write(off, b"") };
}

/// Whether the server comes back with the program: there is one here, and its owner did not turn it off.
pub fn was_on(dir: &Path) -> bool {
    has_config(dir) && !dir.join(OFF_FLAG).exists()
}

/// The running server child, if any. Lives in Tauri state.
#[derive(Default)]
pub struct HostProcess(Mutex<Option<Child>>);

#[derive(Debug, Serialize)]
pub struct HostView {
    pub config: Option<HostConfig>,
    pub running: bool,
    /// Why the server stopped on its own: the last lines of its log.
    pub crash: Option<String>,
    /// `/api/host/status` of the running server (LiveKit state, UPnP, addresses).
    pub status: Option<serde_json::Value>,
}

/// Arguments for hatavoice-server in host mode.
pub fn server_args(data_dir: &Path, livekit_bin: &Path) -> Vec<String> {
    vec![
        "--data-dir".into(),
        data_dir.display().to_string(),
        "--livekit-bin".into(),
        livekit_bin.display().to_string(),
    ]
}

/// How a process ended, in words: its exit code, or the signal that ended it and what that usually means.
pub fn exit_words(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (_, Some(signal)) => {
            let what = match signal {
                6 => " — аварийная остановка (abort)",
                9 => " — убит системой (SIGKILL)",
                11 => " — ошибка памяти (SIGSEGV)",
                31 => " — система запретила системный вызов (SIGSYS, на Android это ограничение для приложений)",
                _ => "",
            };
            format!("процесс завершён сигналом {signal}{what}")
        }
        (Some(code), None) => format!("код выхода {code}"),
        (None, None) => "процесс завершился".to_string(),
    }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Last `lines` lines of a log file, for showing why the server stopped.
pub fn log_tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// The folder of the library named `library` in a process's `/proc/self/maps`, if it was loaded from a folder (not
/// straight out of an APK).
#[cfg(any(target_os = "android", test))]
pub fn library_dir(maps: &str, library: &str) -> Option<PathBuf> {
    maps.lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .find(|path| path.starts_with('/') && !path.contains('!') && Path::new(path).file_name().is_some_and(|n| n == library))
        .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
}

#[cfg(not(target_os = "android"))]
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent().map(Path::to_path_buf).ok_or_else(|| "no exe dir".into())
}

/// On Android the program is a library in a shared process (its «exe» is the system's app_process): the server lies in
/// the folder Android unpacked this library to.
#[cfg(target_os = "android")]
fn exe_dir() -> Result<PathBuf, String> {
    let maps = std::fs::read_to_string("/proc/self/maps").map_err(|e| e.to_string())?;
    library_dir(&maps, OWN_LIBRARY).ok_or_else(|| "Не нашёл папку программы".into())
}

fn server_bin() -> Result<PathBuf, String> {
    let path = exe_dir()?.join(SERVER_EXE);
    path.exists()
        .then_some(path.clone())
        .ok_or_else(|| format!("Не найден {}", path.display()))
}

fn livekit_bin() -> Result<PathBuf, String> {
    let bundled = exe_dir()?.join(LIVEKIT_EXE);
    if bundled.exists() {
        return Ok(bundled);
    }
    // Dev builds: the binary fetched by scripts/get-livekit.ps1.
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/livekit").join(LIVEKIT_EXE);
        if dev.exists() {
            return Ok(dev);
        }
    }
    Err(format!("Не найден {LIVEKIT_EXE} рядом с программой"))
}

fn has_config(dir: &Path) -> bool {
    dir.join(hv_host::config::CONFIG_FILE).exists()
}

pub fn read_config(dir: &Path) -> Result<Option<HostConfig>, String> {
    if !has_config(dir) {
        return Ok(None);
    }
    HostConfig::load_or_create(dir).map(Some)
}

/// Erases the server's folder: its config, keys, members, rooms, chat and logs. A file can stay held for a moment after
/// the server and its LiveKit are gone, so it tries a few times before giving up.
pub fn erase(dir: &Path) -> Result<(), String> {
    let mut last = None;
    for attempt in 0..ERASE_TRIES {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last = Some(e),
        }
        if attempt + 1 < ERASE_TRIES {
            std::thread::sleep(ERASE_PAUSE);
        }
    }
    Err(format!(
        "Не все файлы сервера удалились ({}). Закрой программы, которые могут их держать, и попробуй ещё раз",
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

const ERASE_TRIES: u32 = 10;
const ERASE_PAUSE: Duration = Duration::from_millis(300);

pub fn save_config(dir: &Path, process: &HostProcess, config: &HostConfig) -> Result<(), String> {
    if process.is_running() {
        return Err("Сначала выключи сервер — настройки применяются при запуске".into());
    }
    config.save(dir)
}

impl HostProcess {
    fn is_running(&self) -> bool {
        let mut child = self.0.lock().unwrap_or_else(|e| e.into_inner());
        matches!(child.as_mut().map(|c| c.try_wait()), Some(Ok(None)))
    }

    pub fn start(&self, dir: &Path) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = slot.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
        if !has_config(dir) {
            return Err("Сервер ещё не создан".into());
        }
        let log = std::fs::File::create(dir.join("server.log")).map_err(|e| e.to_string())?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;

        let mut command = Command::new(server_bin()?);
        command
            .args(server_args(dir, &livekit_bin()?))
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log_err);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command.spawn().map_err(|e| format!("Сервер не запустился: {e}"))?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // If the client crashes, the server (and its LiveKit) go down with it.
            hv_host::process::kill_with_this_process(child.as_raw_handle())?;
        }
        *slot = Some(child);
        Ok(())
    }

    /// Asks the server to stop (it closes router ports), then kills it if it doesn't.
    pub async fn stop(&self, api_port: u16) -> Result<(), String> {
        if !self.is_running() {
            return Ok(());
        }
        if let Ok(client) = loopback_client(Duration::from_secs(2)) {
            let _ = client.post(format!("https://127.0.0.1:{api_port}/api/host/shutdown")).send().await;
        }
        let deadline = std::time::Instant::now() + STOP_TIMEOUT;
        while std::time::Instant::now() < deadline {
            if !self.is_running() {
                *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub async fn view(&self, dir: &Path) -> Result<HostView, String> {
        let config = read_config(dir)?;
        let (running, crashed): (bool, Option<String>) = {
            let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_mut().map(|c| c.try_wait()) {
                Some(Ok(None)) => (true, None),
                Some(Ok(Some(status))) => (false, (!status.success()).then(|| exit_words(status.code(), exit_signal(&status)))),
                _ => (false, None),
            }
        };
        // The last lines of its log, and how it ended: a server killed by the system (on a phone: a call Android refuses)
        // writes no line at all, and «не запустился:» with nothing after it said nothing.
        let crash = crashed.map(|how| {
            let tail = std::fs::read_to_string(dir.join("server.log")).map(|text| log_tail(&text, 6)).unwrap_or_default();
            if tail.trim().is_empty() { how } else { format!("{tail}\n({how})") }
        });
        let status = match (&config, running) {
            (Some(config), true) => match loopback_client(Duration::from_secs(2)) {
                Ok(client) => client
                    .get(format!("https://127.0.0.1:{}/api/host/status", config.api_port))
                    .send()
                    .await
                    .ok()
                    .and_then(|r| r.error_for_status().ok()),
                Err(_) => None,
            },
            _ => None,
        };
        let status = match status {
            Some(response) => response.json().await.ok(),
            None => None,
        };
        Ok(HostView { config, running, crash, status })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_crash_says_how_the_server_ended() {
        assert_eq!(exit_words(Some(1), None), "код выхода 1");
        assert!(exit_words(None, Some(31)).contains("SIGSYS"));
        assert!(exit_words(None, Some(11)).starts_with("процесс завершён сигналом 11"));
        assert_eq!(exit_words(None, Some(42)), "процесс завершён сигналом 42");
        assert_eq!(exit_words(None, None), "процесс завершился");
    }

    #[test]
    fn the_server_on_a_phone_lies_next_to_the_programs_own_library() {
        let maps = [
            "7a1c000000-7a1c100000 r--p 00000000 fd:05 123 /system/lib64/libc.so",
            "7b00000000-7b00100000 r-xp 00000000 fd:05 456 /data/app/~~x==/com.hatavoice.app-y==/lib/arm64/libhatavoice_lib.so",
            "7c00000000-7c00001000 rw-p 00000000 00:00 0 [anon:stack]",
        ]
        .join("\n");
        assert_eq!(library_dir(&maps, OWN_LIBRARY), Some(PathBuf::from("/data/app/~~x==/com.hatavoice.app-y==/lib/arm64")));
        // Loaded straight out of the APK (not unpacked): there is no folder to start the server from.
        let packed = "7b00000000-7b00100000 r-xp 00000000 fd:05 456 /data/app/x/base.apk!/lib/arm64-v8a/libhatavoice_lib.so";
        assert_eq!(library_dir(packed, OWN_LIBRARY), None);
        assert_eq!(library_dir("", OWN_LIBRARY), None);
        assert_eq!(library_dir("1-2 r-xp 0 0:0 1 /data/libhatavoice_lib.so.bak", OWN_LIBRARY), None);
    }

    #[test]
    fn server_runs_in_host_mode_with_our_data_dir_and_livekit() {
        let args = server_args(Path::new("C:\\data dir"), Path::new("C:\\lk\\livekit-server.exe"));
        assert_eq!(args, ["--data-dir", "C:\\data dir", "--livekit-bin", "C:\\lk\\livekit-server.exe"]);
    }

    #[test]
    fn the_server_comes_back_unless_its_owner_turned_it_off() {
        let dir = std::env::temp_dir().join(format!("hv-on-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!was_on(&dir), "no server here: nothing to start");
        HostConfig::default().save(&dir).unwrap();
        // No mark at all (a lost one, or a server made by an older version): it comes back.
        assert!(was_on(&dir));
        remember_on(&dir, false);
        assert!(!was_on(&dir), "turned off by hand: it stays off");
        remember_on(&dir, true);
        assert!(was_on(&dir));
        // The old mark of being on goes when met; it decides nothing.
        std::fs::write(dir.join(OLD_ON_FLAG), b"").unwrap();
        remember_on(&dir, true);
        assert!(!dir.join(OLD_ON_FLAG).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn erasing_takes_the_whole_server_folder() {
        let dir = std::env::temp_dir().join(format!("hv-erase-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("roster")).unwrap();
        HostConfig::default().save(&dir).unwrap();
        remember_on(&dir, true);
        std::fs::write(dir.join("roster").join("journal.bin"), b"entries").unwrap();
        erase(&dir).unwrap();
        assert!(!dir.exists());
        assert!(matches!(read_config(&dir), Ok(None)), "no server any more");
        assert!(!was_on(&dir), "nothing comes back with the program");
        // Erasing what is not there is not an error.
        erase(&dir).unwrap();
    }

    #[test]
    fn log_tail_keeps_the_last_lines() {
        assert_eq!(log_tail("a\nb\nc\nd\n", 2), "c\nd");
        assert_eq!(log_tail("only", 5), "only");
        assert_eq!(log_tail("", 3), "");
    }
}
