import SwiftUI

struct OverviewSection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.sectionSpacing) {
            StatusHeroCard()
            SetupReadinessCard()
            AppUpdateCard()
            OverviewGroupsLayout {
                PairingURLsCard()
                ConfigurationCard()
            }
        }
        .frame(maxWidth: 1040)
        .frame(maxWidth: .infinity)
    }
}
