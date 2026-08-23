import Foundation

/// The *shape* of `$AGENTROOM_HOME/config/settings.json`, kept separate from the
/// store that reads and writes it.
///
/// Two shapes exist and both are read. Version 2 (Phase 5 of
/// `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`) nests every setting under the
/// runner that owns it, so registering a runner is what gives its settings a
/// home rather than editing a flat list in five places. Version 1 is the flat
/// legacy document — still read, migrated whole by the next write, and still
/// what {@link encode} emits for the deliberate **rollback** path, because a
/// genuinely older AgentRoom cannot be taught to read the nested shape.
///
/// Everything here is a pure function over `JSONValue`, so the migration and its
/// reverse are testable without touching a disk, and the bytes this app produces
/// can be held to the bytes the backend produces.
enum ManagedSettingsDocument {
    /// The shape this app writes.
    static let currentSchemaVersion = 2
    /// The shape a pre-Phase-5 AgentRoom reads. An *absent* version is this one.
    static let legacySchemaVersion = 1

    /// Re-exported from the settings that live under them, so this file and the
    /// addresses in `ManagedBackendSettingKey.path` cannot drift apart.
    static let globalSection = ManagedBackendSettingKey.globalSection
    static let runnersSection = ManagedBackendSettingKey.runnersSection
    static let schemaVersionField = "schemaVersion"

    static let sectionNames = [schemaVersionField, globalSection, runnersSection]

    /// The runner ids a version-1-reading AgentRoom accepts for `runnerKind`.
    ///
    /// This list describes builds that have already shipped, so it can never
    /// grow: a release that reads the flat document predates both the rollout
    /// gate that admitted a third bundled runner and the external adapters that
    /// can register a fourth. That is what makes hard-coding two ids here honest
    /// rather than a second admission list — it is a fact about the past, not a
    /// claim about which runners exist, which stays `RunnerCatalog`'s answer.
    ///
    /// It matters because of an asymmetry in how an older reader fails. An
    /// unknown `runners.<id>` namespace is preserved and never applied, so a
    /// third runner's *settings* survive a downgrade untouched — but
    /// `runnerKind` is a **known** key, and a malformed known value makes the
    /// whole file unusable, dropping the operator's entire trust posture onto
    /// defaults. See docs/engineering/DEEPSEEK_HARNESS_RUNNER.md.
    static let legacyDocumentRunnerKinds: Set<String> = ["codex", "claude_code"]

    /// The `runnerKind` that makes a document unconvertible, or `nil` when the
    /// rollback is safe.
    ///
    /// An absent key is safe: the older build then applies its own default,
    /// which is a setting the operator never wrote down rather than one this
    /// conversion lost.
    static func runnerKindBlockingLegacyConversion(_ runnerKind: String?) -> String? {
        guard let runnerKind, !legacyDocumentRunnerKinds.contains(runnerKind) else { return nil }
        return runnerKind
    }

    /// A decode that either produced a value or explains why it could not.
    /// `Result` is not available here: its failure type must conform to `Error`,
    /// and these issues are the same human sentences the backend reports.
    enum Decoding<Value: Equatable>: Equatable {
        case value(Value)
        case issue(String)
    }

    struct Decoded: Equatable {
        /// The settings at their flat version-1 keys, which is how this app holds
        /// them in memory (`ManagedBackendSettings`) regardless of the file shape.
        var flat: [String: JSONValue]
        var preserved: PreservedManagedSettings
    }

    /// The version a document declares. An absent `schemaVersion` *is* version 1.
    static func schemaVersion(of document: [String: JSONValue]) -> Decoding<Int> {
        guard let declared = document[schemaVersionField] else { return .value(legacySchemaVersion) }
        guard case .number(let value) = declared, let version = Int(exactly: value) else {
            return .issue("has an unexpected value for \(schemaVersionField)")
        }
        return .value(version)
    }

    static func decode(_ document: [String: JSONValue], version: Int) -> Decoding<Decoded> {
        version == currentSchemaVersion ? decodeCurrent(document) : decodeLegacy(document)
    }

    /// Serializes settings back into a document. `flat` carries only the keys
    /// this app addresses; `preserved` carries what it does not, and the two can
    /// never collide because a preserved entry is by definition an address no
    /// `ManagedBackendSettingKey` claims.
    static func encode(
        flat: [String: JSONValue],
        preserved: PreservedManagedSettings,
        schemaVersion: Int
    ) -> [String: JSONValue] {
        schemaVersion == legacySchemaVersion
            ? encodeLegacy(flat: flat, preserved: preserved)
            : encodeCurrent(flat: flat, preserved: preserved)
    }

    private static func decodeCurrent(_ document: [String: JSONValue]) -> Decoding<Decoded> {
        if let legacyKey = ManagedBackendSettingKey.allCases.first(where: { document[$0.rawValue] != nil }) {
            // One file, exactly one schema. Assigning precedence between a
            // version-2 section and a legacy key at the top level would be a
            // silent answer to a question the operator did not know they asked.
            return .issue("declares schema version \(currentSchemaVersion) alongside the legacy key \(legacyKey.rawValue)")
        }
        if let unexpected = document.keys.filter({ !sectionNames.contains($0) }).sorted().first {
            return .issue("has an unexpected key \(unexpected)")
        }

        var flat: [String: JSONValue] = [:]
        var preserved = PreservedManagedSettings()

        if let global = document[globalSection] {
            guard case .object(let fields) = global else {
                return .issue("has an unexpected value for \(globalSection)")
            }
            for (field, value) in fields {
                let path = "\(globalSection).\(field)"
                guard let key = ManagedBackendSettingKey.allCases.first(where: { $0.path == path }) else {
                    // Forward compatibility: preserved, never applied.
                    preserved.global[field] = value
                    continue
                }
                if case .null = value { return .issue("has an unexpected value for \(path)") }
                flat[key.rawValue] = value
            }
        }

        if let runners = document[runnersSection] {
            guard case .object(let sections) = runners else {
                return .issue("has an unexpected value for \(runnersSection)")
            }
            for (runnerKind, section) in sections {
                guard case .object(let fields) = section else {
                    return .issue("has an unexpected value for \(runnersSection).\(runnerKind)")
                }
                for (field, value) in fields {
                    let path = "\(runnersSection).\(runnerKind).\(field)"
                    guard let key = ManagedBackendSettingKey.allCases.first(where: { $0.path == path }) else {
                        // An unregistered runner's whole namespace lands here too,
                        // one field at a time: this app cannot address what it did
                        // not compile in.
                        preserved.runners[runnerKind, default: [:]][field] = value
                        continue
                    }
                    if case .null = value { return .issue("has an unexpected value for \(path)") }
                    flat[key.rawValue] = value
                }
            }
        }

        return .value(Decoded(flat: flat, preserved: preserved))
    }

    private static func decodeLegacy(_ document: [String: JSONValue]) -> Decoding<Decoded> {
        let known = Set(ManagedBackendSettingKey.allCases.map(\.rawValue)).union(sectionNames)
        // Swift's synthesized `Codable` ignores unknown keys and turns an explicit
        // null into `nil`; the backend's schema is `.strict()` with optional —
        // not nullable — fields. Preflighting here is what keeps the panes from
        // showing a file the backend drops whole.
        if let unexpected = document.keys.filter({ !known.contains($0) }).sorted().first {
            return .issue("has an unexpected key \(unexpected)")
        }
        if let nullKey = document.keys.filter({ if case .null = document[$0] { return true } else { return false } })
            .sorted().first {
            return .issue("has an unexpected value for \(nullKey)")
        }

        var flat: [String: JSONValue] = [:]
        for key in ManagedBackendSettingKey.allCases {
            if let value = document[key.rawValue] { flat[key.rawValue] = value }
        }

        var preserved = PreservedManagedSettings()
        if let global = document[globalSection] {
            guard case .object(let fields) = global else {
                return .issue("has an unexpected value for \(globalSection)")
            }
            preserved.global = unaddressedFields(fields, prefix: globalSection)
        }
        if let runners = document[runnersSection] {
            guard case .object(let sections) = runners else {
                return .issue("has an unexpected value for \(runnersSection)")
            }
            for (runnerKind, section) in sections {
                guard case .object(let fields) = section else {
                    return .issue("has an unexpected value for \(runnersSection).\(runnerKind)")
                }
                let unknown = unaddressedFields(fields, prefix: "\(runnersSection).\(runnerKind)")
                if !unknown.isEmpty { preserved.runners[runnerKind] = unknown }
            }
        }

        return .value(Decoded(flat: flat, preserved: preserved))
    }

    /// In a version-1 document these sections were never applied — the flat key
    /// is what the backend resolved — so carrying a *known* address across the
    /// migration would silently activate a trust value the running backend had
    /// been ignoring. Only the addresses nobody claims survive.
    private static func unaddressedFields(_ fields: [String: JSONValue], prefix: String) -> [String: JSONValue] {
        let addressed = Set(ManagedBackendSettingKey.allCases.map(\.path))
        return fields.filter { !addressed.contains("\(prefix).\($0.key)") }
    }

    private static func encodeCurrent(
        flat: [String: JSONValue],
        preserved: PreservedManagedSettings
    ) -> [String: JSONValue] {
        var global: [String: JSONValue] = [:]
        var runners: [String: [String: JSONValue]] = [:]

        for key in ManagedBackendSettingKey.allCases {
            guard let value = flat[key.rawValue] else { continue }
            guard let scope = ManagedBackendSettingKey.runnerScope(forKey: key.rawValue) else {
                global[key.rawValue] = value
                continue
            }
            runners[scope.runnerKind, default: [:]][scope.field] = value
        }

        // Last, and verbatim: this app does not read these and must not be the
        // reason they are lost.
        for (field, value) in preserved.global where global[field] == nil {
            global[field] = value
        }
        for (runnerKind, section) in preserved.runners {
            for (field, value) in section where runners[runnerKind]?[field] == nil {
                runners[runnerKind, default: [:]][field] = value
            }
        }

        var document: [String: JSONValue] = [schemaVersionField: .number(Double(currentSchemaVersion))]
        if !global.isEmpty { document[globalSection] = .object(global) }
        if !runners.isEmpty {
            document[runnersSection] = .object(runners.mapValues { JSONValue.object($0) })
        }
        return document
    }

    /// The reverse serializer: the flat document a pre-Phase-5 AgentRoom reads.
    /// `schemaVersion` is deliberately absent, because an absent version *is*
    /// version 1 — stamping it would produce a file the older reader calls
    /// malformed, which is the opposite of a rollback.
    private static func encodeLegacy(
        flat: [String: JSONValue],
        preserved: PreservedManagedSettings
    ) -> [String: JSONValue] {
        var document: [String: JSONValue] = [:]
        for key in ManagedBackendSettingKey.allCases {
            if let value = flat[key.rawValue] { document[key.rawValue] = value }
        }
        // A version-1 document has nowhere to *address* these, but it can still
        // carry them: the pre-Phase-5 reader tolerates both names and writes them
        // back untouched, which is what makes the downgrade reversible.
        if !preserved.global.isEmpty { document[globalSection] = .object(preserved.global) }
        if !preserved.runners.isEmpty {
            document[runnersSection] = .object(preserved.runners.mapValues { JSONValue.object($0) })
        }
        return document
    }
}
