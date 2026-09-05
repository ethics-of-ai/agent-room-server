import Foundation

/// Half-open range expressed in zero-based UTF-16 positions.
public struct LanguageServiceRange: Codable, Hashable, Sendable {
    public var start: LanguageServicePosition
    public var end: LanguageServicePosition

    public init(start: LanguageServicePosition, end: LanguageServicePosition) {
        self.start = start
        self.end = end
    }
}
