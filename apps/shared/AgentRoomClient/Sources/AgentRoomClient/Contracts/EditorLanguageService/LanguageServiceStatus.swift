import Foundation

public struct LanguageServiceStatus: Codable, Hashable, Sendable {
    public struct Service: Codable, Hashable, Sendable {
        public var id: String
        public var displayName: String

        public init(id: String, displayName: String) {
            self.id = id
            self.displayName = displayName
        }
    }

    public struct Project: Codable, Hashable, Sendable {
        public var root: String
        public var marker: String?

        public init(root: String, marker: String? = nil) {
            self.root = root
            self.marker = marker
        }
    }

    public struct SemanticTokenLegend: Codable, Hashable, Sendable {
        public var tokenTypes: [String]
        public var tokenModifiers: [String]

        public init(tokenTypes: [String], tokenModifiers: [String]) {
            self.tokenTypes = tokenTypes
            self.tokenModifiers = tokenModifiers
        }
    }

    public var protocolVersion: Int
    public var clientVersion: Int
    public var service: Service
    public var readiness: LanguageServiceReadiness
    public var featureKinds: [LanguageServiceFeatureKind]
    public var project: Project?
    public var semanticTokenLegend: SemanticTokenLegend?

    public init(
        protocolVersion: Int,
        clientVersion: Int,
        service: Service,
        readiness: LanguageServiceReadiness,
        featureKinds: [LanguageServiceFeatureKind],
        project: Project? = nil,
        semanticTokenLegend: SemanticTokenLegend? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.clientVersion = clientVersion
        self.service = service
        self.readiness = readiness
        self.featureKinds = featureKinds
        self.project = project
        self.semanticTokenLegend = semanticTokenLegend
    }
}
