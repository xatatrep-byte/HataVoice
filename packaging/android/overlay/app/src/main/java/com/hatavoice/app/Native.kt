package com.hatavoice.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.KeyEvent
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger

/**
 * What the program's own page may ask of Android, and what Android tells it back. The page reaches it as `HataNative`,
 * an object WebView puts only into frames of the program's own origin: a site in a player frame (YouTube and the like)
 * never sees it. Every request is a small JSON word; pictures and sound of a shared screen come back as raw bytes.
 */
object Native {
    private val ORIGINS = setOf("http://tauri.localhost", "https://tauri.localhost")
    /** Frames on their way to the page at most: an older one is dropped rather than late. */
    private const val MAX_FRAMES_IN_FLIGHT = 2

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var reply: JavaScriptReplyProxy? = null
    private var binary = false
    private val framesInFlight = AtomicInteger(0)
    private var activity = WeakReference<MainActivity>(null)
    lateinit var app: Context
        private set

    /** The screen the page asked for, kept until Android's own question is answered. */
    var pendingScreen: ScreenCapture.Wish? = null

    fun attach(activity: MainActivity, webView: WebView) {
        app = activity.applicationContext
        this.activity = WeakReference(activity)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        binary = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        WebViewCompat.addWebMessageListener(webView, "HataNative", ORIGINS) { _, message, _, isMainFrame, replyProxy ->
            if (!isMainFrame) return@addWebMessageListener
            reply = replyProxy
            val text = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
            if (text != null && text.length < 4096) {
                try {
                    handle(JSONObject(text))
                } catch (e: Exception) {
                    send(JSONObject().put("ev", "error").put("why", e.message ?: e.javaClass.simpleName))
                }
            }
        }
    }

    fun detach(activity: MainActivity) {
        if (this.activity.get() === activity) this.activity = WeakReference(null)
    }

    /** A word to the page (from any thread). */
    fun send(word: JSONObject) {
        main.post { reply?.postMessage(word.toString()) }
    }

    /** The main thread comes first while the screen is shown (the frames go to the page through it), or as it was. */
    fun boostMain(on: Boolean) {
        main.post {
            try {
                android.os.Process.setThreadPriority(if (on) android.os.Process.THREAD_PRIORITY_DISPLAY else android.os.Process.THREAD_PRIORITY_DEFAULT)
            } catch (e: Exception) {
                // Not allowed here: it stays as it was.
            }
        }
    }

    /** The page is still busy with the frames before: a new one would only wait. */
    fun framesBusy(): Boolean = framesInFlight.get() >= MAX_FRAMES_IN_FLIGHT

    /** A frame of the screen to the page; false when the page is still busy with the ones before (this one is dropped). */
    fun sendFrame(bytes: ByteArray): Boolean {
        if (framesInFlight.get() >= MAX_FRAMES_IN_FLIGHT) return false
        framesInFlight.incrementAndGet()
        main.post {
            try {
                postBytes(bytes)
            } finally {
                framesInFlight.decrementAndGet()
            }
        }
        return true
    }

    /** Sound of the screen to the page: never dropped, it is small and a gap is heard. */
    fun sendSound(bytes: ByteArray) {
        main.post { postBytes(bytes) }
    }

    private fun postBytes(bytes: ByteArray) {
        val proxy = reply ?: return
        if (binary) {
            proxy.postMessage(bytes)
        } else {
            // An older WebView takes only text: the same bytes in base64 (slower, but it works).
            proxy.postMessage(JSONObject().put("ev", "bin").put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString())
        }
    }

    private fun handle(word: JSONObject) {
        when (word.optString("op")) {
            "hello" -> send(hello())
            "call" -> {
                CallService.state.call = word.optBoolean("on")
                CallService.state.camera = word.optBoolean("camera")
                CallService.update(app)
            }
            "server" -> {
                CallService.state.hosting = word.optBoolean("on")
                CallService.update(app)
            }
            "online" -> {
                CallService.state.online = word.optBoolean("on")
                CallService.update(app)
            }
            "screen-start" -> {
                val wish = ScreenCapture.Wish(
                    box = Pair(word.optInt("width", 1280), word.optInt("height", 720)),
                    fps = word.optInt("fps", 30),
                    sound = word.optBoolean("audio"),
                )
                if (ScreenCapture.running) {
                    ScreenCapture.tune(wish.box, wish.fps)
                    ScreenCapture.report()
                } else {
                    pendingScreen = wish
                    activity.get()?.askScreen() ?: send(JSONObject().put("ev", "screen").put("state", "error").put("why", "Окно программы закрыто"))
                }
            }
            "screen-tune" -> ScreenCapture.tune(Pair(word.optInt("width", 1280), word.optInt("height", 720)), word.optInt("fps", 30))
            "screen-stop" -> ScreenCapture.stop()
            "keys" -> {
                // Either part may come alone: picking a new key does not drop the one held for push-to-talk.
                word.optJSONArray("watch")?.let { list ->
                    Keys.watched = (0 until list.length()).map { list.optString(it) }.filter { it.startsWith("KEYCODE_") }.toSet()
                }
                if (word.has("capture")) Keys.capture = word.optBoolean("capture")
            }
            "pip" -> activity.get()?.setPip(word.optBoolean("allowed"))
            "fullscreen" -> activity.get()?.setFullscreen(word.optBoolean("on"), word.optBoolean("landscape", true))
            // A friend's input, already checked by Rust (theirs, newer than the last, allowed).
            "control" -> word.optJSONObject("input")?.let { ControlService.play(it) }
            "control-end" -> ControlService.reset()
            "control-status" -> send(JSONObject().put("ev", "control").put("ready", ControlService.instance != null))
            // Android's own page where the person turns the service on: an app may not do it itself.
            "control-settings" -> {
                val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    (activity.get() ?: app).startActivity(intent)
                } catch (e: RuntimeException) {
                    send(JSONObject().put("ev", "control").put("ready", false).put("why", "Не открылись настройки специальных возможностей"))
                }
            }
            // This app's own page: Android 13+ allows an accessibility service of an app installed from a file only after
            // «Разрешить ограниченные настройки» there.
            "app-settings" -> {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package", app.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    (activity.get() ?: app).startActivity(intent)
                } catch (e: RuntimeException) {
                    // No such page on this phone: the person finds the app in the settings.
                }
            }
            "route" -> {
                AudioRoute.set(app, word.optString("to", "auto"))
                send(AudioRoute.describe(app))
            }
            "routes" -> send(AudioRoute.describe(app))
            // «Любой сайт»: the address was checked by Rust; WatchActivity checks it again.
            "watch-open" -> activity.get()?.let { WatchActivity.start(it, word.optString("url")) }
            "watch-command" -> WatchActivity.command(word)
            "watch-focus" -> activity.get()?.let { WatchActivity.focus(it) }
            "watch-close" -> WatchActivity.close()
            "install-update" -> installUpdate()
        }
    }

    /**
     * An update from the friend's server, already checked by Rust (the publisher's seal, the version, the bytes): Android's
     * own installer takes it, checks that it is signed by the same key as this app, and asks the person.
     */
    private fun installUpdate() {
        val file = java.io.File(app.cacheDir, "updates/HataVoice-update.apk")
        if (!file.isFile) {
            send(JSONObject().put("ev", "update").put("state", "missing"))
            return
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(app, app.packageName + ".fileprovider", file)
        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            (activity.get() ?: app).startActivity(intent)
        } catch (e: Exception) {
            send(JSONObject().put("ev", "update").put("state", "error").put("why", e.message ?: "Android не открыл установщик"))
        }
    }

    private fun hello(): JSONObject {
        val features = JSONObject()
            .put("screen", true)
            // Other apps' sound comes with the screen from Android 10 on.
            .put("screenAudio", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            .put("pip", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            .put("binary", binary)
            // «Управление с ПК»: whether its accessibility service is turned on.
            .put("control", ControlService.instance != null)
        return JSONObject().put("ev", "hello").put("sdk", Build.VERSION.SDK_INT).put("features", features)
    }

    fun granted(permission: String): Boolean = app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    fun mayRecord(): Boolean = granted(Manifest.permission.RECORD_AUDIO)
    fun mayFilm(): Boolean = granted(Manifest.permission.CAMERA)
}

/** The keys of the phone (volume, a headset's, a keyboard's) the page listens to for push-to-talk while in front. */
object Keys {
    @Volatile var watched: Set<String> = emptySet()
    @Volatile var capture = false

    /** The phone's own way back, home and power never go to the page. */
    private val SYSTEM = setOf(KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_POWER)

    /** Whether the page took the key: then nothing else does with it (the volume stays as it was). */
    fun handle(event: KeyEvent): Boolean {
        if (event.keyCode in SYSTEM) return false
        val name = KeyEvent.keyCodeToString(event.keyCode)
        if (capture && event.action == KeyEvent.ACTION_DOWN) {
            capture = false
            Native.send(JSONObject().put("ev", "key-captured").put("key", name))
            return true
        }
        if (name !in watched) return false
        if (event.repeatCount == 0 && (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP)) {
            Native.send(JSONObject().put("ev", "key").put("key", name).put("down", event.action == KeyEvent.ACTION_DOWN))
        }
        return true
    }
}

/** Where the call is heard: the earpiece, the loudspeaker, a wired or Bluetooth headset. */
object AudioRoute {
    private fun kindOf(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
    }

    private var wanted = "auto"

    fun describe(context: Context): JSONObject {
        val am = context.getSystemService(AudioManager::class.java)
        val available = JSONArray()
        var now = "auto"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.availableCommunicationDevices.mapNotNull { kindOf(it.type) }.distinct().forEach { available.put(it) }
            now = am.communicationDevice?.let { kindOf(it.type) } ?: "auto"
        } else {
            available.put("earpiece").put("speaker")
            @Suppress("DEPRECATION")
            if (am.isWiredHeadsetOn) available.put("wired")
            @Suppress("DEPRECATION")
            if (am.isBluetoothScoAvailableOffCall) available.put("bluetooth")
            @Suppress("DEPRECATION")
            now = when {
                am.isBluetoothScoOn -> "bluetooth"
                am.isSpeakerphoneOn -> "speaker"
                else -> wanted
            }
        }
        return JSONObject().put("ev", "route").put("now", now).put("wanted", wanted).put("available", available)
    }

    fun set(context: Context, to: String) {
        wanted = to
        val am = context.getSystemService(AudioManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (to == "auto") {
                am.clearCommunicationDevice()
                return
            }
            val device = am.availableCommunicationDevices.firstOrNull { kindOf(it.type) == to } ?: return
            am.setCommunicationDevice(device)
        } else {
            @Suppress("DEPRECATION")
            when (to) {
                "speaker" -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false; am.isSpeakerphoneOn = true }
                "bluetooth" -> { am.isSpeakerphoneOn = false; am.startBluetoothSco(); am.isBluetoothScoOn = true }
                "earpiece", "wired" -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false; am.isSpeakerphoneOn = false }
                else -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false }
            }
        }
    }
}
