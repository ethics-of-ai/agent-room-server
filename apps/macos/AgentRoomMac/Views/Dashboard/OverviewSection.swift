import SwiftUI

struct OverviewSection: View {
    var body: some View {
        StatusHeroCard()
        SetupReadinessCard()
        PairingURLsCard()
        ConfigurationCard()
    }
}
