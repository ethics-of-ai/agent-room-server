import XCTest
@testable import AgentRoomMac

final class ThreadCheckoutBranchTests: XCTestCase {
    func testShowsTheCheckoutBranchNotTheSessionRecord() {
        let snapshot = LocalWorkspaceRegistrySnapshot(defaultWorkspaceRoot: "/w", workspaces: [workspace(branch: "feature/live")])

        XCTAssertEqual(ThreadCheckoutBranch.label(for: session(recorded: "main"), in: snapshot), "feature/live")
    }

    func testDetachedNonRepositoryAndUnknownWorkspaces() {
        XCTAssertEqual(ThreadCheckoutBranch.label(for: workspace(branch: nil)), "Detached HEAD")
        XCTAssertEqual(ThreadCheckoutBranch.label(for: workspace(branch: nil, isRepository: false)), "No Git branch")
        XCTAssertEqual(ThreadCheckoutBranch.label(for: session(recorded: "main"), in: nil), "Branch unknown")
    }

    func testAClosedChildNamesItsLastBranchBecauseItsWorkspaceIsGone() {
        let parent = AgentSessionParent(sessionId: "parent", workspaceId: "workspace-1")
        var closed = session(recorded: "agentroom/fix-1a2b3c4d")
        closed.parent = parent
        closed.closedAt = "2026-10-31T00:00:00Z"
        XCTAssertEqual(ThreadCheckoutBranch.label(for: closed, in: nil), "agentroom/fix-1a2b3c4d")

        var open = session(recorded: "agentroom/fix-1a2b3c4d")
        open.parent = parent
        XCTAssertEqual(ThreadCheckoutBranch.label(for: open, in: nil), "Branch unknown")
    }

    private func workspace(branch: String?, isRepository: Bool = true) -> LocalWorkspace {
        LocalWorkspace(
            id: "workspace-1", name: "repo", path: "/repo", kind: "user_selected",
            trustedAt: "2026-10-17T00:00:00Z", lastOpenedAt: "2026-10-17T00:00:00Z",
            git: LocalWorkspaceGitSnapshot(isRepository: isRepository, branch: branch, remote: nil)
        )
    }

    private func session(recorded branch: String?) -> AgentSession {
        AgentSession(
            id: "session-1", workspaceId: "workspace-1", workspacePath: "/repo", gitBranch: branch,
            runnerKind: "codex", title: "Thread", status: "idle", activeTurnId: nil,
            lastMessage: nil, error: nil, turnCount: 1,
            createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z"
        )
    }
}
