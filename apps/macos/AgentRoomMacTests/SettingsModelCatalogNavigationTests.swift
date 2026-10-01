import SwiftUI
import XCTest
@testable import AgentRoomMac

@MainActor
final class SettingsModelCatalogNavigationTests: XCTestCase {
    func testPendingRestartSurvivesLeavingModelsAndClearsWhileHidden() async throws {
        // SwiftUI exposes its virtual accessibility tree only while an AX client is active.
        NSApplication.shared.accessibilitySetValue(
            true, forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
        )
        defer {
            NSApplication.shared.accessibilitySetValue(
                false, forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
            )
        }
        let home = ModelCatalogTestSupport.temporaryHome()
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set(home.path, forKey: "agentRoomHomePath")
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: home)
        }
        let supervisor = BackendSupervisor(
            defaults: defaults, secretStore: EmptySecretStore(), bootstrapDescriptors: []
        )
        let store = ModelCatalogEditorStore()
        store.load(
            bundledCatalogURL: ModelCatalogTestSupport.bundledCatalogURL,
            localFileURL: ModelCatalogFileStore.fileURL(forAgentRoomHomePath: home.path)
        )
        store.deepseek.models[0].label = "Navigation fixture"
        store.save(backendIsRunning: true)
        XCTAssertTrue(store.isAwaitingRestart)

        func content(_ section: SettingsSection) -> some View {
            SettingsPaneContent(section: section)
                .environment(supervisor)
                .environment(store)
                .environment(AppAppearanceStore(defaults: defaults))
        }
        let host = NSHostingView(rootView: content(.models))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 640),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }

        await settle(host)
        XCTAssertTrue(labels(in: window).contains("Restart backend"))
        host.rootView = content(.appearance)
        await settle(host)
        host.rootView = content(.models)
        await settle(host)
        XCTAssertTrue(labels(in: window).contains("Restart backend"))
        XCTAssertTrue(store.isAwaitingRestart)

        // A restart can happen from another window while Models is absent.
        host.rootView = content(.appearance)
        await settle(host)
        store.backendDidRestart()
        host.rootView = content(.models)
        await settle(host)
        XCTAssertFalse(labels(in: window).contains("Restart backend"))

        // Remounting Models must also retain edits that have not been saved.
        store.deepseek.models[0].label = "Unsaved navigation fixture"
        host.rootView = content(.appearance)
        await settle(host)
        host.rootView = content(.models)
        await settle(host)
        XCTAssertEqual(store.deepseek.models[0].label, "Unsaved navigation fixture")
        XCTAssertTrue(store.hasUnsavedChanges)
    }

    private func settle(_ host: NSView) async {
        host.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(50))
        host.layoutSubtreeIfNeeded()
    }

    private func labels(in element: Any) -> [String] {
        guard let accessible = element as? NSObject else { return [] }
        func value(_ name: String, attribute: String) -> Any? {
            let selector = NSSelectorFromString(name)
            if accessible.responds(to: selector),
               let result = accessible.perform(selector)?.takeUnretainedValue() { return result }
            let legacySelector = NSSelectorFromString("accessibilityAttributeValue:")
            guard accessible.responds(to: legacySelector) else { return nil }
            return accessible.perform(legacySelector, with: attribute)?.takeUnretainedValue()
        }
        var own = [value("accessibilityLabel", attribute: "AXDescription"),
                   value("accessibilityTitle", attribute: "AXTitle"),
                   value("accessibilityValue", attribute: "AXValue")]
            .compactMap { $0 as? String }
        if let view = element as? NSView {
            own += view.subviews.flatMap { labels(in: $0) }
        }
        if let button = element as? NSButton { own.append(button.title) }
        return own + ((value("accessibilityChildren", attribute: "AXChildren") as? [Any]) ?? [])
            .flatMap { labels(in: $0) }
    }

    private struct EmptySecretStore: BackendSecretStore {
        func loadSecrets() throws -> BackendSecretValues { .empty }
        func saveSecrets(_ values: BackendSecretValues) throws {}
    }
}
