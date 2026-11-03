package co.x2v.aeeis

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InboxTest {
    private val runs = JSONObject("""{"items":[
        {"id":"run_b","goal":"写  上线\n说明","status":"needs_input","updatedAt":"2026-11-03T02:00:00Z"},
        {"id":"run_a","goal":"查上线数据","status":"needs_approval","updatedAt":"2026-11-03T03:00:00Z"},
        {"id":"run_c","goal":"做完的","status":"succeeded","updatedAt":"2026-11-03T01:00:00Z"}
    ]}""")
    private val holds = JSONObject("""{"items":[
        {"roomId":"room_1","roomTitle":"发布协作","conversationId":"conv","taskId":"task","title":"发通告","blocked":"等法务","blockedAt":"2026-11-03T01:30:00Z"},
        {"roomId":"room_1","conversationId":"conv","taskId":"other","title":"没阻塞"}
    ]}""")

    @Test fun keepsOnlyWhatNeedsADecision() {
        val items = Inbox.merge(Inbox.fromRuns(runs), Inbox.fromHoldings(holds))
        assertEquals(listOf("run:run_a:needs_approval", "block:room_1:conv:task:2026-11-03T01:30:00Z", "run:run_b:needs_input"), items.map { it.key })
        assertEquals("写 上线 说明", items[2].title)
        assertEquals("阻塞：等法务 · 发布协作", items[1].detail)
        assertEquals("room_1", items[1].roomId)
        assertNull(items[1].runId)
    }

    @Test fun readsThePlanToApproveAndTheQuestion() {
        val detail = Inbox.runDetail(JSONObject("""{"id":"run_a","goal":"查数据","status":"needs_approval",
            "plans":[{"version":1,"hash":"old","summary":"旧","nodes":[]},{"version":2,"hash":"h2","summary":"先查再写","nodes":[{"id":"a","title":"查"},{"id":"b","title":"写"}]}],
            "question":{"text":"哪一版？"}}"""))
        assertEquals("h2", detail.planHash)
        assertEquals(2, detail.planVersion)
        assertEquals(listOf("查", "写"), detail.steps.map { it.title })
        assertEquals("哪一版？", detail.question)
        assertEquals("等你批准", Inbox.statusLabel(detail.status))
    }

    @Test fun acceptsHttpsAndOnlyLocalHttp() {
        assertTrue(Settings.validServer("https://aeeis.example.com"))
        assertTrue(Settings.validServer("http://10.0.2.2:4390"))
        assertFalse(Settings.validServer("http://aeeis.example.com"))
        assertFalse(Settings.validServer("aeeis.example.com"))
    }

    @Test fun opensRunLinksInTheAppAndEverythingElseOnTheWeb() {
        assertEquals("run_0123abcd-0000-4000-8000-000000000000", runIdFromLink("/runs/run_0123abcd-0000-4000-8000-000000000000"))
        assertNull(runIdFromLink("/#room=room_1"))
    }
}
