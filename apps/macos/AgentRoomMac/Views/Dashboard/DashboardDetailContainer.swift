import SwiftUI

struct DashboardDetailContainer: View {
    var selectedSection: DashboardSection
    @Binding var isExportingDiagnostics: Bool
    var exportAction: () -> Void
    var openEndpoint: (String) -> Void

    @State private var confirmingRestart = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DashboardTheme.cardSpacing) {
                switch selectedSection {
                case .backend:
                    OverviewSection()
                case .threads:
                    ThreadMirrorSection()
                case .diagnostics:
                    DiagnosticsSection(
                        isExporting: $isExportingDiagnostics,
                        exportAction: exportAction,
                        openEndpoint: openEndpoint
                    )
                }
            }
            .padding(DashboardTheme.contentPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id(selectedSection)
            .transition(.opacity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle(selectedSection.title)
        .navigationSubtitle(selectedSection.subtitle)
        .toolbar { DashboardToolbar(selectedSection: selectedSection, confirmingRestart: $confirmingRestart) }
        .restartBackendConfirmation(isPresented: $confirmingRestart)
        .animation(DashboardTheme.sectionAnimation, value: selectedSection)
    }
}
