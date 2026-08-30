import Foundation

public struct CodingAgentSettingsDescriptor: Codable, Hashable {
    public var models: [CodingAgentModelOption]
    public var defaultSettings: CodingAgentTurnSettings

    public var defaultModel: CodingAgentModelOption? {
        models.first { $0.isDefault } ?? models.first
    }

    public init(models: [CodingAgentModelOption], defaultSettings: CodingAgentTurnSettings) {
        self.models = models
        self.defaultSettings = defaultSettings
    }

    public func model(for id: String?) -> CodingAgentModelOption? {
        guard let id else { return defaultModel }
        return models.first { $0.id == id } ?? defaultModel
    }
}
