import Foundation

/// A catalog entry the editor lists. `rowID` is view identity only and is never
/// written, because the model `id` is itself editable.
protocol ModelCatalogRow {
    var rowID: UUID { get }
    var id: String { get }
    var label: String { get }
    var description: String { get }
}
