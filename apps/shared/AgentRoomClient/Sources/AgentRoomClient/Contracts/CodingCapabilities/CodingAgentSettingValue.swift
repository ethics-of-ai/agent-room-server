import Foundation

public struct CodingAgentSettingValue: Codable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?

    public init(id: String, label: String, description: String?) {
        self.id = id
        self.label = label
        self.description = description
    }
}
