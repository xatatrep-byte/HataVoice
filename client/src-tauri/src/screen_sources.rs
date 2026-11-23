//! What can be shown, for our own picker: the windows on the desktop (topmost first) and the screens, each with a small
//! picture and the program's icon. Windows of this program (and of its WebView2 processes) are left out, and so are
//! minimized, hidden and tool windows: none of them has a picture to give.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Source {
    /// «window» or «monitor».
    pub kind: &'static str,
    pub id: u64,
    pub title: String,
    /// The program's file name without «.exe», for a window.
    pub app: Option<String>,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    /// A PNG of the picture as `data:` URL, at most `THUMB_WIDTH` wide.
    pub thumb: Option<String>,
    /// The program's icon, a 32×32 PNG as `data:` URL.
    pub icon: Option<String>,
}

pub const THUMB_WIDTH: u32 = 320;
pub const THUMB_HEIGHT: u32 = 180;
/// No picker needs more; each picture takes a moment.
pub const MAX_WINDOWS: usize = 24;
/// Windows smaller than this are not something to show.
pub const MIN_SIDE: i32 = 64;

/// The thumbnail's size for a picture of `width` × `height`: as big as fits the box, the shape kept.
pub fn thumb_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (THUMB_WIDTH, THUMB_HEIGHT);
    }
    let scale = f64::min(THUMB_WIDTH as f64 / width as f64, THUMB_HEIGHT as f64 / height as f64).min(1.0);
    (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1))
}

/// An icon drawn once on black and once on white gives its own transparency: where it is see-through the two differ.
pub fn icon_alpha(on_black: &[u8], on_white: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(on_black.len());
    for (b, w) in on_black.chunks_exact(4).zip(on_white.chunks_exact(4)) {
        // BGRA in, RGBA out.
        let alpha = 255 - (i32::from(w[1]) - i32::from(b[1])).clamp(0, 255);
        let un = |c: u8| if alpha == 0 { 0 } else { ((u32::from(c) * 255) / alpha as u32).min(255) as u8 };
        rgba.extend_from_slice(&[un(b[2]), un(b[1]), un(b[0]), alpha as u8]);
    }
    rgba
}

/// RGBA pixels as a PNG `data:` URL.
pub fn png_url(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    use base64::Engine;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::collections::HashSet;

    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetMonitorInfoW, ReleaseDC, SelectObject,
        SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, HBITMAP, HDC, HGDIOBJ, HMONITOR,
        MONITORINFO, SRCCOPY, CAPTUREBLT,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, DrawIconEx, EnumWindows, GetClassLongPtrW, GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SendMessageTimeoutW, DI_NORMAL, GCLP_HICON, GWL_EXSTYLE, GW_OWNER, HICON, ICON_BIG,
        ICON_SMALL2, SMTO_ABORTIFHUNG, WM_GETICON, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    /// PW_RENDERFULLCONTENT: the window's real picture, DirectX and browsers too.
    const RENDER_FULL: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);
    const ICON: i32 = 32;
    const SKIP_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"];

    /// This process and every process it started (WebView2's among them).
    fn our_processes() -> HashSet<u32> {
        let mut ours = HashSet::from([std::process::id()]);
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return ours };
        let mut parents = Vec::new();
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(snapshot) };
        loop {
            let before = ours.len();
            for (pid, parent) in &parents {
                if ours.contains(parent) {
                    ours.insert(*pid);
                }
            }
            if ours.len() == before {
                return ours;
            }
        }
    }

    fn text_of(hwnd: HWND) -> String {
        let mut buffer = [0u16; 512];
        let n = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        String::from_utf16_lossy(&buffer[..n.max(0) as usize]).trim().to_string()
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buffer = [0u16; 128];
        let n = unsafe { GetClassNameW(hwnd, &mut buffer) };
        String::from_utf16_lossy(&buffer[..n.max(0) as usize])
    }

    fn exe_of(pid: u32) -> Option<String> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buffer.as_mut_ptr()), &mut len) }.is_ok();
        let _ = unsafe { CloseHandle(process) };
        ok.then(|| String::from_utf16_lossy(&buffer[..len as usize]))
    }

    /// A 32-bit top-down DIB section of `width` × `height` and where its pixels are.
    fn dib(dc: HDC, width: i32, height: i32) -> Option<(HBITMAP, *mut u8)> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = unsafe { CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) }.ok()?;
        (!bits.is_null()).then_some((bitmap, bits as *mut u8))
    }

    /// Draws `from` (an area of `source`) small into a fresh DIB and returns it as RGBA.
    fn shrink(source: HDC, from: (i32, i32, i32, i32), size: (u32, u32)) -> Option<Vec<u8>> {
        let (tw, th) = (size.0 as i32, size.1 as i32);
        let dc = unsafe { CreateCompatibleDC(Some(source)) };
        let (bitmap, bits) = dib(dc, tw, th)?;
        let old = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        unsafe { SetStretchBltMode(dc, HALFTONE) };
        let ok = unsafe { StretchBlt(dc, 0, 0, tw, th, Some(source), from.0, from.1, from.2, from.3, SRCCOPY) }.as_bool();
        let rgba = ok.then(|| {
            let bgra = unsafe { std::slice::from_raw_parts(bits, (tw * th * 4) as usize) };
            bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect::<Vec<u8>>()
        });
        unsafe {
            SelectObject(dc, old);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(dc);
        }
        rgba
    }

    /// The window's picture, small: drawn by the window itself into a bitmap of its own size, the invisible frame cut off.
    fn window_thumb(hwnd: HWND, outer: RECT, visible: RECT) -> Option<String> {
        let (w, h) = (outer.right - outer.left, outer.bottom - outer.top);
        let screen = unsafe { GetDC(None) };
        let dc = unsafe { CreateCompatibleDC(Some(screen)) };
        let result = (|| {
            let (bitmap, _) = dib(dc, w, h)?;
            let old = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
            let printed = unsafe { PrintWindow(hwnd, dc, RENDER_FULL) }.as_bool();
            let (vw, vh) = ((visible.right - visible.left) as u32, (visible.bottom - visible.top) as u32);
            let size = thumb_size(vw, vh);
            let rgba = printed.then(|| shrink(dc, (visible.left - outer.left, visible.top - outer.top, vw as i32, vh as i32), size)).flatten();
            unsafe {
                SelectObject(dc, old);
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
            }
            png_url(&rgba?, size.0, size.1)
        })();
        unsafe {
            let _ = DeleteDC(dc);
            ReleaseDC(None, screen);
        }
        result
    }

    fn icon_of(hwnd: HWND, exe: Option<&str>) -> Option<String> {
        let mut handle = 0usize;
        for kind in [ICON_BIG, ICON_SMALL2] {
            let mut answer = 0usize;
            unsafe { SendMessageTimeoutW(hwnd, WM_GETICON, WPARAM(kind as usize), LPARAM(0), SMTO_ABORTIFHUNG, 50, Some(&mut answer)) };
            if answer != 0 {
                handle = answer;
                break;
            }
        }
        if handle == 0 {
            handle = unsafe { GetClassLongPtrW(hwnd, GCLP_HICON) };
        }
        if handle != 0 {
            return draw_icon(HICON(handle as *mut _));
        }
        // From the program's file: this one is ours to free.
        let exe = exe?;
        let wide: Vec<u16> = exe.encode_utf16().chain([0]).collect();
        let mut large = HICON::default();
        if unsafe { ExtractIconExW(PCWSTR(wide.as_ptr()), 0, Some(&mut large), None, 1) } == 0 || large.is_invalid() {
            return None;
        }
        let url = draw_icon(large);
        let _ = unsafe { DestroyIcon(large) };
        url
    }

    fn draw_icon(icon: HICON) -> Option<String> {
        let screen = unsafe { GetDC(None) };
        let dc = unsafe { CreateCompatibleDC(Some(screen)) };
        let result = (|| {
            let mut planes = Vec::new();
            for background in [0u8, 255u8] {
                let (bitmap, bits) = dib(dc, ICON, ICON)?;
                let pixels = unsafe { std::slice::from_raw_parts_mut(bits, (ICON * ICON * 4) as usize) };
                pixels.fill(background);
                let old = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
                let drawn = unsafe { DrawIconEx(dc, 0, 0, icon, ICON, ICON, 0, None, DI_NORMAL) }.is_ok();
                planes.push(drawn.then(|| pixels.to_vec()));
                unsafe {
                    SelectObject(dc, old);
                    let _ = DeleteObject(HGDIOBJ(bitmap.0));
                }
            }
            let (black, white) = (planes[0].as_ref()?, planes[1].as_ref()?);
            png_url(&icon_alpha(black, white), ICON as u32, ICON as u32)
        })();
        unsafe {
            let _ = DeleteDC(dc);
            ReleaseDC(None, screen);
        }
        result
    }

    struct Found {
        ours: HashSet<u32>,
        windows: Vec<HWND>,
    }

    unsafe extern "system" fn each_window(hwnd: HWND, data: LPARAM) -> BOOL {
        let found = unsafe { &mut *(data.0 as *mut Found) };
        if found.windows.len() < MAX_WINDOWS * 2 {
            found.windows.push(hwnd);
        }
        BOOL(1)
    }

    fn showable(hwnd: HWND, ours: &HashSet<u32>) -> Option<(u32, RECT, RECT)> {
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { IsIconic(hwnd) }.as_bool() {
            return None;
        }
        if unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|owner| !owner.is_invalid()) {
            return None;
        }
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if style & WS_EX_TOOLWINDOW.0 != 0 && style & WS_EX_APPWINDOW.0 == 0 {
            return None;
        }
        let mut cloaked = 0u32;
        let _ = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4) };
        if cloaked != 0 {
            return None;
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if ours.contains(&pid) || SKIP_CLASSES.contains(&class_of(hwnd).as_str()) {
            return None;
        }
        let mut outer = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut outer) }.ok()?;
        let mut visible = outer;
        let _ = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut visible as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32) };
        if visible.right - visible.left < MIN_SIDE || visible.bottom - visible.top < MIN_SIDE {
            return None;
        }
        Some((pid, outer, visible))
    }

    pub fn windows(thumbs: bool) -> Vec<Source> {
        let mut found = Found { ours: our_processes(), windows: Vec::new() };
        let _ = unsafe { EnumWindows(Some(each_window), LPARAM(&mut found as *mut Found as isize)) };
        let mut list = Vec::new();
        for hwnd in found.windows {
            if list.len() >= MAX_WINDOWS {
                break;
            }
            let Some((pid, outer, visible)) = showable(hwnd, &found.ours) else { continue };
            let title = text_of(hwnd);
            if title.is_empty() {
                continue;
            }
            let exe = exe_of(pid);
            let app = exe.as_deref().and_then(|p| std::path::Path::new(p).file_stem()).map(|s| s.to_string_lossy().into_owned());
            list.push(Source {
                kind: "window",
                id: hwnd.0 as usize as u64,
                title,
                app,
                width: (visible.right - visible.left) as u32,
                height: (visible.bottom - visible.top) as u32,
                primary: false,
                thumb: if thumbs { window_thumb(hwnd, outer, visible) } else { None },
                icon: icon_of(hwnd, exe.as_deref()),
            });
        }
        list
    }

    unsafe extern "system" fn each_monitor(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(monitor);
        BOOL(1)
    }

    pub fn monitors(thumbs: bool) -> Vec<Source> {
        let mut handles: Vec<HMONITOR> = Vec::new();
        let _ = unsafe { EnumDisplayMonitors(None, None, Some(each_monitor), LPARAM(&mut handles as *mut _ as isize)) };
        let screen = unsafe { GetDC(None) };
        let list = handles
            .into_iter()
            .enumerate()
            .filter_map(|(i, monitor)| {
                let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
                    return None;
                }
                let r = info.rcMonitor;
                let (w, h) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);
                let size = thumb_size(w, h);
                let thumb = if thumbs { shrink_screen(screen, r, size) } else { None };
                Some(Source { kind: "monitor", id: monitor.0 as usize as u64, title: format!("Экран {}", i + 1), app: None, width: w, height: h, primary: info.dwFlags & 1 != 0, thumb, icon: None })
            })
            .collect();
        unsafe { ReleaseDC(None, screen) };
        list
    }

    fn shrink_screen(screen: HDC, r: RECT, size: (u32, u32)) -> Option<String> {
        // CAPTUREBLT: windows drawn in layers (menus, tooltips) too.
        let _ = CAPTUREBLT;
        let rgba = shrink(screen, (r.left, r.top, r.right - r.left, r.bottom - r.top), size)?;
        png_url(&rgba, size.0, size.1)
    }
}

/// The windows and the screens there are to show; pictures only when `thumbs`.
#[tauri::command]
pub async fn capture_sources(thumbs: bool) -> Vec<Source> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let mut all = win::monitors(thumbs);
            all.extend(win::windows(thumbs));
            all
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = thumbs;
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thumbnail_keeps_the_shape_and_never_grows() {
        assert_eq!(thumb_size(1920, 1080), (320, 180));
        assert_eq!(thumb_size(2560, 1440), (320, 180));
        assert_eq!(thumb_size(1000, 1000), (180, 180));
        assert_eq!(thumb_size(3440, 1440), (320, 134));
        assert_eq!(thumb_size(200, 100), (200, 100));
    }

    #[test]
    fn an_icon_drawn_on_black_and_white_gives_its_transparency() {
        // A solid red pixel, a see-through one, and a half see-through grey.
        let black = [0, 0, 255, 0, 0, 0, 0, 0, 64, 64, 64, 0];
        let white = [0, 0, 255, 0, 255, 255, 255, 0, 191, 191, 191, 0];
        assert_eq!(icon_alpha(&black, &white), vec![255, 0, 0, 255, 0, 0, 0, 0, 127, 127, 127, 128]);
    }

    #[test]
    fn pixels_become_a_png_data_url() {
        let url = png_url(&[255, 0, 0, 255], 1, 1).unwrap();
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"));
    }
}
