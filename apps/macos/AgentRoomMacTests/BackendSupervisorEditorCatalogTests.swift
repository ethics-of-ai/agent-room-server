import XCTest
@testable import AgentRoomMac

@MainActor
final class BackendSupervisorEditorCatalogTests: XCTestCase {
    func testImportOwnsDestinationUntilBackendAcceptanceOrRollbackFinishes() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set(root.path, forKey: "agentRoomHomePath")
        let session = EditorCatalogTransactionURLProtocol.session()
        defer {
            session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: root)
        }
        let supervisor = BackendSupervisor(
            defaults: defaults, secretStore: Secrets(), bootstrapProber: RunnerBootstrapTestSupport.prober(),
            apiURLSession: session, launchAtLoginController: Login()
        )
        let destination = URL(fileURLWithPath: supervisor.settings.editorCatalogPath)
        let sourceA = root.appending(path: "a")
        let sourceB = root.appending(path: "b")
        for (folder, text) in [(destination, "original"), (sourceA, "a"), (sourceB, "b")] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data(text.utf8).write(to: folder.appending(path: "EditorGrammars.json"))
        }
        let first = Task { await supervisor.importEditorCatalog(from: sourceA) }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while EditorCatalogTransactionURLProtocol.reloadCount == 0, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(EditorCatalogTransactionURLProtocol.reloadCount, 1)
        await supervisor.importEditorCatalog(from: sourceB)
        await supervisor.resetEditorCatalog()
        await supervisor.reloadEditorCatalog()
        XCTAssertEqual(EditorCatalogTransactionURLProtocol.reloadCount, 1)
        XCTAssertEqual(try String(contentsOf: destination.appending(path: "EditorGrammars.json"), encoding: .utf8), "a")

        EditorCatalogTransactionURLProtocol.rejectFirstReload()
        await first.value
        XCTAssertEqual(try String(contentsOf: destination.appending(path: "EditorGrammars.json"), encoding: .utf8), "original")
        await supervisor.importEditorCatalog(from: sourceB)
        XCTAssertEqual(try String(contentsOf: destination.appending(path: "EditorGrammars.json"), encoding: .utf8), "b")
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path)
            .allSatisfy { !$0.hasPrefix(".agentroom-catalog-") })
    }

    private final class Secrets: BackendSecretStore {
        func loadSecrets() throws -> BackendSecretValues { .empty }
        func saveSecrets(_ values: BackendSecretValues) throws {}
    }

    private struct Login: LaunchAtLoginManaging {
        var isEnabled: Bool { false }
        func setEnabled(_ isEnabled: Bool) throws {}
    }
}
