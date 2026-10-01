import SwiftUI

enum DashboardTheme {
    // Card surface
    static let cardCornerRadius: CGFloat = 10
    static let cardPadding: CGFloat = 16
    static let cardStrokeOpacity: Double = 0.08

    // Inner surface (code blocks, message bubbles)
    static let innerCornerRadius: CGFloat = 6
    static let innerStrokeOpacity: Double = 0.08

    // Spacing scale
    static let contentPadding: CGFloat = 24
    static let sectionSpacing: CGFloat = 24
    static let cardSpacing: CGFloat = 16
    static let rowSpacing: CGFloat = 12
    static let elementSpacing: CGFloat = 8
    static let tightSpacing: CGFloat = 4

    // Animation
    static let sectionAnimation: Animation = .smooth(duration: 0.2)
    static let stateAnimation: Animation = .smooth(duration: 0.25)
}
