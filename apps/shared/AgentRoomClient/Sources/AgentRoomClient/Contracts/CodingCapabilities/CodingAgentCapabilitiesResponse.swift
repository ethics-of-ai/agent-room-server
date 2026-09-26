import Foundation

public struct CodingAgentCapabilitiesResponse: Codable, Hashable {
    public var runnerKind: String
    public var settings: CodingAgentSettingsDescriptor
    public var error: String?
    public var checks: [CodingAgentCapabilityCheck]?
    public var connectionTestAvailable: Bool?
    public var sessionNotice: String?
    public var modelSelectionScope: String?

    public init(runnerKind: String, settings: CodingAgentSettingsDescriptor, error: String? = nil, checks: [CodingAgentCapabilityCheck]? = nil) {
        self.runnerKind = runnerKind
        self.settings = settings
        self.error = error
        self.checks = checks
    }
}
