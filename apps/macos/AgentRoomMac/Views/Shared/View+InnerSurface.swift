import SwiftUI

extension View {
    /// Inset surface used for code blocks and message bubbles inside a card.
    func innerSurface() -> some View {
        background(
            RoundedRectangle(cornerRadius: DashboardTheme.innerCornerRadius)
                .fill(Color(nsColor: .textBackgroundColor))
        )
        .overlay {
            RoundedRectangle(cornerRadius: DashboardTheme.innerCornerRadius)
                .strokeBorder(Color.primary.opacity(DashboardTheme.innerStrokeOpacity))
        }
    }
}
