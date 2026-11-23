package com.hatavoice.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.PointF
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot

/**
 * «Управление с ПК»: the hands of the friend we let control this phone in a call. Android lets no app put touches in but
 * an accessibility service the person turned on in the settings; this one acts only on what the page hands it (`Native`
 * op `control`), which Rust checked first: from the one let in, newer than the last, of a kind allowed. A click is a tap
 * where the friend's pointer is, a drag a swipe along its way, the wheel a short swipe, the right button and Escape are
 * Back, Win is Home; text goes into the field the cursor is in. It reads the screen only to find that field.
 */
class ControlService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: ControlService? = null
            private set

        /** The page's word: what the friend did, if the service is on; otherwise the page hears that it is off. */
        fun play(input: JSONObject) {
            val service = instance
            if (service == null) {
                Native.send(JSONObject().put("ev", "control").put("ready", false))
                return
            }
            service.main.post { service.handle(input) }
        }

        /** Control ended: nothing stays half done (a held finger). */
        fun reset() {
            instance?.let { s -> s.main.post { s.stroke = null } }
        }
    }

    private val main by lazy { android.os.Handler(mainLooper) }
    /** Letters waiting for the field (where there is no keyboard connection): typed fast, they go in together. */
    private val pending = StringBuilder()
    private val flushPending = Runnable { flush() }
    /** Where the friend's pointer is, in this screen's pixels. */
    private var at = PointF(0f, 0f)
    /** The finger held down: its way so far, and when it came down. */
    private var stroke: MutableList<PointF>? = null
    private var downAt = 0L

    override fun onServiceConnected() {
        instance = this
        Native.send(JSONObject().put("ev", "control").put("ready", true))
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        Native.send(JSONObject().put("ev", "control").put("ready", false))
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    /** The whole screen as a shared screen shows it (bars too), in pixels. */
    private fun screen(): Pair<Float, Float> {
        val wm = getSystemService(WindowManager::class.java)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.currentWindowMetrics.bounds
            Pair(b.width().toFloat(), b.height().toFloat())
        } else {
            val m = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(m)
            Pair(m.widthPixels.toFloat(), m.heightPixels.toFloat())
        }
    }

    private fun handle(input: JSONObject) {
        when (input.optString("t")) {
            "move" -> {
                val (w, h) = screen()
                at = PointF((input.optDouble("x", 0.0) / 65535.0 * w).toFloat().coerceIn(0f, w - 1), (input.optDouble("y", 0.0) / 65535.0 * h).toFloat().coerceIn(0f, h - 1))
                stroke?.let { if (it.size < 400) it.add(PointF(at.x, at.y)) }
            }
            "button" -> {
                val down = input.optBoolean("down")
                when (input.optString("b")) {
                    "left" -> if (down) {
                        stroke = mutableListOf(PointF(at.x, at.y))
                        downAt = SystemClock.uptimeMillis()
                    } else {
                        finishStroke()
                    }
                    "right" -> if (down) performGlobalAction(GLOBAL_ACTION_BACK)
                    "middle" -> if (down) performGlobalAction(GLOBAL_ACTION_HOME)
                }
            }
            "wheel" -> {
                val dy = input.optInt("dy", 0)
                if (dy != 0) swipeBy(dy)
            }
            "key" -> if (input.optBoolean("down")) key(input.optString("code"))
            "text" -> type(input.optString("s"))
        }
    }

    /** The finger lifted: a tap where it came down, or a swipe along its way, as long as it was held. */
    private fun finishStroke() {
        val points = stroke ?: return
        stroke = null
        val held = (SystemClock.uptimeMillis() - downAt).coerceIn(40L, 10_000L)
        val first = points.first()
        val far = points.maxOf { hypot(it.x - first.x, it.y - first.y) }
        val path = Path().apply { moveTo(first.x, first.y) }
        if (far < 12f) {
            // A tap, or a long press when held (a menu, a selection).
            path.lineTo(first.x + 1f, first.y + 1f)
        } else {
            // At most some sixty points along the way: enough for its shape.
            val step = maxOf(1, points.size / 60)
            for (i in step until points.size step step) path.lineTo(points[i].x, points[i].y)
            path.lineTo(points.last().x, points.last().y)
        }
        val duration = if (far < 12f && held < 400) 50L else held
        gesture(path, duration)
    }

    /** The wheel: a short swipe where the pointer is, the page following the wheel as it does on a PC. */
    private fun swipeBy(dy: Int) {
        val (_, h) = screen()
        val distance = (dy / 120f * h * 0.18f).coerceIn(-h * 0.6f, h * 0.6f)
        val toY = (at.y + distance).coerceIn(1f, h - 1)
        if (abs(toY - at.y) < 4f) return
        val path = Path().apply {
            moveTo(at.x, at.y)
            lineTo(at.x, toY)
        }
        gesture(path, 180L)
    }

    private fun gesture(path: Path, duration: Long) {
        try {
            dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build(), null, null)
        } catch (e: RuntimeException) {
            // A path Android would not take (empty, too long): nothing happens, nothing breaks.
        }
    }

    private fun key(code: String) {
        // Letters still waiting go first: a Backspace or an Enter is meant after them.
        flush()
        when (code) {
            "Escape", "BrowserBack", "AndroidBack" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "MetaLeft", "MetaRight", "BrowserHome", "AndroidHome" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "AndroidRecents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "Backspace" -> if (!pressKey(KeyEvent.KEYCODE_DEL)) {
                edit { text -> if (text.isEmpty()) text else text.substring(0, text.offsetByCodePoints(text.length, -1)) }
            }
            "Enter", "NumpadEnter" -> enter()
        }
    }

    /**
     * Android 13+: the keyboard connection to the field the cursor is in (the service is an input method too, see
     * control_service.xml). Letters go in at the cursor as from a keyboard, with nothing read back.
     */
    private fun keyboard(): android.accessibilityservice.InputMethod.AccessibilityInputConnection? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
        return inputMethod?.currentInputConnection
    }

    /** A key pressed and let go through the keyboard connection; false where there is none. */
    private fun pressKey(code: Int): Boolean {
        val connection = keyboard() ?: return false
        val at = SystemClock.uptimeMillis()
        connection.sendKeyEvent(KeyEvent(at, at, KeyEvent.ACTION_DOWN, code, 0))
        connection.sendKeyEvent(KeyEvent(at, at, KeyEvent.ACTION_UP, code, 0))
        return true
    }

    /** The field the cursor is in, if it takes text. */
    private fun field(): AccessibilityNodeInfo? {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        return if (node.isEditable) node else null
    }

    /** Its text as typed (not the grey hint an empty field shows). */
    private fun typed(node: AccessibilityNodeInfo): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText) return ""
        return node.text?.toString() ?: ""
    }

    /**
     * The field's text changed by `change`. Read afresh first: the service's cache keeps a field's text until a text
     * event it does not listen to, so a letter typed quickly after another was added to the old text and replaced it.
     */
    private fun edit(change: (String) -> String) {
        val node = field() ?: return
        node.refresh()
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, change(typed(node))) }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun type(text: String) {
        if (text.isEmpty() || text.length > 256) return
        val connection = keyboard()
        if (connection != null) {
            flush()
            connection.commitText(text, 1, null)
            return
        }
        // No keyboard connection: letters typed close together go in as one change.
        pending.append(text)
        main.removeCallbacks(flushPending)
        main.postDelayed(flushPending, 30L)
    }

    private fun flush() {
        main.removeCallbacks(flushPending)
        if (pending.isEmpty()) return
        val letters = pending.toString()
        pending.setLength(0)
        edit { it + letters }
    }

    /** Enter: the keyboard's own «send» or «next» where Android has it, a new line otherwise. */
    private fun enter() {
        if (pressKey(KeyEvent.KEYCODE_ENTER)) return
        val node = field() ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) return
        edit { it + "\n" }
    }
}
