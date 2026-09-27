import Foundation

/// Reads the backend's bundled model catalog and reads and writes the
/// operator's local copy at `$AGENTROOM_HOME/config/models.json`.
///
/// The app writes the local copy directly, like `settings.json`, so it can be
/// edited while the backend is stopped. The backend reads it once at startup
/// and ignores an invalid copy, so `ModelCatalogValidator` checks a document
/// before it is written.
struct ModelCatalogFileStore {
    /// Mirrors `MODEL_CATALOG_MAX_BYTES` in the backend's `runner/modelCatalog.ts`.
    static let maxBytes = 256 * 1024

    var fileManager: FileManager = .default

    /// Mirrors `resolveModelCatalogPath` in the backend's `runner/modelCatalog.ts`.
    static func fileURL(forAgentRoomHomePath agentRoomHomePath: String) -> URL {
        URL(fileURLWithPath: agentRoomHomePath, isDirectory: true)
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("models.json")
    }

    /// The compiled backend ships its catalog beside its entrypoint, at
    /// `dist/runner/modelCatalog.json`.
    static func bundledCatalogURL(forBackendEntrypoint entrypoint: URL) -> URL {
        entrypoint.deletingLastPathComponent()
            .appendingPathComponent("runner", isDirectory: true)
            .appendingPathComponent("modelCatalog.json")
    }

    /// The document at `url`, or `nil` when there is no file.
    func read(at url: URL) throws -> ModelCatalogDocument? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw ModelCatalogFileStoreError.unreadable(error.localizedDescription)
        }
        guard data.count <= Self.maxBytes else { throw ModelCatalogFileStoreError.tooLarge }
        let document: ModelCatalogDocument
        do {
            document = try JSONDecoder().decode(ModelCatalogDocument.self, from: data)
        } catch {
            throw ModelCatalogFileStoreError.unreadable("not a model catalog")
        }
        guard document.schemaVersion == ModelCatalogDocument.currentSchemaVersion else {
            throw ModelCatalogFileStoreError.unsupportedSchema(document.schemaVersion)
        }
        return document
    }

    /// Publishes `runners` atomically, or removes the file when no runner is
    /// customized so the backend uses the bundled catalog.
    func write(_ runners: ModelCatalogDocument.Runners, to url: URL) throws {
        guard !runners.isEmpty else {
            try remove(at: url)
            return
        }
        let document = ModelCatalogDocument(
            comment: ModelCatalogDocument.localFileComment,
            schemaVersion: ModelCatalogDocument.currentSchemaVersion,
            runners: runners
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(document)
        data.append(0x0A)
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    func remove(at url: URL) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }
}
