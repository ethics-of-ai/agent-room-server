import Foundation
import SystemConfiguration

struct AppSettings: Equatable {
    var serverPort: Int
    var workspacePath: String
    var statePath: String
    var agentRoomHomePath: String
    var launchAtLoginEnabled = false
    var autoRestartBackendAfterCrash = true
    // The Mac-side master switch for remote tier-2 edits, injected as
    // REMOTE_SETTINGS_ADMIN. OFF by default, and deliberately *not* a managed
    // key: a setting in the backend's own settings file could be granted by
    // whoever already holds the bearer token, which is the escalation this
    // switch exists to prevent. See docs/safety/TRUST_AND_SAFETY.md.
    var remoteSettingsAdminEnabled = false

    static let defaultServerPort = 8787
    static let defaultRunnerKind = "codex"

    static var defaults: AppSettings {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let appHome = home
            .appendingPathComponent("Library")
            .appendingPathComponent("Application Support")
            .appendingPathComponent("AgentRoom")
            .path
        return AppSettings(
            serverPort: defaultServerPort,
            workspacePath: defaultWorkspacePath(for: appHome),
            statePath: defaultStatePath(for: appHome),
            agentRoomHomePath: appHome
        )
    }

    static func defaultWorkspacePath(for agentRoomHomePath: String) -> String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Developer", isDirectory: true)
            .appendingPathComponent("AgentRoom", isDirectory: true)
            .appendingPathComponent("Workspaces", isDirectory: true)
            .standardizedFileURL
            .path
    }

    static func defaultStatePath(for agentRoomHomePath: String) -> String {
        URL(fileURLWithPath: agentRoomHomePath, isDirectory: true)
            .appendingPathComponent("state", isDirectory: true)
            .standardizedFileURL
            .path
    }

    /// Operator-managed editor language catalog override directory (Phase C.5).
    /// The Languages pane imports catalog data here; the backend reads the same
    /// path from `EDITOR_CATALOG_DIR` and prefers it over the bundled catalog.
    static func editorCatalogPath(for agentRoomHomePath: String) -> String {
        URL(fileURLWithPath: agentRoomHomePath, isDirectory: true)
            .appendingPathComponent("catalog-assets", isDirectory: true)
            .standardizedFileURL
            .path
    }

    var editorCatalogPath: String {
        Self.editorCatalogPath(for: agentRoomHomePath)
    }

    /// The backend-owned managed settings file. The backend resolves the same
    /// path from `AGENTROOM_HOME`, so the panes and the sidecar read one file.
    var managedSettingsFileURL: URL {
        ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: agentRoomHomePath)
    }

    var usesDefaultWorkspacePath: Bool {
        standardizedPath(workspacePath) == standardizedPath(Self.defaultWorkspacePath(for: agentRoomHomePath))
    }

    var usesDefaultStatePath: Bool {
        standardizedPath(statePath) == standardizedPath(Self.defaultStatePath(for: agentRoomHomePath))
    }

    var localServerURL: URL {
        URL(string: "http://localhost:\(serverPort)")!
    }

    var macHostnameServerURLString: String? {
        guard let localHostName = Self.localHostName else {
            return nil
        }
        return "http://\(localHostName).local:\(serverPort)"
    }

    var lanIPAddressServerURLStrings: [String] {
        Self.activeIPv4Addresses().map { "http://\($0):\(serverPort)" }
    }

    var lanServerURLStrings: [String] {
        var candidates: [String] = []
        if let macHostnameServerURLString {
            candidates.append(macHostnameServerURLString)
        }
        candidates.append(contentsOf: lanIPAddressServerURLStrings)
        return Array(NSOrderedSet(array: candidates)) as? [String] ?? candidates
    }

    var primaryLANServerURLString: String {
        lanServerURLStrings.first ?? "No LAN address detected"
    }

    private static var localHostName: String? {
        guard let name = SCDynamicStoreCopyLocalHostName(nil) as String? else {
            return nil
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func activeIPv4Addresses() -> [String] {
        var interfaceAddresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaceAddresses) == 0, let firstAddress = interfaceAddresses else {
            return []
        }
        defer { freeifaddrs(interfaceAddresses) }

        var addresses: [String] = []
        var pointer: UnsafeMutablePointer<ifaddrs>? = firstAddress
        while let current = pointer {
            defer { pointer = current.pointee.ifa_next }

            let interface = current.pointee
            let flags = Int32(interface.ifa_flags)
            guard flags & IFF_UP == IFF_UP,
                  flags & IFF_LOOPBACK == 0,
                  let socketAddress = interface.ifa_addr,
                  socketAddress.pointee.sa_family == UInt8(AF_INET) else {
                continue
            }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                socketAddress,
                socklen_t(socketAddress.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            if result == 0 {
                addresses.append(String(cString: host))
            }
        }
        return addresses.sorted()
    }
}

private func standardizedPath(_ value: String) -> String {
    URL(fileURLWithPath: NSString(string: value).expandingTildeInPath)
        .standardizedFileURL
        .path
}
