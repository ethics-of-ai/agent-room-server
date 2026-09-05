import Foundation

public enum LanguageServiceServerFrame: Codable, Hashable, Sendable {
    case status(LanguageServiceStatus)
    case diagnostics(clientVersion: Int, diagnostics: [LanguageServiceDiagnostic], truncated: Bool)
    case response(requestId: String, clientVersion: Int, result: LanguageServiceFeatureResult)
    case error(code: LanguageServiceErrorCode, message: String, requestId: String?)

    private enum FrameType: String, Codable { case status, diagnostics, response, error }
    private enum CodingKeys: String, CodingKey {
        case type, protocolVersion, clientVersion, service, readiness, featureKinds, project
        case semanticTokenLegend, diagnostics, truncated, requestId, result, code, message
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(FrameType.self, forKey: .type) {
        case .status:
            self = .status(LanguageServiceStatus(
                protocolVersion: try container.decode(Int.self, forKey: .protocolVersion),
                clientVersion: try container.decode(Int.self, forKey: .clientVersion),
                service: try container.decode(LanguageServiceStatus.Service.self, forKey: .service),
                readiness: try container.decode(LanguageServiceReadiness.self, forKey: .readiness),
                featureKinds: try container.decode([LanguageServiceFeatureKind].self, forKey: .featureKinds),
                project: try container.decodeIfPresent(LanguageServiceStatus.Project.self, forKey: .project),
                semanticTokenLegend: try container.decodeIfPresent(
                    LanguageServiceStatus.SemanticTokenLegend.self,
                    forKey: .semanticTokenLegend
                )
            ))
        case .diagnostics:
            self = .diagnostics(
                clientVersion: try container.decode(Int.self, forKey: .clientVersion),
                diagnostics: try container.decode([LanguageServiceDiagnostic].self, forKey: .diagnostics),
                truncated: try container.decode(Bool.self, forKey: .truncated)
            )
        case .response:
            self = .response(
                requestId: try container.decode(String.self, forKey: .requestId),
                clientVersion: try container.decode(Int.self, forKey: .clientVersion),
                result: try container.decode(LanguageServiceFeatureResult.self, forKey: .result)
            )
        case .error:
            self = .error(
                code: try container.decode(LanguageServiceErrorCode.self, forKey: .code),
                message: try container.decode(String.self, forKey: .message),
                requestId: try container.decodeIfPresent(String.self, forKey: .requestId)
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .status(let status):
            try container.encode(FrameType.status, forKey: .type)
            try container.encode(status.protocolVersion, forKey: .protocolVersion)
            try container.encode(status.clientVersion, forKey: .clientVersion)
            try container.encode(status.service, forKey: .service)
            try container.encode(status.readiness, forKey: .readiness)
            try container.encode(status.featureKinds, forKey: .featureKinds)
            try container.encodeIfPresent(status.project, forKey: .project)
            try container.encodeIfPresent(status.semanticTokenLegend, forKey: .semanticTokenLegend)
        case .diagnostics(let clientVersion, let diagnostics, let truncated):
            try container.encode(FrameType.diagnostics, forKey: .type)
            try container.encode(clientVersion, forKey: .clientVersion)
            try container.encode(diagnostics, forKey: .diagnostics)
            try container.encode(truncated, forKey: .truncated)
        case .response(let requestId, let clientVersion, let result):
            try container.encode(FrameType.response, forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(clientVersion, forKey: .clientVersion)
            try container.encode(result, forKey: .result)
        case .error(let code, let message, let requestId):
            try container.encode(FrameType.error, forKey: .type)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(requestId, forKey: .requestId)
        }
    }
}
