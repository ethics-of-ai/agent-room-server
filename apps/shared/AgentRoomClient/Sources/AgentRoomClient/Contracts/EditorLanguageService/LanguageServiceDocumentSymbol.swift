import Foundation

public struct LanguageServiceDocumentSymbol: Codable, Hashable, Sendable {
    public var name: String
    public var kind: LanguageServiceCompletionKind
    public var range: LanguageServiceRange
    public var selectionRange: LanguageServiceRange
    public var children: [LanguageServiceDocumentSymbol]

    public init(
        name: String,
        kind: LanguageServiceCompletionKind,
        range: LanguageServiceRange,
        selectionRange: LanguageServiceRange,
        children: [LanguageServiceDocumentSymbol] = []
    ) {
        self.name = name
        self.kind = kind
        self.range = range
        self.selectionRange = selectionRange
        self.children = children
    }
}
