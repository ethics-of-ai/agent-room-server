import Foundation

public struct LanguageServiceHover: Codable, Hashable, Sendable {
    public var contents: String
    public var range: LanguageServiceRange?

    public init(contents: String, range: LanguageServiceRange? = nil) {
        self.contents = contents
        self.range = range
    }
}
