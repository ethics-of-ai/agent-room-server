import SwiftUI

struct CardBackground: ViewModifier {
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
                    .strokeBorder(Color.primary.opacity(DashboardTheme.cardStrokeOpacity))
            }
            .shadow(
                color: Color.black.opacity(DashboardTheme.cardShadowOpacity),
                radius: DashboardTheme.cardShadowRadius,
                x: 0,
                y: DashboardTheme.cardShadowY
            )
    }
}
