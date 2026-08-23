import SwiftUI

/// The AgentRoom brand mark: a command-prompt chevron paired with a block
/// cursor (`>` plus a caret), drawn as a single fillable shape so callers tint
/// it with `foregroundStyle`. It is the monochrome, appearance-adaptive
/// companion to the full-color `AppIcon`, used wherever the app needs a compact
/// logo such as the menu bar status item.
struct AgentRoomMark: Shape {
    func path(in rect: CGRect) -> Path {
        // Draw inside the largest centered square so the mark stays square and
        // crisp regardless of the frame's aspect ratio.
        let side = min(rect.width, rect.height)
        let originX = rect.midX - side / 2
        let originY = rect.midY - side / 2

        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: originX + side * x, y: originY + side * y)
        }

        var chevron = Path()
        chevron.move(to: point(0.20, 0.26))
        chevron.addLine(to: point(0.50, 0.50))
        chevron.addLine(to: point(0.20, 0.74))

        // Bake the stroked chevron into the fill so the whole mark renders with
        // a single foreground style and scales with the frame.
        var path = chevron.strokedPath(
            StrokeStyle(lineWidth: side * 0.145, lineCap: .round, lineJoin: .round)
        )

        let cursor = CGRect(
            x: originX + side * 0.58,
            y: originY + side * 0.39,
            width: side * 0.22,
            height: side * 0.22
        )
        path.addRoundedRect(in: cursor, cornerSize: CGSize(width: side * 0.05, height: side * 0.05))

        return path
    }
}
