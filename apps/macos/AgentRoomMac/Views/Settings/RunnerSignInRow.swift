import SwiftUI

/// Offers a runner's own sign-in when either readiness authority says the
/// operator is signed out: the local credential probe found nothing, or the
/// backend found the stored credential no longer works. Once both agree the
/// operator is signed in, it offers the matching sign-out instead.
///
/// The CLI runs in Terminal. This app writes the fixed command and reads the
/// two readiness answers again afterwards; it never handles the credential.
struct RunnerSignInRow: View {
    /// The Terminal command the operator is finishing.
    enum PendingCommand {
        case signIn
        case signOut
    }

    @Environment(BackendSupervisor.self) private var supervisor
    @State private var pending: PendingCommand?
    @State private var confirmingSignOut = false
    @State private var launchError: String?

    let descriptor: RunnerBootstrapDescriptor
    let signIn: RunnerSignInCommand

    var body: some View {
        if needsSignIn || pending == .signIn {
            if let executablePath {
                Button(signIn.title, systemImage: "person.badge.key") {
                    launch(.signIn, executablePath: executablePath)
                }
                .buttonStyle(.borderedProminent)
            } else {
                SettingsCaption(
                    text: "No local claude CLI was found to sign in with. Install Claude Code, or run claude auth login in a terminal.",
                    systemImage: "exclamationmark.triangle"
                )
            }
        } else if isSignedIn, let executablePath {
            Button(signIn.signOutTitle, systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                confirmingSignOut = true
            }
            .buttonStyle(.bordered)
            .confirmationDialog(signIn.signOutTitle, isPresented: $confirmingSignOut) {
                Button(signIn.signOutTitle, role: .destructive) {
                    launch(.signOut, executablePath: executablePath)
                }
            } message: {
                Text("This signs out every claude CLI on this Mac, including one you use in a terminal. AgentRoom turns stop until you sign in again.")
            }
        }
        if let launchError {
            StatusMessageRow(message: launchError, style: StatusStyle(systemImage: "xmark.octagon.fill", tint: .red))
        }
        if let pending {
            Text(pending == .signIn
                ? "Finish signing in in Terminal, then check again."
                : "Finish signing out in Terminal, then check again.")
                .foregroundStyle(.secondary)
            Button("Check again", systemImage: "arrow.clockwise", action: checkAgain)
                .buttonStyle(.bordered)
        }
    }

    private var credential: RunnerBootstrapCheckStatus? {
        supervisor.bootstrapStatus(runnerKind: descriptor.runnerKind, probeID: signIn.credentialProbeID)
    }

    private var loginCheckStatus: String? {
        supervisor.runnerCapabilityResults[descriptor.runnerKind]?.checks?
            .first { $0.id == signIn.readinessCheckID }?.status
    }

    private var needsSignIn: Bool {
        credential == .absent || loginCheckStatus == "unavailable"
    }

    /// The Keychain item exists and the backend, if it has answered, has not
    /// found it signed out. With the backend stopped the local probe decides.
    private var isSignedIn: Bool {
        credential?.isSatisfied == true && loginCheckStatus != "unavailable"
    }

    /// The path the executable probe resolved, else the stored slot it fills:
    /// either way, the CLI the backend launches.
    private var executablePath: String? {
        if let resolved = supervisor.bootstrapStatus(runnerKind: descriptor.runnerKind, probeID: signIn.executableProbeID)?.resolvedPath {
            return resolved
        }
        guard let slotID = descriptor.probe(signIn.executableProbeID)?.resolvedSlotID,
              let stored = supervisor.secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slotID)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !stored.isEmpty
        else { return nil }
        return stored
    }

    private func launch(_ command: PendingCommand, executablePath: String) {
        let arguments = command == .signIn ? signIn.arguments : signIn.signOutArguments
        let name = command == .signIn ? "sign-in" : "sign-out"
        Task {
            do {
                try await TerminalCommandLauncher.open(
                    script: signIn.script(executablePath: executablePath, arguments: arguments),
                    named: "AgentRoom-\(descriptor.runnerKind)-\(name)"
                )
                launchError = nil
                pending = command
            } catch {
                launchError = "Could not open Terminal: \(error.localizedDescription)"
            }
        }
    }

    private func checkAgain() {
        if let probe = descriptor.probe(signIn.credentialProbeID) {
            supervisor.checkRunnerBootstrap(probe, of: descriptor)
        }
        Task {
            if supervisor.connectionState == .reachable {
                await supervisor.checkRunnerRuntimeReadiness(runnerKind: descriptor.runnerKind)
            }
            switch pending {
            case .signIn where !needsSignIn, .signOut where needsSignIn:
                pending = nil
            default:
                break
            }
        }
    }
}
