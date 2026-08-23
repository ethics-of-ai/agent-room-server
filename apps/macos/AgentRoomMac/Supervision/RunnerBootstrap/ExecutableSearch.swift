import Foundation

/// Where to look for a runner's CLI when the operator has not named one.
///
/// Plain data on a bundled descriptor rather than a locator subclass per runner:
/// Codex and Claude Code differ only in the binary name and the order of the
/// places worth looking, which is exactly the difference a descriptor should
/// carry.
struct ExecutableSearch: Equatable {
    /// The binary to look for on `PATH` and in the fallback directories.
    var binaryName: String
    /// Directories to search after `PATH`, in order. `~` is expanded.
    var searchPathFallbacks: [String]
    /// Full paths to try last — an app bundle's embedded copy, say. `~` is
    /// expanded.
    var absoluteCandidates: [String]
    /// Executable basenames this contract used to accept but must no longer
    /// treat as satisfying the probe. Keeping the migration rule as descriptor
    /// data preserves the runner-independent locator while letting an app update
    /// repair a previously persisted, still-executable wrong launcher.
    var rejectedBinaryNames: Set<String> = []
}
