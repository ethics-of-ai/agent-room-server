import Foundation

/// One row of the Threads list. A child thread lives in its own worktree
/// workspace but sits right after its parent, indented, when the search and
/// filter leave both visible. A child whose parent is filtered out or gone
/// keeps its own place in the newest-first order, unindented.
struct ThreadListRow: Identifiable, Equatable {
    var session: AgentSession
    /// Placed under its parent's row.
    var isIndented: Bool
    /// The parent's title for a child thread; nil when the parent session is gone.
    var parentTitle: String?

    var id: String { session.id }

    var isChild: Bool { session.parent != nil }

    /// Where a child's row says it came from, in place of the workspace name,
    /// which for a child only repeats its title.
    var parentLine: String? {
        guard isChild else { return nil }
        let prefix = session.closedAt == nil ? "Child" : "Closed child"
        guard let parentTitle else { return "\(prefix) thread" }
        return "\(prefix) of \(parentTitle)"
    }

    /// `visible` is the newest-first list the search and filter leave; `all`
    /// is every session, so a child can name a parent the filter hides.
    static func rows(visible: [AgentSession], all: [AgentSession]) -> [ThreadListRow] {
        let titles = Dictionary(all.map { ($0.id, $0.threadDisplayTitle) }, uniquingKeysWith: { first, _ in first })
        let listed = Set(visible.map(\.id))
        var children: [String: [AgentSession]] = [:]
        for session in visible {
            guard let parentId = session.parent?.sessionId, listed.contains(parentId) else { continue }
            children[parentId, default: []].append(session)
        }
        var rows: [ThreadListRow] = []
        for session in visible {
            if let parentId = session.parent?.sessionId {
                guard !listed.contains(parentId) else { continue }
                rows.append(ThreadListRow(session: session, isIndented: false, parentTitle: titles[parentId]))
                continue
            }
            rows.append(ThreadListRow(session: session, isIndented: false, parentTitle: nil))
            for child in children[session.id] ?? [] {
                rows.append(ThreadListRow(session: child, isIndented: true, parentTitle: session.threadDisplayTitle))
            }
        }
        return rows
    }
}
