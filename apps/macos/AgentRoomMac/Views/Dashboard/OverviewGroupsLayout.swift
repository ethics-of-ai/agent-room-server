import SwiftUI

/// Columns depend on available width, not the intrinsic width of long values.
struct OverviewGroupsLayout: Layout {
    private let minimumGroupWidth: CGFloat = 320
    private let spacing = DashboardTheme.cardSpacing

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? minimumGroupWidth
        let columns = width >= minimumGroupWidth * 2 + spacing
        let groupWidth = columns ? (width - spacing) / 2 : width
        let sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: groupWidth, height: nil)) }
        let height = columns ? sizes.map(\.height).max() ?? 0
            : sizes.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, sizes.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let columns = bounds.width >= minimumGroupWidth * 2 + spacing
        let width = columns ? (bounds.width - spacing) / 2 : bounds.width
        var y = bounds.minY
        for (index, view) in subviews.enumerated() {
            view.place(at: CGPoint(x: bounds.minX + (columns ? CGFloat(index) * (width + spacing) : 0), y: y),
                       anchor: .topLeading, proposal: ProposedViewSize(width: width, height: nil))
            if !columns { y += view.sizeThatFits(ProposedViewSize(width: width, height: nil)).height + spacing }
        }
    }
}
