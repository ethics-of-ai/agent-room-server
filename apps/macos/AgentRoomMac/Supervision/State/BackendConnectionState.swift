import Foundation

enum BackendConnectionState: String {
    case unknown = "Unknown"
    case checking = "Checking"
    case reachable = "Reachable"
    case unreachable = "Unreachable"
}
