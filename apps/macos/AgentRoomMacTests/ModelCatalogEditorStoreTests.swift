import XCTest
@testable import AgentRoomMac

@MainActor
final class ModelCatalogEditorStoreTests: XCTestCase {
    private var localFileURL: URL!

    override func setUp() {
        super.setUp()
        localFileURL = ModelCatalogFileStore.fileURL(forAgentRoomHomePath: ModelCatalogTestSupport.temporaryHome().path)
    }

    private func loadedStore() -> ModelCatalogEditorStore {
        let store = ModelCatalogEditorStore()
        store.load(bundledCatalogURL: ModelCatalogTestSupport.bundledCatalogURL, localFileURL: localFileURL)
        return store
    }

    func testStartsFromTheBundledCatalogWithNothingToSave() {
        let store = loadedStore()

        XCTAssertTrue(store.isLoaded)
        XCTAssertFalse(store.hasUnsavedChanges)
        XCTAssertFalse(store.canSave)
        XCTAssertFalse(ModelCatalogRunner.allCases.contains(where: store.isCustomized))
    }

    func testSavesOnlyTheChangedRunner() throws {
        let store = loadedStore()
        store.addModel(to: .deepseek)
        store.deepseek.models[store.deepseek.models.count - 1].id = "deepseek-local"
        store.deepseek.models[store.deepseek.models.count - 1].label = "  Local  "

        XCTAssertTrue(store.isCustomized(.deepseek))
        XCTAssertFalse(store.isCustomized(.cursor))
        store.save(backendIsRunning: true)

        let written = try XCTUnwrap(ModelCatalogFileStore().read(at: localFileURL))
        XCTAssertNil(written.runners.claudeCode)
        XCTAssertNil(written.runners.cursor)
        XCTAssertEqual(written.runners.deepseek?.models.last?.label, "Local")
        XCTAssertFalse(store.hasUnsavedChanges)
        XCTAssertTrue(store.isAwaitingRestart)

        store.backendDidRestart()
        XCTAssertFalse(store.isAwaitingRestart)
    }

    func testResettingTheLastCustomizedRunnerRemovesTheFile() throws {
        let store = loadedStore()
        store.deepseek.models[0].label = "Renamed"
        store.save(backendIsRunning: false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: localFileURL.path))
        XCTAssertFalse(store.isAwaitingRestart)

        store.resetToBundled(.deepseek)
        store.save(backendIsRunning: false)

        XCTAssertFalse(FileManager.default.fileExists(atPath: localFileURL.path))
    }

    func testReloadsASavedLocalCopy() {
        let store = loadedStore()
        store.moveModel(store.claudeCode.fallbackModels[1].rowID, by: -1, in: .claudeCode)
        let reordered = store.claudeCode.fallbackModels.map(\.id)
        store.save(backendIsRunning: false)

        let reloaded = loadedStore()

        XCTAssertEqual(reloaded.claudeCode.fallbackModels.map(\.id), reordered)
        XCTAssertTrue(reloaded.isCustomized(.claudeCode))
        XCTAssertFalse(reloaded.hasUnsavedChanges)
    }

    func testAnInvalidLocalCopyCanBeReplaced() throws {
        try FileManager.default.createDirectory(at: localFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{".utf8).write(to: localFileURL)

        let store = loadedStore()

        XCTAssertNotNil(store.localFileIssue)
        XCTAssertTrue(store.canSave)
        store.save(backendIsRunning: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: localFileURL.path))
    }

    func testRefusesToSaveWhileTheFormHasIssues() {
        let store = loadedStore()
        store.addModel(to: .deepseek)

        XCTAssertFalse(store.issues.isEmpty)
        XCTAssertFalse(store.canSave)
        store.save(backendIsRunning: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: localFileURL.path))
    }

    func testClaudeCodeEffortTogglesKeepTheShortForm() {
        let vocabulary = ["low", "medium", "high", "xhigh"]
        var model = ClaudeCodeCatalogModel(id: "opus", label: "Opus")

        model[effort: "xhigh", vocabulary: vocabulary] = false
        XCTAssertEqual(model.reasoningEfforts, ["low", "medium", "high"])
        model[effort: "xhigh", vocabulary: vocabulary] = true
        XCTAssertNil(model.reasoningEfforts)
    }
}
