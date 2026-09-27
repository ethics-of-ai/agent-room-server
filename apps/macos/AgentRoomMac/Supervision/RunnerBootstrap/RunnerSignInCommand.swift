import Foundation

/// A runner's own interactive sign-in and sign-out, run in Terminal so the
/// operator drives it and the credential goes straight between the CLI and its
/// store.
///
/// Bundled like the rest of the descriptor: the arguments are fixed here, and
/// the executable is the one the runner's executable probe resolved, which is
/// the path the backend launches. The app never sees what the CLI stores.
struct RunnerSignInCommand: Equatable {
    var title: String
    /// The probe whose resolved path is the CLI to run.
    var executableProbeID: String
    var arguments: [String]
    var signOutTitle: String
    var signOutArguments: [String]
    /// The local credential probe; `absent` offers sign-in while the backend
    /// is stopped.
    var credentialProbeID: String
    /// The backend readiness check that proves the credential still works.
    /// `unavailable` offers sign-in even when the local credential exists.
    var readinessCheckID: String
    /// Shown instead of the button when no local CLI resolved.
    var missingExecutableMessage: String
    /// The sign-out confirmation: what else on the Mac loses its sign-in.
    var signOutWarning: String

    /// The Terminal script. It deletes itself first, so a stale copy cannot be
    /// reopened, and every path and argument is single-quoted for zsh.
    func script(executablePath: String, arguments: [String]) -> String {
        let command = ([executablePath] + arguments).map(Self.shellQuoted).joined(separator: " ")
        return """
        #!/bin/zsh
        rm -f -- "$0"
        \(command)
        echo
        echo "Return to AgentRoom and choose Check again."

        """
    }

    static func shellQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
