import Foundation

/// Relocating one entry to another folder in the same workspace. `newName` is
/// omitted for a plain paste, which keeps the entry's own name, and supplied
/// when the paste also renames. `destinationParent` may be empty: "" is the
/// workspace root, a real paste target.
public struct WorkspaceEntryMoveRequest: Codable, Hashable {
    public var path: String
    public var destinationParent: String
    public var newName: String?
    public var baseModifiedAt: String

    public init(path: String, destinationParent: String, newName: String? = nil, baseModifiedAt: String) {
        self.path = path
        self.destinationParent = destinationParent
        self.newName = newName
        self.baseModifiedAt = baseModifiedAt
    }
}
