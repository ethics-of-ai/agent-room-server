import Foundation

/// Asks whether a regular file exists at a path, and nothing else.
///
/// The file analog of `KeychainPresenceProbe`, under the same rule: the probe
/// is **presence-only**. It stats the path and never opens, reads, returns, or
/// logs it, because the file *is* the credential — Cursor's SDK writes the key
/// its web sign-in mints to `~/.cursor/sdk/auth.json`, a file the SDK owns and
/// this app's Keychain cannot see. Presence cannot tell an expired key from a
/// live one; that is the backend's authority (`ready` on `GET /api/runners`),
/// and keeping the two apart is the two-authorities rule in
/// `docs/clients/MACOS.md`. That posture is documented in
/// `docs/safety/TRUST_AND_SAFETY.md` and must not be widened into a read.
struct FilePresenceProbe {
    private let fileManager: FileManager
    /// What `~` expands to. Injected so a test can point the probe at its own
    /// directory instead of the developer's real sign-in.
    private let homeDirectory: String

    init(fileManager: FileManager = .default, homeDirectory: String = NSHomeDirectory()) {
        self.fileManager = fileManager
        self.homeDirectory = homeDirectory
    }

    enum Presence: Equatable {
        case present
        case absent
    }

    /// Present only for a regular file: a directory at the path is not a
    /// sign-in, and reporting it as one would satisfy a required check with
    /// nothing the SDK can use.
    func presence(at path: String) -> Presence {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: expandingTilde(in: path), isDirectory: &isDirectory),
              !isDirectory.boolValue else {
            return .absent
        }
        return .present
    }

    private func expandingTilde(in path: String) -> String {
        if path == "~" {
            return homeDirectory
        }
        if path.hasPrefix("~/") {
            return homeDirectory + path.dropFirst()
        }
        return path
    }
}
