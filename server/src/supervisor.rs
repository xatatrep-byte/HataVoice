//! Runs livekit-server as a child process and restarts it if it dies.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::process::Command;

/// Crashing faster than this after start counts as a failed start.
const HEALTHY_UPTIME: Duration = Duration::from_secs(10);
/// After this many failed starts in a row we stop retrying and report the error.
const MAX_FAILED_STARTS: u32 = 5;
const READY_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum LiveKitState {
    Starting,
    Running,
    Restarting(String),
    Failed(String),
}

pub type SharedState = Arc<RwLock<LiveKitState>>;

pub struct LiveKitProcess {
    pub binary: PathBuf,
    pub config_path: PathBuf,
    pub log_path: PathBuf,
    pub port: u16,
}

/// Pause before restart attempt `attempt` (1-based): 1 s, 2 s, 4 s … capped at 30 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.saturating_sub(1).min(5)).min(Duration::from_secs(30))
}

fn set(state: &SharedState, value: LiveKitState) {
    *state.write().unwrap_or_else(|e| e.into_inner()) = value;
}

async fn wait_ready(port: u16, child: &mut tokio::process::Child) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("livekit-server завершился при запуске ({status})"));
        }
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("livekit-server не ответил за 20 секунд".into())
}

/// How much of LiveKit's last words goes into the error the owner sees.
const LAST_WORDS_CHARS: usize = 300;

/// The last line LiveKit wrote, cut short: a start that fails says why there («could not validate RTC config: …»), and
/// the owner sees it without opening a file on the phone.
pub fn last_words(log: &str) -> Option<String> {
    let line = log.lines().rev().map(str::trim).find(|line| !line.is_empty())?;
    let mut words: String = line.chars().take(LAST_WORDS_CHARS).collect();
    if line.chars().count() > LAST_WORDS_CHARS {
        words.push('…');
    }
    Some(words)
}

/// The end of LiveKit's log, read without taking a large log whole.
fn log_last_words(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(4096))).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    last_words(&String::from_utf8_lossy(&tail))
}

async fn run_once(process: &LiveKitProcess, state: &SharedState) -> Result<(), String> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&process.log_path)
        .map_err(|e| format!("Не открывается {}: {e}", process.log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut command = Command::new(&process.binary);
    command
        .arg("--config")
        .arg(&process.config_path)
        // Only the signaling port is bound; RTC ports always listen on all interfaces.
        .args(["--bind", "127.0.0.1"])
        .stdout(log)
        .stderr(log_err)
        .kill_on_drop(true);
    // Started from the client the server has no console, so LiveKit would get a window of its own.
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Не запускается {}: {e}", process.binary.display()))?;
    #[cfg(windows)]
    if let Some(handle) = child.raw_handle() {
        if let Err(e) = hv_host::process::kill_with_this_process(handle) {
            tracing::warn!("LiveKit may outlive the server if it crashes: {e}");
        }
    }

    if let Err(e) = wait_ready(process.port, &mut child).await {
        return Err(match log_last_words(&process.log_path) {
            Some(words) => format!("{e}: {words}"),
            None => e,
        });
    }
    set(state, LiveKitState::Running);
    tracing::info!("LiveKit is running");

    let status = child.wait().await.map_err(|e| e.to_string())?;
    Err(format!("livekit-server остановился ({status})"))
}

/// Starts LiveKit in the background and keeps it running; returns the live state.
pub fn spawn(process: LiveKitProcess) -> SharedState {
    let state: SharedState = Arc::new(RwLock::new(LiveKitState::Starting));
    let shared = state.clone();
    tokio::spawn(async move {
        let mut failed_starts = 0;
        loop {
            let started = Instant::now();
            let error = run_once(&process, &shared).await.unwrap_err();
            tracing::error!("{error}");
            if started.elapsed() >= HEALTHY_UPTIME {
                failed_starts = 0;
            }
            failed_starts += 1;
            if failed_starts >= MAX_FAILED_STARTS {
                set(&shared, LiveKitState::Failed(format!("{error}. Подробности: {}", process.log_path.display())));
                return;
            }
            set(&shared, LiveKitState::Restarting(error));
            tokio::time::sleep(backoff(failed_starts)).await;
            set(&shared, LiveKitState::Starting);
        }
    });
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_is_capped() {
        let secs: Vec<u64> = (1..=8).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn a_failed_start_says_why_in_the_last_line_of_the_log() {
        let log = "2026-11-20 INFO starting\ncould not validate RTC config: route ip+net: netlinkrib: permission denied\n\n";
        assert_eq!(last_words(log).as_deref(), Some("could not validate RTC config: route ip+net: netlinkrib: permission denied"));
        assert_eq!(last_words("\n  \n"), None);
        let long = "я".repeat(LAST_WORDS_CHARS + 50);
        let words = last_words(&long).unwrap();
        assert_eq!(words.chars().count(), LAST_WORDS_CHARS + 1);
        assert!(words.ends_with('…'));
    }

    #[test]
    fn state_serializes_for_the_client() {
        let json = serde_json::to_value(LiveKitState::Failed("нет файла".into())).unwrap();
        assert_eq!(json, serde_json::json!({"state": "failed", "detail": "нет файла"}));
        let json = serde_json::to_value(LiveKitState::Running).unwrap();
        assert_eq!(json, serde_json::json!({"state": "running"}));
    }
}
