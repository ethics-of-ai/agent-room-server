enum DashboardSection: Hashable {
    case backend
    case threads
    case diagnostics

    var title: String {
        switch self {
        case .backend:
            "Overview"
        case .threads:
            "Threads"
        case .diagnostics:
            "Diagnostics"
        }
    }

    var subtitle: String {
        switch self {
        case .backend:
            "Local backend status, pairing, and readiness"
        case .threads:
            "Server-owned sessions, messages, and live turn metadata"
        case .diagnostics:
            "Backend snapshots, process logs, and audit trail"
        }
    }
}
