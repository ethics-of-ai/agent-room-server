import SwiftUI

/// Bounded syntax-catalog facts reported by the backend. Validation location is
/// catalog-relative metadata, never asset content or an arbitrary host path.
struct EditorCatalogStatusSection: View {
    let status: EditorCatalogStatus?
    let actionStatus: EditorCatalogActionStatus?

    var body: some View {
        Section("Syntax Catalog Status") {
            if let status {
                LabeledContent("Delivery", value: status.enabled ? "Enabled" : "Disabled")
                LabeledContent("Serving", value: sourceLabel(status.source))
                LabeledContent("Languages", value: "\(status.languageCount)")
                LabeledContent(
                    "Syntax providers",
                    value: "Monaco \(status.syntaxProviders.monaco) · TextMate \(status.syntaxProviders.textmate) · Plain text \(status.syntaxProviders.plaintext)"
                )
                LabeledContent(
                    "Grammars",
                    value: "\(status.primaryGrammarCount) primary · \(status.scopeGrammarCount) auxiliary"
                )
                LabeledContent(
                    "Embedded fallbacks",
                    value: status.unresolvedScopeCount == 0
                        ? "None"
                        : "\(status.unresolvedScopeCount) embedded scopes stay plain text"
                )
                if let schemaVersion = status.schemaVersion,
                   let languageMapVersion = status.languageMapVersion {
                    LabeledContent("Schemas", value: "Catalog \(schemaVersion) · Languages \(languageMapVersion)")
                }
                LabeledContent("Validation", value: validationLabel(status.validation))
                if let location = status.validation.location {
                    LabeledContent("Validation location", value: location)
                }
                if let version = status.version {
                    LabeledContent("Catalog hash", value: String(version.prefix(12)))
                }
            } else {
                SettingsCaption(
                    text: "Start the backend to load syntax catalog status.",
                    systemImage: "questionmark.circle"
                )
            }
            if let actionStatus {
                StatusMessageRow(message: actionStatus.message, style: actionStatus.style)
            }
        }
    }

    private func sourceLabel(_ source: EditorCatalogSource) -> String {
        switch source {
        case .overrideDir: "Imported catalog (this Mac)"
        case .bundled: "Bundled catalog (built-in)"
        case .none: "No catalog"
        }
    }

    private func validationLabel(_ validation: EditorCatalogValidation) -> String {
        let label = switch validation.state {
        case .accepted: "Accepted"
        case .fallback: "Bundled fallback"
        case .rejected: "Rejected; previous generation active"
        case .unavailable: "Unavailable"
        }
        if let code = validation.code { return "\(label) (\(code))" }
        return label
    }
}
