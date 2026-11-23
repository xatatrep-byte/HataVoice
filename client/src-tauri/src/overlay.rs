//! The call's characters on the desktop: a window with no frame and no background over the whole work area of the main
//! screen, always on top, that never takes the focus and that the mouse goes through. It runs the app's own page, which
//! sees its label and draws only what the main window sends it: each character where the person put it. While they are
//! being put in their places, the window takes the mouse.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The overlay window's label; the page draws the characters alone when it is this one.
pub const LABEL: &str = "overlay";

/// The work area of a screen (without the taskbar) as the window's place and size, physical pixels. A screen too small
/// to be one still gets a window of one pixel.
pub fn cover(area: (i32, i32, u32, u32)) -> ((i32, i32), (u32, u32)) {
    let (x, y, width, height) = area;
    ((x, y), (width.max(1), height.max(1)))
}

/// A phone has no windows over other apps.
#[cfg(mobile)]
fn build(_app: &AppHandle) -> tauri::Result<WebviewWindow> {
    Err(tauri::Error::WindowNotFound)
}

#[cfg(desktop)]
fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
        .title("ХатаВойс — персонажи")
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(640.0, 360.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    window.set_ignore_cursor_events(true)?;
    Ok(window)
}

/// A debug build's test copies put the window where `HATAVOICE_OVERLAY_AREA` says ("x,y,width,height", beyond the edges
/// of the desktop): checking it must not cover the screen of whoever sits at the PC, nor take their mouse.
#[cfg(debug_assertions)]
fn test_area() -> Option<(i32, i32, u32, u32)> {
    let spec = std::env::var("HATAVOICE_OVERLAY_AREA").ok()?;
    let parts: Vec<i64> = spec.split(',').map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    match parts[..] {
        [x, y, w, h] => Some((i32::try_from(x).ok()?, i32::try_from(y).ok()?, u32::try_from(w).ok()?, u32::try_from(h).ok()?)),
        _ => None,
    }
}

#[cfg(not(debug_assertions))]
fn test_area() -> Option<(i32, i32, u32, u32)> {
    None
}

/// Stretches the window over the work area of the main screen and shows it.
fn put(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()? else { return Ok(()) };
    let area = monitor.work_area();
    let work = (area.position.x, area.position.y, area.size.width, area.size.height);
    let ((x, y), (width, height)) = cover(test_area().unwrap_or(work));
    window.set_position(PhysicalPosition::new(x, y))?;
    window.set_size(PhysicalSize::new(width, height))?;
    window.show()
}

/// Shows the characters on the desktop, or closes them. Async: a window made in a command that blocks the main thread
/// would hang WebView2.
#[tauri::command]
pub async fn overlay_show(app: AppHandle, show: bool) -> Result<(), String> {
    let existing = app.get_webview_window(LABEL);
    if !show {
        if let Some(window) = existing {
            window.destroy().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let window = match existing {
        Some(window) => window,
        None => build(&app).map_err(|e| e.to_string())?,
    };
    put(&window).map_err(|e| e.to_string())
}

/// A point of the desktop (physical pixels) as a point of the window's page (its own pixels), or none when it is outside
/// the window.
pub fn within(cursor: (f64, f64), at: (i32, i32), size: (u32, u32), scale: f64) -> Option<(f64, f64)> {
    let dx = cursor.0 - f64::from(at.0);
    let dy = cursor.1 - f64::from(at.1);
    if dx < 0.0 || dy < 0.0 || dx >= f64::from(size.0) || dy >= f64::from(size.1) || scale <= 0.0 {
        return None;
    }
    Some((dx / scale, dy / scale))
}

/// Where the mouse is over the characters' window, in the page's pixels; none when it is elsewhere. The page asks a few
/// times a second, and the window takes the mouse only while a character (or its menu) is under it: the rest of the
/// desktop stays clickable, and the characters may walk anywhere, since what is under the mouse is the scene's answer.
#[tauri::command]
pub fn overlay_cursor(app: AppHandle) -> Option<(f64, f64)> {
    let window = app.get_webview_window(LABEL)?;
    let cursor = app.cursor_position().ok()?;
    let at = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    within((cursor.x, cursor.y), (at.x, at.y), (size.width, size.height), window.scale_factor().ok()?)
}

/// While `on`, the window takes the mouse: a character is under it, or the characters are being put in their places;
/// off, the mouse goes through it again.
#[tauri::command]
pub fn overlay_arrange(app: AppHandle, on: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    #[cfg(desktop)]
    window.set_ignore_cursor_events(!on).map_err(|e| e.to_string())?;
    #[cfg(not(desktop))]
    let _ = (window, on);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_covers_the_work_area_of_the_screen() {
        // A 1920×1080 screen whose taskbar takes the bottom 48 pixels.
        assert_eq!(cover((0, 0, 1920, 1032)), ((0, 0), (1920, 1032)));
        // A second screen to the left of the main one.
        assert_eq!(cover((-1280, 0, 1280, 984)), ((-1280, 0), (1280, 984)));
        assert_eq!(cover((0, 0, 0, 0)), ((0, 0), (1, 1)));
    }

    #[test]
    fn it_tells_where_the_mouse_is_in_the_page() {
        // A window over a 1920×1032 work area at 150 %: the page is 1280×688.
        assert_eq!(within((960.0, 516.0), (0, 0), (1920, 1032), 1.5), Some((640.0, 344.0)));
        // On a screen to the left of the main one.
        assert_eq!(within((-1000.0, 30.0), (-1280, 0), (1280, 984), 1.0), Some((280.0, 30.0)));
        // Over the taskbar, or off the window: nothing.
        assert_eq!(within((500.0, 1050.0), (0, 0), (1920, 1032), 1.0), None);
        assert_eq!(within((-1.0, 10.0), (0, 0), (1920, 1032), 1.0), None);
        assert_eq!(within((10.0, 10.0), (0, 0), (1920, 1032), 0.0), None);
    }
}
