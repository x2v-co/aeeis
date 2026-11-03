import SwiftUI
import UserNotifications
import AEEISCore

/// AEEIS for iPhone: the inbox and the decisions on it (§11.6), with APNs push for S1 items.
/// Groups, the task board and the studio stay on the web; a block opens its group in Safari.
@main
struct AEEISApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    @AppStorage("server") var serverText = ""
    @AppStorage("push") var pushSubscriptionId = ""
    @Published var linkedRunId: String?
    /// A pending push registration: the token arrives from the system after the person turns push on.
    var pushContinuation: CheckedContinuation<Data, Error>?

    /// The token stays in the Keychain, not in preferences.
    var token: String {
        get { Keychain.read("token") ?? "" }
        set { Keychain.write("token", newValue) }
    }

    var client: AeeisClient? {
        guard let server = try? ServerAddress(serverText) else { return nil }
        return AeeisClient(server: server, token: token)
    }

    func open(link: String) {
        if let runId = Inbox.runId(fromLink: link) { linkedRunId = runId }
        else if let url = client?.webURL(link) { UIApplication.shared.open(url) }
    }

    func signOut() async {
        if let client, !pushSubscriptionId.isEmpty { try? await client.unregisterPush(pushSubscriptionId) }
        pushSubscriptionId = ""; serverText = ""; token = ""
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            let model = AppModel.shared
            if let waiting = model.pushContinuation { model.pushContinuation = nil; waiting.resume(returning: deviceToken); return }
            // A new token while push is on replaces this phone's entry on the server.
            guard !model.pushSubscriptionId.isEmpty, let client = model.client else { return }
            if let id = try? await client.registerAPNs(token: deviceToken, label: UIDevice.current.name, sandbox: Push.sandbox) { model.pushSubscriptionId = id }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in AppModel.shared.pushContinuation?.resume(throwing: error); AppModel.shared.pushContinuation = nil }
    }

    /// While the app is open the inbox shows the item already; still show the banner so it is not missed.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let link = response.notification.request.content.userInfo["url"] as? String ?? "/"
        await MainActor.run { AppModel.shared.open(link: link) }
    }
}

enum Push {
    /// Development builds get tokens for Apple's sandbox push service.
    static var sandbox: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    @MainActor
    static func enable(_ model: AppModel) async throws -> String {
        guard let client = model.client else { throw AeeisError.invalidServer }
        guard try await client.pushChannels().contains("apns") else { throw AeeisError.server(status: 409, message: "这个 AEEIS 没有打开 iPhone 推送（服务端要配 APNs）。") }
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) else { throw AeeisError.server(status: 0, message: "系统设置里没有允许 AEEIS 发通知。") }
        let token = try await withCheckedThrowingContinuation { continuation in
            model.pushContinuation = continuation
            UIApplication.shared.registerForRemoteNotifications()
        }
        let id = try await client.registerAPNs(token: token, label: UIDevice.current.name, sandbox: sandbox)
        model.pushSubscriptionId = id
        return id
    }

    @MainActor
    static func disable(_ model: AppModel) async throws {
        if let client = model.client, !model.pushSubscriptionId.isEmpty { try await client.unregisterPush(model.pushSubscriptionId) }
        model.pushSubscriptionId = ""
        UIApplication.shared.unregisterForRemoteNotifications()
    }
}

enum Keychain {
    static func read(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "co.x2v.aeeis", kSecAttrAccount as String: key, kSecReturnData as String: true]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "co.x2v.aeeis", kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty else { return }
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
