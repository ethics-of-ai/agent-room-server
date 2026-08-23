import SwiftUI

@main
@MainActor
struct AgentRoomMacApp: App {
    @NSApplicationDelegateAdaptor(AppTerminationDelegate.self) private var appDelegate
    @State private var supervisor: BackendSupervisor
    @State private var threadMirrorStore: BackendThreadMirrorStore

    init() {
        let supervisor = BackendSupervisor()
        _supervisor = State(initialValue: supervisor)
        _threadMirrorStore = State(initialValue: BackendThreadMirrorStore())
        AppTerminationDelegate.supervisor = supervisor
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
