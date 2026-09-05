import SwiftUI

/// The running backend's safe language-service registry projection. The refresh
/// action only re-reads observed state; it does not spawn or probe a server.
struct LanguageServiceStatusSection: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        Section("Semantic Service Readiness") {
            if let catalog = supervisor.languageServiceCatalog {
                if catalog.services.isEmpty {
                    SettingsCaption(
                        text: "The backend reported no registered language services.",
                        systemImage: "questionmark.circle"
                    )
                } else {
                    ForEach(catalog.services, id: \.id) { service in
                        LanguageServiceReadinessRow(service: service)
                    }
                }
            } else if let issue = supervisor.languageServiceCatalogIssue {
                StatusMessageRow(
                    message: issue,
                    style: StatusStyle(systemImage: "exclamationmark.triangle.fill", tint: .orange)
                )
            } else {
                SettingsCaption(
                    text: "Start the backend to load semantic service status.",
                    systemImage: "questionmark.circle"
                )
            }

            Button("Refresh Readiness", systemImage: "arrow.clockwise") {
                Task { await supervisor.refreshLanguageServiceCatalog() }
            }
            .buttonStyle(.bordered)

            SettingsCaption(
                text: "Readiness is observed only after an editor opens a supported file. Not checked is not a failure. This response contains no executable paths or environment values.",
                systemImage: "lock.shield"
            )
        }
    }
}
