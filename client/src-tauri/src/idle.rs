//! How long the keyboard and mouse have been untouched (for the AFK channel).

/// Milliseconds from `last_input` to `now` on the 32-bit tick counter, which wraps.
#[cfg_attr(not(windows), allow(dead_code))]
fn idle_ms(now: u32, last_input: u32) -> u64 {
    u64::from(now.wrapping_sub(last_input))
}

#[cfg(windows)]
fn since_last_input_ms() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: plain Win32 calls; `info` is sized as the API requires.
    let (ok, now) = unsafe { (GetLastInputInfo(&mut info).as_bool(), GetTickCount()) };
    ok.then(|| idle_ms(now, info.dwTime))
}

/// A Mac counts the seconds since any keyboard or mouse event of this login session itself.
#[cfg(target_os = "macos")]
fn since_last_input_ms() -> Option<u64> {
    /// `kCGEventSourceStateCombinedSessionState`: everything the session gets, from every device.
    const COMBINED_SESSION: i32 = 0;
    /// `kCGAnyInputEventType`.
    const ANY_INPUT: u32 = !0;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event_type: u32) -> f64;
    }
    // SAFETY: a plain query with two integers; it reads nothing of ours.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION, ANY_INPUT) };
    (seconds.is_finite() && seconds >= 0.0).then(|| (seconds * 1000.0) as u64)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn since_last_input_ms() -> Option<u64> {
    None
}

#[tauri::command]
pub fn idle_seconds() -> u64 {
    since_last_input_ms().map_or(0, |ms| ms / 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_time_survives_the_tick_counter_wrapping() {
        assert_eq!(idle_ms(10_000, 4_000), 6_000);
        assert_eq!(idle_ms(5, u32::MAX - 4), 10, "the tick count wraps every 49.7 days");
    }

    #[test]
    fn this_pc_reports_an_idle_time() {
        assert!(idle_seconds() < 60 * 60 * 24 * 50);
    }
}
