import SwiftUI

@main
@MainActor
struct AgentRoomMacApp: App {
    @NSApplicationDelegateAdaptor(AppTerminationDelegate.self) private var appDelegate
    @State private var supervisor: BackendSupervisor
    @State private var threadMirrorStore: BackendThreadMirrorStore
    @State private var updateController: AppUpdateController

    init() {
        let supervisor = BackendSupervisor()
        let updateRelaunchState = AppUpdateRelaunchState()
        _supervisor = State(initialValue: supervisor)
        _threadMirrorStore = State(initialValue: BackendThreadMirrorStore())
        _updateController = State(
            initialValue: AppUpdateController(
                relaunchState: updateRelaunchState,
                shouldRestartBackendAfterUpdate: { supervisor.hasSupervisedProcess }
            )
        )
        AppTerminationDelegate.supervisor = supervisor
        AppTerminationDelegate.updateRelaunchState = updateRelaunchState
    }

    var body: some Scene {
        WindowGroup("AgentRoom", id: "main") {
            SupervisionDashboardView()
                .environment(supervisor)
                .environment(threadMirrorStore)
                .frame(minWidth: 920, minHeight: 620)
        }
        .defaultSize(width: 1080, height: 720)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesButton(updateController: updateController)

                Divider()

                Button("Refresh Backend Status") {
                    Task { await supervisor.refreshConnectionStatus() }
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }

        Settings {
            SettingsView()
                .environment(supervisor)
        }

        MenuBarExtra {
            MenuBarStatusView()
                .environment(supervisor)
        } label: {
            MenuBarLabel(state: supervisor.serverState)
        }
        .menuBarExtraStyle(.window)
    }
}
