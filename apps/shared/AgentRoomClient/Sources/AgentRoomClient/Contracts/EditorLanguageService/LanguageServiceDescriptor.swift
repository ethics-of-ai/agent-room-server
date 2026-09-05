import Foundation

public struct LanguageServiceDescriptor: Codable, Hashable, Sendable {
    public var id: String
    public var displayName: String
    public var configured: Bool
    public var enabled: Bool
    public var ready: Bool?
    public var languageIds: [String]
    public var featureKinds: [LanguageServiceFeatureKind]

    public init(
        id: String,
        displayName: String,
        configured: Bool,
        enabled: Bool,
        ready: Bool? = nil,
        languageIds: [String],
        featureKinds: [LanguageServiceFeatureKind]
    ) {
        self.id = id
        self.displayName = displayName
        self.configured = configured
        self.enabled = enabled
        self.ready = ready
        self.languageIds = languageIds
        self.featureKinds = featureKinds
    }
}
