//! The studio's stream: the encoded frames from the window go to Twitch, YouTube or any RTMP server, over RTMPS
//! where the service has it. The stream key is a secret: kept under DPAPI in the profile, never given back to the
//! window. A dropped connection is dialled again, and the stream goes on from the next key frame.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use hv_roster::keys::decode_b64_vec;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};

use crate::rtmp::{self, ChunkReader, Endpoint, StreamInfo};

pub const EVENT: &str = "stream";
/// Packets waiting for the network; more means it is too slow, and video is dropped to the next key frame.
const QUEUE: usize = 512;
const RETRY: Duration = Duration::from_secs(3);
const MAX_KEY: usize = 256;

/// The places a stream can go. Each keeps its own key.
const SERVICES: [&str; 10] = ["twitch", "youtube", "tiktok", "vk", "rutube", "kick", "trovo", "facebook", "custom", "custom2"];

/// Where a service takes streams when the person gave no address.
pub fn service_url(service: &str) -> Option<&'static str> {
    match service {
        "twitch" => Some("rtmps://live.twitch.tv:443/app"),
        "youtube" => Some("rtmps://a.rtmps.youtube.com:443/live2"),
        _ => None,
    }
}

fn key_file(app: &AppHandle, service: &str) -> Result<std::path::PathBuf, String> {
    if !SERVICES.contains(&service) {
        return Err("Неизвестный сервис".into());
    }
    Ok(crate::data_dir(app)?.join(format!("stream-{service}.key")))
}

/// A stream key as services give them: printable, no spaces.
pub fn valid_key(key: &str) -> bool {
    (1..=MAX_KEY).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}

#[tauri::command]
pub fn stream_key_set(app: AppHandle, service: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if !valid_key(key) {
        return Err("Ключ трансляции выглядит неверно".into());
    }
    let sealed = hv_host::protect::protect(key.as_bytes())?;
    std::fs::write(key_file(&app, &service)?, sealed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stream_key_has(app: AppHandle, service: String) -> bool {
    key_file(&app, &service).ok().and_then(|path| std::fs::read(path).ok()).is_some()
}

#[tauri::command]
pub fn stream_key_forget(app: AppHandle, service: String) -> Result<(), String> {
    let path = key_file(&app, &service)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_key(app: &AppHandle, service: &str) -> Result<String, String> {
    let sealed = std::fs::read(key_file(app, service)?).map_err(|_| "Сначала сохрани ключ трансляции")?;
    let key = String::from_utf8(hv_host::protect::unprotect(&sealed)?).map_err(|_| "Ключ трансляции испорчен")?;
    valid_key(&key).then_some(key).ok_or_else(|| "Ключ трансляции испорчен".into())
}

/// A frame or a piece of sound for the stream: time in ms from its start.
#[derive(Debug, Clone)]
pub enum Media {
    Video { ms: u32, key: bool, data: Vec<u8>, config: Option<Vec<u8>> },
    Audio { ms: u32, data: Vec<u8>, config: Option<Vec<u8>> },
}

/// One message to send: video or audio, its time, its FLV body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Out {
    Video(u32, Vec<u8>),
    Audio(u32, Vec<u8>),
}

/// What goes out, and when: nothing before a key frame; each track's sequence header before its first frame and
/// again after a new connection or a new config, stamped with that track's own time, so each track's times only grow.
#[derive(Default)]
pub struct Sequencer {
    /// The video is AV1 (Enhanced RTMP), not H.264.
    pub av1: bool,
    video_config: Option<Vec<u8>>,
    audio_config: Option<Vec<u8>>,
    video_header: bool,
    audio_header: bool,
    started: bool,
}

impl Sequencer {
    /// A new connection, or packets lost on the way: headers again, and wait for a key frame.
    pub fn restart(&mut self) {
        self.video_header = false;
        self.audio_header = false;
        self.started = false;
    }

    pub fn take(&mut self, media: Media) -> Vec<Out> {
        let mut out = Vec::new();
        match media {
            Media::Video { ms, key, data, config } => {
                if config.is_some() {
                    self.video_config = config;
                    self.video_header = false;
                }
                if !self.started && !key {
                    return out;
                }
                self.started = true;
                if !self.video_header && let Some(config) = &self.video_config {
                    out.push(Out::Video(ms, if self.av1 { rtmp::av1_header(config) } else { rtmp::video_header(config) }));
                    self.video_header = true;
                }
                if self.video_header {
                    out.push(Out::Video(ms, if self.av1 { rtmp::av1_body(key, &data) } else { rtmp::video_body(key, &data) }));
                }
            }
            Media::Audio { ms, data, config } => {
                if config.is_some() {
                    self.audio_config = config;
                    self.audio_header = false;
                }
                if !self.started {
                    return out;
                }
                if !self.audio_header && let Some(config) = &self.audio_config {
                    out.push(Out::Audio(ms, rtmp::audio_header(config)));
                    self.audio_header = true;
                }
                if self.audio_header {
                    out.push(Out::Audio(ms, rtmp::audio_body(&data)));
                }
            }
        }
        out
    }
}

/// What the window hears of the stream.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum StreamState {
    Connecting,
    Live { kbps: u32 },
    Reconnecting { error: String },
    Off { error: Option<String> },
}

/// What one destination takes.
struct Feed {
    media: mpsc::Sender<Media>,
    congested: std::sync::Arc<AtomicBool>,
}

struct Running {
    feeds: Vec<Feed>,
    stop: watch::Sender<bool>,
}

/// A place to send the stream to, and the address the person gave for it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Destination {
    service: String,
    url: String,
}

/// The address of a destination: what the person gave, or what the service always has.
pub fn destination_url(service: &str, given: &str) -> Result<String, String> {
    let given = given.trim();
    if !given.is_empty() {
        return Ok(given.to_string());
    }
    service_url(service).map(str::to_string).ok_or_else(|| "Укажи адрес сервера".to_string())
}

#[derive(Default)]
pub struct Streamer {
    running: Mutex<Option<Running>>,
}

/// Starts streaming to every destination at once, each with its own connection, with what the window will send.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn stream_start(
    app: AppHandle,
    streamer: tauri::State<'_, Streamer>,
    destinations: Vec<Destination>,
    width: u32,
    height: u32,
    fps: u32,
    kbps: u32,
    audio_kbps: u32,
    av1: Option<bool>,
) -> Result<(), String> {
    if destinations.is_empty() {
        return Err("Некуда стримить".into());
    }
    let mut prepared = Vec::with_capacity(destinations.len());
    for destination in &destinations {
        let address = destination_url(&destination.service, &destination.url)?;
        let endpoint = rtmp::parse_url(&address).ok_or("Адрес должен начинаться с rtmp:// или rtmps://")?;
        prepared.push((destination.service.clone(), endpoint, read_key(&app, &destination.service)?));
    }
    let mut slot = streamer.running.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return Err("Стрим уже идёт".into());
    }
    let (stop, stopped) = watch::channel(false);
    let info = StreamInfo { width, height, fps, video_kbps: kbps, audio_kbps, av1: av1.unwrap_or(false) };
    let mut feeds = Vec::with_capacity(prepared.len());
    for (service, endpoint, key) in prepared {
        let (media, rx) = mpsc::channel(QUEUE);
        let congested = std::sync::Arc::new(AtomicBool::new(false));
        tauri::async_runtime::spawn(run(app.clone(), service, endpoint, key, info, rx, stopped.clone(), congested.clone()));
        feeds.push(Feed { media, congested });
    }
    *slot = Some(Running { feeds, stop });
    Ok(())
}

#[tauri::command]
pub fn stream_stop(streamer: tauri::State<'_, Streamer>) {
    if let Some(running) = streamer.running.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = running.stop.send(true);
    }
}

/// One packet of the window's encoders: `x-kind` (video, audio), `x-ts` (µs), `x-key`, `x-config` (base64).
#[tauri::command]
pub fn stream_packet(streamer: tauri::State<'_, Streamer>, request: Request<'_>) {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let InvokeBody::Raw(data) = request.body() else { return };
    let ms = header("x-ts").and_then(|v| v.parse::<u64>().ok()).map(|us| (us / 1000) as u32).unwrap_or(0);
    let config = header("x-config").filter(|c| !c.is_empty()).and_then(|c| decode_b64_vec(&c));
    let media = match header("x-kind").as_deref() {
        Some("video") => Media::Video { ms, key: header("x-key").as_deref() == Some("1"), data: data.clone(), config },
        Some("audio") => Media::Audio { ms, data: data.clone(), config },
        _ => return,
    };
    let slot = streamer.running.lock().unwrap_or_else(|e| e.into_inner());
    let Some(running) = slot.as_ref() else { return };
    // One slow destination loses its own frames, and nobody else's.
    for feed in &running.feeds {
        if feed.media.try_send(media.clone()).is_err() {
            feed.congested.store(true, Ordering::Relaxed);
        }
    }
}

/// What the window hears: one destination's state.
#[derive(Serialize, Clone)]
struct Told<'a> {
    service: &'a str,
    #[serde(flatten)]
    state: StreamState,
}

fn tell(app: &AppHandle, service: &str, state: StreamState) {
    let _ = app.emit(EVENT, Told { service, state });
}

/// The stream's life: dial, publish, send; on a broken connection dial again, until stopped.
#[allow(clippy::too_many_arguments)]
async fn run(
    app: AppHandle,
    service: String,
    endpoint: Endpoint,
    key: String,
    info: StreamInfo,
    mut rx: mpsc::Receiver<Media>,
    mut stopped: watch::Receiver<bool>,
    congested: std::sync::Arc<AtomicBool>,
) {
    let mut sequencer = Sequencer { av1: info.av1, ..Sequencer::default() };
    let mut first = true;
    loop {
        tell(&app, &service, if first { StreamState::Connecting } else { StreamState::Reconnecting { error: "переподключаюсь".into() } });
        let attempt = async {
            let (read, write) = tokio::io::split(rtmp::dial(&endpoint).await?);
            let mut reader = ChunkReader::new(read);
            let publisher = rtmp::publish(&mut reader, write, &endpoint, &key, info).await?;
            Ok::<_, rtmp::RtmpError>((reader, publisher))
        };
        let connected = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(15), attempt) => result.unwrap_or_else(|_| Err(rtmp::RtmpError::Refused("сервер не ответил за 15 с".into()))),
            _ = stopped.changed() => break,
        };
        let (mut reader, mut publisher) = match connected {
            Ok(pair) => pair,
            Err(e @ rtmp::RtmpError::Refused(_)) if first => {
                tell(&app, &service, StreamState::Off { error: Some(e.to_string()) });
                return;
            }
            Err(e) => {
                tell(&app, &service, StreamState::Reconnecting { error: e.to_string() });
                while rx.try_recv().is_ok() {}
                tokio::select! {
                    _ = tokio::time::sleep(RETRY) => continue,
                    _ = stopped.changed() => break,
                }
            }
        };
        first = false;
        // What the server says goes to a task of its own; its end is the connection's end.
        let (pings, mut pinged) = mpsc::channel::<Vec<u8>>(8);
        let listener = tokio::spawn(async move {
            while let Ok(message) = reader.next().await {
                if message.kind == rtmp::TYPE_USER_CONTROL && pings.send(message.payload).await.is_err() {
                    break;
                }
            }
        });
        sequencer.restart();
        let mut sent = 0usize;
        let mut since = Instant::now();
        tell(&app, &service, StreamState::Live { kbps: 0 });
        let broken = loop {
            tokio::select! {
                media = rx.recv() => {
                    let Some(media) = media else { break None };
                    if congested.swap(false, Ordering::Relaxed) {
                        sequencer.restart();
                    }
                    let mut result = Ok(());
                    for out in sequencer.take(media) {
                        result = match out {
                            Out::Video(ms, body) => {
                                sent += body.len();
                                publisher.video(ms, body).await
                            }
                            Out::Audio(ms, body) => {
                                sent += body.len();
                                publisher.audio(ms, body).await
                            }
                        };
                        if result.is_err() {
                            break;
                        }
                    }
                    if let Err(e) = result {
                        break Some(e.to_string());
                    }
                    let elapsed = since.elapsed();
                    if elapsed >= Duration::from_secs(2) {
                        tell(&app, &service, StreamState::Live { kbps: ((sent as f64 * 8.0) / elapsed.as_secs_f64() / 1000.0) as u32 });
                        sent = 0;
                        since = Instant::now();
                    }
                }
                ping = pinged.recv() => match ping {
                    Some(payload) => {
                        if let Err(e) = publisher.pong(&payload).await {
                            break Some(e.to_string());
                        }
                    }
                    None => break Some("сервер закрыл соединение".into()),
                },
                _ = stopped.changed() => {
                    publisher.close().await;
                    listener.abort();
                    tell(&app, &service, StreamState::Off { error: None });
                    return;
                }
            }
        };
        listener.abort();
        match broken {
            None => break,
            Some(error) => {
                tell(&app, &service, StreamState::Reconnecting { error });
                tokio::select! {
                    _ = tokio::time::sleep(RETRY) => {}
                    _ = stopped.changed() => break,
                }
            }
        }
    }
    tell(&app, &service, StreamState::Off { error: None });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_come_first_and_each_track_keeps_its_time() {
        let mut s = Sequencer::default();
        let video = |ms, key, config: Option<Vec<u8>>| Media::Video { ms, key, data: vec![0x65], config };
        let audio = |ms, config: Option<Vec<u8>>| Media::Audio { ms, data: vec![0x21], config };
        assert!(s.take(audio(5, Some(vec![0x11, 0x90]))).is_empty(), "no sound before the first key frame");
        assert!(s.take(video(0, false, Some(vec![1, 0x64]))).is_empty(), "no picture before a key frame");
        let first = s.take(video(16, true, None));
        assert_eq!(first, vec![Out::Video(16, rtmp::video_header(&[1, 0x64])), Out::Video(16, rtmp::video_body(true, &[0x65]))]);
        assert_eq!(s.take(audio(21, None)), vec![Out::Audio(21, rtmp::audio_header(&[0x11, 0x90])), Out::Audio(21, rtmp::audio_body(&[0x21]))]);
        assert_eq!(s.take(audio(42, None)), vec![Out::Audio(42, rtmp::audio_body(&[0x21]))]);
        assert_eq!(s.take(video(33, false, None)), vec![Out::Video(33, rtmp::video_body(false, &[0x65]))]);
        // A new connection: nothing until a key frame, then both headers again.
        s.restart();
        assert!(s.take(audio(63, None)).is_empty());
        assert!(s.take(video(50, false, None)).is_empty());
        assert_eq!(s.take(video(66, true, None)).len(), 2);
        assert_eq!(s.take(audio(84, None)).len(), 2);
    }

    #[test]
    fn services_and_keys() {
        assert_eq!(service_url("twitch"), Some("rtmps://live.twitch.tv:443/app"));
        assert!(rtmp::parse_url(service_url("youtube").unwrap()).is_some_and(|e| e.tls && e.app == "live2"));
        assert_eq!(service_url("evil"), None);
        assert_eq!(destination_url("twitch", "  ").unwrap(), "rtmps://live.twitch.tv:443/app");
        assert_eq!(destination_url("twitch", " rtmp://own/app ").unwrap(), "rtmp://own/app", "the address given wins");
        assert!(destination_url("tiktok", "").is_err(), "a service with no address of its own needs one");
        assert!(valid_key("live_123456789_AbCdEf"));
        for bad in ["", "with space", "перевод", &"x".repeat(257)] {
            assert!(!valid_key(bad), "{bad}");
        }
    }
}
