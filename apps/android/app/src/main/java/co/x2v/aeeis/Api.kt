package co.x2v.aeeis

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** One item a person has to decide on now (interaction design §9.1 S1), as the web inbox shows it. */
data class InboxItem(
    val key: String,
    val kind: Kind,
    val title: String,
    val detail: String,
    val at: String,
    val runId: String? = null,
    val roomId: String? = null,
) {
    enum class Kind { APPROVAL, QUESTION, BLOCK }
}

data class PlanStep(val id: String, val title: String)

data class RunDetail(
    val id: String,
    val goal: String,
    val status: String,
    val planSummary: String?,
    val planHash: String?,
    val planVersion: Int?,
    val steps: List<PlanStep>,
    val question: String?,
    val error: String?,
)

class ApiException(val status: Int, message: String) : IOException(message)

/** The S1 rule shared with the web inbox and the push pump: approvals, questions, and blocked tasks in a group. */
object Inbox {
    fun fromRuns(page: JSONObject): List<InboxItem> {
        val items = page.optJSONArray("items") ?: JSONArray()
        return (0 until items.length()).mapNotNull { index ->
            val run = items.getJSONObject(index)
            val status = run.optString("status")
            val kind = when (status) {
                "needs_approval" -> InboxItem.Kind.APPROVAL
                "needs_input" -> InboxItem.Kind.QUESTION
                else -> return@mapNotNull null
            }
            val id = run.getString("id")
            InboxItem(
                key = "run:$id:$status",
                kind = kind,
                title = clip(run.optString("goal"), 80),
                detail = if (kind == InboxItem.Kind.APPROVAL) "计划等你批准后才会执行" else "Bot 在等你回答一个问题",
                at = run.optString("updatedAt"),
                runId = id,
            )
        }
    }

    fun fromHoldings(page: JSONObject): List<InboxItem> {
        val items = page.optJSONArray("items") ?: JSONArray()
        return (0 until items.length()).mapNotNull { index ->
            val hold = items.getJSONObject(index)
            val blocked = hold.optString("blocked").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val roomTitle = hold.optString("roomTitle").takeIf { it.isNotBlank() }
            InboxItem(
                key = "block:${hold.getString("roomId")}:${hold.optString("conversationId")}:${hold.optString("taskId")}:${hold.optString("blockedAt")}",
                kind = InboxItem.Kind.BLOCK,
                title = clip(hold.optString("title").ifBlank { "频道里的事" }, 80),
                detail = "阻塞：$blocked" + (roomTitle?.let { " · $it" } ?: ""),
                at = hold.optString("blockedAt"),
                roomId = hold.getString("roomId"),
            )
        }
    }

    /** Approvals first, then questions and blocks; the longest-waiting first within each, as on the web. */
    fun merge(runs: List<InboxItem>, holds: List<InboxItem>): List<InboxItem> =
        (runs + holds).sortedWith(compareBy<InboxItem>({ if (it.kind == InboxItem.Kind.APPROVAL) 0 else 1 }, { it.at }))

    fun runDetail(run: JSONObject): RunDetail {
        val plans = run.optJSONArray("plans") ?: JSONArray()
        val plan = if (plans.length() > 0) plans.getJSONObject(plans.length() - 1) else null
        val nodes = plan?.optJSONArray("nodes") ?: JSONArray()
        return RunDetail(
            id = run.getString("id"),
            goal = run.optString("goal"),
            status = run.optString("status"),
            planSummary = plan?.optString("summary")?.takeIf { it.isNotBlank() },
            planHash = plan?.optString("hash")?.takeIf { it.isNotBlank() },
            planVersion = plan?.optInt("version")?.takeIf { plan.has("version") },
            steps = (0 until nodes.length()).map { nodes.getJSONObject(it).let { node -> PlanStep(node.getString("id"), node.optString("title")) } },
            question = run.optJSONObject("question")?.optString("text")?.takeIf { it.isNotBlank() },
            error = run.optString("error").takeIf { it.isNotBlank() },
        )
    }

    fun statusLabel(status: String): String = when (status) {
        "needs_approval" -> "等你批准"
        "needs_input" -> "等你回答"
        "queued" -> "排队中"
        "planning" -> "在做计划"
        "running" -> "在做"
        "reviewing" -> "在审核"
        "paused" -> "暂停了"
        "succeeded" -> "做完了"
        "failed" -> "失败了"
        "cancelled" -> "取消了"
        "unknown" -> "结果不明"
        "waiting_external" -> "等外部回执"
        else -> status
    }

    private fun clip(text: String, length: Int): String {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        return if (flat.length > length) flat.take(length) + "…" else flat
    }
}

/** A small client for the AEEIS HTTP API. Every call is blocking; callers run it off the main thread. */
class AeeisClient(private val server: String, private val token: String) {
    private val base = server.trimEnd('/')

    fun inbox(): List<InboxItem> {
        val runs = Inbox.fromRuns(request("GET", "/api/runs/page?limit=100"))
        // Groups are optional on a server; without them there are simply no blocks.
        val holds = try { Inbox.fromHoldings(request("GET", "/api/board-holdings")) } catch (error: ApiException) { emptyList() }
        return Inbox.merge(runs, holds)
    }

    fun run(id: String): RunDetail = Inbox.runDetail(request("GET", "/api/runs/${encode(id)}"))

    fun approve(run: RunDetail, once: Boolean) {
        val hash = run.planHash ?: throw ApiException(409, "这件事没有等批准的计划")
        val body = JSONObject().put("planHash", hash).put("planVersion", run.planVersion ?: 1)
        if (once) body.put("duration", "once")
        request("POST", "/api/runs/${encode(run.id)}/approve", body)
    }

    fun revise(run: RunDetail, feedback: String) {
        request("POST", "/api/runs/${encode(run.id)}/revise-plan", JSONObject().put("planVersion", run.planVersion ?: 1).put("feedback", feedback))
    }

    fun answer(runId: String, answer: String) {
        request("POST", "/api/runs/${encode(runId)}/answer", JSONObject().put("answer", answer))
    }

    /** Which push channels the server can send to. */
    fun pushChannels(): Set<String> {
        val config = request("GET", "/api/push/config")
        return buildSet {
            if (config.optBoolean("fcm")) add("fcm")
            if (config.optBoolean("apns")) add("apns")
            if (!config.isNull("web")) add("web")
        }
    }

    fun registerFcm(token: String, label: String): String =
        request("POST", "/api/push/subscriptions", JSONObject().put("channel", "fcm").put("label", label).put("token", token)).getString("id")

    fun unregisterPush(id: String) {
        try { request("DELETE", "/api/push/subscriptions/${encode(id)}") } catch (error: ApiException) { if (error.status != 404) throw error }
    }

    fun webUrl(path: String): String = base + path

    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8")

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            connection.setRequestProperty("accept", "application/json")
            if (token.isNotBlank()) connection.setRequestProperty("authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = connection.responseCode
            val text = (if (status >= 400) connection.errorStream else connection.inputStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status >= 400) {
                val message = try { JSONObject(text).optString("error") } catch (_: Exception) { "" }
                throw ApiException(status, message.ifBlank { "服务器返回 $status" })
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }
}
