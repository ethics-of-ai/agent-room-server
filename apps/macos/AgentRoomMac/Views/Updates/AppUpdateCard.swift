import SwiftUI

struct AppUpdateCard: View {
    @Environment(AppUpdateController.self) private var updateController

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.rowSpacing) {
            CardHeader(
                title: "App Updates",
                systemImage: "arrow.down.circle",
                subtitle: "Check for signed AgentRoom releases from this window"
            )

            LabeledContent("Installed version") {
                Text(installedVersion)
                    .monospaced()
                    .textSelection(.enabled)
            }

            CheckForUpdatesButton(updateController: updateController)
                .buttonStyle(.borderedProminent)

            SettingsCaption(
                text: updateStatusMessage,
                systemImage: updateController.isUpdaterAvailable
                    ? "checkmark.shield"
                    : "info.circle"
            )
        }
        .cardBackground()
    }

    private var installedVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String

        switch (version, build) {
        case let (.some(version), .some(build)):
            return "\(version) (\(build))"
        case let (.some(version), .none):
            return version
        case let (.none, .some(build)):
            return "Build \(build)"
        case (.none, .none):
            return "Unknown"
        }
    }

    private var updateStatusMessage: String {
        if updateController.isUpdaterAvailable {
            "AgentRoom checks for signed updates once a day. This button runs the same check now; installation still requires your confirmation."
        } else {
            "Updates are unavailable in this build. Source, unsigned, and updater-disabled builds contain no update feed or signing key."
        }
    }
}
