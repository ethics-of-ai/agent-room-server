import XCTest
@testable import AgentRoomMac

final class WorkspaceSettingsRulesTests: XCTestCase {
    func testKindLabels() {
        XCTAssertEqual(WorkspaceSettingsRules.kindLabel(for: workspace("a", kind: "user_selected")), "Selected")
        XCTAssertEqual(WorkspaceSettingsRules.kindLabel(for: workspace("b", kind: "managed_throwaway")), "Managed")
        XCTAssertEqual(WorkspaceSettingsRules.kindLabel(for: workspace("c", kind: "managed_worktree", parent: "a")), "Worktree")
        XCTAssertEqual(WorkspaceSettingsRules.kindLabel(for: workspace("d", kind: "something_newer")), "Selected")
    }

    func testRemoveIsOffForAChildWorktreeAndTheWorkspaceItCameFrom() {
        let parent = workspace("parent", kind: "user_selected")
        let child = workspace("child", kind: "managed_worktree", parent: "parent")
        let other = workspace("other", kind: "user_selected")
        let all = [parent, child, other]

        XCTAssertNotNil(WorkspaceSettingsRules.removalBlock(for: child, among: all))
        XCTAssertNotNil(WorkspaceSettingsRules.removalBlock(for: parent, among: all))
        XCTAssertNil(WorkspaceSettingsRules.removalBlock(for: other, among: all))
        // Once Close unregisters the worktree, the parent can go.
        XCTAssertNil(WorkspaceSettingsRules.removalBlock(for: parent, among: [parent, other]))
    }

    func testAChildWorktreeOffersNoBranchSwitch() {
        XCTAssertFalse(WorkspaceSettingsRules.offersBranchSwitch(for: workspace("child", kind: "managed_worktree", parent: "parent")))
        XCTAssertTrue(WorkspaceSettingsRules.offersBranchSwitch(for: workspace("parent", kind: "user_selected")))
        XCTAssertTrue(WorkspaceSettingsRules.offersBranchSwitch(for: workspace("scratch", kind: "managed_throwaway")))
    }

    private func workspace(_ id: String, kind: String, parent: String? = nil) -> LocalWorkspace {
        LocalWorkspace(
            id: id, name: id, path: "/\(id)", kind: kind,
            trustedAt: "2026-10-31T00:00:00Z", lastOpenedAt: "2026-10-31T00:00:00Z",
            git: LocalWorkspaceGitSnapshot(isRepository: true, branch: "main", remote: nil),
            worktree: parent.map {
                LocalWorkspaceWorktree(parentWorkspaceId: $0, worktreePath: "/\(id)", branch: "agentroom/\(id)-1a2b3c4d", baseCommit: "abc")
            }
        )
    }
}
