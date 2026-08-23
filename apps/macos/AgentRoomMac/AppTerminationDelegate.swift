import AppKit

@MainActor
final class AppTerminationDelegate: NSObject, NSApplicationDelegate {
    static weak var supervisor: BackendSupervisor?

    func applicationWillTerminate(_ notification: Notification) {
        Self.supervisor?.shutdownNow()
    }
}
