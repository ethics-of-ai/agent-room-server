import SwiftUI

struct MenuBarStatusView: View {
    @Environment(AppUpdateController.self) private var updateController

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuBarHeader()
                .padding(.horizontal, DashboardTheme.cardPadding)
                .padding(.top, DashboardTheme.cardPadding)
                .padding(.bottom, DashboardTheme.rowSpacing)

            Divider()

            MenuBarActions()
                .padding(.horizontal, DashboardTheme.elementSpacing)
                .padding(.vertical, DashboardTheme.elementSpacing)

            Divider()

            CheckForUpdatesButton(updateController: updateController)
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, DashboardTheme.rowSpacing)
                .padding(.vertical, DashboardTheme.elementSpacing)
                .help(updateController.isUpdaterAvailable
                    ? "Check for a new AgentRoom release"
                    : "App updates are unavailable in this build")

            Divider()

            MenuBarFooter()
                .padding(.horizontal, DashboardTheme.rowSpacing)
                .padding(.vertical, DashboardTheme.elementSpacing)
        }
        .frame(width: 296)
    }
}
