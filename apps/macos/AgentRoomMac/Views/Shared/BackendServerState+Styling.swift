import SwiftUI

extension BackendServerState {
    var tint: Color {
        switch self {
        case .running, .externalRunning:
            .green
        case .starting, .stopping:
            .orange
        case .failed:
            .red
        case .stopped:
            .secondary
        }
    }

    var isTransient: Bool {
        self == .starting || self == .stopping
    }
}
