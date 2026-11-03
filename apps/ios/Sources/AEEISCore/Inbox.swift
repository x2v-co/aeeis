import Foundation

/// One item a person has to decide on now (interaction design §9.1 S1), as the web inbox shows it.
public struct InboxItem: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable { case approval, question, block }
    public let key: String
    public let kind: Kind
    public let title: String
    public let detail: String
    public let at: String
    public let runId: String?
    public let roomId: String?
    public var id: String { key }
}

public struct PlanStep: Equatable, Sendable { public let id: String; public let title: String }

public struct RunDetail: Equatable, Sendable {
    public let id: String
    public let goal: String
    public let status: String
    public let planSummary: String?
    public let planHash: String?
    public let planVersion: Int?
    public let steps: [PlanStep]
    public let question: String?
    public let error: String?
}

/// The S1 rule shared with the web inbox and the push pump: approvals, questions, and blocked tasks in a group.
public enum Inbox {
    static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AeeisError.server(status: 0, message: "服务器返回的不是 JSON 对象") }
        return value
    }
    static func items(_ page: [String: Any]) -> [[String: Any]] { page["items"] as? [[String: Any]] ?? [] }
    static func text(_ value: Any?) -> String { (value as? String) ?? "" }

    public static func fromRuns(_ data: Data) throws -> [InboxItem] {
        try items(object(data)).compactMap { run in
            let status = text(run["status"])
            let kind: InboxItem.Kind
            switch status {
            case "needs_approval": kind = .approval
            case "needs_input": kind = .question
            default: return nil
            }
            guard let id = run["id"] as? String else { return nil }
            return InboxItem(key: "run:\(id):\(status)", kind: kind, title: clip(text(run["goal"]), 80),
                             detail: kind == .approval ? "计划等你批准后才会执行" : "Bot 在等你回答一个问题",
                             at: text(run["updatedAt"]), runId: id, roomId: nil)
        }
    }

    public static func fromHoldings(_ data: Data) throws -> [InboxItem] {
        try items(object(data)).compactMap { hold in
            let blocked = text(hold["blocked"])
            guard !blocked.isEmpty, let roomId = hold["roomId"] as? String else { return nil }
            let roomTitle = text(hold["roomTitle"])
            let title = text(hold["title"])
            return InboxItem(key: "block:\(roomId):\(text(hold["conversationId"])):\(text(hold["taskId"])):\(text(hold["blockedAt"]))", kind: .block,
                             title: clip(title.isEmpty ? "频道里的事" : title, 80), detail: "阻塞：\(blocked)" + (roomTitle.isEmpty ? "" : " · \(roomTitle)"),
                             at: text(hold["blockedAt"]), runId: nil, roomId: roomId)
        }
    }

    /// Approvals first, then questions and blocks; the longest-waiting first within each, as on the web.
    public static func merge(_ runs: [InboxItem], _ holds: [InboxItem]) -> [InboxItem] {
        (runs + holds).enumerated().sorted { left, right in
            let l = left.element.kind == .approval ? 0 : 1, r = right.element.kind == .approval ? 0 : 1
            if l != r { return l < r }
            if left.element.at != right.element.at { return left.element.at < right.element.at }
            return left.offset < right.offset
        }.map(\.element)
    }

    public static func runDetail(_ data: Data) throws -> RunDetail {
        let run = try object(data)
        let plan = (run["plans"] as? [[String: Any]])?.last
        let nodes = plan?["nodes"] as? [[String: Any]] ?? []
        let summary = text(plan?["summary"]), hash = text(plan?["hash"]), error = text(run["error"])
        let question = text((run["question"] as? [String: Any])?["text"])
        return RunDetail(id: text(run["id"]), goal: text(run["goal"]), status: text(run["status"]),
                         planSummary: summary.isEmpty ? nil : summary, planHash: hash.isEmpty ? nil : hash, planVersion: plan?["version"] as? Int,
                         steps: nodes.map { PlanStep(id: text($0["id"]), title: text($0["title"])) },
                         question: question.isEmpty ? nil : question, error: error.isEmpty ? nil : error)
    }

    public static func statusLabel(_ status: String) -> String {
        [
            "needs_approval": "等你批准", "needs_input": "等你回答", "queued": "排队中", "planning": "在做计划", "running": "在做",
            "reviewing": "在审核", "paused": "暂停了", "succeeded": "做完了", "failed": "失败了", "cancelled": "取消了",
            "unknown": "结果不明", "waiting_external": "等外部回执",
        ][status] ?? status
    }

    /// `/runs/<id>` opens the Run in the app; anything else (a group) opens in the browser.
    public static func runId(fromLink link: String) -> String? {
        guard let match = link.wholeMatch(of: #/\/runs\/(run_[0-9a-f-]{36})\/?/#) else { return nil }
        return String(match.1)
    }

    static func clip(_ text: String, _ length: Int) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return flat.count > length ? String(flat.prefix(length)) + "…" : flat
    }
}
