//! Global push-to-talk on a Mac: a listen-only event tap of the login session (CGEventTap). It only observes: the game
//! in front still gets every key. Mac keys are turned into the Windows codes bindings are written in (`mac_keys.rs`),
//! so one binding means the same key on both systems.
//!
//! macOS lets an app hear keys typed into other apps only with «Мониторинг ввода» (Input Monitoring) allowed in the
//! system settings, and only after a restart once allowed: until then the tap cannot be made and the setting says why.

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::mac_keys::{modifier_mask, vk_of};
use crate::ptt::{Capture, InputCode, MouseButton, PttMatcher};

/// Tauri event with `true`/`false` when the PTT combo is pressed/released.
pub const PTT_EVENT: &str = "ptt";
/// Tauri event with the captured combo as strings, e.g. `["key:162", "mouse:x1"]`.
pub const CAPTURED_EVENT: &str = "ptt-captured";

const NO_PERMISSION: &str = "Разреши ХатаВойс «Мониторинг ввода»: Системные настройки → Конфиденциальность и безопасность → \
Мониторинг ввода, затем перезапусти программу. Без этого Mac не даёт слышать клавишу, пока ты в игре";

type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;
type CGEventTapCallBack = unsafe extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, callback: CGEventTapCallBack, user_info: *mut c_void) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: CFMachPortRef, order: isize) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

/// `kCGSessionEventTap`, `kCGHeadInsertEventTap`, `kCGEventTapOptionListenOnly`.
const SESSION_TAP: u32 = 1;
const HEAD_INSERT: u32 = 0;
const LISTEN_ONLY: u32 = 1;

// CGEventType values.
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;
/// The system turns a tap off when it is slow, or for secure input; it is turned back on.
const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

// CGEventField values.
const FIELD_MOUSE_BUTTON: u32 = 3;
const FIELD_KEYCODE: u32 = 9;

enum Notice {
    Ptt(bool),
    Captured(Vec<InputCode>),
}

struct HookState {
    matcher: PttMatcher,
    capture: Option<Capture>,
    notices: mpsc::Sender<Notice>,
}

static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();
/// The tap, once made: the callback turns it back on when the system turned it off.
static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// Made at most one at a time; tried again on the next binding when it could not be made.
static STARTING: Mutex<()> = Mutex::new(());

fn state(app: &AppHandle) -> &'static Mutex<HookState> {
    STATE.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        // Emitting is kept off the tap's thread so that its callback returns at once.
        let app = app.clone();
        std::thread::Builder::new()
            .name("ptt-events".into())
            .spawn(move || {
                for notice in rx {
                    let result = match notice {
                        Notice::Ptt(active) => app.emit(PTT_EVENT, active),
                        Notice::Captured(combo) => app.emit(CAPTURED_EVENT, combo.iter().map(InputCode::as_string).collect::<Vec<_>>()),
                    };
                    if let Err(e) = result {
                        eprintln!("ptt: cannot emit event: {e}");
                    }
                }
            })
            .expect("spawn ptt-events thread");
        Mutex::new(HookState { matcher: PttMatcher::default(), capture: None, notices: tx })
    })
}

/// Makes the tap on a thread of its own, which then runs it; the reason in words if macOS does not allow it.
fn ensure_tap() -> Result<(), String> {
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if !TAP.load(Ordering::Acquire).is_null() {
        return Ok(());
    }
    // SAFETY: plain queries; the request shows the system's own question once.
    if !unsafe { CGPreflightListenEventAccess() } {
        unsafe { CGRequestListenEventAccess() };
        return Err(NO_PERMISSION.into());
    }
    let (made, result) = mpsc::channel();
    std::thread::Builder::new()
        .name("ptt-tap".into())
        .spawn(move || run_tap(made))
        .map_err(|e| format!("Не удалось запустить push-to-talk: {e}"))?;
    result.recv_timeout(Duration::from_secs(3)).unwrap_or_else(|_| Err("Push-to-talk не запустился вовремя".into()))
}

fn run_tap(made: mpsc::Sender<Result<(), String>>) {
    let events = [LEFT_DOWN, LEFT_UP, RIGHT_DOWN, RIGHT_UP, KEY_DOWN, KEY_UP, FLAGS_CHANGED, OTHER_DOWN, OTHER_UP]
        .iter()
        .fold(0u64, |mask, t| mask | (1u64 << t));
    // SAFETY: CoreGraphics and CoreFoundation calls with the arguments they document; the tap and its run-loop source
    // live as long as this thread, which runs the loop until the app quits.
    unsafe {
        let tap = CGEventTapCreate(SESSION_TAP, HEAD_INSERT, LISTEN_ONLY, events, tap_callback, std::ptr::null_mut());
        if tap.is_null() {
            let _ = made.send(Err(NO_PERMISSION.into()));
            return;
        }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            let _ = made.send(Err("Push-to-talk: macOS не дал источник событий".into()));
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        TAP.store(tap, Ordering::Release);
        let _ = made.send(Ok(()));
        CFRunLoopRun();
    }
}

unsafe extern "C" fn tap_callback(_proxy: CGEventTapProxy, kind: u32, event: CGEventRef, _user: *mut c_void) -> CGEventRef {
    if kind == DISABLED_BY_TIMEOUT || kind == DISABLED_BY_USER_INPUT {
        let tap = TAP.load(Ordering::Acquire);
        if !tap.is_null() {
            // SAFETY: the tap made by `run_tap`, alive while its loop runs.
            unsafe { CGEventTapEnable(tap, true) };
        }
        return event;
    }
    // SAFETY: `event` is the event the system passes for this callback.
    let field = |f: u32| unsafe { CGEventGetIntegerValueField(event, f) };
    let input = match kind {
        KEY_DOWN | KEY_UP => {
            let mac = field(FIELD_KEYCODE) as u16;
            vk_of(mac).map(|vk| (InputCode::Key(vk), kind == KEY_DOWN))
        }
        FLAGS_CHANGED => {
            let mac = field(FIELD_KEYCODE) as u16;
            // SAFETY: as above.
            let flags = unsafe { CGEventGetFlags(event) };
            match (vk_of(mac), modifier_mask(mac)) {
                (Some(vk), Some(mask)) => Some((InputCode::Key(vk), flags & mask != 0)),
                _ => None,
            }
        }
        LEFT_DOWN | LEFT_UP => Some((InputCode::Mouse(MouseButton::Left), kind == LEFT_DOWN)),
        RIGHT_DOWN | RIGHT_UP => Some((InputCode::Mouse(MouseButton::Right), kind == RIGHT_DOWN)),
        OTHER_DOWN | OTHER_UP => {
            let button = match field(FIELD_MOUSE_BUTTON) {
                2 => Some(MouseButton::Middle),
                3 => Some(MouseButton::X1),
                4 => Some(MouseButton::X2),
                _ => None,
            };
            button.map(|b| (InputCode::Mouse(b), kind == OTHER_DOWN))
        }
        _ => None,
    };
    if let Some((code, down)) = input {
        handle(code, down);
    }
    event
}

fn handle(code: InputCode, down: bool) {
    let Some(state) = STATE.get() else { return };
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(capture) = s.capture.as_mut()
        && let Some(combo) = capture.feed(code, down)
    {
        s.capture = None;
        let _ = s.notices.send(Notice::Captured(combo));
    }
    if let Some(active) = s.matcher.feed(code, down) {
        let _ = s.notices.send(Notice::Ptt(active));
    }
}

/// Watches `binding` from now on (an empty one: nothing). Fails when macOS does not let the app hear keys.
pub fn set_binding(app: &AppHandle, binding: Vec<InputCode>) -> Result<(), String> {
    let state = state(app);
    if !binding.is_empty() {
        ensure_tap()?;
    }
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = s.matcher.set_binding(binding) {
        let _ = s.notices.send(Notice::Ptt(active));
    }
    Ok(())
}

/// Waits for the next combo the person presses.
pub fn start_capture(app: &AppHandle) -> Result<(), String> {
    let state = state(app);
    ensure_tap()?;
    state.lock().unwrap_or_else(|e| e.into_inner()).capture = Some(Capture::default());
    Ok(())
}

pub fn cancel_capture(app: &AppHandle) {
    state(app).lock().unwrap_or_else(|e| e.into_inner()).capture = None;
}
