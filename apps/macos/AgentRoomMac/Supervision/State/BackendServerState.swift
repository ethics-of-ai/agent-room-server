import Foundation

enum BackendServerState: String {
    case stopped = "Stopped"
    case starting = "Starting"
    case running = "Running"
    case externalRunning = "Running Outside App"
    case stopping = "Stopping"
    case failed = "Failed"

    var statusSystemImage: String {
        switch self {
        case .running, .externalRunning:
            return "bolt.horizontal.circle.fill"
        case .starting, .stopping:
            return "clock.arrow.circlepath"
        case .failed:
            return "exclamationmark.triangle.fill"
        case .stopped:
            return "bolt.horizontal.circle"
        }
    }

    var statusTitle: String {
        switch self {
        case .running:
            return "Backend is running"
        case .externalRunning:
            return "Backend is running outside this app"
        case .starting:
            return "Backend is starting"
        case .stopping:
            return "Backend is stopping"
        case .failed:
            return "Backend needs attention"
        case .stopped:
            return "Backend is stopped"
        }
    }

    var statusDetail: String {
        switch self {
        case .running:
            return "AgentRoom is listening for local and LAN clients."
        case .externalRunning:
            return "AgentRoom is reachable on this port, but this app did not start it. Stop it where it was started, then press Start."
        case .starting:
            return "Starting the backend sidecar process."
        case .stopping:
            return "Stopping the app-owned backend sidecar."
        case .failed:
            return "Check diagnostics and backend logs before trying again."
        case .stopped:
            return "Start the backend before connecting visionOS clients."
        }
    }

    var canStart: Bool {
        self == .stopped || self == .failed
    }

    var canStop: Bool {
        self == .running || self == .starting
    }

    var canRestart: Bool {
        self == .running || self == .starting
    }
}
