import SwiftUI

struct OverviewSection: View {
    var body: some View {
        StatusHeroCard()
        AppUpdateCard()
        SetupReadinessCard()
        PairingURLsCard()
        ConfigurationCard()
    }
}
