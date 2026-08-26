import Foundation

/// Runs one bootstrap probe and reports what it found.
///
/// Deliberately **pure**: it reads the machine and returns an outcome, and never
/// writes the Keychain. Persisting a resolved path is the supervisor's job, so a
/// save failure is reported as the probe's failure message rather than silently
/// leaving a value the next launch would not use.
struct RunnerBootstrapProber {
    var environment: [String: String]
    var fileManager: FileManager
    var keychain: KeychainPresenceProbe
    var filePresence: FilePresenceProbe
    /// Overrides the search a descriptor declares, keyed by `runnerKind/probeID`.
    /// Tests point a probe at a temporary directory with it; production passes
    /// none and the descriptor's own search is used.
    var searchOverrides: [String: ExecutableSearch]

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        keychain: KeychainPresenceProbe = KeychainPresenceProbe(),
        filePresence: FilePresenceProbe = FilePresenceProbe(),
        searchOverrides: [String: ExecutableSearch] = [:]
    ) {
        self.environment = environment
        self.fileManager = fileManager
        self.keychain = keychain
        self.filePresence = filePresence
        self.searchOverrides = searchOverrides
    }

    static func overrideKey(runnerKind: String, probeID: String) -> String {
        "\(runnerKind)/\(probeID)"
    }

    /// What a probe found, plus the slot value the caller should persist.
    struct Outcome: Equatable {
        var status: RunnerBootstrapCheckStatus
        /// Set only when the probe resolved a *new* path for a slot.
        var resolvedSlot: ResolvedSlot?

        struct ResolvedSlot: Equatable {
            var slotID: String
            var path: String
        }
    }

    func run(
        _ probe: RunnerBootstrapProbe,
        of descriptor: RunnerBootstrapDescriptor,
        storedValue: (String) -> String?
    ) -> Outcome {
        switch probe.kind {
        case .executablePath(let slotID, let declaredSearch):
            let search = searchOverrides[Self.overrideKey(runnerKind: descriptor.runnerKind, probeID: probe.id)]
                ?? declaredSearch
            let locator = ExecutablePathLocator(search: search, environment: environment, fileManager: fileManager)
            if let current = storedValue(slotID)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !current.isEmpty,
               locator.isExecutablePath(current) {
                return Outcome(status: .satisfied(detail: current), resolvedSlot: nil)
            }
            // Reaching here means any stored path failed the executable check, so
            // a CLI that was moved or removed is replaced rather than left pinned.
            guard let located = locator.locateExecutable(
                explicitEnvironmentName: descriptor.slot(slotID)?.environmentName
            ) else {
                return Outcome(status: .absent, resolvedSlot: nil)
            }
            return Outcome(
                status: .detected(detail: located.path),
                resolvedSlot: Outcome.ResolvedSlot(slotID: slotID, path: located.path)
            )

        case .filePath(let slotID):
            guard let current = storedValue(slotID)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !current.isEmpty,
                  let normalized = normalizedReadableFilePath(current) else {
                return Outcome(status: .absent, resolvedSlot: nil)
            }
            guard normalized != current else {
                return Outcome(status: .satisfied(detail: normalized), resolvedSlot: nil)
            }
            // Persist expansion/standardization so the backend receives the
            // absolute path this check proved, never a `~` or relative spelling
            // whose meaning would change under the runner child's workspace cwd.
            return Outcome(
                status: .detected(detail: normalized),
                resolvedSlot: Outcome.ResolvedSlot(slotID: slotID, path: normalized)
            )

        case .keychainPresence(let service):
            switch keychain.presence(ofService: service) {
            case .present:
                return Outcome(status: .satisfied(detail: nil), resolvedSlot: nil)
            case .absent:
                return Outcome(status: .absent, resolvedSlot: nil)
            case .failed(let reason):
                return Outcome(
                    status: .failed(message: probe.messages.filled(probe.messages.failure, with: reason)),
                    resolvedSlot: nil
                )
            }

        case .filePresence(let path):
            // Presence carries no detail on purpose: the path is the
            // credential's location, and the status row, the setup checklist,
            // and the diagnostics log all render what this returns.
            switch filePresence.presence(at: path) {
            case .present:
                return Outcome(status: .satisfied(detail: nil), resolvedSlot: nil)
            case .absent:
                return Outcome(status: .absent, resolvedSlot: nil)
            }
        }
    }

    private func normalizedReadableFilePath(_ path: String) -> String? {
        let expanded = NSString(string: path).expandingTildeInPath
        guard NSString(string: expanded).isAbsolutePath else { return nil }
        let normalized = URL(fileURLWithPath: expanded).standardizedFileURL.path
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: normalized, isDirectory: &isDirectory),
              !isDirectory.boolValue,
              fileManager.isReadableFile(atPath: normalized) else {
            return nil
        }
        return normalized
    }
}
