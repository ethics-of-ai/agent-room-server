import Foundation

public enum LanguageServiceFeatureResult: Codable, Hashable, Sendable {
    case completion(items: [LanguageServiceCompletion], truncated: Bool)
    case hover(hover: LanguageServiceHover?, truncated: Bool)
    case definition(locations: [LanguageServiceDefinition], truncated: Bool)
    case documentSymbols(symbols: [LanguageServiceDocumentSymbol], truncated: Bool)
    case semanticTokens(tokens: LanguageServiceSemanticTokens, truncated: Bool)

    public var kind: LanguageServiceFeatureKind {
        switch self {
        case .completion: .completion
        case .hover: .hover
        case .definition: .definition
        case .documentSymbols: .documentSymbols
        case .semanticTokens: .semanticTokens
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, items, hover, locations, symbols, tokens, truncated
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(LanguageServiceFeatureKind.self, forKey: .kind) {
        case .completion:
            self = .completion(
                items: try container.decode([LanguageServiceCompletion].self, forKey: .items),
                truncated: try container.decode(Bool.self, forKey: .truncated)
            )
        case .hover:
            self = .hover(
                hover: try container.decodeIfPresent(LanguageServiceHover.self, forKey: .hover),
                truncated: try container.decode(Bool.self, forKey: .truncated)
            )
        case .definition:
            self = .definition(
                locations: try container.decode([LanguageServiceDefinition].self, forKey: .locations),
                truncated: try container.decode(Bool.self, forKey: .truncated)
            )
        case .documentSymbols:
            self = .documentSymbols(
                symbols: try container.decode([LanguageServiceDocumentSymbol].self, forKey: .symbols),
                truncated: try container.decode(Bool.self, forKey: .truncated)
            )
        case .semanticTokens:
            self = .semanticTokens(
                tokens: try container.decode(LanguageServiceSemanticTokens.self, forKey: .tokens),
                truncated: try container.decode(Bool.self, forKey: .truncated)
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .completion(let items, let truncated):
            try container.encode(LanguageServiceFeatureKind.completion, forKey: .kind)
            try container.encode(items, forKey: .items)
            try container.encode(truncated, forKey: .truncated)
        case .hover(let hover, let truncated):
            try container.encode(LanguageServiceFeatureKind.hover, forKey: .kind)
            try container.encodeIfPresent(hover, forKey: .hover)
            if hover == nil { try container.encodeNil(forKey: .hover) }
            try container.encode(truncated, forKey: .truncated)
        case .definition(let locations, let truncated):
            try container.encode(LanguageServiceFeatureKind.definition, forKey: .kind)
            try container.encode(locations, forKey: .locations)
            try container.encode(truncated, forKey: .truncated)
        case .documentSymbols(let symbols, let truncated):
            try container.encode(LanguageServiceFeatureKind.documentSymbols, forKey: .kind)
            try container.encode(symbols, forKey: .symbols)
            try container.encode(truncated, forKey: .truncated)
        case .semanticTokens(let tokens, let truncated):
            try container.encode(LanguageServiceFeatureKind.semanticTokens, forKey: .kind)
            try container.encode(tokens, forKey: .tokens)
            try container.encode(truncated, forKey: .truncated)
        }
    }
}
