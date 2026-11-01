import SwiftUI

struct ThreadSessionListCard: View {
    var rows: [ThreadListRow]
    /// The registry each row reads its workspace's live branch from.
    var workspaceSnapshot: LocalWorkspaceRegistrySnapshot?
    var hasSessions: Bool
    @Binding var selectedSessionID: String?
    @Binding var query: String
    @Binding var filter: ThreadStatusFilter

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.elementSpacing) {
            TextField("Search threads", text: $query)
                .textFieldStyle(.roundedBorder)
            Picker("Status", selection: $filter) {
                ForEach(ThreadStatusFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            if rows.isEmpty {
                ContentUnavailableView(
                    hasSessions ? "No matching threads" : "No threads",
                    systemImage: "text.bubble",
                    description: Text(hasSessions ? "Change the search or status filter." : "Sessions created from a client appear here.")
                )
                .frame(maxHeight: .infinity)
            } else {
                List(selection: $selectedSessionID) {
                    ForEach(rows) { row in
                        ThreadSessionRow(
                            row: row,
                            branch: ThreadCheckoutBranch.label(for: row.session, in: workspaceSnapshot)
                        )
                        .tag(row.id)
                    }
                }
                .listStyle(.inset)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
