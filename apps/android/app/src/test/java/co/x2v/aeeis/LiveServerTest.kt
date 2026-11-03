package co.x2v.aeeis

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

/**
 * End to end against a running AEEIS (for example `npm run demo:local`): set AEEIS_E2E_SERVER to its address.
 * Creates a Run, finds it in the inbox, approves it, and checks the server moved on.
 */
class LiveServerTest {
    private val server = System.getenv("AEEIS_E2E_SERVER").orEmpty()
    private val token = System.getenv("AEEIS_E2E_TOKEN").orEmpty()
    private val client = AeeisClient(server, token)

    @Before fun needsAServer() = assumeTrue("AEEIS_E2E_SERVER is not set", server.isNotBlank())

    private fun post(path: String, body: JSONObject): JSONObject {
        val connection = URL(server.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("content-type", "application/json")
            if (token.isNotBlank()) connection.setRequestProperty("authorization", "Bearer $token")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val text = (if (connection.responseCode >= 400) connection.errorStream else connection.inputStream).bufferedReader().use { it.readText() }
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun createRun(goal: String): String = post("/api/runs", JSONObject().put("goal", goal)).getString("id")

    private fun cancel(runId: String) {
        runCatching { post("/api/runs/$runId/cancel", JSONObject().put("reason", "Android 端到端测试结束")) }
    }

    private fun waitFor(runId: String, done: (RunDetail) -> Boolean): RunDetail {
        repeat(40) {
            val run = client.run(runId)
            if (done(run)) return run
            Thread.sleep(500)
        }
        throw AssertionError("Run $runId did not reach the expected state")
    }

    @Test fun approvesARunFromTheInbox() {
        val runId = createRun("Android 端到端：整理一份上线核对清单")
        try {
            val waiting = waitFor(runId) { it.status == "needs_approval" }
            assertNotNull(waiting.planHash)
            assertTrue(waiting.steps.isNotEmpty())
            assertTrue(client.inbox().any { it.key == "run:$runId:needs_approval" && it.kind == InboxItem.Kind.APPROVAL })
            client.approve(waiting, once = true)
            assertNotEquals("needs_approval", waitFor(runId) { it.status != "needs_approval" }.status)
            assertFalse(client.inbox().any { it.runId == runId && it.kind == InboxItem.Kind.APPROVAL })
        } finally {
            cancel(runId)
        }
    }

    @Test fun sendsAPlanBackWithWhatToChange() {
        val runId = createRun("Android 端到端：写一段发布说明")
        try {
            val waiting = waitFor(runId) { it.status == "needs_approval" }
            client.revise(waiting, "先列风险再写说明")
            val revised = waitFor(runId) { it.planVersion != waiting.planVersion || it.status != "needs_approval" }
            assertTrue(revised.planVersion != waiting.planVersion || revised.status != "needs_approval")
        } finally {
            cancel(runId)
        }
    }

    @Test fun refusesAStalePlan() {
        val runId = createRun("Android 端到端：旧计划不能批准")
        try {
            val waiting = waitFor(runId) { it.status == "needs_approval" }
            val error = runCatching { client.approve(waiting.copy(planHash = "stale"), once = true) }.exceptionOrNull()
            assertTrue(error is ApiException && error.status in 400..499)
            assertEquals("needs_approval", client.run(runId).status)
        } finally {
            cancel(runId)
        }
    }

    @Test fun reportsWhichPushChannelsTheServerHas() {
        assertTrue(client.pushChannels().contains("web"))
    }
}
