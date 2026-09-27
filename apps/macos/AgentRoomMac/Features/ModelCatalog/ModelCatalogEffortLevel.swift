import Foundation

/// One Claude Code effort level the catalog offers, such as `high`.
struct ModelCatalogEffortLevel: Codable, Equatable, Hashable {
    var id: String
    var label: String
    var description: String?
}
