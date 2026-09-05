import Foundation

public struct LanguageServiceCatalog: Codable, Hashable, Sendable {
    public var protocolVersion: Int
    public var services: [LanguageServiceDescriptor]

    public init(protocolVersion: Int, services: [LanguageServiceDescriptor]) {
        self.protocolVersion = protocolVersion
        self.services = services
    }
}
