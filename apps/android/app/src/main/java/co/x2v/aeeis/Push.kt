package co.x2v.aeeis

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.tasks.await

/**
 * Push for S1 items (§9.4) over Firebase Cloud Messaging. The Firebase project comes from build settings, so a build
 * without them simply has no push: the inbox still refreshes while the app is open.
 */
object Push {
    const val CHANNEL = "aeeis-s1"

    val built: Boolean get() = BuildConfig.FCM_APPLICATION_ID.isNotBlank() && BuildConfig.FCM_PROJECT_ID.isNotBlank() && BuildConfig.FCM_API_KEY.isNotBlank() && BuildConfig.FCM_SENDER_ID.isNotBlank()

    fun initialize(context: Context) {
        createChannel(context)
        if (!built || FirebaseApp.getApps(context).isNotEmpty()) return
        FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FCM_APPLICATION_ID)
            .setProjectId(BuildConfig.FCM_PROJECT_ID)
            .setApiKey(BuildConfig.FCM_API_KEY)
            .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
            .build())
    }

    /** Registers this phone with the server and returns the subscription id. */
    suspend fun enable(context: Context, settings: Settings): String {
        check(built) { "这个版本没有配置推送" }
        val token = FirebaseMessaging.getInstance().token.await()
        val id = settings.client().registerFcm(token, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        settings.pushSubscriptionId = id
        return id
    }

    fun disable(settings: Settings) {
        val id = settings.pushSubscriptionId
        if (id.isNotBlank()) settings.client().unregisterPush(id)
        settings.pushSubscriptionId = ""
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "要你决定的事", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "审批、提问和群里的阻塞。同一件事只提醒一次。"
        })
    }

    fun show(context: Context, title: String, body: String, url: String, tag: String) {
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_URL, url)
        }
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try { NotificationManagerCompat.from(context).notify(tag, 0, notification) } catch (_: SecurityException) { /* notifications are off for this app */ }
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val settings = Settings(this)
        // Only refresh a registration the person turned on; a new token replaces the old device entry on the server.
        if (settings.pushSubscriptionId.isBlank() || !settings.configured) return
        try { settings.pushSubscriptionId = settings.client().registerFcm(token, "${Build.MANUFACTURER} ${Build.MODEL}".trim()) } catch (_: Exception) { /* retried on next app start */ }
    }

    /** In the foreground FCM hands the message here instead of the tray, so show it the same way. */
    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: "AEEIS：有事要你决定"
        val body = message.notification?.body ?: message.data["body"].orEmpty()
        Push.show(this, title, body, message.data["url"] ?: "/", message.data["tag"] ?: message.messageId ?: title)
    }
}
