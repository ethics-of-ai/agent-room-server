import Foundation

enum ModelCatalogFileStoreError: LocalizedError, Equatable {
    case unreadable(String)
    case unsupportedSchema(Int)
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .unreadable(let reason):
            "could not be read (\(reason))"
        case .unsupportedSchema(let version):
            "uses schema version \(version), which this app does not read"
        case .tooLarge:
            "is larger than \(ModelCatalogFileStore.maxBytes / 1024) KiB"
        }
    }
}
