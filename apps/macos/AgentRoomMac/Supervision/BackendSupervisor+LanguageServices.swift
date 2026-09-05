import Foundation

extension BackendSupervisor {
    /// Refresh both halves of the Languages pane. These reads are independent:
    /// a catalog-status failure must not hide semantic-service readiness, or the
    /// reverse.
    func refreshEditorLanguageStatus() async {
        async let catalogStatus: Void = refreshEditorCatalogStatus()
        async let serviceCatalog: Void = refreshLanguageServiceCatalog()
        await catalogStatus
        await serviceCatalog
    }

    /// Reads the registry's probe-free public projection. This never initializes
    /// a language server and the response contains no executable or environment
    /// values; readiness appears only after an editor connection observed it.
    func refreshLanguageServiceCatalog() async {
        do {
            languageServiceCatalog = try await EditorLanguageServiceEndpoint(
                client: currentAPIClient()
            ).fetchCatalog()
            languageServiceCatalogIssue = nil
        } catch {
            languageServiceCatalog = nil
            languageServiceCatalogIssue = "Could not load semantic service status: \(error.localizedDescription)"
            appendDiagnostic("warning", "Could not load semantic service status: \(error.localizedDescription)")
        }
    }

    var displayedLanguageServicesEnabled: Bool {
        settingStatus(for: .languageServicesEnabled)?.displayedBool(
            fileValue: managedSettings.resolvedLanguageServicesEnabled
        ) ?? managedSettings.resolvedLanguageServicesEnabled
    }

    func updateLanguageServicesEnabled(_ isEnabled: Bool) {
        updateManagedSettings(
            describedAs: isEnabled
                ? "Enabled editor language services for future backend launches."
                : "Disabled editor language services for future backend launches."
        ) { settings in
            settings.languageServicesEnabled = isEnabled
        }
    }
}
