import Foundation

/// The runners a client may offer, and the one place that decides what to show
/// for a runner id it has never heard of.
///
/// Clients hydrate this from `GET /api/runners` while connected. The macOS app
/// falls back to ``builtIn`` because it edits backend settings *while the backend
/// is stopped*, which is exactly when it cannot ask. A remote client pairing with
/// a backend that predates the route uses ``legacyBackendFallback`` instead, so a
/// runner introduced after that route is never advertised without a backend
/// descriptor. Both floors are deliberately identity-only (see
/// `RunnerDescriptor.registered`).
public struct RunnerCatalog: Hashable, Sendable {
    public var descriptors: [RunnerDescriptor]

    public init(descriptors: [RunnerDescriptor]) {
        self.descriptors = descriptors
    }

    /// The offline floor: the runners this app was built knowing about.
    ///
    /// It is a *fallback*, not the source of truth, and it is not the same
    /// statement as the backend's admission list — a backend may register more.
    /// Keeping it identity-only is what stops it from claiming a runner is
    /// configured on a machine it has not asked.
    public static let builtIn = RunnerCatalog(descriptors: [
        RunnerDescriptor(runnerKind: AgentRunnerKind.codex.rawValue, displayName: AgentRunnerKind.codex.displayName),
        RunnerDescriptor(
            runnerKind: AgentRunnerKind.claudeCode.rawValue,
            displayName: AgentRunnerKind.claudeCode.displayName
        ),
        RunnerDescriptor(
            runnerKind: AgentRunnerKind.deepseek.rawValue,
            displayName: AgentRunnerKind.deepseek.displayName
        ),
        RunnerDescriptor(
            runnerKind: AgentRunnerKind.cursor.rawValue,
            displayName: AgentRunnerKind.cursor.displayName
        )
    ])

    /// The compatibility floor for a remote client whose runner-catalog read
    /// failed or reached a backend that predates `GET /api/runners`.
    ///
    /// Only runners shipped before the route belong here. A newer runner needs
    /// the backend's `configured` and `enabled` answers before a remote client
    /// may offer it; adding it on silence would create a session that can only
    /// fail on its first turn. The Mac does not use this floor: its bundled
    /// bootstrap descriptors and backend-written offline catalog are separate
    /// local authorities.
    public static let legacyBackendFallback = RunnerCatalog(descriptors: [
        RunnerDescriptor(runnerKind: AgentRunnerKind.codex.rawValue, displayName: AgentRunnerKind.codex.displayName),
        RunnerDescriptor(
            runnerKind: AgentRunnerKind.claudeCode.rawValue,
            displayName: AgentRunnerKind.claudeCode.displayName
        )
    ])

    public var isEmpty: Bool { descriptors.isEmpty }

    /// The descriptor for a runner id, or a placeholder that displays the id as
    /// itself. Never `nil`, and never another runner: a caller that has an id to
    /// render always gets something honest to render it with.
    public func descriptor(for runnerKind: String) -> RunnerDescriptor {
        descriptors.first { $0.runnerKind == runnerKind } ?? .placeholder(for: runnerKind)
    }

    public func displayName(for runnerKind: String) -> String {
        descriptor(for: runnerKind).displayName
    }

    /// The catalog a picker should offer, with `selected` guaranteed present.
    ///
    /// A session pinned to a runner the catalog no longer lists — a backend that
    /// dropped it, or a descriptor that has not hydrated — must still render as
    /// itself rather than silently reading as whichever runner happens to be
    /// first.
    public func includingSelection(_ selected: String?) -> [RunnerDescriptor] {
        guard let selected, !descriptors.contains(where: { $0.runnerKind == selected }) else {
            return descriptors
        }
        return descriptors + [.placeholder(for: selected)]
    }
}
