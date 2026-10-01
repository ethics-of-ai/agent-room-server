import SwiftUI

struct DashboardDetailContainer: View {
    var selectedSection: DashboardSection
    @Binding var isExportingDiagnostics: Bool
    var exportAction: () -> Void
    var openEndpoint: (String) -> Void

    @State private var confirmingRestart = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if selectedSection == .threads {
                ThreadMirrorSection()
                    .padding(DashboardTheme.cardPadding)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: DashboardTheme.cardSpacing) {
                        if selectedSection == .backend {
                            OverviewSection()
                        } else {
                            DiagnosticsSection(
                                isExporting: $isExportingDiagnostics,
                                exportAction: exportAction,
                                openEndpoint: openEndpoint
                            )
                        }
                    }
                    .padding(DashboardTheme.contentPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle(selectedSection.title)
        .navigationSubtitle(selectedSection.subtitle)
        .toolbar { DashboardToolbar(selectedSection: selectedSection, confirmingRestart: $confirmingRestart) }
        .restartBackendConfirmation(isPresented: $confirmingRestart)
        .animation(reduceMotion ? nil : DashboardTheme.sectionAnimation, value: selectedSection)
    }
}
