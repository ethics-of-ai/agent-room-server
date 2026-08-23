import Foundation

enum ManagedSettingsFileStoreError: LocalizedError, Equatable {
    /// The file exists but could not be parsed, so merging into it would
    /// silently drop whatever else the operator (or a paired client) put there.
    /// The backend answers `PATCH /api/config` with `409` in the same state.
    case unusableFile(String)
    /// A caller attempted to publish an in-memory value the backend schema
    /// would reject. The store validates before writing, matching the backend.
    case invalidSettings(String)
    /// The file declares a settings schema this app cannot read, or a caller
    /// asked to write one. Distinct from `unusableFile` because the file is not
    /// damaged: the repair is updating AgentRoom, and resetting would discard a
    /// posture the operator authored on a newer version.
    case unsupportedSchema(Int)
    /// The rollback conversion would produce a file the older AgentRoom rejects
    /// **whole**, because `runnerKind` names a runner it does not know. Refused
    /// rather than converted-anyway or silently rewritten: the conversion exists
    /// to carry the operator's trust posture across a downgrade, and a document
    /// that drops all of it onto defaults is the failure it prevents.
    case unconvertibleRunnerKind(String)

    var errorDescription: String? {
        switch self {
        case .unusableFile(let reason):
            return "Backend settings file is unusable: \(reason)"
        case .invalidSettings(let reason):
            return "Backend settings are invalid: \(reason)"
        case .unsupportedSchema(let version):
            return "Backend settings file uses settings schema version \(version), "
                + "which this version of AgentRoom cannot read. Update AgentRoom to change these settings."
        case .unconvertibleRunnerKind(let runnerKind):
            return "Backend settings select the \(runnerKind) runner, which an older AgentRoom does not know. "
                + "It would reject the whole file and fall back to defaults, losing your trust posture. "
                + "Change the default runner to Codex or Claude Code, then convert."
        }
    }
}
