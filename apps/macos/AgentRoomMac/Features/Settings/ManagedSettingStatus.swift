import Foundation

/// What the running backend reports about one managed setting, reduced to the
/// three things these panes render: the value in force, whether an environment
/// variable has locked the key, and what a restart would change it to.
///
/// It is derived from `/api/config`, so it exists only while the backend is
/// reachable. Absent metadata means "we cannot know yet", which the panes say
/// rather than guess: the file this app just wrote is the pending state, and the
/// running process is the only thing that can report the value in force.
struct ManagedSettingStatus: Equatable {
    /// The value the running backend resolved at startup. The panes normally
    /// render the file-backed pending value, but an environment lock makes that
    /// file value inert, so a locked control must render this value instead.
    var runningValue: JSONValue?

    /// `source == "env"`. An environment variable wins and locks the key, so the
    /// settings file is inert for it and the pane's control must be read-only —
    /// otherwise the operator would toggle something that changes nothing.
    var isEnvironmentLocked = false

    /// The value a backend restart would produce.
    ///
    /// `nil` means nothing is pending. `.some(.null)` means a restart would leave
    /// the key *unset* — a real, different outcome, which is why this keeps the
    /// backend's absent-versus-null distinction instead of flattening it.
    var pendingValue: JSONValue?

    init(
        runningValue: JSONValue? = nil,
        isEnvironmentLocked: Bool = false,
        pendingValue: JSONValue? = nil
    ) {
        self.runningValue = runningValue
        self.isEnvironmentLocked = isEnvironmentLocked
        self.pendingValue = pendingValue
    }

    init(metadata: PublicManagedSetting) {
        self.runningValue = metadata.value
        self.isEnvironmentLocked = metadata.source == "env"
        self.pendingValue = metadata.pendingValue
    }

    func displayedString(fileValue: String?) -> String? {
        guard isEnvironmentLocked else { return fileValue }
        return runningValue?.stringValue ?? fileValue
    }

    func displayedBool(fileValue: Bool) -> Bool {
        guard isEnvironmentLocked else { return fileValue }
        return runningValue?.boolValue ?? fileValue
    }

    var hasPendingChange: Bool {
        pendingValue != nil
    }

    /// Short, human-readable form of the pending value for a caption.
    var pendingDescription: String? {
        guard let pendingValue else { return nil }
        switch pendingValue {
        case .bool(let value):
            return value ? "enabled" : "disabled"
        case .string(let value):
            return value
        case .number(let value):
            return value == value.rounded() ? String(Int(value)) : String(value)
        case .null:
            return "unset"
        case .object, .array:
            return "changed"
        }
    }
}
