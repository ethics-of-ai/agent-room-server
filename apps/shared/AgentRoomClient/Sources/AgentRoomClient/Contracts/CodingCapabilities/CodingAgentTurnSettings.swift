import Foundation

public struct CodingAgentTurnSettings: Codable, Hashable {
    public var model: String?
    public var reasoningEffort: String?
    public var serviceTier: String?

    public var isEmpty: Bool {
        model == nil && reasoningEffort == nil && serviceTier == nil
    }

    public init(model: String? = nil, reasoningEffort: String? = nil, serviceTier: String? = nil) {
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.serviceTier = serviceTier
    }
}
