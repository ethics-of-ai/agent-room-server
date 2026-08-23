import AppKit
import SwiftUI

/// Provides a template image for the menu bar status item. `MenuBarExtra`
/// reliably promotes image-backed labels into the system status area, whereas a
/// raw custom shape can reserve space without drawing there.
@MainActor
enum AgentRoomMenuBarIcon {
    private static let size = CGSize(width: 18, height: 18)
    private static var cachedImage: NSImage?

    static func image() -> NSImage {
        if let cachedImage {
            return cachedImage
        }

        let renderer = ImageRenderer(
            content: AgentRoomMark()
                .frame(width: size.width, height: size.height)
                .foregroundStyle(.black)
        )
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2

        let image = renderer.nsImage ?? fallbackImage()
        image.isTemplate = true
        image.size = size
        cachedImage = image
        return image
    }

    private static func fallbackImage() -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.black.setStroke()
        NSColor.black.setFill()

        let side = min(size.width, size.height)
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: side * x, y: side * y)
        }

        let chevron = NSBezierPath()
        chevron.move(to: point(0.20, 0.26))
        chevron.line(to: point(0.50, 0.50))
        chevron.line(to: point(0.20, 0.74))
        chevron.lineWidth = side * 0.145
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        chevron.stroke()

        let cursor = NSRect(
            x: side * 0.58,
            y: side * 0.39,
            width: side * 0.22,
            height: side * 0.22
        )
        NSBezierPath(
            roundedRect: cursor,
            xRadius: side * 0.05,
            yRadius: side * 0.05
        ).fill()

        image.unlockFocus()
        return image
    }
}
