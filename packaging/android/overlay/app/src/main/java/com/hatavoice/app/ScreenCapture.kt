package com.hatavoice.app

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.Display
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The phone's screen for a call: Android's MediaProjection draws it into a virtual display of the size asked for (the
 * system shrinks it on the video card), each new picture becomes an I420 frame and goes to the page, which makes a video
 * track of it and sends it encrypted with the call's keys, as on a PC. Other apps' sound comes along from Android 10 on
 * (AudioPlaybackCapture): only what apps allow to be captured, never this app's own (the call's voices do not go back).
 *
 * A packet to the page starts with four little-endian ints: kind (1 picture, 2 sound), then for a picture its width,
 * height and 0, for sound its frames, rate and channels.
 */
object ScreenCapture {
    data class Wish(val box: Pair<Int, Int>, val fps: Int, val sound: Boolean)

    const val KIND_PICTURE = 1
    const val KIND_SOUND = 2
    private const val HEADER = 16
    private const val RATE = 48000
    private const val CHANNELS = 2
    /** 20 ms of sound a packet. */
    private const val SOUND_FRAMES = 960

    @Volatile var running = false
        private set
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var sound: SoundThread? = null
    private var displays: DisplayManager? = null
    private var box = Pair(1280, 720)
    @Volatile private var fps = 30
    private var size = Pair(0, 0)
    private var dpi = 160
    private var lastAt = 0L
    private var soundWhy: String? = null
    private var buffer = ByteArray(0)

    /**
     * How much of the size asked for is captured now. While the phone is touched Android gives its CPU to the app in
     * front and holds this one back: the frames could not get to the page in time and the picture fell to 4–10 a
     * second. Then the picture gets smaller a step at a time (fewer bytes to carry), and grows back once they keep up.
     */
    private val SCALES = doubleArrayOf(1.0, 0.75, 0.56)
    @Volatile private var step = 0
    /** Frames that were due (the screen changed and their time came) and those that got to the page, this second. */
    private var due = 0
    private var sent = 0
    private var countFrom = 0L
    private var slowSeconds = 0
    private var goodSeconds = 0

    /** The size to capture: the screen's own proportions, no bigger than the box asked for (either way round). */
    fun fit(screenWidth: Int, screenHeight: Int, box: Pair<Int, Int>): Pair<Int, Int> {
        val long = maxOf(screenWidth, screenHeight).toDouble()
        val short = minOf(screenWidth, screenHeight).toDouble()
        val boxLong = maxOf(box.first, box.second).toDouble()
        val boxShort = minOf(box.first, box.second).toDouble()
        val scale = minOf(1.0, boxLong / long, boxShort / short)
        fun even(v: Double) = maxOf(2, (v * scale).toInt() and 1.inv())
        return Pair(even(screenWidth.toDouble()), even(screenHeight.toDouble()))
    }

    private fun screen(context: Context): DisplayMetrics {
        val metrics = DisplayMetrics()
        val manager = context.getSystemService(DisplayManager::class.java)
        @Suppress("DEPRECATION")
        manager.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        return metrics
    }

    /** Starts it with Android's yes (`code`, `data`): called by the call's service once it runs as a screen one. */
    fun begin(context: Context, code: Int, data: Intent, wish: Wish) {
        stop(quiet = true)
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        val made = try {
            manager.getMediaProjection(code, data)
        } catch (e: Exception) {
            null
        }
        if (made == null) {
            Native.send(JSONObject().put("ev", "screen").put("state", "error").put("why", "Android не дал экран"))
            CallService.state.sharing = false
            CallService.update(context)
            return
        }
        val worker = HandlerThread("hv-screen", Process.THREAD_PRIORITY_DISPLAY).also { it.start() }
        step = 0
        // The frames go to the page through the app's main thread: while the screen is shown it comes first.
        Native.boostMain(true)
        val on = Handler(worker.looper)
        thread = worker
        handler = on
        projection = made
        box = wish.box
        fps = wish.fps.coerceIn(5, 60)
        // Android 14 wants to be told before the display is made; the person may stop it from the status bar too.
        made.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                stop()
            }
        }, on)
        val metrics = screen(context)
        dpi = metrics.densityDpi
        size = fit(metrics.widthPixels, metrics.heightPixels, box)
        val first = newReader(size, on)
        reader = first
        display = made.createVirtualDisplay("HataVoice", size.first, size.second, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, first.surface, null, on)
        running = true
        // The phone turned: the picture follows, the right way up.
        val manager2 = context.getSystemService(DisplayManager::class.java)
        displays = manager2
        manager2.registerDisplayListener(turned, on)
        soundWhy = null
        if (wish.sound) startSound(made)
        report()
    }

    private val turned = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) resize()
        }
    }

    private fun resize() {
        val on = handler ?: return
        val virtual = display ?: return
        val metrics = screen(Native.app)
        val scale = SCALES[step]
        val next = fit(metrics.widthPixels, metrics.heightPixels, Pair((box.first * scale).toInt(), (box.second * scale).toInt()))
        if (next == size) return
        size = next
        val old = reader
        val fresh = newReader(next, on)
        reader = fresh
        virtual.resize(next.first, next.second, dpi)
        virtual.surface = fresh.surface
        old?.close()
        report()
    }

    /** A new size or frame rate while it runs (another quality picked, or someone drives the PC we watch). */
    fun tune(box: Pair<Int, Int>, fps: Int) {
        this.fps = fps.coerceIn(5, 60)
        this.box = box
        step = 0
        handler?.post { resize() }
    }

    /**
     * Once a second: too few frames getting through two seconds running — a step smaller; all of them for six seconds
     * while the screen moves — a step bigger again.
     */
    private fun adapt(now: Long) {
        if (countFrom == 0L) countFrom = now
        if (now - countFrom < 1000L) return
        val moving = due >= fps / 2
        val share = if (due == 0) 1.0 else sent.toDouble() / due
        due = 0
        sent = 0
        countFrom = now
        if (moving && share < 0.6) {
            goodSeconds = 0
            if (++slowSeconds >= 2 && step < SCALES.size - 1) {
                step++
                slowSeconds = 0
                // After this frame is done with: a new reader closes the one this frame came from.
                handler?.post { resize() }
            }
        } else {
            slowSeconds = 0
            if (moving && share >= 0.95) goodSeconds++
            if (goodSeconds >= 6 && step > 0) {
                step--
                goodSeconds = 0
                // After this frame is done with: a new reader closes the one this frame came from.
                handler?.post { resize() }
            }
        }
    }

    /** Tells the page how it goes now. */
    fun report() {
        val word = JSONObject().put("ev", "screen").put("state", if (running) "on" else "off")
        if (running) {
            word.put("width", size.first).put("height", size.second).put("audio", sound != null)
            soundWhy?.let { word.put("audioWhy", it) }
        }
        Native.send(word)
    }

    private fun newReader(size: Pair<Int, Int>, on: Handler): ImageReader {
        val made = ImageReader.newInstance(size.first, size.second, PixelFormat.RGBA_8888, 3)
        made.setOnImageAvailableListener({ r ->
            val image = try {
                r.acquireLatestImage()
            } catch (e: Exception) {
                null
            } ?: return@setOnImageAvailableListener
            try {
                val now = SystemClock.uptimeMillis()
                // The display draws as often as the screen changes; the page gets what the frame rate asks for.
                if (now - lastAt >= 1000L / fps - 2) {
                    due++
                    if (!Native.framesBusy()) {
                        val packet = toI420(image)
                        if (packet != null && Native.sendFrame(packet)) {
                            lastAt = now
                            sent++
                        }
                    }
                }
                adapt(now)
            } catch (e: Exception) {
                // An odd frame (a size changing under it) is skipped: on this thread an error would end the whole app.
            } catch (e: OutOfMemoryError) {
                // Too big a frame for the memory left: this one is skipped, the next may fit.
            } finally {
                image.close()
            }
        }, on)
        return made
    }

    /** Made I420 in Rust (`i420.rs`, in this app's own library): several times faster than the loops below. */
    private external fun rgbaToI420(src: ByteBuffer, stride: Int, pixel: Int, width: Int, height: Int, out: ByteBuffer): Boolean

    /** The Rust way works here (it is found the first time it is called); false: the Kotlin loops do it. */
    private var nativeWay = true
    /** Where Rust writes the picture, then copied into a packet: a direct buffer, reused. */
    private var picture: ByteBuffer = ByteBuffer.allocateDirect(0)
    /**
     * Packets for the page, reused in turn: a new megabyte every frame kept the collector busy and the picture stuttered.
     * Three are enough: at most two frames wait to be posted (`Native.framesBusy`), and posting copies the bytes.
     */
    private val packets = arrayOfNulls<ByteArray>(3)
    private var nextPacket = 0

    private fun packet(size: Int): ByteArray {
        val at = nextPacket
        nextPacket = (nextPacket + 1) % packets.size
        val held = packets[at]
        if (held != null && held.size == size) return held
        return ByteArray(size).also { packets[at] = it }
    }

    /**
     * RGBA → I420 (BT.709, studio range), chroma from each 2×2 block's mean, into a packet with its header. Rust does it
     * when it can; the Kotlin loops are the way back.
     */
    private fun toI420(image: Image): ByteArray? {
        val plane = image.planes.firstOrNull() ?: return null
        val width = image.width and 1.inv()
        val height = image.height and 1.inv()
        if (width < 2 || height < 2) return null
        val stride = plane.rowStride
        val pixel = plane.pixelStride
        val source = plane.buffer
        val ySize = width * height
        val cWidth = width / 2
        val cSize = cWidth * (height / 2)
        val bytes = ySize + 2 * cSize
        val out = packet(HEADER + bytes)
        ByteBuffer.wrap(out, 0, HEADER).order(ByteOrder.LITTLE_ENDIAN).putInt(KIND_PICTURE).putInt(width).putInt(height).putInt(0)
        if (nativeWay && source.isDirect) {
            try {
                if (picture.capacity() < bytes) picture = ByteBuffer.allocateDirect(bytes)
                if (rgbaToI420(source, stride, pixel, width, height, picture)) {
                    picture.position(0)
                    picture.get(out, HEADER, bytes)
                    return out
                }
            } catch (e: UnsatisfiedLinkError) {
                nativeWay = false
            }
        }
        val needed = source.remaining()
        if (buffer.size < needed) buffer = ByteArray(needed)
        source.get(buffer, 0, needed)
        val src = buffer
        var yAt = HEADER
        for (y in 0 until height) {
            var p = y * stride
            for (x in 0 until width) {
                val r = src[p].toInt() and 0xFF
                val g = src[p + 1].toInt() and 0xFF
                val b = src[p + 2].toInt() and 0xFF
                out[yAt++] = (((47 * r + 157 * g + 16 * b + 128) shr 8) + 16).toByte()
                p += pixel
            }
        }
        var uAt = HEADER + ySize
        var vAt = uAt + cSize
        for (cy in 0 until height / 2) {
            val row0 = 2 * cy * stride
            val row1 = row0 + stride
            for (cx in 0 until cWidth) {
                val a = row0 + 2 * cx * pixel
                val c = row1 + 2 * cx * pixel
                val r = (src[a].toInt() and 0xFF) + (src[a + pixel].toInt() and 0xFF) + (src[c].toInt() and 0xFF) + (src[c + pixel].toInt() and 0xFF)
                val g = (src[a + 1].toInt() and 0xFF) + (src[a + pixel + 1].toInt() and 0xFF) + (src[c + 1].toInt() and 0xFF) + (src[c + pixel + 1].toInt() and 0xFF)
                val b = (src[a + 2].toInt() and 0xFF) + (src[a + pixel + 2].toInt() and 0xFF) + (src[c + 2].toInt() and 0xFF) + (src[c + pixel + 2].toInt() and 0xFF)
                // Sums of four: the shift is two more than for one pixel.
                out[uAt++] = (((-26 * r - 86 * g + 112 * b + 512) shr 10) + 128).coerceIn(0, 255).toByte()
                out[vAt++] = (((112 * r - 102 * g - 10 * b + 512) shr 10) + 128).coerceIn(0, 255).toByte()
            }
        }
        return out
    }

    private fun startSound(made: MediaProjection) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            soundWhy = "Звук других программ Android отдаёт с версии 10"
            return
        }
        if (!Native.mayRecord()) {
            soundWhy = "Нет разрешения на звук (микрофон): без него Android не отдаёт звук программ"
            return
        }
        try {
            val config = AudioPlaybackCaptureConfiguration.Builder(made)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .excludeUid(Process.myUid())
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                .setSampleRate(RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val least = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
            @Suppress("MissingPermission")
            val record = AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(maxOf(least, SOUND_FRAMES * CHANNELS * 4 * 4))
                .setAudioPlaybackCaptureConfig(config)
                .build()
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                soundWhy = "Android не открыл звук программ"
                return
            }
            sound = SoundThread(record).also { it.start() }
        } catch (e: Exception) {
            soundWhy = "Звук программ не открылся: ${e.message ?: e.javaClass.simpleName}"
        }
    }

    private class SoundThread(private val record: AudioRecord) : Thread("hv-screen-sound") {
        @Volatile var going = true

        override fun run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val samples = FloatArray(SOUND_FRAMES * CHANNELS)
            try {
                record.startRecording()
                while (going) {
                    val n = record.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                    if (n <= 0) {
                        if (n < 0) break
                        continue
                    }
                    val frames = n / CHANNELS
                    val bytes = ByteBuffer.allocate(HEADER + frames * CHANNELS * 4).order(ByteOrder.LITTLE_ENDIAN)
                    bytes.putInt(KIND_SOUND).putInt(frames).putInt(RATE).putInt(CHANNELS)
                    bytes.asFloatBuffer().put(samples, 0, frames * CHANNELS)
                    Native.sendSound(bytes.array())
                }
            } catch (e: Exception) {
                // The projection ended under it; the picture's end tells the page.
            } finally {
                try {
                    record.stop()
                } catch (e: Exception) {
                }
                record.release()
            }
        }
    }

    /** Ends it (the page asked, the person stopped it from the status bar, or the call ended). */
    fun stop(quiet: Boolean = false) {
        val was = running
        running = false
        sound?.going = false
        sound = null
        displays?.unregisterDisplayListener(turned)
        displays = null
        display?.release()
        display = null
        reader?.close()
        reader = null
        val made = projection
        projection = null
        try {
            made?.stop()
        } catch (e: Exception) {
        }
        thread?.quitSafely()
        thread = null
        handler = null
        Native.boostMain(false)
        if (quiet) return
        if (was || made != null) {
            CallService.state.sharing = false
            CallService.update(Native.app)
        }
        report()
    }
}
