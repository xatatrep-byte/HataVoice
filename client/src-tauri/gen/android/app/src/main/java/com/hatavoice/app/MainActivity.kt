package com.hatavoice.app

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.KeyEvent
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import android.content.Intent
import org.json.JSONObject

class MainActivity : TauriActivity() {
    private lateinit var screenAsk: ActivityResultLauncher<Intent>
    private var webView: WebView? = null
    /** The page allows the small window over other apps now (a call is on). */
    private var pipAllowed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Android's own question «start recording or casting?»; its answer goes to the call's service.
        screenAsk = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode == RESULT_OK && data != null) {
                CallService.screen(this, result.resultCode, data)
            } else {
                Native.pendingScreen = null
                Native.send(JSONObject().put("ev", "screen").put("state", "denied"))
            }
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        this.webView = webView
        Native.attach(this, webView)
        // The call's page stays important to Android while another app is in front or the screen is off.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        // The window draws edge to edge (Android 15 and later insist), so the keyboard comes up over the page instead of
        // making it shorter: the chat's field at the bottom would be under it. The page gets shorter by the keyboard's
        // height instead, and lays itself out above it.
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, keyboard)
            insets
        }
    }

    fun askScreen() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        screenAsk.launch(manager.createScreenCaptureIntent())
    }

    private fun pipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        val builder = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 10))
        // From Android 12 the small window comes by itself when the person goes home during a call.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(pipAllowed).setSeamlessResizeEnabled(true)
        return builder.build()
    }

    /** Some phones (Android Go, some cheap ones) have no small windows at all: then there is none, and nothing breaks. */
    private fun pipAvailable(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    fun setPip(allowed: Boolean) {
        pipAllowed = allowed && pipAvailable()
        if (!pipAvailable()) return
        try {
            pipParams()?.let { setPictureInPictureParams(it) }
        } catch (e: RuntimeException) {
            pipAllowed = false
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (pipAllowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try {
                pipParams()?.let { enterPictureInPictureMode(it) }
            } catch (e: RuntimeException) {
                // Refused by the system (another app in a small window, a setting): the call goes on in the background.
            }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        Native.send(JSONObject().put("ev", "pip").put("on", isInPictureInPictureMode))
    }

    override fun onPause() {
        super.onPause()
        // A paused WebView stops drawing; in the small window it is still seen, so it goes on.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode) webView?.onResume()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (Keys.handle(event)) return true
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        Native.detach(this)
        super.onDestroy()
    }
}
