import Foundation

public struct LanguageServiceDefinition: Codable, Hashable, Sendable {
    public var path: String
    public var range: LanguageServiceRange

    public init(path: String, range: LanguageServiceRange) {
        self.path = path
        self.range = range
    }
}
