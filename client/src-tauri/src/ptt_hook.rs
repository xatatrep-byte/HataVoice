//! Global push-to-talk input via low-level Windows hooks.
//!
//! The hooks only observe input: every event is passed on with `CallNextHookEx`, so the game
//! still receives the key. They are installed lazily, the first time a binding or capture is set.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_BACK, VK_CONTROL, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, SetWindowsHookExW,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN,
    WM_XBUTTONUP,
};

use crate::ptt::{Capture, InputCode, MouseButton, PttMatcher};

/// Tauri event with `true`/`false` when the PTT combo is pressed/released.
pub const PTT_EVENT: &str = "ptt";
/// Tauri event with the captured combo as strings, e.g. `["key:162", "mouse:x1"]`.
pub const CAPTURED_EVENT: &str = "ptt-captured";

enum Notice {
    Ptt(bool),
    Captured(Vec<InputCode>),
    /// Ctrl+Alt+Backspace while someone controls our PC: control ends at once.
    StopRemote,
}

/// Someone controls our PC: Ctrl+Alt+Backspace ends it.
/// Who wants the stop keys watched now: remote control we host, friends' pads on our PC (bits).
static WATCH_STOP: AtomicU8 = AtomicU8::new(0);
pub const STOP_REMOTE: u8 = 1;
pub const STOP_PADS: u8 = 2;

struct HookState {
    matcher: PttMatcher,
    capture: Option<Capture>,
    notices: mpsc::Sender<Notice>,
}

static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();

fn state(app: &AppHandle) -> &'static Mutex<HookState> {
    STATE.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        // Emitting is kept off the hook thread so the hook callback returns immediately.
        let app = app.clone();
        std::thread::Builder::new()
            .name("ptt-events".into())
            .spawn(move || {
                for notice in rx {
                    let result = match notice {
                        Notice::Ptt(active) => app.emit(PTT_EVENT, active),
                        Notice::Captured(combo) => app.emit(
                            CAPTURED_EVENT,
                            combo.iter().map(InputCode::as_string).collect::<Vec<_>>(),
                        ),
                        Notice::StopRemote => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = crate::remote_cmd::remote_stop(app.clone()).await;
                                crate::pads_cmd::pad_stop_all(app).await;
                            });
                            Ok(())
                        }
                    };
                    if let Err(e) = result {
                        eprintln!("ptt: cannot emit event: {e}");
                    }
                }
            })
            .expect("spawn ptt-events thread");
        std::thread::Builder::new()
            .name("ptt-hook".into())
            .spawn(run_hooks)
            .expect("spawn ptt-hook thread");
        Mutex::new(HookState {
            matcher: PttMatcher::default(),
            capture: None,
            notices: tx,
        })
    })
}

pub fn set_binding(app: &AppHandle, binding: Vec<InputCode>) {
    let mut s = state(app).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = s.matcher.set_binding(binding) {
        let _ = s.notices.send(Notice::Ptt(active));
    }
}

/// While someone controls our PC, Ctrl+Alt+Backspace on the keyboard ends it (the hooks start if they had not).
/// The stop keys end `who` (remote control, pads) while `on`.
pub fn watch_stop(app: &AppHandle, who: u8, on: bool) {
    if on {
        let _ = state(app);
        WATCH_STOP.fetch_or(who, Ordering::Relaxed);
    } else {
        WATCH_STOP.fetch_and(!who, Ordering::Relaxed);
    }
}

/// Backspace with Ctrl and Alt held.
fn stop_chord(vk: u32) -> bool {
    // SAFETY: plain key-state queries.
    let held = |key: i32| unsafe { GetAsyncKeyState(key) } as u16 & 0x8000 != 0;
    vk == u32::from(VK_BACK.0) && held(i32::from(VK_CONTROL.0)) && held(i32::from(VK_MENU.0))
}

pub fn start_capture(app: &AppHandle) {
    state(app).lock().unwrap_or_else(|e| e.into_inner()).capture = Some(Capture::default());
}

pub fn cancel_capture(app: &AppHandle) {
    state(app).lock().unwrap_or_else(|e| e.into_inner()).capture = None;
}

fn handle(code: InputCode, down: bool) {
    let Some(state) = STATE.get() else { return };
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(capture) = s.capture.as_mut() {
        if let Some(combo) = capture.feed(code, down) {
            s.capture = None;
            let _ = s.notices.send(Notice::Captured(combo));
        }
    }
    if let Some(active) = s.matcher.feed(code, down) {
        let _ = s.notices.send(Notice::Ptt(active));
    }
}

fn run_hooks() {
    // SAFETY: plain Win32 calls; the hook procedures only read the structs Windows passes them.
    unsafe {
        let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
        if let Err(e) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0) {
            eprintln!("ptt: keyboard hook failed: {e}");
        }
        if let Err(e) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0) {
            eprintln!("ptt: mouse hook failed: {e}");
        }
        // Low-level hooks are called on this thread, so it must keep pumping messages.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    }
}

unsafe extern "system" fn keyboard_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code == HC_ACTION as i32 {
        let down = match w_param.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
            WM_KEYUP | WM_SYSKEYUP => Some(false),
            _ => None,
        };
        if let Some(down) = down {
            // SAFETY: for WH_KEYBOARD_LL, lParam points to a KBDLLHOOKSTRUCT.
            let info = unsafe { &*(l_param.0 as *const KBDLLHOOKSTRUCT) };
            if down
                && WATCH_STOP.load(Ordering::Relaxed) != 0
                && stop_chord(info.vkCode)
                && let Some(state) = STATE.get()
            {
                let _ = state.lock().unwrap_or_else(|e| e.into_inner()).notices.send(Notice::StopRemote);
            }
            handle(InputCode::Key(info.vkCode), down);
        }
    }
    unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
}

unsafe extern "system" fn mouse_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code == HC_ACTION as i32 {
        let event = match w_param.0 as u32 {
            WM_LBUTTONDOWN => Some((MouseButton::Left, true)),
            WM_LBUTTONUP => Some((MouseButton::Left, false)),
            WM_RBUTTONDOWN => Some((MouseButton::Right, true)),
            WM_RBUTTONUP => Some((MouseButton::Right, false)),
            WM_MBUTTONDOWN => Some((MouseButton::Middle, true)),
            WM_MBUTTONUP => Some((MouseButton::Middle, false)),
            msg @ (WM_XBUTTONDOWN | WM_XBUTTONUP) => {
                // SAFETY: for WH_MOUSE_LL, lParam points to an MSLLHOOKSTRUCT.
                let info = unsafe { &*(l_param.0 as *const MSLLHOOKSTRUCT) };
                let button = match (info.mouseData >> 16) & 0xffff {
                    1 => Some(MouseButton::X1),
                    2 => Some(MouseButton::X2),
                    _ => None,
                };
                button.map(|b| (b, msg == WM_XBUTTONDOWN))
            }
            _ => None,
        };
        if let Some((button, down)) = event {
            handle(InputCode::Mouse(button), down);
        }
    }
    unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
}
