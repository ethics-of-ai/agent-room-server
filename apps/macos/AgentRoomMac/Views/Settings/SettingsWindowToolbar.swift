import AppKit
import SwiftUI

/// Settings scenes ignore SwiftUI's window toolbar style on some macOS versions.
struct SettingsWindowToolbar: NSViewRepresentable {
    func makeNSView(context: Context) -> ToolbarView {
        ToolbarView()
    }

    func updateNSView(_ nsView: ToolbarView, context: Context) {
        nsView.window?.toolbarStyle = .unifiedCompact
    }

    final class ToolbarView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.toolbarStyle = .unifiedCompact
        }
    }
}
