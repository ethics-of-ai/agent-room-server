import Foundation

/// Who decided a permission request, as reported on `coding_permission_resolved`.
/// Open-ended by construction: an unknown authority renders as itself rather
/// than being coerced into one of these.
public enum CodingPermissionAuthority {
    public static let human = "human"
    public static let policy = "policy"
    public static let timeout = "timeout"
}
