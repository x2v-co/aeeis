import SwiftUI
import AEEISCore

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @State private var path: [String] = []

    var body: some View {
        if model.client == nil {
            SetupView()
        } else {
            NavigationStack(path: $path) {
                InboxView()
                    .navigationDestination(for: String.self) { RunView(runId: $0) }
            }
            .onChange(of: model.linkedRunId) { _, runId in
                guard let runId else { return }
                path = [runId]; model.linkedRunId = nil
            }
        }
    }
}

struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var server = "https://"
    @State private var token = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section(footer: Text("填你平时打开 AEEIS 的地址。服务端配置了访问令牌时，再填令牌。")) {
                    TextField("地址", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("访问令牌（可不填）", text: $token)
                }
                if let error { Text(error).foregroundStyle(.red) }
                Button(busy ? "正在连接…" : "连接") { Task { await connect() } }.disabled(busy)
            }
            .navigationTitle("连接 AEEIS")
        }
    }

    private func connect() async {
        busy = true; defer { busy = false }
        do {
            let client = AeeisClient(server: try ServerAddress(server), token: token)
            _ = try await client.inbox()
            model.token = token; model.serverText = client.server.base.absoluteString
        } catch let failure as AeeisError where failure.status == 401 {
            error = "令牌不对，或这个 AEEIS 需要令牌。"
        } catch {
            self.error = "连不上：\(error.localizedDescription)"
        }
    }
}

struct InboxView: View {
    @EnvironmentObject var model: AppModel
    @State private var items: [InboxItem]?
    @State private var error: String?
    @State private var showSettings = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let items, items.isEmpty { Text("没有要你决定的事。").foregroundStyle(.secondary) }
            ForEach(items ?? []) { item in
                if let runId = item.runId {
                    NavigationLink(value: runId) { row(item) }
                } else {
                    Button { if let roomId = item.roomId { model.open(link: "/#room=\(roomId)") } } label: { row(item) }.tint(.primary)
                }
            }
        }
        .overlay { if items == nil && error == nil { ProgressView() } }
        .navigationTitle("收件箱")
        .toolbar { Button("设置") { showSettings = true } }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .refreshable { await load() }
        .task {
            // Refresh while the inbox is on screen; push covers the time the app is closed.
            while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(15)) }
        }
    }

    private func row(_ item: InboxItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.kind == .approval ? "等批准" : item.kind == .question ? "等回答" : "阻塞").font(.caption).foregroundStyle(.secondary)
            Text(item.title).font(.headline)
            Text(item.detail).font(.subheadline)
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do { items = try await client.inbox(); error = nil } catch { self.error = "刷新失败：\(error.localizedDescription)" }
    }
}

struct RunView: View {
    @EnvironmentObject var model: AppModel
    let runId: String
    @State private var run: RunDetail?
    @State private var error: String?
    @State private var notice: String?
    @State private var busy = false
    @State private var answer = ""
    @State private var feedback = ""
    @State private var revising = false

    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            if let notice { Text(notice) }
            if let run {
                Section {
                    Text(run.goal).font(.title3)
                    Text(Inbox.statusLabel(run.status)).font(.subheadline.weight(.semibold))
                }
                if run.planSummary != nil || !run.steps.isEmpty {
                    Section("计划") {
                        if let summary = run.planSummary { Text(summary) }
                        ForEach(Array(run.steps.enumerated()), id: \.offset) { index, step in Text("\(index + 1). \(step.title)") }
                    }
                }
                switch run.status {
                case "needs_approval":
                    Section(footer: Text("批准后 Bot 按这个计划做。只批这一次的话，下次同样的事还会来问你。")) {
                        Button("批准并执行") { act("已批准，Bot 开始做了。") { try await $0.approve(run, once: false) } }
                        Button("只批这一次") { act("已批准这一次。") { try await $0.approve(run, once: true) } }
                        Button("打回，说明要改什么") { revising = true }
                    }.disabled(busy)
                case "needs_input":
                    Section(run.question ?? "Bot 需要一条补充信息才能继续。") {
                        TextField("你的回答", text: $answer, axis: .vertical)
                        Button("回答并继续") { let text = answer.trimmingCharacters(in: .whitespacesAndNewlines); act("已回答，Bot 接着做。") { try await $0.answer(run.id, text); answer = "" } }
                            .disabled(busy || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                default:
                    if let failure = run.error { Text(failure).foregroundStyle(.red) }
                }
                Section { Link("在网页版看完整过程", destination: model.client!.webURL("/runs/\(run.id)")) }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle("这件事")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: runId) { await load() }
        .alert("打回计划", isPresented: $revising) {
            TextField("要改什么", text: $feedback)
            Button("打回") { guard let run else { return }; let text = feedback; act("已打回，Bot 会重新做计划。") { try await $0.revise(run, feedback: text); feedback = "" } }
            Button("取消", role: .cancel) {}
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do { run = try await client.run(runId); error = nil } catch { self.error = "打不开：\(error.localizedDescription)" }
    }

    private func act(_ done: String, _ action: @escaping (AeeisClient) async throws -> Void) {
        guard let client = model.client else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await action(client); notice = done; await load() } catch { self.error = error.localizedDescription }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var note: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section { Text("连接到 \(model.serverText)") }
                Section(footer: Text(note ?? "审批、提问和群里的阻塞。app 关着也提醒，同一件事只提醒一次。")) {
                    Toggle("推送要你决定的事", isOn: Binding(get: { !model.pushSubscriptionId.isEmpty }, set: { wanted in Task { await setPush(wanted) } }))
                        .disabled(busy)
                }
                Section {
                    Button("断开这个 AEEIS", role: .destructive) { Task { await model.signOut(); dismiss() } }
                }
            }
            .navigationTitle("设置")
            .toolbar { Button("完成") { dismiss() } }
        }
    }

    private func setPush(_ wanted: Bool) async {
        busy = true; defer { busy = false }
        do {
            if wanted { _ = try await Push.enable(model); note = "已打开推送。" }
            else { try await Push.disable(model); note = "已关闭推送。" }
        } catch {
            note = "没能\(wanted ? "打开" : "关闭")：\(error.localizedDescription)"
        }
    }
}
