import Foundation

/// Stages data-only catalog imports beside the live override so activation and
/// rollback use same-volume directory renames.
struct EditorCatalogImporter {
    enum ImportError: LocalizedError, Equatable {
        case missingIndex
        case noDataFiles

        var errorDescription: String? {
            switch self {
            case .missingIndex:
                "The selected folder is not a catalog: it has no regular EditorGrammars.json at its root."
            case .noDataFiles:
                "The selected folder has no .json or .wasm catalog data to import."
            }
        }
    }

    struct Summary: Equatable, Sendable {
        var fileCount: Int
    }

    final class Transaction: @unchecked Sendable {
        private enum State: Equatable { case staged, activated, finished }

        let summary: Summary
        private let destination: URL
        private let candidate: URL
        private let backup: URL
        private let hadDestination: Bool
        private var state = State.staged

        fileprivate init(summary: Summary, destination: URL, candidate: URL, backup: URL, hadDestination: Bool) {
            self.summary = summary
            self.destination = destination
            self.candidate = candidate
            self.backup = backup
            self.hadDestination = hadDestination
        }

        func activate(fileManager: FileManager = .default) throws {
            guard state == .staged else { return }
            if hadDestination {
                try fileManager.moveItem(at: destination, to: backup)
            }
            do {
                try fileManager.moveItem(at: candidate, to: destination)
            } catch {
                // Put the previous override back so a failed swap leaves the
                // working catalog live; `rollback()` retries if this move fails.
                state = .activated
                if hadDestination, fileManager.fileExists(atPath: backup.path),
                   (try? fileManager.moveItem(at: backup, to: destination)) != nil {
                    state = .staged
                }
                throw error
            }
            state = .activated
        }

        func commit(fileManager: FileManager = .default) throws {
            guard state == .activated else { return }
            if fileManager.fileExists(atPath: backup.path) {
                try fileManager.removeItem(at: backup)
            }
            state = .finished
        }

        func rollback(fileManager: FileManager = .default) throws {
            if state == .activated, fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            if state == .activated, hadDestination, fileManager.fileExists(atPath: backup.path) {
                try fileManager.moveItem(at: backup, to: destination)
            }
            if fileManager.fileExists(atPath: candidate.path) {
                try fileManager.removeItem(at: candidate)
            }
            state = .finished
        }
    }

    static let allowedExtensions: Set<String> = ["json", "wasm"]
    var fileManager: FileManager = .default

    /// Copy the candidate without touching the currently working override.
    func stageCatalog(from sourceURL: URL, into destinationPath: String) throws -> Transaction {
        let source = sourceURL.standardizedFileURL
        let index = source.appending(path: "EditorGrammars.json")
        let indexValues = try? index.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard indexValues?.isRegularFile == true, indexValues?.isSymbolicLink != true else {
            throw ImportError.missingIndex
        }

        let files = try dataFiles(in: source)
        guard !files.isEmpty else { throw ImportError.noDataFiles }

        let destination = URL(fileURLWithPath: destinationPath, isDirectory: true).standardizedFileURL
        let parent = destination.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        let nonce = UUID().uuidString
        let candidate = parent.appending(path: ".agentroom-catalog-candidate-\(nonce)", directoryHint: .isDirectory)
        let backup = parent.appending(path: ".agentroom-catalog-backup-\(nonce)", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: candidate, withIntermediateDirectories: false)
        do {
            for file in files {
                let target = file.relativePath.split(separator: "/").reduce(candidate) {
                    $0.appending(path: String($1))
                }
                try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try fileManager.copyItem(at: file.source, to: target)
            }
        } catch {
            try? fileManager.removeItem(at: candidate)
            throw error
        }
        return Transaction(
            summary: Summary(fileCount: files.count),
            destination: destination,
            candidate: candidate,
            backup: backup,
            hadDestination: fileManager.fileExists(atPath: destination.path)
        )
    }

    func reset(_ destinationPath: String) throws {
        let destination = URL(fileURLWithPath: destinationPath, isDirectory: true)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)
    }

    private func dataFiles(in root: URL) throws -> [(source: URL, relativePath: String)] {
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        let rootPrefix = root.path + "/"
        var files: [(source: URL, relativePath: String)] = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            guard Self.allowedExtensions.contains(fileURL.pathExtension.lowercased()) else { continue }
            let path = fileURL.standardizedFileURL.path
            guard path.hasPrefix(rootPrefix) else { continue }
            files.append((source: fileURL, relativePath: String(path.dropFirst(rootPrefix.count))))
        }
        return files.sorted { $0.relativePath < $1.relativePath }
    }
}
