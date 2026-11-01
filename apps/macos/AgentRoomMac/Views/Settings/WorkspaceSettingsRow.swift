import SwiftUI

struct WorkspaceSettingsRow: View {
    @Environment(BackendSupervisor.self) private var supervisor
    var workspace: LocalWorkspace
    /// Why Remove is off; see `WorkspaceSettingsRules.removalBlock`.
    var removalBlock: String?

    private var branches: [LocalWorkspaceGitBranch] {
        workspace.git.branches ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.tightSpacing) {
            HStack {
                Label(workspace.name, systemImage: workspace.git.isRepository ? "chevron.left.forwardslash.chevron.right" : "folder")
                    .font(.callout.weight(.medium))
                Spacer()
                Text(WorkspaceSettingsRules.kindLabel(for: workspace))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Remove", systemImage: "trash", role: .destructive, action: unregisterWorkspace)
                    .buttonStyle(.bordered)
                    .disabled(removalBlock != nil)
            }
            Text(workspace.path)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            HStack(spacing: 8) {
                if workspace.git.isRepository, !branches.isEmpty, WorkspaceSettingsRules.offersBranchSwitch(for: workspace) {
                    Menu {
                        ForEach(branches) { branch in
                            Button {
                                switchBranch(branch.name)
                            } label: {
                                Label(branch.name, systemImage: branch.current ? "checkmark" : "arrow.triangle.branch")
                            }
                        }
                    } label: {
                        Label(workspace.git.branch ?? "Detached HEAD", systemImage: "arrow.triangle.branch")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .disabled(branches.count < 2)
                } else {
                    Label(workspace.git.branch ?? "No Git branch", systemImage: "arrow.triangle.branch")
                        .foregroundStyle(.secondary)
                }

                if workspace.git.hasUncommittedChanges == true {
                    Label("Uncommitted changes", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }
            .font(.caption)
            if let removalBlock {
                SettingsCaption(text: removalBlock, systemImage: "arrow.triangle.branch")
            }
        }
    }

    private func unregisterWorkspace() {
        Task { await supervisor.unregisterWorkspace(workspace) }
    }

    private func switchBranch(_ branch: String) {
        Task { await supervisor.switchWorkspaceBranch(workspace, branch: branch) }
    }
}
