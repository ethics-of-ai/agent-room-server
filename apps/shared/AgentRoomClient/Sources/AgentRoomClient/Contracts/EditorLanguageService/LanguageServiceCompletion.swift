import Foundation

public struct LanguageServiceCompletion: Codable, Hashable, Sendable {
    public struct TextEdit: Codable, Hashable, Sendable {
        public var range: LanguageServiceRange
        public var newText: String

        public init(range: LanguageServiceRange, newText: String) {
            self.range = range
            self.newText = newText
        }
    }

    public var label: String
    public var kind: LanguageServiceCompletionKind
    public var detail: String?
    public var documentation: String?
    public var insertText: String?
    public var textEdit: TextEdit?

    public init(
        label: String,
        kind: LanguageServiceCompletionKind,
        detail: String? = nil,
        documentation: String? = nil,
        textEdit: TextEdit? = nil,
        insertText: String? = nil
    ) {
        self.label = label
        self.kind = kind
        self.detail = detail
        self.documentation = documentation
        self.insertText = insertText
        self.textEdit = textEdit
    }
}
