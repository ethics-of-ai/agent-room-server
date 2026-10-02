import SwiftUI

/// Native tracking distinguishes user movement from layout and programmatic scrolling.
/// The content's AppKit observer remains the macOS 14 fallback.
struct ThreadReadingScrollTracking: ViewModifier {
    @Binding var reading: ThreadReadingState

    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content
                .onScrollGeometryChange(for: Double.self) { geometry in
                    distanceToBottom(geometry)
                } action: { _, distance in
                    if reading.isUserScrolling {
                        reading.userScrolled(distanceToBottom: distance)
                    }
                }
                .onScrollPhaseChange { _, phase, context in
                    reading.scrollPhaseChanged(
                        isUserScrolling: phase == .tracking || phase == .interacting || phase == .decelerating,
                        distanceToBottom: distanceToBottom(context.geometry)
                    )
                }
        } else {
            content
        }
    }

    @available(macOS 15, *)
    private func distanceToBottom(_ geometry: ScrollGeometry) -> Double {
        max(0, geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY)
    }
}
