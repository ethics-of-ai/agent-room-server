import Foundation

public struct LanguageServiceSemanticTokens: Codable, Hashable, Sendable {
    public var data: [Int]

    public init(data: [Int]) {
        self.data = data
    }
}
