import SwiftUI

/// A status rendered as an SF Symbol plus a tint. Shared by the per-type status
/// extensions so the icon/color mapping lives in one shape.
struct StatusStyle {
    var systemImage: String
    var tint: Color
}
