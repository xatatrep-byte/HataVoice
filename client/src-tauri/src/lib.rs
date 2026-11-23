mod audit;
mod avatar;
mod bridge;
mod call;
mod call_plan;
mod chat;
mod chat_files;
mod chat_model;
mod chat_store;
mod commands;
mod events;
#[cfg(target_os = "linux")]
mod front;
mod fullscreen;
mod games;
mod host;
// Used on Android only (through JNI); tested everywhere.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod i420;
mod identity;
mod idle;
mod music;
mod music_word;
mod overlay;
mod pads;
mod pads_cmd;
mod remote;
mod remote_cmd;
mod remote_input;
mod vpad;
mod watch_browser;
mod mac_keys;
mod ptt;
#[cfg(windows)]
mod ptt_hook;
#[cfg(target_os = "macos")]
#[path = "ptt_hook_mac.rs"]
mod ptt_hook;
mod server_check;
mod signal_rewrite;
mod picked;
mod rtmp;
mod screen_audio;
mod screen_capture;
mod screen_sources;
mod server_state;
mod stream;
mod studio;
mod server_group;
mod session;
mod speedtest;
mod virustotal;
#[cfg(all(test, windows))]
mod testkit;
mod tls;
mod updater;

use host::{HostProcess, HostView};
use hv_host::HostConfig;
use tauri::Manager;

#[cfg(not(any(windows, target_os = "macos")))]
const PTT_UNSUPPORTED: &str = "Push-to-talk пока работает только в Windows и на Mac";

#[tauri::command]
fn ptt_set_binding(app: tauri::AppHandle, binding: Vec<String>) -> Result<(), String> {
    let codes = ptt::parse_binding(&binding)?;
    #[cfg(windows)]
    {
        ptt_hook::set_binding(&app, codes);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        ptt_hook::set_binding(&app, codes)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, codes);
        Err(PTT_UNSUPPORTED.into())
    }
}

#[tauri::command]
fn ptt_capture(app: tauri::AppHandle, active: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if active {
            ptt_hook::start_capture(&app);
        } else {
            ptt_hook::cancel_capture(&app);
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        if active {
            ptt_hook::start_capture(&app)
        } else {
            ptt_hook::cancel_capture(&app);
            Ok(())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, active);
        Err(PTT_UNSUPPORTED.into())
    }
}

/// What every window's WebView2 starts with — the same for all, as WebView2 wants of windows sharing a data folder:
/// wry's own defaults (no mini menu, no SmartScreen) and AV1 encoded by the video card in calls. Chromium keeps the
/// latter off on Windows; without it even an RTX 40 encodes an AV1 screen on the processor.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=WebRtcAV1HWEncode,MediaFoundationAV1Encoding";

/// The variable that starts a second copy of a debug build with a data folder of its own, so two copies can
/// run on one PC and talk to each other.
const PROFILE_VAR: &str = "HATAVOICE_PROFILE";
const PROFILE_NAME_MAX: usize = 16;

/// The profile a copy was asked to run as. Only debug builds listen, so an installed copy cannot be pointed
/// at another folder; only `[a-z0-9-]{1,16}` is a name, so a profile can never leave the `profiles` folder.
fn profile_name(debug: bool, requested: Option<&str>) -> Option<&str> {
    let name = requested?;
    let plain = !name.is_empty()
        && name.len() <= PROFILE_NAME_MAX
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    (debug && plain).then_some(name)
}

/// Where a copy keeps its identity and its own server: `base`, or the folder of its profile.
fn profile_dir(base: &std::path::Path, debug: bool, requested: Option<&str>) -> std::path::PathBuf {
    match profile_name(debug, requested) {
        Some(name) => base.join("profiles").join(name),
        None => base.to_path_buf(),
    }
}

/// The folder WebView2 keeps the window's own data in (saved servers, settings) when a profile is on;
/// without it two copies would share, and overwrite, one another's.
fn webview_dir(base: &std::path::Path, debug: bool, requested: Option<&str>) -> Option<std::path::PathBuf> {
    profile_name(debug, requested).map(|_| profile_dir(base, debug, requested).join("webview"))
}

/// Whether this copy lets a second launch hand its invite link over instead of opening. A profile is a
/// second copy on purpose.
fn single_instance(debug: bool, requested: Option<&str>) -> bool {
    profile_name(debug, requested).is_none()
}

fn requested_profile() -> Option<String> {
    std::env::var(PROFILE_VAR).ok()
}

/// This copy's data folder: the app's own, or that of the dev profile.
pub(crate) fn data_dir<R: tauri::Runtime>(manager: &impl Manager<R>) -> Result<std::path::PathBuf, String> {
    let base = manager.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(profile_dir(&base, cfg!(debug_assertions), requested_profile().as_deref()))
}

/// Points WebView2 at the profile's own folder. It has to happen before the window exists, and Tauri creates
/// the window after its plugins have been set up, so this is a plugin. The variable beats the folder Tauri asks
/// for, which is the point.
fn profile_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("hatavoice-profile")
        .setup(|app, _| {
            let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
            if let Some(dir) = webview_dir(&base, cfg!(debug_assertions), requested_profile().as_deref()) {
                std::fs::create_dir_all(&dir).map_err(|e| format!("Не создаётся {}: {e}", dir.display()))?;
                // SAFETY: plugins are set up on the main thread while the app is built, before the window and
                // before any of this program's own tasks exist, so nothing else touches the environment.
                unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir) };
            }
            Ok(())
        })
        .build()
}

/// The window's answer when its page asks for a permission. Our own page gets the microphone and the camera without a
/// WebView2 prompt: a prompt answered «Блокировать», or dismissed a few times, stays in the WebView2 profile, and nothing
/// in the app can undo it. The page asks for the camera only when its button is pressed (or the motion editor's webcam
/// is on). Anything else, or any other page, goes the usual way — nothing is refused for good, so a later feature can
/// still ask.
fn permission_answer(
    kind: tauri::webview::PermissionKind,
    page: &tauri::Url,
    dev_url: Option<&tauri::Url>,
) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind, PermissionResponse};
    // The installed window serves its page from tauri.localhost; a debug build loads it from the dev server.
    let installed = matches!(page.scheme(), "http" | "https") && page.host_str() == Some("tauri.localhost") && page.port().is_none();
    let dev = dev_url.is_some_and(|dev| dev.origin() == page.origin());
    if matches!(kind, PermissionKind::Microphone | PermissionKind::Camera) && (installed || dev) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Default
    }
}

/// The answer on a phone, from the webview's label alone. Android asks on its UI thread, and asking the webview for its
/// address waits for that very thread: it stood still for wry's 10 s, Android called the app frozen and killed it at the
/// first microphone question («Проверим звук», 0.16.0). The phone has one webview of Tauri's, the program's own page (a
/// site for watching together lives in WatchActivity, which refuses every permission itself), so the label says enough.
#[cfg_attr(not(mobile), allow(dead_code))]
fn phone_permission_answer(kind: tauri::webview::PermissionKind, label: &str) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind, PermissionResponse};
    if label == "main" && matches!(kind, PermissionKind::Microphone | PermissionKind::Camera) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Default
    }
}

/// The windows that show this program's own page (never the watch window, which shows other sites).
const OWN_WINDOWS: [&str; 3] = ["main", overlay::LABEL, remote_cmd::BANNER];

fn may_read_media(label: &str) -> bool {
    OWN_WINDOWS.contains(&label)
}

/// The origin of this program's own page: tauri.localhost in the installed program, the dev server in a debug build.
fn is_own_origin(origin: &str, dev_url: Option<&tauri::Url>) -> bool {
    matches!(origin, "http://tauri.localhost" | "https://tauri.localhost") || dev_url.is_some_and(|dev| dev.origin().ascii_serialization() == origin)
}

/// Data folder of the server hosted on this PC (one per user for now).
pub(crate) fn host_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(data_dir(app)?.join("servers").join("default"))
}

#[tauri::command]
async fn host_view(app: tauri::AppHandle, process: tauri::State<'_, HostProcess>) -> Result<HostView, String> {
    process.view(&host_dir(&app)?).await
}

#[tauri::command]
fn host_save(app: tauri::AppHandle, process: tauri::State<'_, HostProcess>, config: HostConfig) -> Result<(), String> {
    host::save_config(&host_dir(&app)?, &process, &config)
}

#[tauri::command]
fn host_start(app: tauri::AppHandle, process: tauri::State<'_, HostProcess>) -> Result<(), String> {
    let dir = host_dir(&app)?;
    process.start(&dir)?;
    host::remember_on(&dir, true);
    Ok(())
}

/// Stops the server hosted here. `keep_on` is for a restart (new settings): it is not the owner turning it off, so it
/// still comes back with the program if the start after it fails.
#[tauri::command]
async fn host_stop(app: tauri::AppHandle, process: tauri::State<'_, HostProcess>, keep_on: Option<bool>) -> Result<(), String> {
    let dir = host_dir(&app)?;
    let port = host::read_config(&dir)?.map(|c| c.api_port).unwrap_or_default();
    if keep_on != Some(true) {
        host::remember_on(&dir, false);
    }
    process.stop(port).await
}

/// Deletes the server hosted on this PC for good: it stops, its folder goes, and so does what this PC kept of its chat.
/// `server_key` is the key the window saved for it, for when it is not open now.
#[tauri::command]
async fn host_delete(app: tauri::AppHandle, process: tauri::State<'_, HostProcess>, server_key: Option<String>) -> Result<Option<String>, String> {
    let dir = host_dir(&app)?;
    let port = host::read_config(&dir).ok().flatten().map(|c| c.api_port);
    host::remember_on(&dir, false);
    if let Some(port) = port {
        process.stop(port).await?;
    }
    let opened = match port {
        Some(port) => commands::close_server(&app, &format!("127.0.0.1:{port}")).await,
        None => None,
    };
    let key = match opened {
        Some(key) => Some(key),
        None => server_key.as_deref().map(commands::saved_key).transpose()?,
    };
    let erase_dir = dir.clone();
    tauri::async_runtime::spawn_blocking(move || host::erase(&erase_dir)).await.map_err(|e| e.to_string())??;
    if let Some(key) = &key {
        chat_store::forget_server(&data_dir(&app)?, key)?;
    }
    // The window drops every entry of this server from its list by this key (the same server added by another address).
    Ok(key.map(|k| hv_roster::keys::encode_b64(&k.0)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // A second launch (an invite link clicked in the browser) hands its link to the running
    // window instead: the deep-link plugin delivers it there as an opened URL.
    #[cfg(desktop)]
    if single_instance(cfg!(debug_assertions), requested_profile().as_deref()) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    // A debug copy started with HATAVOICE_PROFILE=<name> is a second copy on purpose: it has its own folder.
    // The single-instance plugin asks to be the first; this one only has to run before the window exists.
    builder = builder.plugin(profile_plugin());
    // Android hands picked files over as content:// addresses, which only this plugin opens (see `picked`).
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_fs::init());
    }
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Only a debug build loads its page from the dev server.
        .on_permission_request(|webview, kind| {
            // Never ask a phone's webview anything here: see `phone_permission_answer`.
            if cfg!(mobile) {
                return phone_permission_answer(kind, webview.label());
            }
            let dev_url = if cfg!(debug_assertions) { webview.config().build.dev_url.clone() } else { None };
            match webview.url() {
                Ok(page) => permission_answer(kind, &page, dev_url.as_ref()),
                Err(_) => tauri::webview::PermissionResponse::Default,
            }
        })
        .manage(HostProcess::default())
        .manage(call::Calls::default())
        .manage(remote::Remote::default())
        .manage(pads::Pads::new(Box::new(vpad::ViGEm::default())))
        .manage(studio::Studio::default())
        .manage(stream::Streamer::default())
        // The window cannot check a server's certificate, so server media comes through the bridge,
        // which carries it over pinned TLS and checks its hash.
        .register_asynchronous_uri_scheme_protocol("hvmedia", |ctx, request, responder| {
            // Opened chat files and friends' characters are for this program's own page alone: the watch window shows
            // any site, and a site there must not read them.
            if !may_read_media(ctx.webview_label()) {
                responder.respond(bridge::media_reply(Err((403, "Не для этого окна".to_string()))));
                return;
            }
            let dev_url = if cfg!(debug_assertions) { ctx.app_handle().config().build.dev_url.clone() } else { None };
            let origin = request.headers().get("origin").and_then(|o| o.to_str().ok()).filter(|o| is_own_origin(o, dev_url.as_ref())).map(str::to_string);
            // A picked picture or video for the page's editors, in the pieces its player asks for; the page draws it, so
            // it is named as allowed to (its own origin only).
            if let Some(token) = request.uri().path().strip_prefix("/picked/") {
                let range = request.headers().get("range").and_then(|r| r.to_str().ok());
                let reply = match picked::piece_of(token, range) {
                    Ok(piece) => tauri::http::Response::builder()
                        .status(if range.is_some() { 206 } else { 200 })
                        .header("content-type", piece.kind)
                        .header("accept-ranges", "bytes")
                        .header("content-range", format!("bytes {}-{}/{}", piece.from, piece.to, piece.size))
                        .header("x-content-type-options", "nosniff")
                        .body(piece.bytes)
                        .unwrap_or_default(),
                    Err(e) => bridge::media_reply(Err(e)),
                };
                let mut reply = reply;
                if let Some(origin) = origin.and_then(|o| tauri::http::HeaderValue::from_str(&o).ok()) {
                    reply.headers_mut().insert("access-control-allow-origin", origin);
                }
                reply.headers_mut().insert("vary", tauri::http::HeaderValue::from_static("origin"));
                responder.respond(reply);
                return;
            }
            let bridge = ctx.app_handle().try_state::<std::sync::Arc<bridge::Bridge>>().map(|b| b.inner().clone());
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                let result = match bridge {
                    // Files of the chat, opened on this PC.
                    _ if path.starts_with("/chat/") => chat::media(&app, &path).await,
                    // Files of characters, read by the page itself: it may only look at them when told it can.
                    _ if path.starts_with("/avatar/") => avatar::media(&app, &path).await,
                    Some(bridge) => bridge::media(&bridge, &path).await,
                    None => Err((503, "Мост ещё не запущен".to_string())),
                };
                let mut reply = bridge::media_reply(result);
                // The page reads characters' files itself (another origin than this scheme): it is named, nobody else.
                if path.starts_with("/avatar/") {
                    if let Some(origin) = origin.and_then(|o| tauri::http::HeaderValue::from_str(&o).ok()) {
                        reply.headers_mut().insert("access-control-allow-origin", origin);
                    }
                    reply.headers_mut().insert("vary", tauri::http::HeaderValue::from_static("origin"));
                }
                responder.respond(reply);
            });
        })
        .setup(|app| {
            // Files dropped on the window reach the page by token (see `picked`): Windows names them, the page never does.
            if let Some(main) = app.get_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        let files = picked::dropped(paths.clone());
                        if !files.is_empty() {
                            let _ = tauri::Emitter::emit_to(&handle, "main", "files-dropped", files);
                        }
                    }
                });
            }
            app.manage(tauri::async_runtime::block_on(bridge::Bridge::start())?);
            #[cfg(target_os = "linux")]
            front::open(app)?;
            // hatavoice:// opens this copy, and an installed copy takes it back from whatever had it. A test copy with
            // a profile leaves it alone: it once left links pointing at a build folder that was deleted later.
            #[cfg(windows)]
            if single_instance(cfg!(debug_assertions), requested_profile().as_deref()) {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("hatavoice:// not registered: {e}");
                }
            }
            remote_cmd::start(app.handle());
            pads_cmd::start(app.handle());
            commands::setup(app)?;
            updater::clean_leftovers();
            picked::clean_staged();
            #[cfg(target_os = "android")]
            picked::clean_android_cache(app.handle());
            // The server hosted here comes back with the program (on a phone too: Android starts it from its libraries).
            #[cfg(any(desktop, target_os = "android"))]
            if let Ok(dir) = host_dir(app.handle())
                && host::was_on(&dir)
                && let Err(e) = app.state::<HostProcess>().start(&dir)
            {
                eprintln!("the server did not come back: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::voice_token,
            commands::identity_info,
            commands::identity_export,
            commands::identity_import,
            commands::save_picture,
            picked::picked_media,
            picked::stage_media,
            virustotal::vt_has_key,
            virustotal::vt_set_key,
            virustotal::vt_check,
            virustotal::vt_upload,
            virustotal::vt_analysis,
            commands::identity_file,
            commands::identity_forget,
            watch_browser::watch_browser_open,
            watch_browser::watch_browser_check,
            watch_browser::watch_browser_command,
            watch_browser::watch_browser_focus,
            watch_browser::watch_browser_close,
            watch_browser::watch_view_open,
            watch_browser::watch_view_place,
            watch_browser::watch_view_close,
            commands::server_open,
            commands::server_join,
            commands::invite_preview,
            commands::invite_from_clipboard,
            commands::p2p_state,
            commands::server_use_tunnel,
            commands::host_claim,
            commands::server_state,
            commands::presence_set,
            commands::profile_set,
            commands::server_post,
            commands::invite_create,
            commands::moderate,
            commands::media_upload,
            commands::audit,
            call::call_join,
            call::call_presence,
            call::call_leave,
            chat::chat_view,
            chat::chat_status,
            chat::chat_unread_base,
            chat::chat_send,
            chat::chat_edit,
            chat::chat_delete,
            chat::chat_react,
            chat::chat_poll,
            chat::chat_vote,
            chat::chat_poll_close,
            chat::chat_reset,
            chat::chat_file_save,
            chat::chat_file_fingerprint,
            speedtest::speed_server,
            speedtest::speed_internet,
            chat::chat_typing,
            chat::chat_watch,
            chat::chat_music,
            chat::chat_act,
            chat::chat_dms,
            chat::chat_dm_open,
            overlay::overlay_show,
            overlay::overlay_arrange,
            overlay::overlay_cursor,
            remote_cmd::remote_screens,
            remote_cmd::remote_ask,
            remote_cmd::remote_answer,
            remote_cmd::remote_seal,
            remote_cmd::remote_input,
            remote_cmd::remote_open,
            remote_cmd::remote_stop,
            remote_cmd::remote_state,
            remote_cmd::remote_banner,
            remote_cmd::remote_banner_setting,
            remote_cmd::remote_banner_close,
            pads_cmd::pad_ask,
            pads_cmd::pad_answer,
            pads_cmd::pad_seal,
            pads_cmd::pad_input,
            pads_cmd::pad_kick,
            pads_cmd::pad_stop_all,
            pads_cmd::pad_release,
            pads_cmd::pad_state,
            pads_cmd::pad_driver,
            studio::studio_record_open,
            studio::studio_record_write,
            studio::studio_record_close,
            studio::studio_snapshot,
            studio::studio_save_clip,
            studio::studio_folder,
            studio::studio_pick_folder,
            studio::studio_folder_reset,
            studio::studio_open_folder,
            stream::stream_key_set,
            stream::stream_key_has,
            stream::stream_key_forget,
            stream::stream_start,
            stream::stream_stop,
            stream::stream_packet,
            idle::idle_seconds,
            games::games_enable,
            fullscreen::fullscreen_app,
            picked::pick_files,
            commands::my_gifs,
            commands::my_gif_upload,
            picked::pick_save,
            screen_capture::capture_start,
            screen_capture::capture_tune,
            screen_capture::capture_stop,
            screen_capture::capture_stats,
            screen_sources::capture_sources,
            screen_audio::capture_audio_start,
            screen_audio::capture_audio_stop,
            music::music_sources,
            music::music_now,
            music::music_start,
            music::music_stop,
            games::games_custom,
            games::streaming_status,
            ptt_set_binding,
            ptt_capture,
            avatar::avatar_seal,
            avatar::avatar_publish,
            updater::update_check,
            updater::update_install,
            host_view,
            host_save,
            host_start,
            host_stop,
            host_delete
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // The main window is the app: once it is closed the app quits. The characters over other apps or the
        // remote-control banner would otherwise keep it running with no window to come back to, and a second
        // launch would only hand over to it.
        if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event
            && label == "main"
        {
            app.exit(0);
        }
        if let tauri::RunEvent::Exit = event {
            // Friends' pads come out of this PC with the app.
            app.state::<pads::Pads>().stop_all();
            // Stop our server gracefully so it closes the router ports it opened.
            let port = host_dir(app)
                .ok()
                .and_then(|dir| host::read_config(&dir).ok().flatten())
                .map(|c| c.api_port);
            if let Some(port) = port {
                let process = app.state::<HostProcess>();
                tauri::async_runtime::block_on(process.stop(port)).ok();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_window_starts_its_webview_with_the_same_args_and_av1_on_the_video_card() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["additionalBrowserArgs"], super::BROWSER_ARGS, "the main window");
        assert!(super::BROWSER_ARGS.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"), "wry's own defaults stay");
        assert!(super::BROWSER_ARGS.contains("WebRtcAV1HWEncode"));
    }

    #[test]
    fn the_whole_app_carries_one_version() {
        let package: serde_json::Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"), "scripts/bump-version.ps1 sets both");
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config.get("version").is_none(), "without a version of its own, Tauri takes the one in Cargo.toml");
    }

    use std::path::PathBuf;

    use super::*;

    #[test]
    fn profile_dir_is_used_only_in_debug() {
        let base = PathBuf::from("data");
        // A debug build started with a profile keeps everything under its own folder...
        assert_eq!(profile_dir(&base, true, Some("a")), base.join("profiles").join("a"));
        assert_eq!(profile_dir(&base, true, Some("test-2")), base.join("profiles").join("test-2"));
        // ...a release build never looks at the variable, so an installed copy cannot be pointed elsewhere.
        assert_eq!(profile_dir(&base, false, Some("a")), base);
        // No profile, no change.
        assert_eq!(profile_dir(&base, true, None), base);
        assert_eq!(profile_dir(&base, false, None), base);
    }

    #[test]
    fn profile_names_are_short_and_plain() {
        let base = PathBuf::from("data");
        for good in ["a", "b", "0", "a-b", "test-2", "abcdefghijklmnop"] {
            assert_eq!(profile_dir(&base, true, Some(good)), base.join("profiles").join(good), "{good}");
        }
        // Anything that could leave the profiles folder, or is not a plain lowercase name, is ignored.
        for bad in ["", "A", "a b", "a_b", "a.b", "..", "../x", "a/b", r"a\b", "C:", "а", "abcdefghijklmnopq"] {
            assert_eq!(profile_dir(&base, true, Some(bad)), base, "{bad:?}");
        }
    }

    #[test]
    fn the_app_page_gets_the_microphone_and_the_camera_without_a_prompt() {
        use tauri::webview::PermissionKind::*;
        use tauri::webview::PermissionResponse::{Allow, Default};
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = url("http://localhost:1420/");
        // The installed window's own page, and the dev server of a debug build.
        assert_eq!(permission_answer(Microphone, &url("http://tauri.localhost/"), None), Allow);
        assert_eq!(permission_answer(Microphone, &url("https://tauri.localhost/index.html?x=1"), None), Allow);
        assert_eq!(permission_answer(Microphone, &url("http://localhost:1420/settings"), Some(&dev)), Allow);
        // Any other page, or the dev address in a build without one, asks the usual way.
        for page in ["http://localhost:1420/", "https://tauri.localhost.example.com/", "http://tauri.localhost:8080/", "https://example.com/"] {
            assert_eq!(permission_answer(Microphone, &url(page), None), Default, "{page}");
        }
        assert_eq!(permission_answer(Microphone, &url("http://localhost:1421/"), Some(&dev)), Default);
        assert_eq!(permission_answer(Camera, &url("http://tauri.localhost/"), None), Allow);
        assert_eq!(permission_answer(Camera, &url("https://example.com/"), Some(&dev)), Default);
        // Only the microphone and the camera: nothing else is granted, and nothing is refused for good.
        for kind in [DisplayCapture, Geolocation, Notifications, ClipboardRead, Other] {
            assert_eq!(permission_answer(kind, &url("http://tauri.localhost/"), Some(&dev)), Default, "{kind}");
        }
    }

    #[test]
    fn a_phone_answers_by_the_webview_alone_without_asking_it_anything() {
        use tauri::webview::PermissionKind::*;
        use tauri::webview::PermissionResponse::{Allow, Default};
        assert_eq!(phone_permission_answer(Microphone, "main"), Allow);
        assert_eq!(phone_permission_answer(Camera, "main"), Allow);
        // Anything else goes Android's usual way; another webview, were there one, too.
        for kind in [DisplayCapture, Geolocation, Notifications, ClipboardRead, Other] {
            assert_eq!(phone_permission_answer(kind, "main"), Default, "{kind}");
        }
        assert_eq!(phone_permission_answer(Microphone, crate::watch_browser::LABEL), Default);
    }

    #[test]
    fn only_the_programs_own_page_reads_its_media() {
        assert!(may_read_media("main"));
        assert!(may_read_media("overlay"));
        assert!(may_read_media("remote-banner"));
        assert!(!may_read_media(crate::watch_browser::LABEL), "a site in the watch window");
        assert!(!may_read_media("anything-else"));
        let dev = tauri::Url::parse("http://localhost:1420/").unwrap();
        assert!(is_own_origin("http://tauri.localhost", None));
        assert!(is_own_origin("http://localhost:1420", Some(&dev)));
        for other in ["https://evil.example", "http://tauri.localhost.evil.example", "http://localhost:1420", "null", "*"] {
            assert!(!is_own_origin(other, None), "{other}");
        }
    }

    #[test]
    fn a_profile_gets_its_own_window_data_and_no_single_instance() {
        let base = PathBuf::from("data");
        assert_eq!(webview_dir(&base, true, Some("a")), Some(base.join("profiles").join("a").join("webview")));
        assert_eq!(webview_dir(&base, false, Some("a")), None);
        assert_eq!(webview_dir(&base, true, Some("A")), None);
        assert_eq!(webview_dir(&base, true, None), None);

        // Two copies of one program must be allowed to run: only a profile switches the guard off.
        assert!(!single_instance(true, Some("a")));
        assert!(single_instance(false, Some("a")));
        assert!(single_instance(true, Some("bad name")));
        assert!(single_instance(true, None));
    }
}
