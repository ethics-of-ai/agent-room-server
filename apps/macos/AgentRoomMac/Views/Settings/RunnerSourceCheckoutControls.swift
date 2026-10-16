import SwiftUI

/// The shortest way to set a runner up from a source checkout: choose the
/// folder, and fix the checkout from here when it is outdated or unbuilt.
///
/// The fix runs in Terminal, like a runner's sign-in, so the operator sees
/// every command. This view writes the fixed script and rechecks the same
/// folder afterwards; it never runs the build itself.
struct RunnerSourceCheckoutControls: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var launchError: String?

    let runnerName: String
    let descriptor: RunnerBootstrapDescriptor
    let contract: RunnerBootstrapSourceCheckout

    var body: some View {
        Button("Use a source checkout…", systemImage: "folder.badge.gearshape", action: chooseCheckout)
            .buttonStyle(.bordered)
        if let note = contract.note {
            SettingsCaption(text: note.text, systemImage: note.systemImage)
        }
        if let outcome {
            // Required styling: a walk the operator explicitly asked for that
            // came back empty is a failure to report, not a neutral state.
            StatusMessageRow(message: outcome.message, style: outcome.status.style(for: .required))
            if let repair = outcome.repair {
                HStack {
                    Button(repair.title, systemImage: "terminal") {
                        launch(repair, root: outcome.root)
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Check again", systemImage: "arrow.clockwise") {
                        checkAgain(outcome.root)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        if let launchError {
            StatusMessageRow(message: launchError, style: .failure)
        }
    }

    private var outcome: RunnerBootstrapSourceCheckoutOutcome? {
        supervisor.sourceCheckoutOutcomes[descriptor.runnerKind]
    }

    private func chooseCheckout() {
        guard let root = chooseCheckoutFolder() else { return }
        launchError = nil
        supervisor.adoptSourceCheckout(root, of: descriptor)
    }

    /// Matches the folder pickers the workspace and catalog panes already use,
    /// rather than `fileImporter`: this is a modal operator action on macOS, and
    /// one picker idiom in the app beats two.
    private func chooseCheckoutFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Select the \(runnerName) source checkout. Its built entrypoint is read from it."
        panel.prompt = "Use Checkout"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.directoryURL = outcome?.root.deletingLastPathComponent()
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func checkAgain(_ root: URL) {
        supervisor.adoptSourceCheckout(root, of: descriptor)
    }

    private func launch(_ repair: RunnerBootstrapCheckoutRepair, root: URL) {
        Task {
            launchError = await TerminalCommandLauncher.openReportingFailure(
                script: repair.script(root: root),
                named: "AgentRoom-\(descriptor.runnerKind)-checkout"
            )
        }
    }
}
