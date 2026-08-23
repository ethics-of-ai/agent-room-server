import Foundation

/// Resolves a runner's CLI from an `ExecutableSearch`, so "find the binary" is
/// one implementation rather than one per runner.
///
/// It replaced two near-identical locators that differed only in the binary name
/// and the order of the directories worth trying — the difference a descriptor
/// carries. A runner that ships a CLI therefore needs no locator of its own.
struct ExecutablePathLocator {
    var environment: [String: String]
    var search: ExecutableSearch

    private let fileManager: FileManager

    init(
        search: ExecutableSearch,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) {
        self.search = search
        self.environment = environment
        self.fileManager = fileManager
    }

    /// The first candidate that is an executable file, or `nil` when the machine
    /// has none.
    func locateExecutable(explicitEnvironmentName: String? = nil) -> URL? {
        candidateURLs(explicitEnvironmentName: explicitEnvironmentName).first(where: isAcceptedExecutableFile)
    }

    func isExecutablePath(_ path: String) -> Bool {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return isAcceptedExecutableFile(URL(fileURLWithPath: trimmed.expandingTilde))
    }

    private func candidateURLs(explicitEnvironmentName: String?) -> [URL] {
        var candidates: [URL] = []
        // An operator who exported the runner's own variable has already
        // answered this question; it leads.
        if let explicitEnvironmentName,
           let explicitPath = environment[explicitEnvironmentName]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !explicitPath.isEmpty {
            candidates.append(URL(fileURLWithPath: explicitPath.expandingTilde))
        }
        for searchPath in searchPathComponents() {
            candidates.append(
                URL(fileURLWithPath: searchPath, isDirectory: true).appendingPathComponent(search.binaryName)
            )
        }
        candidates.append(contentsOf: search.absoluteCandidates.map { URL(fileURLWithPath: $0.expandingTilde) })

        var seen = Set<String>()
        return candidates.compactMap { candidate in
            let standardized = candidate.standardizedFileURL
            guard seen.insert(standardized.path).inserted else { return nil }
            return standardized
        }
    }

    private func searchPathComponents() -> [String] {
        let environmentPaths = environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        var seen = Set<String>()
        return (environmentPaths + search.searchPathFallbacks).compactMap { path in
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return nil }
            return trimmed.expandingTilde
        }
    }

    private func isExecutableFile(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return false
        }
        return fileManager.isExecutableFile(atPath: url.path)
    }

    private func isAcceptedExecutableFile(_ url: URL) -> Bool {
        !search.rejectedBinaryNames.contains(url.lastPathComponent) && isExecutableFile(url)
    }
}

private extension String {
    var expandingTilde: String {
        NSString(string: self).expandingTildeInPath
    }
}
