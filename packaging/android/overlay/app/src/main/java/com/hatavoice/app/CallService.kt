package com.hatavoice.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONObject

private const val CHANNEL = "call"
private const val NOTIFICATION = 1
private const val ACTION_UPDATE = "com.hatavoice.app.UPDATE"
private const val ACTION_SCREEN = "com.hatavoice.app.SCREEN"
private const val ACTION_LEAVE = "com.hatavoice.app.LEAVE"

/**
 * While a call is on (or the screen is shown, or this phone hosts a server), Android keeps the app working with the
 * screen off or another app in front, as long as it can see why: a notification, and the kinds of work it is doing —
 * the microphone, the camera, the screen, a server. Each kind is claimed only while it is in use.
 */
class CallService : Service() {
    /** What the app does now; the page and the screen capture change it, `update` tells Android. */
    class State {
        @Volatile var call = false
        @Volatile var camera = false
        @Volatile var sharing = false
        @Volatile var hosting = false
        /** The person keeps the app on in the background for chat messages. */
        @Volatile var online = false
        val busy get() = call || sharing || hosting || online
    }

    companion object {
        val state = State()

        fun update(context: Context) {
            val service = Intent(context, CallService::class.java).setAction(ACTION_UPDATE)
            try {
                if (state.busy) context.startForegroundService(service) else context.stopService(service)
            } catch (e: RuntimeException) {
                // Android refuses a service started from the background: the call goes on while the app is in front.
            }
        }

        /** Android said yes to showing the screen: the service turns into a screen one, then the capture starts. */
        fun screen(context: Context, code: Int, data: Intent) {
            state.sharing = true
            val service = Intent(context, CallService::class.java).setAction(ACTION_SCREEN)
                .putExtra("code", code)
                .putExtra("data", data)
            try {
                context.startForegroundService(service)
            } catch (e: RuntimeException) {
                state.sharing = false
                Native.send(JSONObject().put("ev", "screen").put("state", "error").put("why", "Android не дал запустить показ экрана"))
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** A kind with no conditions: «special use» from Android 14, data sync before it. */
    private fun plain(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC

    private fun types(): Int {
        var types = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (state.call && Native.mayRecord()) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (state.call && state.camera && Native.mayFilm()) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && state.sharing) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && state.hosting) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        return types
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Звонок", NotificationManager.IMPORTANCE_LOW))
        val back = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
        val text = when {
            state.sharing -> "Ты показываешь экран"
            state.call -> "Идёт звонок"
            state.hosting -> "Сервер работает на этом телефоне"
            else -> "В сети: сообщения приходят"
        }
        val builder = Notification.Builder(this, CHANNEL)
            .setContentTitle("ХатаВойс")
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(back)
        if (state.call) {
            val leave = PendingIntent.getService(this, 1, Intent(this, CallService::class.java).setAction(ACTION_LEAVE), PendingIntent.FLAG_IMMUTABLE)
            builder.addAction(Notification.Action.Builder(null, "Выйти из звонка", leave).build())
        }
        return builder.build()
    }

    /**
     * Claims what is in use. A service started as a foreground one must claim something, or Android ends the whole app;
     * when a kind is refused (a permission taken back meanwhile), a plain kind that needs nothing stands in for it.
     */
    private fun claim() {
        val notification = notification()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION, notification)
            return
        }
        val types = types()
        try {
            startForeground(NOTIFICATION, notification, if (types != 0) types else plain())
        } catch (e: RuntimeException) {
            startForeground(NOTIFICATION, notification, plain())
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_LEAVE -> {
                Native.send(JSONObject().put("ev", "leave"))
                return START_NOT_STICKY
            }
            ACTION_SCREEN -> {
                try {
                    claim()
                } catch (e: RuntimeException) {
                    state.sharing = false
                    Native.send(JSONObject().put("ev", "screen").put("state", "error").put("why", "Android не дал запустить показ экрана"))
                    return START_NOT_STICKY
                }
                val code = intent.getIntExtra("code", 0)
                @Suppress("DEPRECATION")
                val data = intent.getParcelableExtra<Intent>("data")
                val wish = Native.pendingScreen ?: ScreenCapture.Wish(Pair(1280, 720), 30, false)
                Native.pendingScreen = null
                if (data != null) {
                    // Whatever Android refuses on the way (a projection taken back, no display for it) ends the show,
                    // not the app.
                    try {
                        ScreenCapture.begin(this, code, data, wish)
                    } catch (e: RuntimeException) {
                        ScreenCapture.stop(quiet = true)
                        state.sharing = false
                        update(this)
                        Native.send(JSONObject().put("ev", "screen").put("state", "error").put("why", "Android не дал экран: ${e.message ?: e.javaClass.simpleName}"))
                    }
                }
                return START_NOT_STICKY
            }
        }
        // Claimed first even when the work just ended: a foreground service that stops before claiming takes the app down.
        try {
            claim()
        } catch (e: RuntimeException) {
            // Nothing Android lets this service claim: it ends, the call goes on while the app is in front.
            stopSelf()
            return START_NOT_STICKY
        }
        if (!state.busy) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    /** The app was swiped away: the call and the screen go with it; a server hosted here keeps running. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        ScreenCapture.stop(quiet = true)
        state.call = false
        state.camera = false
        state.sharing = false
        // The page that tells of messages is gone with the app: only a server hosted here goes on.
        state.online = false
        if (!state.hosting) stopSelf() else claim()
    }

    override fun onDestroy() {
        ScreenCapture.stop(quiet = true)
        super.onDestroy()
    }
}
