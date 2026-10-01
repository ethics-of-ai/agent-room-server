import SwiftUI

struct DashboardSidebarView: View {
    @Binding var selectedSection: DashboardSection

    var body: some View {
        List(selection: $selectedSection) {
            Section("Workspace") {
                Label("Overview", systemImage: "server.rack")
                    .tag(DashboardSection.backend)
                Label("Threads", systemImage: "text.bubble")
                    .tag(DashboardSection.threads)
                Label("Diagnostics", systemImage: "stethoscope")
                    .tag(DashboardSection.diagnostics)
            }

        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            SidebarStatusSummary()
                .padding(DashboardTheme.cardPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("AgentRoom")
        .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 300)
    }
}
