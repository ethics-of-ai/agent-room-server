import SwiftUI

extension BackendConnectionState {
    var tint: Color {
        switch self {
        case .reachable:
            .green
        case .checking:
            .orange
        case .unreachable:
            .red
        case .unknown:
            .secondary
        }
    }

    var systemImage: String {
        switch self {
        case .reachable:
            "checkmark.circle.fill"
        case .checking:
            "ellipsis.circle"
        case .unreachable:
            "exclamationmark.circle.fill"
        case .unknown:
            "questionmark.circle"
        }
    }
}
