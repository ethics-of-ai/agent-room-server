import SwiftUI

enum DashboardTheme {
    // Card surface
    static let cardCornerRadius: CGFloat = 14
    static let cardPadding: CGFloat = 20
    static let cardStrokeOpacity: Double = 0.08
    static let cardShadowOpacity: Double = 0.04
    static let cardShadowRadius: CGFloat = 12
    static let cardShadowY: CGFloat = 4

    // Inner surface (code blocks, message bubbles)
    static let innerCornerRadius: CGFloat = 8
    static let innerStrokeOpacity: Double = 0.08

    // Spacing scale
    static let contentPadding: CGFloat = 28
    static let sectionSpacing: CGFloat = 18
    static let cardSpacing: CGFloat = 18
    static let rowSpacing: CGFloat = 14
    static let elementSpacing: CGFloat = 10
    static let tightSpacing: CGFloat = 6

    // Animation
    static let sectionAnimation: Animation = .smooth(duration: 0.2)
    static let stateAnimation: Animation = .smooth(duration: 0.25)
}
