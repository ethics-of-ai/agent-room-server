import Foundation

struct LogRowItem: Identifiable {
    let id: UUID
    let timestamp: Date
    let tag: String
    let message: String
    let isError: Bool
}
