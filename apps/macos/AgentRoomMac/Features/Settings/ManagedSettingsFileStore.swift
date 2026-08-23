import Foundation

/// Reads and writes the backend-owned managed settings file,
/// `$AGENTROOM_HOME/config/settings.json`.
///
/// The Mac edits the **file**, not `PATCH /api/config`, for one reason: the
/// panes have to work while the backend is stopped — which is exactly when an
/// operator is fixing why it would not start. Same machine, atomic writes, and a
/// single operator, so cross-process contention with the backend's own
/// read-merge-write stays last-write-wins (see the plan's open questions).
///
/// Every write is a read-merge-write so a Mac-side toggle preserves the settings
/// this app never renders — the ones a paired client patched, or a hand edit
/// added — instead of rewriting the file from the four controls it owns.
///
/// The file's *shape* lives in `ManagedSettingsDocument`; this type owns the IO,
/// the validation, and the atomic publish. Both version-1 and version-2
/// documents are read, version 2 is written, and version 1 is written only for
/// the deliberate rollback path.
struct ManagedSettingsFileStore {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    /// Mirrors `resolveManagedSettingsPath` in the backend's settings store.
    static func fileURL(forAgentRoomHomePath agentRoomHomePath: String) -> URL {
        URL(fileURLWithPath: agentRoomHomePath, isDirectory: true)
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("settings.json")
    }

    func read(at url: URL) -> ManagedSettingsFileRead {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return .empty
        } catch {
            return ManagedSettingsFileRead(settings: ManagedBackendSettings(), issue: "could not be read")
        }

        guard let document = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
            return ManagedSettingsFileRead(settings: ManagedBackendSettings(), issue: "is not valid JSON")
        }

        let version: Int
        switch ManagedSettingsDocument.schemaVersion(of: document) {
        case .issue(let issue):
            return ManagedSettingsFileRead(settings: ManagedBackendSettings(), issue: issue)
        case .value(let declared):
            version = declared
        }

        guard version == ManagedSettingsDocument.currentSchemaVersion
            || version == ManagedSettingsDocument.legacySchemaVersion else {
            // Recognized as a document and still not applied: a version this app
            // does not know could mean anything, and the panes show what a
            // restart would produce. Showing values from a schema neither this
            // app nor the running backend can apply would be a lie in both
            // directions — and this file is *not* damaged, so the repair is
            // updating AgentRoom rather than resetting it.
            return ManagedSettingsFileRead(
                settings: ManagedBackendSettings(),
                issue: "uses settings schema version \(version), which this version of AgentRoom cannot read",
                unsupportedSchemaVersion: version
            )
        }

        let decoded: ManagedSettingsDocument.Decoded
        switch ManagedSettingsDocument.decode(document, version: version) {
        case .issue(let issue):
            return ManagedSettingsFileRead(settings: ManagedBackendSettings(), issue: issue)
        case .value(let value):
            decoded = value
        }

        do {
            var settings = try Self.decodeSettings(from: decoded.flat)
            settings.normalizeForBackendSchema()
            if let issue = settings.backendSchemaIssue() {
                return ManagedSettingsFileRead(
                    settings: ManagedBackendSettings(),
                    preserved: decoded.preserved,
                    issue: issue
                )
            }
            return ManagedSettingsFileRead(
                settings: settings,
                preserved: decoded.preserved,
                schemaVersion: version
            )
        } catch {
            return ManagedSettingsFileRead(
                settings: ManagedBackendSettings(),
                preserved: decoded.preserved,
                issue: Self.describe(decodingFailure: error)
            )
        }
    }

    /// Atomic publish — `Data.write(options: .atomic)` writes a sibling temp file
    /// and renames it — so the backend, which re-reads this file on every
    /// `GET /api/config`, never observes a torn document. Permissions match the
    /// `0o600` the backend writes with.
    ///
    /// `schemaVersion` defaults to the shape this release applies. Passing the
    /// legacy version is the **rollback** path — the file a pre-Phase-5 backend
    /// can still read — and is deliberately explicit rather than a fallback.
    func write(
        _ settings: ManagedBackendSettings,
        preserved: PreservedManagedSettings = PreservedManagedSettings(),
        to url: URL,
        schemaVersion: Int = ManagedSettingsDocument.currentSchemaVersion
    ) throws {
        var settings = settings
        settings.normalizeForBackendSchema()
        if let issue = settings.backendSchemaIssue() {
            throw ManagedSettingsFileStoreError.invalidSettings(issue)
        }
        guard schemaVersion == ManagedSettingsDocument.currentSchemaVersion
            || schemaVersion == ManagedSettingsDocument.legacySchemaVersion else {
            // Enforced rather than remembered: a writer that emitted a version it
            // cannot itself apply would strand the operator on a file only a
            // future AgentRoom can open.
            throw ManagedSettingsFileStoreError.unsupportedSchema(schemaVersion)
        }

        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var data = try Self.encode(settings, preserved: preserved, schemaVersion: schemaVersion)
        data.append(0x0A)
        try data.write(to: url, options: .atomic)
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Read, apply `mutate`, write back — and refuse when the file on disk cannot
    /// be parsed, because merging into it would drop the operator's other
    /// settings. `BackendSupervisor` surfaces that refusal; resetting the file is
    /// the deliberate way out (`write` above), never a silent overwrite.
    ///
    /// A version-1 file is migrated **whole** by the first write that changes
    /// anything, so the document never holds one setting at two addresses. A
    /// change that changes nothing writes nothing, so opening a pane never
    /// rewrites the operator's file underneath them.
    @discardableResult
    func update(
        at url: URL,
        _ mutate: (inout ManagedBackendSettings) -> Void
    ) throws -> ManagedBackendSettings {
        let current = read(at: url)
        if let version = current.unsupportedSchemaVersion {
            throw ManagedSettingsFileStoreError.unsupportedSchema(version)
        }
        if let issue = current.issue {
            throw ManagedSettingsFileStoreError.unusableFile(issue)
        }
        var settings = current.settings
        mutate(&settings)
        settings.normalizeForBackendSchema()
        if let issue = settings.backendSchemaIssue() {
            throw ManagedSettingsFileStoreError.invalidSettings(issue)
        }
        guard settings != current.settings else {
            return settings
        }
        // The preserved sections ride back out untouched: a toggle in these panes
        // must not be the reason a section this app cannot address disappears.
        try write(settings, preserved: current.preserved, to: url)
        return settings
    }

    /// Converts the file to the flat document a pre-Phase-5 AgentRoom reads,
    /// which is what makes running an older build a supported step rather than a
    /// one-way upgrade. Refuses a file it could not read for the same reason
    /// `update` does: it would be writing over settings it cannot see.
    ///
    /// It also refuses a posture the older build could not hold: a `runnerKind`
    /// naming a runner that predates it is a *known* key with a value that
    /// build's schema rejects, and a malformed known value makes the whole file
    /// unusable — so converting would hand the operator a document that drops
    /// every trust setting they authored. Refusing keeps the choice theirs:
    /// change the default runner, then convert. Silently rewriting `runnerKind`
    /// would be this app deciding which agent their turns run on.
    func writeLegacyDocument(at url: URL) throws {
        let current = read(at: url)
        if let version = current.unsupportedSchemaVersion {
            throw ManagedSettingsFileStoreError.unsupportedSchema(version)
        }
        if let issue = current.issue {
            throw ManagedSettingsFileStoreError.unusableFile(issue)
        }
        if let runnerKind = ManagedSettingsDocument
            .runnerKindBlockingLegacyConversion(current.settings.runnerKind) {
            throw ManagedSettingsFileStoreError.unconvertibleRunnerKind(runnerKind)
        }
        try write(
            current.settings,
            preserved: current.preserved,
            to: url,
            schemaVersion: ManagedSettingsDocument.legacySchemaVersion
        )
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        // Deterministic bytes, and the same ordering rule the backend's writer
        // uses, so the two writers produce the same file for the same settings
        // and an unchanged setting never shows up as a file change.
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    private static func encode(
        _ settings: ManagedBackendSettings,
        preserved: PreservedManagedSettings,
        schemaVersion: Int
    ) throws -> Data {
        let flat = try JSONDecoder().decode([String: JSONValue].self, from: encoder.encode(settings))
        let document = ManagedSettingsDocument.encode(
            flat: flat,
            preserved: preserved,
            schemaVersion: schemaVersion
        )
        return try encoder.encode(document)
    }

    private static func decodeSettings(from flat: [String: JSONValue]) throws -> ManagedBackendSettings {
        try JSONDecoder().decode(ManagedBackendSettings.self, from: encoder.encode(flat))
    }

    private static func describe(decodingFailure error: Error) -> String {
        guard let error = error as? DecodingError else {
            return "is not valid JSON"
        }
        switch error {
        case .dataCorrupted:
            return "is not valid JSON"
        case .typeMismatch(_, let context), .valueNotFound(_, let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? "has an unexpected value" : "has an unexpected value for \(path)"
        case .keyNotFound(let key, _):
            return "is missing \(key.stringValue)"
        @unknown default:
            return "could not be read"
        }
    }
}
