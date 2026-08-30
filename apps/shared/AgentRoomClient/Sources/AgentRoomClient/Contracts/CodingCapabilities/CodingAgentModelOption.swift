import Foundation

public struct CodingAgentModelOption: Codable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?
    public var contextWindowTokens: Int?
    public var isDefault: Bool
    public var reasoningEfforts: [CodingAgentSettingValue]
    public var defaultReasoningEffort: String?
    public var serviceTiers: [CodingAgentSettingValue]
    public var defaultServiceTier: String?

    public init(
        id: String,
        label: String,
        description: String?,
        contextWindowTokens: Int? = nil,
        isDefault: Bool,
        reasoningEfforts: [CodingAgentSettingValue],
        defaultReasoningEffort: String?,
        serviceTiers: [CodingAgentSettingValue],
        defaultServiceTier: String?
    ) {
        self.id = id
        self.label = label
        self.description = description
        self.contextWindowTokens = contextWindowTokens
        self.isDefault = isDefault
        self.reasoningEfforts = reasoningEfforts
        self.defaultReasoningEffort = defaultReasoningEffort
        self.serviceTiers = serviceTiers
        self.defaultServiceTier = defaultServiceTier
    }
}
