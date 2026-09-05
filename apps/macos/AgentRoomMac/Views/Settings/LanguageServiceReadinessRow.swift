import SwiftUI

/// One backend-owned language-service descriptor with an explicit neutral state
/// before the first editor connection attempts initialization.
struct LanguageServiceReadinessRow: View {
    let service: LanguageServiceDescriptor

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(service.displayName)
                .font(.headline)
            StatusMessageRow(message: state.message, style: style)
            Text("\(languageSummary) · \(featureSummary)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var state: LanguageServiceOperatorState {
        LanguageServiceOperatorState(service: service)
    }

    private var languageSummary: String {
        service.languageIds.sorted().joined(separator: ", ")
    }

    private var featureSummary: String {
        service.featureKinds.map(featureLabel).joined(separator: ", ")
    }

    private var style: StatusStyle {
        switch state {
        case .disabled:
            StatusStyle(systemImage: "pause.circle.fill", tint: .secondary)
        case .notConfigured:
            StatusStyle(systemImage: "wrench.and.screwdriver.fill", tint: .orange)
        case .ready:
            StatusStyle(systemImage: "checkmark.circle.fill", tint: .green)
        case .failed:
            StatusStyle(systemImage: "exclamationmark.triangle.fill", tint: .orange)
        case .notChecked:
            StatusStyle(systemImage: "info.circle.fill", tint: .secondary)
        }
    }

    private func featureLabel(_ feature: LanguageServiceFeatureKind) -> String {
        switch feature {
        case .completion: "completion"
        case .hover: "hover"
        case .definition: "definition"
        case .documentSymbols: "symbols"
        case .semanticTokens: "semantic tokens"
        }
    }
}
