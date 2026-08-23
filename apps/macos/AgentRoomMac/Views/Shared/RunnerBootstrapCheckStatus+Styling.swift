import SwiftUI

extension RunnerBootstrapCheckStatus {
    /// The requirement decides how an unmet prerequisite reads. An absent
    /// *informational* one is not a warning — Claude Code's bundled CLI is a
    /// working default — so tinting it orange would ask the operator to fix
    /// something that is not broken.
    func style(for requirement: RunnerBootstrapProbe.Requirement) -> StatusStyle {
        switch self {
        case .satisfied, .detected:
            StatusStyle(systemImage: "checkmark.circle.fill", tint: .green)
        case .absent:
            requirement == .required
                ? StatusStyle(systemImage: "exclamationmark.triangle.fill", tint: .orange)
                : StatusStyle(systemImage: "info.circle.fill", tint: .secondary)
        case .failed:
            StatusStyle(systemImage: "xmark.octagon.fill", tint: .red)
        }
    }
}
