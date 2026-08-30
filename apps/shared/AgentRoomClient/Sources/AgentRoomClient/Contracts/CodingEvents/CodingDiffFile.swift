import Foundation

public struct CodingDiffFile: Codable, Hashable, Identifiable, Sendable {
    public var path: String
    public var status: String
    public var additions: Int?
    public var deletions: Int?

    public var id: String {
        path
    }

    public init(path: String, status: String, additions: Int? = nil, deletions: Int? = nil) {
        self.path = path
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}
