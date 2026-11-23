//! Whether a program fills the screen now, as a game does: Windows' own answer, the one it holds its notifications back
//! by. A shared window that stops changing while this is so is a game in full-screen mode, whose picture Windows gives
//! to no capture (see `frozenShare.ts`).

/// A full-screen program is in front: a game in exclusive mode (Direct3D) or anything else covering the screen.
#[tauri::command]
pub fn fullscreen_app() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
        // SAFETY: the call takes nothing and only returns the state.
        match unsafe { SHQueryUserNotificationState() } {
            Ok(state) => state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN,
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}
