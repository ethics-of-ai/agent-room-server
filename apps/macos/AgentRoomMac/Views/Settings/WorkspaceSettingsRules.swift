import Foundation

/// What a Setup pane workspace row says about the workspace's kind and whether
/// it offers Remove. Close is what unregisters a child's worktree, so a
/// registered `managed_worktree` workspace belongs to an open child thread. The
/// row refuses Remove for that worktree and for the workspace it was added
/// from, as the backend does with `409 child_workspace` and
/// `409 has_open_children`. The same worktree shows its branch without the
/// switch menu: Land needs it on the child's own branch, and the backend
/// refuses a switch there with `409 child_workspace`.
enum WorkspaceSettingsRules {
    static func kindLabel(for workspace: LocalWorkspace) -> String {
        if workspace.isChildWorktree { return "Worktree" }
        return workspace.kind == "managed_throwaway" ? "Managed" : "Selected"
    }

    /// Whether the row offers the branch switch menu.
    static func offersBranchSwitch(for workspace: LocalWorkspace) -> Bool {
        !workspace.isChildWorktree
    }

    /// Why Remove is off for this workspace, or nil when it is allowed.
    static func removalBlock(for workspace: LocalWorkspace, among workspaces: [LocalWorkspace]) -> String? {
        if workspace.isChildWorktree {
            return "A child thread works in this worktree. Close the child from its parent thread in the visionOS app to remove it."
        }
        let hasChildWorktrees = workspaces.contains {
            $0.isChildWorktree && $0.worktree?.parentWorkspaceId == workspace.id
        }
        if hasChildWorktrees {
            return "Child threads work in worktrees of this workspace. Close them from their parent threads in the visionOS app first."
        }
        return nil
    }
}
