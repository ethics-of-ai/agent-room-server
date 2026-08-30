import Foundation

/// Duplicating one entry inside the same workspace. `onCollision` is the only
/// field with no move counterpart: a copy may be asked to take the next name on
/// the backend's bounded `-2`…`-5` ladder instead of refusing, and the response
/// reports the name it actually took.
public struct WorkspaceEntryCopyRequest: Codable, Hashable {
    public enum CollisionStrategy: String, Codable, Hashable {
        case fail
        case keepBoth = "keep_both"
    }

    public var path: String
    public var destinationParent: String
    public var newName: String?
    public var baseModifiedAt: String
    public var onCollision: CollisionStrategy?

    public init(
        path: String,
        destinationParent: String,
        newName: String? = nil,
        baseModifiedAt: String,
        onCollision: CollisionStrategy? = nil
    ) {
        self.path = path
        self.destinationParent = destinationParent
        self.newName = newName
        self.baseModifiedAt = baseModifiedAt
        self.onCollision = onCollision
    }
}
