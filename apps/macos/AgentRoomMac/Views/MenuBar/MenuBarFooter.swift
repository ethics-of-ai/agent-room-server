import AppKit
import SwiftUI

struct MenuBarFooter: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 8) {
            Button("Open AgentRoom", systemImage: "macwindow", action: openMainWindow)
                .buttonStyle(.bordered)
                .controlSize(.small)

            Spacer()

            Button("Quit", action: quit)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .keyboardShortcut("q", modifiers: [.command])
        }
    }

    private func openMainWindow() {
        openWindow(id: "main")
        NSApp.activate()
    }

    private func quit() {
        NSApplication.shared.terminate(nil)
    }
}
