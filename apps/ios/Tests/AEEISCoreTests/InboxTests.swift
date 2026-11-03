import Foundation
import Testing
@testable import AEEISCore

@Suite struct InboxTests {
    let runs = Data(#"{"items":[{"id":"run_b","goal":"写  上线\n说明","status":"needs_input","updatedAt":"2026-11-03T02:00:00Z"},{"id":"run_a","goal":"查上线数据","status":"needs_approval","updatedAt":"2026-11-03T03:00:00Z"},{"id":"run_c","goal":"做完的","status":"succeeded","updatedAt":"2026-11-03T01:00:00Z"}]}"#.utf8)
    let holds = Data(#"{"items":[{"roomId":"room_1","roomTitle":"发布协作","conversationId":"conv","taskId":"task","title":"发通告","blocked":"等法务","blockedAt":"2026-11-03T01:30:00Z"},{"roomId":"room_1","conversationId":"conv","taskId":"other","title":"没阻塞"}]}"#.utf8)

    @Test func keepsOnlyWhatNeedsADecision() throws {
        let items = Inbox.merge(try Inbox.fromRuns(runs), try Inbox.fromHoldings(holds))
        #expect(items.map(\.key) == ["run:run_a:needs_approval", "block:room_1:conv:task:2026-11-03T01:30:00Z", "run:run_b:needs_input"])
        #expect(items[2].title == "写 上线 说明")
        #expect(items[1].detail == "阻塞：等法务 · 发布协作")
        #expect(items[1].roomId == "room_1" && items[1].runId == nil)
    }

    @Test func readsThePlanToApproveAndTheQuestion() throws {
        let detail = try Inbox.runDetail(Data(#"{"id":"run_a","goal":"查数据","status":"needs_approval","plans":[{"version":1,"hash":"old","summary":"旧","nodes":[]},{"version":2,"hash":"h2","summary":"先查再写","nodes":[{"id":"a","title":"查"},{"id":"b","title":"写"}]}],"question":{"text":"哪一版？"}}"#.utf8))
        #expect(detail.planHash == "h2")
        #expect(detail.planVersion == 2)
        #expect(detail.steps.map(\.title) == ["查", "写"])
        #expect(detail.question == "哪一版？")
        #expect(Inbox.statusLabel(detail.status) == "等你批准")
    }

    @Test func acceptsHttpsAndOnlyLocalHttp() throws {
        #expect(try ServerAddress("https://aeeis.example.com/").base.absoluteString == "https://aeeis.example.com")
        #expect(try ServerAddress("http://localhost:4390").base.port == 4390)
        #expect(throws: AeeisError.invalidServer) { try ServerAddress("http://aeeis.example.com") }
        #expect(throws: AeeisError.invalidServer) { try ServerAddress("aeeis.example.com") }
    }

    @Test func opensRunLinksInTheAppAndEverythingElseOnTheWeb() {
        #expect(Inbox.runId(fromLink: "/runs/run_0123abcd-0000-4000-8000-000000000000") == "run_0123abcd-0000-4000-8000-000000000000")
        #expect(Inbox.runId(fromLink: "/#room=room_1") == nil)
    }
}
