import SwiftUI

struct WorkspaceSettingsRow: View {
    @Environment(BackendSupervisor.self) private var supervisor
    var workspace: LocalWorkspace

    private var branches: [LocalWorkspaceGitBranch] {
        workspace.git.branches ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(workspace.name, systemImage: workspace.git.isRepository ? "chevron.left.forwardslash.chevron.right" : "folder")
                    .font(.callout.weight(.medium))
                Spacer()
                Text(workspace.kind == "managed_throwaway" ? "Managed" : "Selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Remove", systemImage: "trash", role: .destructive, action: unregisterWorkspace)
                    .buttonStyle(.bordered)
            }
            Text(workspace.path)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            HStack(spacing: 8) {
                if workspace.git.isRepository, !branches.isEmpty {
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
        }
    }

    private func unregisterWorkspace() {
        Task { await supervisor.unregisterWorkspace(workspace) }
    }

    private func switchBranch(_ branch: String) {
        Task { await supervisor.switchWorkspaceBranch(workspace, branch: branch) }
    }
}
