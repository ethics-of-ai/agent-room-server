import Foundation

public struct CodingAgentCapabilitiesResponse: Codable, Hashable {
    public var runnerKind: String
    public var settings: CodingAgentSettingsDescriptor
    public var error: String?

    public init(runnerKind: String, settings: CodingAgentSettingsDescriptor, error: String? = nil) {
        self.runnerKind = runnerKind
        self.settings = settings
        self.error = error
    }
}
