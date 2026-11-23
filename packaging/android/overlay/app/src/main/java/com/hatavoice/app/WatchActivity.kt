package com.hatavoice.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.net.InetAddress

/**
 * «Любой сайт» in watch-together on a phone: the site in a window of its own, as on a PC, where the person picks the
 * player and the dub. The same small script as on a PC (watch_agent.js) goes into each of its frames, finds the video,
 * reports it through the page's title and obeys play, pause and seek. Nothing of the program is reachable from here:
 * no bridge, every permission refused, no new windows, only plain sites on the internet.
 */
class WatchActivity : AppCompatActivity() {
    companion object {
        /** What the agent puts before its word in the page's title. */
        private const val MARK = "⁣HV⁣"
        private var open = WeakReference<WatchActivity>(null)

        /** Plain sites on the internet only: never this phone, the home network, or another scheme. */
        fun mayOpen(address: String): Boolean {
            val uri = Uri.parse(address)
            if (uri.scheme != "http" && uri.scheme != "https" || address.length > 2000) return false
            val host = (uri.host ?: return false).lowercase().trimEnd('.')
            if (!host.contains('.') && !host.contains(':')) return false
            val local = listOf(".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".home.arpa")
            if (host == "localhost" || local.any { host.endsWith(it) }) return false
            val literal = host.trim('[', ']')
            val isIp = literal.all { it.isDigit() || it == '.' } || literal.contains(':')
            if (!isIp) return true
            return try {
                val ip = InetAddress.getByName(literal)
                val b = ip.address
                val cgnat = b.size == 4 && (b[0].toInt() and 0xFF) == 100 && (b[1].toInt() and 0xFF) in 64..127
                !(ip.isLoopbackAddress || ip.isSiteLocalAddress || ip.isLinkLocalAddress || ip.isAnyLocalAddress || ip.isMulticastAddress || cgnat ||
                    (b.size == 16 && (b[0].toInt() and 0xFE) == 0xFC))
            } catch (e: Exception) {
                false
            }
        }

        fun start(from: Activity, address: String) {
            if (!mayOpen(address)) return
            open.get()?.let {
                it.web?.loadUrl(address)
                from.startActivity(Intent(from, WatchActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                return
            }
            from.startActivity(Intent(from, WatchActivity::class.java).putExtra("url", address).addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION))
        }

        /** The kinds of a page's choices the program may ask for (as watch_browser.rs). */
        private val CHOICE_KINDS = setOf("players", "season", "episode", "dub")

        fun command(word: JSONObject) {
            val activity = open.get() ?: return
            val web = activity.web ?: return
            val script = when (val op = word.optString("command")) {
                "play", "pause" -> "window.__hvWatch && window.__hvWatch.command(${JSONObject().put("op", op)})"
                "seek" -> {
                    val ms = word.optDouble("ms", -1.0)
                    if (!ms.isFinite() || ms < 0) return
                    "window.__hvWatch && window.__hvWatch.command(${JSONObject().put("op", "seek").put("ms", minOf(ms, 7.0 * 24 * 3600 * 1000))})"
                }
                // Catching up with everyone: the speed, kept between 0.5 and 2.
                "rate" -> {
                    val rate = word.optDouble("ms", 1.0)
                    if (!rate.isFinite()) return
                    "window.__hvWatch && window.__hvWatch.command(${JSONObject().put("op", "rate").put("rate", rate.coerceIn(0.5, 2.0))})"
                }
                // One of the page's choices (its player, the player's season, episode or dub), by the item's words.
                "choose" -> {
                    val kind = word.optString("kind")
                    val label = word.optString("label")
                    if (kind !in CHOICE_KINDS || label.isEmpty() || label.length > 60) return
                    "window.__hvWatch && window.__hvWatch.command(${JSONObject().put("op", "choose").put("kind", kind).put("label", label)})"
                }
                "theater" -> "window.__hvWatch && window.__hvWatch.command(${JSONObject().put("op", "theater").put("on", word.optBoolean("on", true))})"
                "back" -> "history.back()"
                "forward" -> "history.forward()"
                "reload" -> "location.reload()"
                else -> return
            }
            web.evaluateJavascript(script, null)
        }

        fun focus(from: Activity) {
            if (open.get() != null) from.startActivity(Intent(from, WatchActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        }

        fun close() {
            open.get()?.finish()
        }
    }

    private var web: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        open = WeakReference(this)
        val view = WebView(this)
        web = view
        setContentView(view)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        // The call starts and stops the video for everyone: no tap needed for that.
        view.settings.mediaPlaybackRequiresUserGesture = false
        view.settings.setSupportMultipleWindows(false)
        view.settings.javaScriptCanOpenWindowsAutomatically = false
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        val agent = try {
            assets.open("watch_agent.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        }
        if (agent != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, agent, setOf("*"))
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !mayOpen(request.url.toString())

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // Without document-start scripts (an old WebView) the agent comes as soon as the page starts.
                if (agent != null && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(agent, null)
            }

            override fun onPageFinished(view: WebView, url: String) {
                Native.send(JSONObject().put("ev", "watch-url").put("url", url))
                // The player alone over the whole screen: the site around it (and its adverts) would only be in the way.
                view.evaluateJavascript("window.__hvWatch && window.__hvWatch.command({\"op\":\"theater\",\"on\":true})", null)
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }

            override fun onReceivedTitle(view: WebView, title: String?) {
                val text = title ?: return
                if (!text.startsWith(MARK) || text.length > 4096) return
                val word = try {
                    JSONObject(text.removePrefix(MARK))
                } catch (e: Exception) {
                    return
                }
                Native.send(JSONObject().put("ev", "watch-agent").put("word", word))
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (view.canGoBack()) view.goBack() else finish()
            }
        })
        intent.getStringExtra("url")?.takeIf { mayOpen(it) }?.let { view.loadUrl(it) } ?: finish()
    }

    override fun onDestroy() {
        if (open.get() === this) open = WeakReference(null)
        web?.destroy()
        web = null
        Native.send(JSONObject().put("ev", "watch-closed"))
        super.onDestroy()
    }
}
