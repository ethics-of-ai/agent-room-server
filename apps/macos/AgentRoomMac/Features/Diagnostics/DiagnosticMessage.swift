import Foundation

struct DiagnosticMessage: Identifiable, Equatable, Codable {
    let id = UUID()
    var timestamp: Date
    var level: String
    var message: String

    enum CodingKeys: String, CodingKey {
        case timestamp
        case level
        case message
    }
}
