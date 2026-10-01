import XCTest
@testable import AgentRoomMac

@MainActor
final class AppAppearanceTests: XCTestCase {
    func testFallbackPersistenceAndSystemResolution() throws {
        let name = "AppAppearanceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("unknown", forKey: "appAppearance")
        let store = AppAppearanceStore(defaults: defaults)
        XCTAssertEqual(store.selection, .system)
        XCTAssertNil(store.selection.colorScheme)
        store.selection = .dark
        XCTAssertEqual(AppAppearanceStore(defaults: defaults).selection, .dark)
        XCTAssertEqual(store.selection.colorScheme, .dark)
        store.selection = .system
        XCTAssertNil(AppAppearanceStore(defaults: defaults).selection.colorScheme)
    }
}
