import Foundation

/// Creating one directory under an existing parent. It is the only entry
/// mutation with no `baseModifiedAt`: nothing is being replaced, so there is no
/// prior version for the caller to prove it had seen. The backend refuses an
/// occupied name rather than adopting the folder that is already there, which is
/// what makes the token unnecessary rather than merely absent.
public struct WorkspaceDirectoryCreateRequest: Codable, Hashable {
    public var path: String

    public init(path: String) {
        self.path = path
    }
}
