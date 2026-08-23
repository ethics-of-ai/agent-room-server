import Foundation

/// One coding-agent runner as `GET /api/runners` reports it.
///
/// This is the client half of Phase 4 of
/// `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`. Both apps used to decide
/// *which runners exist* from a compiled-in `AgentRunnerKind`, which meant a
/// runner the backend registered stayed invisible until the apps shipped again.
/// The backend's registry is the admission list; this is its safe/public
/// projection, and a client renders from it rather than from an enum.
///
/// The identity half (`runnerKind`, `displayName`) is all a picker needs, and is
/// the half a bundled offline floor can honestly supply. The availability half
/// is a *running* backend's answer, which is why it is optional rather than
/// defaulted — see `registered`.
public struct RunnerDescriptor: Codable, Hashable, Sendable, Identifiable {
    /// The wire runner id (`codex`, `claude_code`) — the descriptor's identity,
    /// and the value that travels on sessions and settings.
    public var runnerKind: String
    /// Presentation only. Never parsed, never matched on.
    public var displayName: String
    /// The backend knows this runner id exists.
    ///
    /// This and the two below are `nil` on a descriptor from the offline floor:
    /// whether a runner is registered, configured, or enabled is something only a
    /// running backend can say, and a bundled list that answered anyway would be
    /// the "ready in the UI, unusable by the backend" failure in miniature.
    public var registered: Bool?
    /// The bootstrap configuration this runner cannot start without is present.
    /// Deliberately not a readiness probe — that is a separate authority.
    public var configured: Bool?
    /// The operator has turned this runner on.
    public var enabled: Bool?
    /// What the backend's own capability discovery proved: it spawned the child,
    /// completed the handshake, and read the model list.
    ///
    /// A **different authority** from the three above, which describe
    /// configuration. `nil` means *nothing has probed* — not "not ready" — since
    /// the backend never spawns a child merely to answer `GET /api/runners`;
    /// reading a runner's capabilities is what establishes it. Whether the
    /// operator's own machine has the local prerequisite (an installed CLI, a
    /// `claude login` credential) is a third authority again, answered on the Mac
    /// because it has to work while the backend is stopped.
    public var ready: Bool?

    public var id: String { runnerKind }

    /// Whether a client should offer this runner for a **new session** now.
    ///
    /// It reads the two configuration states and deliberately not `ready`:
    /// readiness is evidence from a probe that may never have run, so refusing
    /// on it would refuse every runner nobody had asked about yet.
    ///
    /// `nil` is the load-bearing case. A descriptor from the offline floor, or
    /// from a backend that predates these fields, reports nothing — and "not
    /// reported" must read as *no reason to refuse*, never as "not configured".
    /// Defaulting the other way would empty a picker against any older backend.
    public var canStartSession: Bool {
        configured != false && enabled != false
    }

    /// Why a client is refusing it, in words someone at a headset can act on.
    ///
    /// It names no environment variable, path, or Keychain slot — a descriptor
    /// carries none by design — and points at the Mac, because that is where
    /// both answers are actually changed.
    public var unavailabilityReason: String? {
        if enabled == false { return "turned off on the Mac" }
        if configured == false { return "not set up on the Mac" }
        return nil
    }

    public init(
        runnerKind: String,
        displayName: String,
        registered: Bool? = nil,
        configured: Bool? = nil,
        enabled: Bool? = nil,
        ready: Bool? = nil
    ) {
        self.runnerKind = runnerKind
        self.displayName = displayName
        self.registered = registered
        self.configured = configured
        self.enabled = enabled
        self.ready = ready
    }

    /// A stand-in for a runner id no catalog describes — a session created
    /// against a newer backend, or a descriptor that has not hydrated yet.
    ///
    /// It shows the id *as itself*. Resolving an unknown runner to a known one
    /// would be the worst available answer: the operator would read "Codex" on a
    /// thread that is not Codex, and every posture the label implies would be
    /// wrong. A runner with no bespoke chrome must look deliberate, not broken.
    public static func placeholder(for runnerKind: String) -> RunnerDescriptor {
        RunnerDescriptor(runnerKind: runnerKind, displayName: humanizedDisplayName(for: runnerKind))
    }

    /// `acp_demo` → `Acp Demo`. Reversible and purely typographic: it can never
    /// turn one runner id into another runner's name.
    static func humanizedDisplayName(for runnerKind: String) -> String {
        let words = runnerKind
            .split(whereSeparator: { $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        return words.isEmpty ? runnerKind : words.joined(separator: " ")
    }
}

/// The `GET /api/runners` body.
public struct RunnerCatalogResponse: Codable, Hashable, Sendable {
    public var runners: [RunnerDescriptor]

    public init(runners: [RunnerDescriptor]) {
        self.runners = runners
    }
}
