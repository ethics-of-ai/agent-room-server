import Foundation

public enum LanguageServiceFeatureKind: String, Codable, CaseIterable, Hashable, Sendable {
    case completion
    case hover
    case definition
    case documentSymbols = "document_symbols"
    case semanticTokens = "semantic_tokens"
}
