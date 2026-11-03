package co.x2v.aeeis

import android.content.Context

/** Where this phone reaches AEEIS, kept in the app's private storage. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("aeeis", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString("server", "").orEmpty()
        set(value) = prefs.edit().putString("server", value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "").orEmpty()
        set(value) = prefs.edit().putString("token", value.trim()).apply()

    /** This phone's push registration on the server, when push is on. */
    var pushSubscriptionId: String
        get() = prefs.getString("push", "").orEmpty()
        set(value) = prefs.edit().putString("push", value).apply()

    val configured: Boolean get() = server.isNotBlank()

    fun client() = AeeisClient(server, token)

    fun clear() = prefs.edit().clear().apply()

    companion object {
        /** Plain HTTP is only for a server on this machine or the emulator's host; everything else must be HTTPS. */
        fun validServer(value: String): Boolean {
            val url = try { java.net.URI(value.trim()) } catch (_: Exception) { return false }
            val host = url.host ?: return false
            return when (url.scheme) {
                "https" -> true
                "http" -> host == "10.0.2.2" || host == "localhost" || host == "127.0.0.1"
                else -> false
            }
        }
    }
}
