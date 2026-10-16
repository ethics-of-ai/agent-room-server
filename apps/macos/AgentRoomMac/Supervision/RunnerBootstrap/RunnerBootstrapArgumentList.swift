import Foundation

/// A runner's argument list as one slot stores it: comma-separated, because it
/// reaches the backend as one environment variable.
///
/// Parsed the way the backend's `listEnv` parses it, trimming each item and
/// dropping empty ones, so a check here reads the same argument the backend
/// will launch.
enum RunnerBootstrapArgumentList {
    /// The first argument, or `nil` when there is none. For a Node runner it is
    /// the entrypoint.
    static func first(in value: String?) -> String? {
        value?
            .split(separator: ",")
            .lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
    }
}
