import XCTest
@testable import AgentRoomMac

@MainActor
final class LanguageServiceOperatorStateTests: XCTestCase {
    func testMapsDisabledUnconfiguredObservedAndUnobservedStatesSeparately() {
        XCTAssertEqual(state(configured: true, enabled: false, ready: nil), .disabled)
        XCTAssertEqual(state(configured: false, enabled: true, ready: nil), .notConfigured)
        XCTAssertEqual(state(configured: true, enabled: true, ready: true), .ready)
        XCTAssertEqual(state(configured: true, enabled: true, ready: false), .failed)
        XCTAssertEqual(state(configured: true, enabled: true, ready: nil), .notChecked)
    }

    private func state(configured: Bool, enabled: Bool, ready: Bool?) -> LanguageServiceOperatorState {
        LanguageServiceOperatorState(service: LanguageServiceDescriptor(
            id: "test_lsp",
            displayName: "Test LSP",
            configured: configured,
            enabled: enabled,
            ready: ready,
            languageIds: ["swift"],
            featureKinds: [.completion]
        ))
    }
}
