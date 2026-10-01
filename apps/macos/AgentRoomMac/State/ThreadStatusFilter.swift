import Foundation

enum ThreadStatusFilter: String, CaseIterable, Identifiable {
    case all, running, idle, failed

    var id: Self { self }
    var title: String { rawValue.capitalized }

    func matches(_ session: AgentSession) -> Bool {
        switch self {
        case .all: true
        case .running: session.threadIsRunning
        case .idle: !session.threadIsRunning && session.status.lowercased() == "idle"
        case .failed: !session.threadIsRunning && session.status.lowercased() == "failed"
        }
    }

    func sessions(in sessions: [AgentSession], query: String) -> [AgentSession] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return sessions.filter { session in
            matches(session) && (query.isEmpty || [
                session.threadDisplayTitle, session.threadWorkspaceName, session.runnerKind
            ].contains { $0.range(of: query, options: .caseInsensitive) != nil })
        }
    }
}
