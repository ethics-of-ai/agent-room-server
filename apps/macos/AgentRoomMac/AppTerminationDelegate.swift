import AppKit

@MainActor
final class AppTerminationDelegate: NSObject, NSApplicationDelegate {
    static weak var supervisor: BackendSupervisor?
    static var updateRelaunchState: AppUpdateRelaunchState?
    private var pendingTerminationTask: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard Self.updateRelaunchState?.consumeBackendRestartRequired() == true else {
            return
        }
        Self.supervisor?.startServer()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard pendingTerminationTask == nil else { return .terminateLater }
        guard let supervisor = Self.supervisor, supervisor.hasSupervisedProcess else {
            return .terminateNow
        }

        pendingTerminationTask = Task { @MainActor [weak self] in
            let stopped = await supervisor.stopForApplicationTermination()
            if !stopped {
                Self.updateRelaunchState?.clearBackendRestartRequired()
            }
            self?.pendingTerminationTask = nil
            sender.reply(toApplicationShouldTerminate: stopped)
        }
        return .terminateLater
    }
}
