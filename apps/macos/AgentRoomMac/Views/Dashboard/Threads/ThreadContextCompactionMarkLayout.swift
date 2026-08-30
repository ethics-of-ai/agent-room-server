import SwiftUI

/// Positions one threshold mark along the context bar without observing the
/// parent through `GeometryReader`.
struct ThreadContextCompactionMarkLayout: Layout {
    var fraction: Double

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache _: inout ()
    ) -> CGSize {
        let idealSize = subviews.first?.sizeThatFits(proposal) ?? .zero
        return proposal.replacingUnspecifiedDimensions(by: idealSize)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache _: inout ()
    ) {
        guard let mark = subviews.first else { return }
        let markSize = mark.sizeThatFits(proposal)
        let availableWidth = max(0, bounds.width - markSize.width)
        let clampedFraction = min(max(fraction, 0), 1)
        let x = bounds.minX + markSize.width / 2 + availableWidth * clampedFraction
        mark.place(
            at: CGPoint(x: x, y: bounds.midY),
            anchor: .center,
            proposal: ProposedViewSize(markSize)
        )
    }
}
