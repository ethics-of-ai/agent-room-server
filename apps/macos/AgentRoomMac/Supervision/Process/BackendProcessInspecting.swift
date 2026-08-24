import Foundation

/// Reads and signals processes this app did not spawn.
///
/// `Process` cannot attach to a pid it did not create, so an adopted sidecar is
/// driven through the kernel directly. The protocol exists so tests can drive
/// the supervisor's adoption paths without real processes.
protocol BackendProcessInspecting {
    /// The identity of whatever is live at `pid`, or `nil` when nothing is.
    func describe(pid: pid_t, port: Int) -> BackendProcessIdentity?

    /// Whether this exact process currently owns a listening TCP socket on the
    /// recorded port. Identity alone says who the process is; this says it is
    /// the backend answering where the app found a healthy service.
    func ownsListeningTCPPort(_ port: Int, for identity: BackendProcessIdentity) -> Bool

    /// Re-checks the recorded identity immediately before sending `signal` and
    /// returns whether it was sent.
    ///
    /// Darwin exposes signals by pid rather than by a stable process handle, so
    /// this closes stale-record mistakes but cannot make the identity check and
    /// `kill` one atomic kernel operation. The residual pid-reuse race is
    /// documented in the trust posture.
    @discardableResult
    func signal(_ signal: Int32, to identity: BackendProcessIdentity) -> Bool
}

extension BackendProcessInspecting {
    /// Whether the described process is still the one running under that pid.
    func isAlive(_ identity: BackendProcessIdentity) -> Bool {
        describe(pid: identity.pid, port: identity.port) == identity
    }
}
