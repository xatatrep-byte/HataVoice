//! Our own capture of a window or a screen (Windows Graphics Capture), so the call has a picker of its own instead of
//! WebView2's: the picture leaves out the mouse arrow (the friend who drives sees their own pointer) and has no yellow
//! frame. The video card shrinks each frame to the size asked for and turns it into NV12 (what the encoder wants: 1.5
//! bytes a pixel instead of 4), then it reaches the page through a WebView2 shared buffer, a few slots of one frame
//! each, and a web message per frame names the slot; the page turns it into a video track (`MediaStreamTrackGenerator`)
//! and publishes it encrypted, like any other.
//!
//! A slot is `seq: u32, width: u32, height: u32, stride: u32`, then the Y plane (`height` rows of `stride` bytes) and
//! the interleaved UV plane (`height / 2` rows). `seq` is odd while the slot is being written and even once it is
//! whole: the page copies a slot only when it reads the same even `seq` before and after.

use serde::{Deserialize, Serialize};

/// The header of a slot, bytes.
pub const SLOT_HEADER: usize = 16;
/// Slots in the ring: the page has two frames' time to take one before it is written again.
pub const SLOTS: usize = 3;
/// The biggest picture ever sent: 4K.
pub const MAX_BOX: (u32, u32) = (3840, 2160);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CaptureSource {
    /// This app's own main window (for checks).
    #[serde(rename = "self")]
    Own,
    Window { id: u64 },
    Monitor { id: u64 },
}

/// What the picture should be: at most `width` × `height` (smaller sources stay as they are), `fps` frames a second.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct CaptureQuality {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureInfo {
    pub slot_size: usize,
    pub slots: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CaptureStats {
    pub frames: u64,
    pub skipped: u64,
    pub copy_us: u64,
    /// The size frames go out at now.
    pub width: u32,
    pub height: u32,
}

/// Bytes of one slot for an NV12 picture of at most `width` × `height`.
pub fn slot_size(width: u32, height: u32) -> usize {
    SLOT_HEADER + width as usize * height as usize * 3 / 2
}

/// Whether a frame that came `since_last_us` after the last one sent goes out at `fps`: a frame a little early still
/// does, so 60 frames a second from a 60 Hz screen are not halved by jitter.
pub fn due(since_last_us: u64, fps: u32) -> bool {
    let period = 1_000_000 / u64::from(fps.max(1));
    since_last_us * 10 >= period * 8
}

/// The size a source of `width` × `height` goes out at inside `limit`: shrunk to fit with its shape kept, never grown,
/// both sides even (NV12 halves the colour both ways).
pub fn fit(width: u32, height: u32, limit: (u32, u32)) -> (u32, u32) {
    let scale = f64::min(1.0, f64::min(limit.0 as f64 / width.max(1) as f64, limit.1 as f64 / height.max(1) as f64));
    let even = |v: f64| ((v.floor() as u32) & !1).max(2);
    (even(width as f64 * scale), even(height as f64 * scale))
}

/// The capture's box, kept within 4K: a page cannot make the buffer as big as it likes.
pub fn bounded(quality: CaptureQuality) -> CaptureQuality {
    CaptureQuality { width: quality.width.clamp(2, MAX_BOX.0), height: quality.height.clamp(2, MAX_BOX.1), fps: quality.fps.clamp(1, 120) }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use tauri::{Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
    };
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Graphics::SizeInt32;
    use windows::Win32::Foundation::{HMODULE, HWND};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL,
        DXGI_SAMPLE_DESC,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

    /// A COM object used from one thread at a time behind a lock, or only on the main thread.
    struct Held<T>(T);
    // SAFETY: every `Held` lives behind a Mutex (or is touched only on the main thread through `with_webview`).
    unsafe impl<T> Send for Held<T> {}

    struct Running {
        session: GraphicsCaptureSession,
        pool: Direct3D11CaptureFramePool,
        _item: GraphicsCaptureItem,
        writer: Arc<Mutex<Held<Writer>>>,
    }

    static RUNNING: Mutex<Option<Held<Running>>> = Mutex::new(None);
    /// The buffers the page reads, by what they carry («capture», «audio»); opened and closed on the main thread only.
    static BUFFERS: Mutex<Vec<(&'static str, Held<ICoreWebView2SharedBuffer>)>> = Mutex::new(Vec::new());
    static FRAMES: AtomicU64 = AtomicU64::new(0);
    static SKIPPED: AtomicU64 = AtomicU64::new(0);
    static COPY_US: AtomicU64 = AtomicU64::new(0);
    static OUT_W: AtomicU32 = AtomicU32::new(0);
    static OUT_H: AtomicU32 = AtomicU32::new(0);

    fn texture(device: &ID3D11Device, width: u32, height: u32, format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT, usage: D3D11_USAGE, bind: u32, cpu: u32) -> windows::core::Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: usage,
            BindFlags: bind,
            CPUAccessFlags: cpu,
            MiscFlags: 0,
        };
        let mut made = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut made))? };
        made.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
    }

    /// The video card's shrink-and-convert from one input size to one output size.
    struct Converter {
        input_size: (u32, u32),
        output_size: (u32, u32),
        input: ID3D11Texture2D,
        output: ID3D11Texture2D,
        staging: ID3D11Texture2D,
        processor: ID3D11VideoProcessor,
        input_view: ID3D11VideoProcessorInputView,
        output_view: ID3D11VideoProcessorOutputView,
    }

    impl Converter {
        fn new(device: &ID3D11Device, video: &ID3D11VideoDevice, context: &ID3D11VideoContext, input_size: (u32, u32), output_size: (u32, u32)) -> windows::core::Result<Self> {
            let rate = DXGI_RATIONAL { Numerator: 60, Denominator: 1 };
            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: input_size.0,
                InputHeight: input_size.1,
                OutputFrameRate: rate,
                OutputWidth: output_size.0,
                OutputHeight: output_size.1,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = unsafe { video.CreateVideoProcessorEnumerator(&content)? };
            let processor = unsafe { video.CreateVideoProcessor(&enumerator, 0)? };
            let input = texture(device, input_size.0, input_size.1, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_USAGE_DEFAULT, (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32, 0)?;
            let output = texture(device, output_size.0, output_size.1, DXGI_FORMAT_NV12, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET.0 as u32, 0)?;
            let staging = texture(device, output_size.0, output_size.1, DXGI_FORMAT_NV12, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ.0 as u32)?;
            let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input_view = None;
            unsafe { video.CreateVideoProcessorInputView(&input, &enumerator, &input_desc, Some(&mut input_view))? };
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut output_view = None;
            unsafe { video.CreateVideoProcessorOutputView(&output, &enumerator, &output_desc, Some(&mut output_view))? };
            // Full-range RGB in, BT.709 studio-range YUV out: what the page tells the VideoFrame.
            if let Ok(context1) = context.cast::<ID3D11VideoContext1>() {
                unsafe {
                    context1.VideoProcessorSetStreamColorSpace1(&processor, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                    context1.VideoProcessorSetOutputColorSpace1(&processor, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
                }
            }
            // Frames, not fields; no auto-processing that would change the picture.
            unsafe { context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false) };
            let fail = || windows::core::Error::from(windows::Win32::Foundation::E_FAIL);
            Ok(Converter { input_size, output_size, input, output, staging, processor, input_view: input_view.ok_or_else(fail)?, output_view: output_view.ok_or_else(fail)? })
        }
    }

    struct Writer {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        video: ID3D11VideoDevice,
        video_context: ID3D11VideoContext,
        winrt: IDirect3DDevice,
        converter: Option<Converter>,
        pool_size: SizeInt32,
        base: usize,
        slot_size: usize,
        /// What the slots were made for: the box may be changed within it.
        limit: (u32, u32),
        quality: CaptureQuality,
        next: usize,
        seq: u32,
        last: Option<Instant>,
        app: tauri::AppHandle,
    }

    fn device() -> Result<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice), String> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(|e| format!("Нет Direct3D 11: {e}"))?;
        let device: ID3D11Device = device.ok_or("Нет Direct3D 11")?;
        let context = context.ok_or("Нет Direct3D 11")?;
        let dxgi: IDXGIDevice = device.cast().map_err(|e| e.to_string())?;
        let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }.and_then(|i| i.cast()).map_err(|e| e.to_string())?;
        Ok((device, context, winrt))
    }

    fn item_for(app: &tauri::AppHandle, source: &CaptureSource) -> Result<GraphicsCaptureItem, String> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|e| format!("Захват окон недоступен: {e}"))?;
        match source {
            CaptureSource::Own => {
                let window = app.get_window("main").ok_or("Нет окна")?;
                let hwnd = window.hwnd().map_err(|e| e.to_string())?;
                unsafe { interop.CreateForWindow(HWND(hwnd.0)) }.map_err(|e| format!("Окно не захватывается: {e}"))
            }
            CaptureSource::Window { id } => unsafe { interop.CreateForWindow(HWND(*id as usize as *mut _)) }.map_err(|_| "Это окно уже закрыто или его нельзя показать".to_string()),
            CaptureSource::Monitor { id } => unsafe { interop.CreateForMonitor(windows::Win32::Graphics::Gdi::HMONITOR(*id as usize as *mut _)) }
                .map_err(|_| "Этот экран больше не подключён".to_string()),
        }
    }

    /// Opens a shared buffer of `size` bytes for `kind` on the main thread (closing the last one of that kind), hands it
    /// to the page with `extra` and returns where its bytes are.
    pub(crate) async fn shared_buffer(app: &tauri::AppHandle, kind: &'static str, size: usize, extra: String) -> Result<usize, String> {
        // The page as a webview: with a site watched in the call, the main window holds two (see `watch_browser`).
        let window = app.get_webview("main").ok_or("Нет окна")?;
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<usize, String>>();
        window
            .with_webview(move |webview| {
                let opened = (|| -> Result<usize, String> {
                    let environment: ICoreWebView2Environment12 = webview.environment().cast().map_err(|_| "WebView2 устарел: обнови Windows".to_string())?;
                    let buffer = unsafe { environment.CreateSharedBuffer(size as u64) }.map_err(|e| format!("Нет памяти под кадры: {e}"))?;
                    let mut bytes = std::ptr::null_mut();
                    unsafe { buffer.Buffer(&mut bytes) }.map_err(|e| e.to_string())?;
                    let core: ICoreWebView2_17 = unsafe { webview.controller().CoreWebView2() }.and_then(|c| c.cast()).map_err(|_| "WebView2 устарел: обнови Windows".to_string())?;
                    unsafe { core.PostSharedBufferToScript(&buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, &HSTRING::from(extra.as_str())) }.map_err(|e| e.to_string())?;
                    let mut buffers = BUFFERS.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(at) = buffers.iter().position(|(k, _)| *k == kind) {
                        let (_, Held(old)) = buffers.remove(at);
                        let _ = unsafe { old.Close() };
                    }
                    buffers.push((kind, Held(buffer)));
                    Ok(bytes as usize)
                })();
                let _ = tx.send(opened);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "Окно не ответило".to_string())?
    }

    /// A web message to the page, from any thread.
    pub(crate) fn post_json(app: &tauri::AppHandle, json: String) {
        let Some(window) = app.get_webview("main") else { return };
        let message = HSTRING::from(json);
        let _ = window.with_webview(move |webview| {
            if let Ok(core) = unsafe { webview.controller().CoreWebView2() } {
                let _ = unsafe { core.PostWebMessageAsJson(&message) };
            }
        });
    }

    impl Writer {
        fn take(&mut self, pool: &Direct3D11CaptureFramePool) -> windows::core::Result<()> {
            let frame = pool.TryGetNextFrame()?;
            // A window that changed size: the pool follows it, and the next frame has the whole of it.
            let content = frame.ContentSize()?;
            if content.Width > 0 && content.Height > 0 && (content.Width != self.pool_size.Width || content.Height != self.pool_size.Height) {
                self.pool_size = content;
                pool.Recreate(&self.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content)?;
                return Ok(());
            }
            let now = Instant::now();
            if let Some(last) = self.last {
                if !due(now.duration_since(last).as_micros() as u64, self.quality.fps) {
                    SKIPPED.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
            }
            self.last = Some(now);
            let texture: ID3D11Texture2D = unsafe { frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            let input_size = (desc.Width, desc.Height);
            let box_now = (self.quality.width.min(self.limit.0), self.quality.height.min(self.limit.1));
            let output_size = fit(input_size.0, input_size.1, box_now);
            if self.converter.as_ref().map(|c| (c.input_size, c.output_size)) != Some((input_size, output_size)) {
                self.converter = Some(Converter::new(&self.device, &self.video, &self.video_context, input_size, output_size)?);
                OUT_W.store(output_size.0, Ordering::Relaxed);
                OUT_H.store(output_size.1, Ordering::Relaxed);
            }
            let Some(c) = self.converter.as_ref() else { return Ok(()) };
            let started = Instant::now();
            unsafe {
                self.context.CopyResource(&c.input, &texture);
                let stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: std::mem::ManuallyDrop::new(Some(c.input_view.clone())), ..Default::default() };
                let streams = [stream];
                let blt = self.video_context.VideoProcessorBlt(&c.processor, &c.output_view, 0, &streams);
                let [mut stream] = streams;
                std::mem::ManuallyDrop::drop(&mut stream.pInputSurface);
                blt?;
                self.context.CopyResource(&c.staging, &c.output);
            }
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe { self.context.Map(&c.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
            let (w, h) = (output_size.0 as usize, output_size.1 as usize);
            let slot = self.next;
            let at = self.base + slot * self.slot_size;
            self.seq = self.seq.wrapping_add(2);
            unsafe {
                let header = at as *mut u32;
                header.write_volatile(self.seq | 1);
                std::sync::atomic::fence(Ordering::Release);
                header.add(1).write(w as u32);
                header.add(2).write(h as u32);
                header.add(3).write(w as u32);
                let pixels = (at + SLOT_HEADER) as *mut u8;
                let source = mapped.pData as *const u8;
                let pitch = mapped.RowPitch as usize;
                // Y, then UV right after the Y rows of the texture.
                for row in 0..h {
                    std::ptr::copy_nonoverlapping(source.add(row * pitch), pixels.add(row * w), w);
                }
                let uv_from = source.add(pitch * h);
                let uv_to = pixels.add(w * h);
                for row in 0..h / 2 {
                    std::ptr::copy_nonoverlapping(uv_from.add(row * pitch), uv_to.add(row * w), w);
                }
                std::sync::atomic::fence(Ordering::Release);
                header.write_volatile(self.seq);
                self.context.Unmap(&c.staging, 0);
            }
            COPY_US.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
            FRAMES.fetch_add(1, Ordering::Relaxed);
            self.next = (self.next + 1) % SLOTS;
            post_json(&self.app, format!(r#"{{"hv":"frame","slot":{slot},"seq":{}}}"#, self.seq));
            Ok(())
        }
    }

    pub async fn start(app: tauri::AppHandle, source: CaptureSource, quality: CaptureQuality, limit: CaptureQuality) -> Result<CaptureInfo, String> {
        stop(&app);
        let quality = bounded(quality);
        let limit = bounded(limit);
        // The slots fit the biggest size the share may be changed to; nothing of Direct3D is held across the wait.
        let info = CaptureInfo { slot_size: slot_size(limit.width.max(quality.width), limit.height.max(quality.height)), slots: SLOTS };
        let extra = serde_json::json!({ "hv": "capture", "slotSize": info.slot_size, "slots": info.slots }).to_string();
        let base = shared_buffer(&app, "capture", info.slot_size * SLOTS, extra).await?;
        begin(app, &source, quality, (limit.width.max(quality.width), limit.height.max(quality.height)), &info, base)?;
        Ok(info)
    }

    fn begin(app: tauri::AppHandle, source: &CaptureSource, quality: CaptureQuality, limit: (u32, u32), info: &CaptureInfo, base: usize) -> Result<(), String> {
        let (device, context, winrt) = device()?;
        let video: ID3D11VideoDevice = device.cast().map_err(|_| "Видеокарта не умеет сжимать кадры".to_string())?;
        let video_context: ID3D11VideoContext = context.cast().map_err(|_| "Видеокарта не умеет сжимать кадры".to_string())?;
        let item = item_for(&app, source)?;
        let size = item.Size().map_err(|e| e.to_string())?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("Это окно свёрнуто: разверни его и выбери снова".into());
        }
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size).map_err(|e| format!("Захват не начался: {e}"))?;
        let session = pool.CreateCaptureSession(&item).map_err(|e| format!("Захват не начался: {e}"))?;
        // The friend who drives sees their own pointer; the arrow in the picture would only lag behind it.
        let _ = session.SetIsCursorCaptureEnabled(false);
        let _ = session.SetIsBorderRequired(false);
        let writer = Arc::new(Mutex::new(Held(Writer {
            device,
            context,
            video,
            video_context,
            winrt,
            converter: None,
            pool_size: size,
            base,
            slot_size: info.slot_size,
            limit,
            quality,
            next: 0,
            seq: 0,
            last: None,
            app: app.clone(),
        })));
        FRAMES.store(0, Ordering::Relaxed);
        SKIPPED.store(0, Ordering::Relaxed);
        COPY_US.store(0, Ordering::Relaxed);
        let frames = writer.clone();
        pool.FrameArrived(&TypedEventHandler::new(move |pool: windows::core::Ref<Direct3D11CaptureFramePool>, _| {
            if let Some(pool) = pool.as_ref() {
                let _ = frames.lock().unwrap_or_else(|e| e.into_inner()).0.take(pool);
            }
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
        // The window was closed (or the screen unplugged): the share ends.
        let closed = app.clone();
        item.Closed(&TypedEventHandler::new(move |_, _| {
            let _ = closed.emit("capture-ended", ());
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
        session.StartCapture().map_err(|e| format!("Захват не начался: {e}"))?;
        *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(Held(Running { session, pool, _item: item, writer }));
        Ok(())
    }

    /// Another size or rate for the running capture, within what its slots were made for.
    pub fn tune(quality: CaptureQuality) {
        if let Some(Held(running)) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            running.writer.lock().unwrap_or_else(|e| e.into_inner()).0.quality = bounded(quality);
        }
    }

    pub fn stop(app: &tauri::AppHandle) {
        if let Some(Held(running)) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = running.session.Close();
            let _ = running.pool.Close();
        }
        if let Some(window) = app.get_webview("main") {
            let _ = window.with_webview(|_| {
                for (_, Held(buffer)) in BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
                    let _ = unsafe { buffer.Close() };
                }
            });
        }
    }

    pub fn stats() -> CaptureStats {
        CaptureStats {
            frames: FRAMES.load(Ordering::Relaxed),
            skipped: SKIPPED.load(Ordering::Relaxed),
            copy_us: COPY_US.load(Ordering::Relaxed),
            width: OUT_W.load(Ordering::Relaxed),
            height: OUT_H.load(Ordering::Relaxed),
        }
    }
}

/// Starts showing `source` at `quality`; `limit` is the biggest it may later be tuned to (while someone drives).
#[tauri::command]
pub async fn capture_start(app: tauri::AppHandle, source: CaptureSource, quality: CaptureQuality, limit: Option<CaptureQuality>) -> Result<CaptureInfo, String> {
    #[cfg(windows)]
    {
        win::start(app, source, quality, limit.unwrap_or(quality)).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, source, quality, limit);
        Err("Свой захват экрана есть только в Windows".into())
    }
}

#[tauri::command]
pub fn capture_tune(quality: CaptureQuality) {
    #[cfg(windows)]
    win::tune(quality);
    #[cfg(not(windows))]
    let _ = quality;
}

#[cfg(windows)]
pub(crate) use win::{post_json, shared_buffer};

#[tauri::command]
pub fn capture_stop(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        crate::screen_audio::stop();
        win::stop(&app);
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub fn capture_stats() -> CaptureStats {
    #[cfg(windows)]
    {
        win::stats()
    }
    #[cfg(not(windows))]
    CaptureStats::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slot_holds_its_header_and_an_nv12_picture() {
        assert_eq!(slot_size(1920, 1080), 16 + 1920 * 1080 * 3 / 2);
    }

    #[test]
    fn frames_go_out_at_the_rate_asked_for_and_jitter_does_not_halve_it() {
        assert!(due(16_000, 60), "a frame a little early still goes");
        assert!(!due(8_000, 60), "two frames in one period: the second waits");
        assert!(due(33_000, 30));
        assert!(!due(16_667, 30), "a 60 Hz screen shared at 30: every other frame");
    }

    #[test]
    fn a_picture_shrinks_to_the_box_with_its_shape_and_even_sides() {
        assert_eq!(fit(3840, 2160, (1920, 1080)), (1920, 1080));
        assert_eq!(fit(2560, 1440, (1920, 1080)), (1920, 1080));
        assert_eq!(fit(3440, 1440, (1920, 1080)), (1920, 802), "a wide screen fits by its width");
        assert_eq!(fit(1266, 793, (1920, 1080)), (1266, 792), "never grown; odd sides made even");
        assert_eq!(fit(1, 1, (1920, 1080)), (2, 2));
    }

    #[test]
    fn a_page_cannot_ask_for_more_than_4k() {
        assert_eq!(bounded(CaptureQuality { width: 100_000, height: 0, fps: 1000 }), CaptureQuality { width: 3840, height: 2, fps: 120 });
    }
}
