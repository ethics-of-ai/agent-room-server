import Foundation
import Observation
import Sparkle

/// Owns Sparkle's updater for the lifetime of the app and bridges the one bit
/// of updater state the SwiftUI command needs.
@MainActor
@Observable
final class AppUpdateController: NSObject, SPUUpdaterDelegate {
    private(set) var isUpdaterAvailable = false
    private(set) var canCheckForUpdates = false

    @ObservationIgnored private let relaunchState: AppUpdateRelaunchState
    @ObservationIgnored private let shouldRestartBackendAfterUpdate: @MainActor () -> Bool
    @ObservationIgnored private var updaterController: SPUStandardUpdaterController?
    @ObservationIgnored private var canCheckForUpdatesObservation: NSKeyValueObservation?

    init(
        relaunchState: AppUpdateRelaunchState,
        shouldRestartBackendAfterUpdate: @escaping @MainActor () -> Bool,
        publicEDKey: String? = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
    ) {
        self.relaunchState = relaunchState
        self.shouldRestartBackendAfterUpdate = shouldRestartBackendAfterUpdate
        super.init()

        // Source, unsigned, and updater-disabled stable builds have no key.
        // Starting Sparkle with SUVerifyUpdateBeforeExtraction but no key would
        // report a configuration error on every launch, so updates stay off in
        // those builds. An enabled release channel injects the public key.
        guard let publicEDKey, !publicEDKey.isEmpty else {
            return
        }

        let updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
        self.updaterController = updaterController
        isUpdaterAvailable = true
        // The current value is read here rather than through an `.initial`
        // notification so the menu item is enabled on the first draw, and the
        // observation then carries only the new Bool across to the main actor.
        canCheckForUpdates = updaterController.updater.canCheckForUpdates
        canCheckForUpdatesObservation = updaterController.updater.observe(
            \.canCheckForUpdates,
            options: [.new]
        ) { [weak self] _, change in
            guard let newValue = change.newValue else { return }
            Task { @MainActor [weak self] in
                self?.canCheckForUpdates = newValue
            }
        }
    }

    func checkForUpdates() {
        updaterController?.checkForUpdates(nil)
    }

    func recordBackendRestartIfNeeded() {
        guard shouldRestartBackendAfterUpdate() else { return }
        relaunchState.markBackendRestartRequired()
    }

    // `SPUUpdaterDelegate` is a plain Objective-C protocol, so this requirement
    // is nonisolated. Sparkle calls it on the main thread immediately before it
    // terminates this process, which is what makes the assumption safe.
    nonisolated func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        MainActor.assumeIsolated {
            recordBackendRestartIfNeeded()
        }
    }
}
