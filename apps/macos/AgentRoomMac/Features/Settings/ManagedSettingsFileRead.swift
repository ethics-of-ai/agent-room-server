import Foundation

/// The outcome of reading `$AGENTROOM_HOME/config/settings.json`.
///
/// A file that exists but cannot be used lands as an `issue` with empty
/// `settings`, mirroring the backend, which drops an unusable file *whole*
/// rather than per key: a partially applied trust file is a worse answer than
/// the conservative defaults. Because both sides agree, an operator who breaks
/// the file by hand sees the same story in the pane and in the running backend.
struct ManagedSettingsFileRead: Equatable {
    var settings: ManagedBackendSettings
    /// Sections the file carried that this app cannot address, to be written back
    /// untouched. Reported even alongside an `issue`, so the deliberate reset
    /// path can clear the settings this app owns without discarding them.
    var preserved: PreservedManagedSettings = PreservedManagedSettings()
    /// Set only when a file was present and could not be used. A missing file is
    /// the ordinary first-run state, not an issue.
    var issue: String?
    /// Set when the file declares a settings schema this app cannot apply. It
    /// carries an `issue` as well — an inapplicable file is as unusable as a
    /// broken one — but the two must stay distinguishable: this file is not
    /// damaged, so resetting it would destroy a posture the operator authored on
    /// a newer AgentRoom.
    var unsupportedSchemaVersion: Int?
    /// The schema version the document declared, when it could be applied. The
    /// panes use it to say whether the next write would migrate the file.
    var schemaVersion: Int?

    static let empty = ManagedSettingsFileRead(settings: ManagedBackendSettings())
}
