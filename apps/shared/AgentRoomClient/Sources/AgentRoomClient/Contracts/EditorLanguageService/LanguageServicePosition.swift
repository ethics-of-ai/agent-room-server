import Foundation

/// Zero-based UTF-16 position, matching the backend language-service protocol.
public struct LanguageServicePosition: Codable, Hashable, Sendable {
    public var line: Int
    public var character: Int

    public init(line: Int, character: Int) {
        self.line = line
        self.character = character
    }
}
