import Foundation
import Testing
@testable import AEEISCore

/// End to end against a running AEEIS (for example `npm run demo:local`): set AEEIS_E2E_SERVER to its address.
/// Creates a Run, finds it in the inbox, approves it, and checks the server moved on.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["AEEIS_E2E_SERVER"] != nil))
struct LiveServerTests {
    let client = AeeisClient(server: try! ServerAddress(ProcessInfo.processInfo.environment["AEEIS_E2E_SERVER"] ?? "http://localhost"), token: ProcessInfo.processInfo.environment["AEEIS_E2E_TOKEN"] ?? "")

    func createRun(_ goal: String) async throws -> String {
        let data = try await client.request("POST", "/api/runs", ["goal": goal])
        return try #require(try Inbox.object(data)["id"] as? String)
    }

    func waitFor(_ runId: String, _ done: (RunDetail) -> Bool) async throws -> RunDetail {
        for _ in 0..<40 {
            let run = try await client.run(runId)
            if done(run) { return run }
            try await Task.sleep(for: .milliseconds(500))
        }
        Issue.record("Run \(runId) did not reach the expected state"); return try await client.run(runId)
    }

    @Test func approvesARunFromTheInbox() async throws {
        let runId = try await createRun("iOS 端到端：整理一份上线核对清单")
        let waiting = try await waitFor(runId) { $0.status == "needs_approval" }
        #expect(waiting.planHash != nil && !waiting.steps.isEmpty)
        let inbox = try await client.inbox()
        #expect(inbox.contains { $0.key == "run:\(runId):needs_approval" && $0.kind == .approval })
        try await client.approve(waiting, once: true)
        let approved = try await waitFor(runId) { $0.status != "needs_approval" }
        #expect(approved.status != "needs_approval")
        #expect(try await client.inbox().contains { $0.runId == runId && $0.kind == .approval } == false)
        _ = try? await client.request("POST", "/api/runs/\(runId)/cancel", ["reason": "iOS 端到端测试结束"])
    }

    @Test func sendsAPlanBackWithWhatToChange() async throws {
        let runId = try await createRun("iOS 端到端：写一段发布说明")
        let waiting = try await waitFor(runId) { $0.status == "needs_approval" }
        try await client.revise(waiting, feedback: "先列风险再写说明")
        let revised = try await waitFor(runId) { $0.planVersion != waiting.planVersion || $0.status != "needs_approval" }
        #expect(revised.planVersion != waiting.planVersion || revised.status != "needs_approval")
        _ = try? await client.request("POST", "/api/runs/\(runId)/cancel", ["reason": "iOS 端到端测试结束"])
    }

    @Test func reportsWhichPushChannelsTheServerHas() async throws {
        #expect(try await client.pushChannels().contains("web"))
    }
}
