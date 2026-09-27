import XCTest
@testable import AgentRoomMac

final class ModelCatalogFileStoreTests: XCTestCase {
    private let store = ModelCatalogFileStore()

    func testDecodesTheBackendBundledCatalog() throws {
        let document = try XCTUnwrap(store.read(at: ModelCatalogTestSupport.bundledCatalogURL))

        XCTAssertEqual(document.schemaVersion, ModelCatalogDocument.currentSchemaVersion)
        XCTAssertFalse(try XCTUnwrap(document.runners.claudeCode).fallbackModels.isEmpty)
        XCTAssertEqual(try XCTUnwrap(document.runners.cursor).fallbackModels.filter(\.isDefault).count, 1)
        XCTAssertFalse(try XCTUnwrap(document.runners.deepseek).models.isEmpty)
        XCTAssertEqual(ModelCatalogValidator.issues(in: document.runners), [])
    }

    func testPathsMatchTheBackend() {
        XCTAssertEqual(
            ModelCatalogFileStore.fileURL(forAgentRoomHomePath: "/tmp/home").path,
            "/tmp/home/config/models.json"
        )
        XCTAssertEqual(
            ModelCatalogFileStore.bundledCatalogURL(forBackendEntrypoint: URL(fileURLWithPath: "/app/backend/dist/index.js")).path,
            "/app/backend/dist/runner/modelCatalog.json"
        )
    }

    func testAbsentFileReadsAsNil() throws {
        XCTAssertNil(try store.read(at: ModelCatalogTestSupport.temporaryHome().appendingPathComponent("models.json")))
    }

    func testWritesOnlyListedRunnersWithoutEmptyFields() throws {
        let url = ModelCatalogFileStore.fileURL(forAgentRoomHomePath: ModelCatalogTestSupport.temporaryHome().path)
        let runners = ModelCatalogDocument.Runners(
            deepseek: DeepSeekModelCatalog(models: [DeepSeekCatalogModel(id: "deepseek-flash", label: "Flash")])
        )

        try store.write(runners, to: url)

        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let written = try XCTUnwrap(json?["runners"] as? [String: Any])
        XCTAssertEqual(Array(written.keys), ["deepseek"])
        let model = try XCTUnwrap((written["deepseek"] as? [String: Any])?["models"] as? [[String: Any]]).first
        // The backend's schema is strict: an empty description or a null would
        // make it ignore the whole file.
        XCTAssertEqual(model?.keys.sorted(), ["id", "label"])
        XCTAssertEqual(try store.read(at: url)?.runners, runners)
    }

    func testWritingNoRunnersRemovesTheFile() throws {
        let url = ModelCatalogFileStore.fileURL(forAgentRoomHomePath: ModelCatalogTestSupport.temporaryHome().path)
        try store.write(ModelCatalogDocument.Runners(deepseek: DeepSeekModelCatalog(models: [])), to: url)

        try store.write(ModelCatalogDocument.Runners(), to: url)

        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testRejectsANewerSchema() throws {
        let url = ModelCatalogTestSupport.temporaryHome().appendingPathComponent("models.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"schemaVersion":2,"runners":{}}"#.utf8).write(to: url)

        XCTAssertThrowsError(try store.read(at: url)) { error in
            XCTAssertEqual(error as? ModelCatalogFileStoreError, .unsupportedSchema(2))
        }
    }
}
