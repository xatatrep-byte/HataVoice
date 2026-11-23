//! The sound that goes with our own screen capture: Windows' process loopback, either every program but this one (the
//! friends' voices this app plays never go back to them) or only the program of the window shown, with what it started.
//! Packets of 48 kHz stereo float reach the page like the frames do: slots of a WebView2 shared buffer, a web message
//! per packet. A slot is `seq: u32, frames: u32, _: u64`, then `frames` × 2 floats; `seq` is odd while it is written.

use serde::Deserialize;

pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
pub const AUDIO_HEADER: usize = 16;
/// The most frames a slot holds (100 ms): a bigger packet goes in several.
pub const SLOT_FRAMES: usize = 4_800;
pub const AUDIO_SLOTS: usize = 50;

pub fn audio_slot_size() -> usize {
    AUDIO_HEADER + SLOT_FRAMES * CHANNELS * 4
}

/// Two captures may run at once, each with its own buffer, message and stop: the sound of a shared screen, and music
/// played together (`music.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Screen,
    Music,
}

impl Lane {
    /// The shared buffer's name, and the `hv` of its messages, as the page reads them (`OwnAudioTrack`).
    pub fn buffer(self) -> &'static str {
        match self {
            Lane::Screen => "audio",
            Lane::Music => "music",
        }
    }

    pub fn index(self) -> usize {
        match self {
            Lane::Screen => 0,
            Lane::Music => 1,
        }
    }
}

/// Each lane's stop flag, while it runs.
pub type Flags = [Option<std::sync::Arc<std::sync::atomic::AtomicBool>>; 2];

/// The running capture of `lane` stops; the other runs on.
pub fn take_flag(flags: &mut Flags, lane: Lane) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    flags[lane.index()].take()
}

/// Whose sound goes out with the picture.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AudioFrom {
    /// Every program but this one: the computer's sound, without the call.
    Computer,
    /// The program of this window, and what it started.
    Window { id: u64 },
    /// This program, and what it started: the player music is played from.
    Process { pid: u32 },
}

/// A packet of `frames` cut to slot-sized pieces: (first frame, frames) of each.
pub fn pieces(frames: usize) -> Vec<(usize, usize)> {
    (0..frames).step_by(SLOT_FRAMES).map(|start| (start, SLOT_FRAMES.min(frames - start))).collect()
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};

    use windows::core::{implement, Interface, Ref, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HWND, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Activated(Mutex<Option<mpsc::Sender<()>>>);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            if let Some(done) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = done.send(());
            }
            Ok(())
        }
    }

    static STOPS: Mutex<Flags> = Mutex::new([None, None]);



    /// The audio client of the process loopback asked for (COM must be on in this thread).
    fn loopback(from: &AudioFrom) -> Result<IAudioClient, String> {
        let (pid, mode) = match from {
            AudioFrom::Computer => (std::process::id(), PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE),
            AudioFrom::Window { id } => {
                let mut pid = 0;
                unsafe { GetWindowThreadProcessId(HWND(*id as usize as *mut _), Some(&mut pid)) };
                if pid == 0 {
                    return Err("Окно закрыто: его звука нет".into());
                }
                (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE)
            }
            AudioFrom::Process { pid } => (*pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
        };
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 { ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: mode } },
        };
        // `PROPVARIANT` frees what it points at when dropped (PropVariantClear): these bytes are on the stack, so it never is.
        let blob = std::mem::ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 },
                    },
                }),
            },
        });
        let (done, wait) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(done))).into();
        let operation = unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*blob), &handler) }
            .map_err(|e| format!("Звук программ недоступен (нужна Windows 10 2004 или новее): {e}"))?;
        wait.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| "Windows не дала звук программ".to_string())?;
        let mut result = HRESULT(0);
        let mut unknown = None;
        unsafe { operation.GetActivateResult(&mut result, &mut unknown) }.map_err(|e| e.to_string())?;
        result.ok().map_err(|e| format!("Windows не дала звук программ: {e}"))?;
        unknown.ok_or("Windows не дала звук программ")?.cast().map_err(|e| e.to_string())
    }

    fn run(from: AudioFrom, lane: Lane, app: tauri::AppHandle, base: usize, stop: Arc<AtomicBool>, started: mpsc::Sender<Result<(), String>>) {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let opened = (|| -> Result<(IAudioClient, IAudioCaptureClient, windows::Win32::Foundation::HANDLE), String> {
            let client = loopback(&from)?;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                nChannels: CHANNELS as u16,
                nSamplesPerSec: RATE,
                nAvgBytesPerSec: RATE * (CHANNELS as u32) * 4,
                nBlockAlign: (CHANNELS * 4) as u16,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
            unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200_000, 0, &format, None) }.map_err(|e| format!("Звук программ не открылся: {e}"))?;
            let event = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| e.to_string())?;
            unsafe { client.SetEventHandle(event) }.map_err(|e| e.to_string())?;
            let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
            unsafe { client.Start() }.map_err(|e| e.to_string())?;
            Ok((client, capture, event))
        })();
        let (client, capture, event) = match opened {
            Ok(opened) => {
                let _ = started.send(Ok(()));
                opened
            }
            Err(e) => {
                let _ = started.send(Err(e));
                unsafe { CoUninitialize() };
                return;
            }
        };
        let slot_size = audio_slot_size();
        let mut next = 0usize;
        let mut seq = 0u32;
        while !stop.load(Ordering::Relaxed) {
            if unsafe { WaitForSingleObject(event, 100) } != WAIT_OBJECT_0 {
                continue;
            }
            loop {
                let size = unsafe { capture.GetNextPacketSize() }.unwrap_or(0);
                if size == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }.is_err() {
                    break;
                }
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                for (start, count) in pieces(frames as usize) {
                    let at = base + next * slot_size;
                    seq = seq.wrapping_add(2);
                    unsafe {
                        let header = at as *mut u32;
                        header.write_volatile(seq | 1);
                        std::sync::atomic::fence(Ordering::Release);
                        header.add(1).write(count as u32);
                        let to = (at + AUDIO_HEADER) as *mut u8;
                        let bytes = count * CHANNELS * 4;
                        if silent || data.is_null() {
                            std::ptr::write_bytes(to, 0, bytes);
                        } else {
                            std::ptr::copy_nonoverlapping(data.add(start * CHANNELS * 4), to, bytes);
                        }
                        std::sync::atomic::fence(Ordering::Release);
                        header.write_volatile(seq);
                    }
                    crate::screen_capture::post_json(&app, format!(r#"{{"hv":"{}","slot":{next},"seq":{seq}}}"#, lane.buffer()));
                    next = (next + 1) % AUDIO_SLOTS;
                }
                let _ = unsafe { capture.ReleaseBuffer(frames) };
            }
        }
        unsafe {
            let _ = client.Stop();
            let _ = CloseHandle(event);
        }
        // Released while COM is still on in this thread.
        drop(capture);
        drop(client);
        unsafe { CoUninitialize() };
    }

    pub async fn start(app: tauri::AppHandle, from: AudioFrom, lane: Lane) -> Result<(), String> {
        stop(lane);
        let extra = serde_json::json!({ "hv": lane.buffer(), "slotSize": audio_slot_size(), "slots": AUDIO_SLOTS, "rate": RATE, "channels": CHANNELS }).to_string();
        let base = crate::screen_capture::shared_buffer(&app, lane.buffer(), audio_slot_size() * AUDIO_SLOTS, extra).await?;
        let flag = Arc::new(AtomicBool::new(false));
        STOPS.lock().unwrap_or_else(|e| e.into_inner())[lane.index()] = Some(flag.clone());
        let (started, wait) = mpsc::channel();
        let name = match lane {
            Lane::Screen => "hv-screen-audio",
            Lane::Music => "hv-music",
        };
        std::thread::Builder::new().name(name.into()).spawn(move || run(from, lane, app, base, flag, started)).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || wait.recv_timeout(std::time::Duration::from_secs(8)).unwrap_or_else(|_| Err("Звук программ не ответил".into())))
            .await
            .map_err(|e| e.to_string())?
    }

    pub fn stop(lane: Lane) {
        if let Some(flag) = take_flag(&mut STOPS.lock().unwrap_or_else(|e| e.into_inner()), lane) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// The sound of the computer (without this app) or of the shown window's program goes with the picture.
#[tauri::command]
pub async fn capture_audio_start(app: tauri::AppHandle, from: AudioFrom) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::start(app, from, Lane::Screen).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, from);
        Err("Звук программ есть только в Windows".into())
    }
}

#[tauri::command]
pub fn capture_audio_stop() {
    stop();
}

/// The sound of a shared screen stops (music played together runs on).
pub fn stop() {
    stop_lane(Lane::Screen);
}

pub fn stop_lane(lane: Lane) {
    #[cfg(windows)]
    win::stop(lane);
    #[cfg(not(windows))]
    let _ = lane;
}

/// The sound of program `pid` (and what it started) goes to the page on `lane`.
pub async fn start_lane(app: tauri::AppHandle, from: AudioFrom, lane: Lane) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::start(app, from, lane).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, from, lane);
        Err("Звук программ есть только в Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_long_packet_goes_in_slot_sized_pieces() {
        assert_eq!(pieces(480), vec![(0, 480)]);
        assert_eq!(pieces(10_000), vec![(0, 4_800), (4_800, 4_800), (9_600, 400)]);
        assert!(pieces(0).is_empty());
    }

    #[test]
    fn sources_of_sound_read_as_the_page_writes_them() {
        assert_eq!(serde_json::from_str::<AudioFrom>(r#"{"kind":"computer"}"#).unwrap(), AudioFrom::Computer);
        assert_eq!(serde_json::from_str::<AudioFrom>(r#"{"kind":"window","id":42}"#).unwrap(), AudioFrom::Window { id: 42 });
        assert_eq!(serde_json::from_str::<AudioFrom>(r#"{"kind":"process","pid":7}"#).unwrap(), AudioFrom::Process { pid: 7 });
    }

    #[test]
    fn music_has_a_lane_of_its_own() {
        assert_eq!(Lane::Screen.buffer(), "audio");
        assert_eq!(Lane::Music.buffer(), "music");
        let screen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let music = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut flags: Flags = [Some(screen.clone()), Some(music.clone())];
        let taken = take_flag(&mut flags, Lane::Screen).expect("the screen's flag");
        assert!(Arc::ptr_eq(&taken, &screen));
        assert!(flags[Lane::Music.index()].as_ref().is_some_and(|f| Arc::ptr_eq(f, &music)), "stopping the screen's sound leaves the music playing");
        assert!(take_flag(&mut flags, Lane::Screen).is_none());
    }
}
