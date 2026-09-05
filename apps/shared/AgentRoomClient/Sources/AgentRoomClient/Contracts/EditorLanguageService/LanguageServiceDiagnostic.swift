import Foundation

public struct LanguageServiceDiagnostic: Codable, Hashable, Sendable {
    public enum Severity: String, Codable, Hashable, Sendable {
        case error
        case warning
        case information
        case hint
    }

    public var range: LanguageServiceRange
    public var message: String
    public var severity: Severity
    public var source: String?
    public var code: String?

    public init(
        range: LanguageServiceRange,
        message: String,
        severity: Severity,
        source: String? = nil,
        code: String? = nil
    ) {
        self.range = range
        self.message = message
        self.severity = severity
        self.source = source
        self.code = code
    }
}
