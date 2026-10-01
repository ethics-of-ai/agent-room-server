import SwiftUI

struct CardBackground: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .padding(DashboardTheme.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: DashboardTheme.cardCornerRadius)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay {
                RoundedRectangle(cornerRadius: DashboardTheme.cardCornerRadius)
                    .strokeBorder(Color.primary.opacity(contrast == .increased ? 0.35 : DashboardTheme.cardStrokeOpacity))
            }
    }
}
