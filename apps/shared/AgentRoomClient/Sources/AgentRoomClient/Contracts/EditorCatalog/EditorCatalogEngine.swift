import Foundation

public struct EditorCatalogEngine: Codable, Hashable, Sendable {
    public var onigWasm: EditorCatalogAssetRef

    public init(onigWasm: EditorCatalogAssetRef) {
        self.onigWasm = onigWasm
    }
}
