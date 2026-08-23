import Foundation

struct DiagnosticsBundle: Codable {
    var generatedAt: Date
    var app: AppSection
    var backend: BackendSection
    var localDiagnostics: [DiagnosticMessage]
    var processLogs: [BackendProcessLogLine]

    struct AppSection: Codable {
        var serverState: String
        var connectionState: String
        var localServerURL: String
        var lanServerURLs: [String]
        var settings: SanitizedSettings
        var configuredSecrets: SanitizedSecretStatus
    }

    struct BackendSection: Codable {
        var health: String?
        var config: String?
        var recentLogs: String?
        var auditTrail: String?
    }

    func redactingSecrets(_ secrets: BackendSecretValues) -> DiagnosticsBundle {
        let redactor = DiagnosticsTextRedactor(secrets: secrets)
        return DiagnosticsBundle(
            generatedAt: generatedAt,
            app: app,
            backend: BackendSection(
                health: backend.health.map(redactor.redact),
                config: backend.config.map(redactor.redact),
                recentLogs: backend.recentLogs.map(redactor.redact),
                auditTrail: backend.auditTrail.map(redactor.redact)
            ),
            localDiagnostics: localDiagnostics.map { item in
                DiagnosticMessage(
                    timestamp: item.timestamp,
                    level: item.level,
                    message: redactor.redact(item.message)
                )
            },
            processLogs: processLogs.map { item in
                BackendProcessLogLine(
                    timestamp: item.timestamp,
                    stream: item.stream,
                    message: redactor.redact(item.message)
                )
            }
        )
    }
}
