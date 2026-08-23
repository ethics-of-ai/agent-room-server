import SwiftUI

struct ThreadStatusStyle {
    var label: String
    var systemImage: String
    var tint: Color

    static func style(for status: String) -> ThreadStatusStyle {
        switch status.lowercased() {
        case "running":
            ThreadStatusStyle(label: "Running", systemImage: "play.circle.fill", tint: .green)
        case "failed":
            ThreadStatusStyle(label: "Failed", systemImage: "exclamationmark.triangle.fill", tint: .red)
        case "cancelled":
            ThreadStatusStyle(label: "Cancelled", systemImage: "stop.circle.fill", tint: .orange)
        case "idle":
            ThreadStatusStyle(label: "Idle", systemImage: "checkmark.circle.fill", tint: .blue)
        default:
            ThreadStatusStyle(label: status.capitalized, systemImage: "circle.fill", tint: .secondary)
        }
    }
}
