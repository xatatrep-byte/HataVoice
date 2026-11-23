//! Remote control's hands on this PC: the input of the one we let in, played with Windows `SendInput` on the screen
//! we share. Keys go by their place on the keyboard (scan codes), so our own layout types them. Windows itself keeps
//! out what must stay out: windows run as administrator, the UAC screen, Ctrl+Alt+Del.

#[cfg(windows)]
use crate::remote::Button;
use crate::remote::{Held, Input, Screen};

/// The whole desktop of all screens, as Windows spans it: x, y, width, height.
pub type Desktop = (i32, i32, u32, u32);

/// A key's scan code (set 1) and whether it is an extended one, by `KeyboardEvent.code`. `None` for a key we do not
/// play (media keys and the like).
pub fn scan_code(code: &str) -> Option<(u16, bool)> {
    let plain = |c: u16| Some((c, false));
    let extended = |c: u16| Some((c, true));
    if let Some(letter) = code.strip_prefix("Key").filter(|l| l.len() == 1) {
        const LETTERS: [u16; 26] = [
            0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F,
            0x11, 0x2D, 0x15, 0x2C,
        ];
        let index = letter.bytes().next().filter(u8::is_ascii_uppercase)? - b'A';
        return plain(LETTERS[index as usize]);
    }
    if let Some(digit) = code.strip_prefix("Digit").and_then(|d| d.parse::<u16>().ok()).filter(|d| *d <= 9) {
        return plain(if digit == 0 { 0x0B } else { 0x01 + digit });
    }
    if let Some(n) = code.strip_prefix('F').and_then(|f| f.parse::<u16>().ok()) {
        return match n {
            1..=10 => plain(0x3A + n),
            11 => plain(0x57),
            12 => plain(0x58),
            _ => None,
        };
    }
    match code {
        "Escape" => plain(0x01),
        "Minus" => plain(0x0C),
        "Equal" => plain(0x0D),
        "Backspace" => plain(0x0E),
        "Tab" => plain(0x0F),
        "BracketLeft" => plain(0x1A),
        "BracketRight" => plain(0x1B),
        "Enter" => plain(0x1C),
        "ControlLeft" => plain(0x1D),
        "Semicolon" => plain(0x27),
        "Quote" => plain(0x28),
        "Backquote" => plain(0x29),
        "ShiftLeft" => plain(0x2A),
        "Backslash" => plain(0x2B),
        "Comma" => plain(0x33),
        "Period" => plain(0x34),
        "Slash" => plain(0x35),
        "ShiftRight" => plain(0x36),
        "NumpadMultiply" => plain(0x37),
        "AltLeft" => plain(0x38),
        "Space" => plain(0x39),
        "CapsLock" => plain(0x3A),
        "NumLock" => plain(0x45),
        "ScrollLock" => plain(0x46),
        "Numpad7" => plain(0x47),
        "Numpad8" => plain(0x48),
        "Numpad9" => plain(0x49),
        "NumpadSubtract" => plain(0x4A),
        "Numpad4" => plain(0x4B),
        "Numpad5" => plain(0x4C),
        "Numpad6" => plain(0x4D),
        "NumpadAdd" => plain(0x4E),
        "Numpad1" => plain(0x4F),
        "Numpad2" => plain(0x50),
        "Numpad3" => plain(0x51),
        "Numpad0" => plain(0x52),
        "NumpadDecimal" => plain(0x53),
        "IntlBackslash" => plain(0x56),
        "NumpadEnter" => extended(0x1C),
        "ControlRight" => extended(0x1D),
        "NumpadDivide" => extended(0x35),
        "PrintScreen" => extended(0x37),
        "AltRight" => extended(0x38),
        "Home" => extended(0x47),
        "ArrowUp" => extended(0x48),
        "PageUp" => extended(0x49),
        "ArrowLeft" => extended(0x4B),
        "ArrowRight" => extended(0x4D),
        "End" => extended(0x4F),
        "ArrowDown" => extended(0x50),
        "PageDown" => extended(0x51),
        "Insert" => extended(0x52),
        "Delete" => extended(0x53),
        "MetaLeft" => extended(0x5B),
        "MetaRight" => extended(0x5C),
        "ContextMenu" => extended(0x5D),
        _ => None,
    }
}

/// Where a point given as fractions (0–65535) of `screen` is in Windows' absolute coordinates over the whole
/// desktop (0–65535 across all screens).
pub fn absolute(screen: Screen, desktop: Desktop, x: u16, y: u16) -> (i32, i32) {
    let along = |fraction: u16, start: i32, length: u32| start + ((u64::from(fraction) * u64::from(length.saturating_sub(1))) / 65535) as i32;
    let px = along(x, screen.x, screen.width);
    let py = along(y, screen.y, screen.height);
    let (dx, dy, dw, dh) = desktop;
    let scale = |p: i32, start: i32, length: u32| (((i64::from(p - start)) * 65535) / i64::from(length.saturating_sub(1).max(1))) as i32;
    (scale(px, dx, dw), scale(py, dy, dh))
}

/// One wheel step, as Windows counts it.
const WHEEL_STEP: i32 = 120;
/// A wheel turn larger than this is cut: ten steps at once is a lot already.
const MAX_WHEEL: i32 = 10 * WHEEL_STEP;

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
        MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
        MOUSEINPUT, SendInput, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

    pub fn desktop() -> Desktop {
        // SAFETY: plain metric queries.
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32,
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32,
            )
        }
    }

    fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn key(scan: u16, extended: bool, down: bool) -> INPUT {
        let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn button(b: Button, down: bool) -> INPUT {
        let flags = match (b, down) {
            (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (Button::Left, false) => MOUSEEVENTF_LEFTUP,
            (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
            (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        mouse(0, 0, 0, flags)
    }

    fn send(inputs: &[INPUT]) {
        if inputs.is_empty() {
            return;
        }
        // SAFETY: the inputs are fully built above; SendInput only reads them.
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    pub fn play(input: &Input, screen: Screen) {
        let inputs: Vec<INPUT> = match input {
            Input::Move { x, y } => {
                let (dx, dy) = absolute(screen, desktop(), *x, *y);
                vec![mouse(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)]
            }
            Input::Button { b, down } => vec![button(*b, *down)],
            Input::Wheel { dx, dy } => {
                let mut turns = Vec::new();
                if *dy != 0 {
                    turns.push(mouse(0, 0, i32::from(*dy).clamp(-MAX_WHEEL, MAX_WHEEL), MOUSEEVENTF_WHEEL));
                }
                if *dx != 0 {
                    turns.push(mouse(0, 0, i32::from(*dx).clamp(-MAX_WHEEL, MAX_WHEEL), MOUSEEVENTF_HWHEEL));
                }
                turns
            }
            Input::Key { code, down } => scan_code(code).map(|(scan, extended)| vec![key(scan, extended, *down)]).unwrap_or_default(),
            // Text is for a phone; a PC types by its keys.
            Input::Text { .. } | Input::Ping => Vec::new(),
        };
        send(&inputs);
    }

    pub fn release(held: &[Held]) {
        let inputs: Vec<INPUT> = held
            .iter()
            .filter_map(|h| match h {
                Held::Button(b) => Some(button(*b, false)),
                Held::Key(code) => scan_code(code).map(|(scan, extended)| key(scan, extended, false)),
            })
            .collect();
        send(&inputs);
    }
}

/// Plays one input of the one in control on `screen`.
pub fn play(input: &Input, screen: Screen) {
    #[cfg(windows)]
    win::play(input, screen);
    #[cfg(not(windows))]
    let _ = (input, screen);
}

/// Lets go of everything still held down when control ends: no key stays stuck.
pub fn release(held: &[Held]) {
    #[cfg(windows)]
    win::release(held);
    #[cfg(not(windows))]
    let _ = held;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_go_by_their_place_on_the_keyboard() {
        assert_eq!(scan_code("KeyA"), Some((0x1E, false)));
        assert_eq!(scan_code("KeyZ"), Some((0x2C, false)));
        assert_eq!(scan_code("KeyQ"), Some((0x10, false)));
        assert_eq!(scan_code("Digit1"), Some((0x02, false)));
        assert_eq!(scan_code("Digit0"), Some((0x0B, false)));
        assert_eq!(scan_code("F1"), Some((0x3B, false)));
        assert_eq!(scan_code("F10"), Some((0x44, false)));
        assert_eq!(scan_code("F12"), Some((0x58, false)));
        assert_eq!(scan_code("ArrowUp"), Some((0x48, true)));
        assert_eq!(scan_code("Numpad8"), Some((0x48, false)), "the same code, not extended");
        assert_eq!(scan_code("ControlRight"), Some((0x1D, true)));
        for unknown in ["Keya", "KeyAB", "Digit10", "F13", "MediaPlayPause", "", "Fn"] {
            assert_eq!(scan_code(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn a_point_lands_on_the_shared_screen_of_the_whole_desktop() {
        let one = Screen { x: 0, y: 0, width: 1920, height: 1080 };
        assert_eq!(absolute(one, (0, 0, 1920, 1080), 0, 0), (0, 0));
        assert_eq!(absolute(one, (0, 0, 1920, 1080), 65535, 65535), (65535, 65535));
        // Two screens side by side, the shared one on the right: its left edge is the middle of the desktop.
        let right = Screen { x: 1920, y: 0, width: 1920, height: 1080 };
        let (x, y) = absolute(right, (0, 0, 3840, 1080), 0, 65535);
        assert_eq!(y, 65535);
        assert!((32760..=32776).contains(&x), "{x}");
        // A screen to the left of the main one starts at a negative x.
        let left = Screen { x: -1280, y: 0, width: 1280, height: 1024 };
        assert_eq!(absolute(left, (-1280, 0, 3200, 1080), 0, 0), (0, 0));
    }
}
