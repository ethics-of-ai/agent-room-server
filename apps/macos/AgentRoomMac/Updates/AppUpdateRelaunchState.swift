import Foundation

/// One-shot handoff between Sparkle's old app process and the newly installed
/// process. A normal launch does not start the backend; a Sparkle relaunch does
/// because the update stopped the sidecar as part of terminating the old app.
struct AppUpdateRelaunchState {
    private static let restartBackendKey = "restartBackendAfterSparkleUpdate"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func markBackendRestartRequired() {
        defaults.set(true, forKey: Self.restartBackendKey)
    }

    func clearBackendRestartRequired() {
        defaults.removeObject(forKey: Self.restartBackendKey)
    }

    func consumeBackendRestartRequired() -> Bool {
        guard defaults.bool(forKey: Self.restartBackendKey) else {
            return false
        }
        defaults.removeObject(forKey: Self.restartBackendKey)
        return true
    }
}
