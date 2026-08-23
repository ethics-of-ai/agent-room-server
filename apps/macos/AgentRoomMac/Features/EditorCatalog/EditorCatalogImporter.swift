import Foundation

/// Copies an operator-chosen editor language catalog folder into the app-managed
/// override directory (`$AGENTROOM_HOME/catalog-assets`), then the backend reloads
/// from it (Phase C.5).
///
/// DATA ONLY: only `.json` and `.wasm` files are copied — never `.js`. This mirrors
/// the backend's `sync-catalog-assets.mjs` data-only rule and the catalog routes'
/// extension allowlist, so an operator can never introduce executable language
/// packs. The import is a clean replace (the override dir is emptied first) so a
/// stale grammar removed from the source can't linger and skew the manifest.
struct EditorCatalogImporter {
    enum ImportError: LocalizedError, Equatable {
        case missingIndex
        case noDataFiles

        var errorDescription: String? {
            switch self {
            case .missingIndex:
                return "The selected folder is not a catalog: it has no EditorGrammars.json at its root."
            case .noDataFiles:
                return "The selected folder has no .json or .wasm catalog data to import."
            }
        }
    }

    struct Summary: Equatable {
        var fileCount: Int
    }

    /// The only servable catalog data extensions. The TextMate engine `.js` stays
    /// bundled in the app and is never imported.
    static let allowedExtensions: Set<String> = ["json", "wasm"]

    var fileManager: FileManager = .default

    /// Clean-replace the override directory with the source folder's data files.
    @discardableResult
    func importCatalog(from sourceURL: URL, into destinationPath: String) throws -> Summary {
        let source = sourceURL.standardizedFileURL
        let indexPath = source.appendingPathComponent("EditorGrammars.json").path
        guard fileManager.fileExists(atPath: indexPath) else {
            throw ImportError.missingIndex
        }

        let files = try dataFiles(in: source)
        guard !files.isEmpty else { throw ImportError.noDataFiles }

        let destination = URL(fileURLWithPath: destinationPath, isDirectory: true)
        try replaceDirectory(at: destination)
        for file in files {
            let target = file.relativePath
                .split(separator: "/")
                .reduce(destination) { $0.appendingPathComponent(String($1)) }
            try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fileManager.copyItem(at: file.source, to: target)
        }
        return Summary(fileCount: files.count)
    }

    /// Empty the override directory so the backend falls back to its bundled catalog.
    func reset(_ destinationPath: String) throws {
        try replaceDirectory(at: URL(fileURLWithPath: destinationPath, isDirectory: true))
    }

    private func replaceDirectory(at url: URL) throws {
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }

    private func dataFiles(in root: URL) throws -> [(source: URL, relativePath: String)] {
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        let rootPrefix = root.path + "/"
        var files: [(source: URL, relativePath: String)] = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey])
            guard values.isRegularFile == true else { continue }
            guard Self.allowedExtensions.contains(fileURL.pathExtension.lowercased()) else { continue }
            let path = fileURL.standardizedFileURL.path
            guard path.hasPrefix(rootPrefix) else { continue }
            files.append((source: fileURL, relativePath: String(path.dropFirst(rootPrefix.count))))
        }
        return files.sorted { $0.relativePath < $1.relativePath }
    }
}
