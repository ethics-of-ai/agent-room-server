import Foundation

public struct EditorCatalogSyntaxProviders: Codable, Hashable, Sendable {
    public var monaco: Int
    public var textmate: Int
    public var plaintext: Int

    public init(monaco: Int = 0, textmate: Int = 0, plaintext: Int = 0) {
        self.monaco = monaco
        self.textmate = textmate
        self.plaintext = plaintext
    }
}
