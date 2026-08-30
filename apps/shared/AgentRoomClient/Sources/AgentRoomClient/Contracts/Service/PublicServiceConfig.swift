import Foundation

/// Safe client-renderable subset of the backend's `/api/config` response. Only the
/// fields the visionOS client renders are decoded; the backend sends more (release
/// compatibility, Codex/Claude posture) and any extra keys are ignored. `terminalEnabled`
/// is optional so an older backend that predates the field decodes as `nil` (treated as off).
public struct PublicServiceConfig: Codable, Hashable {
    public var runnerKind: String
    /// Which `coding_*` event contract the backend speaks. Optional so a
    /// backend that predates the field decodes as `nil`, which the client reads
    /// as version 1 (legacy per-runner metadata, no canonical activity).
    public var codingEventContractVersion: Int?
    public var requireAuth: Bool
    public var terminalEnabled: Bool?
    public var sceneEngineEnabled: Bool?
    /// Managed-settings metadata keyed by setting name. Optional so a backend
    /// that predates the shared settings store still decodes.
    public var settings: [String: PublicManagedSetting]?
    /// The Mac-side master switch for remote tier-2 edits (`REMOTE_SETTINGS_ADMIN`).
    public var remoteSettingsAdmin: Bool?

    /// The lowest coding-event contract this client can render. The backend
    /// dual-emits the legacy metadata blocks until its own advertised version
    /// passes this, so a mismatch is informational rather than fatal.
    public static let minimumCodingEventContractVersion = 1

    public var codingEventContract: Int {
        codingEventContractVersion ?? 1
    }

    public init(
        runnerKind: String,
        codingEventContractVersion: Int? = nil,
        requireAuth: Bool,
        terminalEnabled: Bool?,
        sceneEngineEnabled: Bool? = nil,
        settings: [String: PublicManagedSetting]? = nil,
        remoteSettingsAdmin: Bool? = nil
    ) {
        self.runnerKind = runnerKind
        self.codingEventContractVersion = codingEventContractVersion
        self.requireAuth = requireAuth
        self.terminalEnabled = terminalEnabled
        self.sceneEngineEnabled = sceneEngineEnabled
        self.settings = settings
        self.remoteSettingsAdmin = remoteSettingsAdmin
    }
}
