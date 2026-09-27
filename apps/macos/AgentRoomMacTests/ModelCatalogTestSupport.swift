import Foundation

/// The backend's real bundled catalog, so these tests fail if the Swift types
/// stop decoding the file the backend ships.
enum ModelCatalogTestSupport {
    static var bundledCatalogURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("backend/src/runner/modelCatalog.json")
    }

    static func temporaryHome() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("agentroom-model-catalog-\(UUID().uuidString)", isDirectory: true)
    }
}
