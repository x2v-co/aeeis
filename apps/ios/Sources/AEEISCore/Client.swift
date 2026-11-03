import Foundation

public enum AeeisError: LocalizedError, Equatable {
    case server(status: Int, message: String)
    case invalidServer
    public var errorDescription: String? {
        switch self {
        case .server(_, let message): return message
        case .invalidServer: return "地址要用 https://（只有本机的 http://localhost 可以用 http）"
        }
    }
    public var status: Int? { if case .server(let status, _) = self { return status } else { return nil } }
}

/// Where this phone reaches AEEIS. Plain HTTP only for a server on this machine (the simulator shares it).
public struct ServerAddress: Equatable, Sendable {
    public let base: URL
    public init(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), let host = url.host, let scheme = url.scheme else { throw AeeisError.invalidServer }
        guard scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { throw AeeisError.invalidServer }
        base = url
    }
    public func url(_ path: String) -> URL { URL(string: base.absoluteString + path)! }
}

/// A small client for the AEEIS HTTP API.
public struct AeeisClient: Sendable {
    public let server: ServerAddress
    public let token: String
    let session: URLSession
    public init(server: ServerAddress, token: String, session: URLSession = .shared) { self.server = server; self.token = token; self.session = session }

    public func inbox() async throws -> [InboxItem] {
        let runs = try Inbox.fromRuns(try await request("GET", "/api/runs/page?limit=100"))
        // Groups are optional on a server; without them there are simply no blocks.
        let holds = (try? Inbox.fromHoldings(try await request("GET", "/api/board-holdings"))) ?? []
        return Inbox.merge(runs, holds)
    }

    public func run(_ id: String) async throws -> RunDetail { try Inbox.runDetail(try await request("GET", "/api/runs/\(escape(id))")) }

    public func approve(_ run: RunDetail, once: Bool) async throws {
        guard let hash = run.planHash else { throw AeeisError.server(status: 409, message: "这件事没有等批准的计划") }
        var body: [String: Any] = ["planHash": hash, "planVersion": run.planVersion ?? 1]
        if once { body["duration"] = "once" }
        _ = try await request("POST", "/api/runs/\(escape(run.id))/approve", body)
    }

    public func revise(_ run: RunDetail, feedback: String) async throws {
        _ = try await request("POST", "/api/runs/\(escape(run.id))/revise-plan", ["planVersion": run.planVersion ?? 1, "feedback": feedback])
    }

    public func answer(_ runId: String, _ answer: String) async throws {
        _ = try await request("POST", "/api/runs/\(escape(runId))/answer", ["answer": answer])
    }

    public func pushChannels() async throws -> Set<String> {
        let config = try Inbox.object(try await request("GET", "/api/push/config"))
        var channels = Set<String>()
        if config["apns"] as? Bool == true { channels.insert("apns") }
        if config["fcm"] as? Bool == true { channels.insert("fcm") }
        if config["web"] is [String: Any] { channels.insert("web") }
        return channels
    }

    /// Registers this phone's APNs token and returns the subscription id.
    public func registerAPNs(token deviceToken: Data, label: String, sandbox: Bool) async throws -> String {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        let created = try Inbox.object(try await request("POST", "/api/push/subscriptions", ["channel": "apns", "label": label, "token": hex, "sandbox": sandbox]))
        guard let id = created["id"] as? String else { throw AeeisError.server(status: 0, message: "服务器没有返回推送登记") }
        return id
    }

    public func unregisterPush(_ id: String) async throws {
        do { _ = try await request("DELETE", "/api/push/subscriptions/\(escape(id))") }
        catch let error as AeeisError where error.status == 404 { }
    }

    public func webURL(_ path: String) -> URL { server.url(path) }

    func escape(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-"))) ?? value }

    func request(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: server.url(path), timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status < 400 else {
            let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
            throw AeeisError.server(status: status, message: message ?? "服务器返回 \(status)")
        }
        return data.isEmpty ? Data("{}".utf8) : data
    }
}
