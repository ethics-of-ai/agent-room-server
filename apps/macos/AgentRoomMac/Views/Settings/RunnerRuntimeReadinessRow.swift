import SwiftUI

/// What the *backend* proved about a runner, beside what this Mac can see.
///
/// Deliberately a separate row from the bootstrap probes above it: the two
/// answer different questions and can honestly disagree — a `claude` CLI can be
/// installed here while the backend still fails to spawn it — and collapsing
/// them is what produces a runner that reads ready and cannot start.
struct RunnerRuntimeReadinessRow: View {
    @Environment(BackendSupervisor.self) private var supervisor

    let runnerKind: String

    var body: some View {
        StatusMessageRow(message: message, style: style)
        Button("Check with backend", systemImage: "stethoscope") {
            Task { await supervisor.checkRunnerRuntimeReadiness(runnerKind: runnerKind) }
        }
        .buttonStyle(.bordered)
        .disabled(supervisor.connectionState != .reachable)
    }

    private var ready: Bool? {
        supervisor.runnerCatalog.descriptor(for: runnerKind).ready
    }

    private var message: String {
        switch ready {
        case true:
            "The backend started this runner and read its model list."
        case false:
            "The backend could not start this runner. Check its capabilities response for the reason."
        default:
            supervisor.connectionState == .reachable
                ? "The backend has not tried to start this runner yet."
                : "Start the backend to check whether it can run this runner."
        }
    }

    private var style: StatusStyle {
        switch ready {
        case true:
            StatusStyle(systemImage: "checkmark.circle.fill", tint: .green)
        case false:
            StatusStyle(systemImage: "exclamationmark.triangle.fill", tint: .orange)
        default:
            // Unprobed is not unready, so it must not read as a warning.
            StatusStyle(systemImage: "info.circle.fill", tint: .secondary)
        }
    }
}
