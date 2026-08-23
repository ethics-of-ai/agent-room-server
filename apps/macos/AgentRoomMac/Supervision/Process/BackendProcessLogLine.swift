import Foundation

struct BackendProcessLogLine: Identifiable, Equatable, Codable {
    let id = UUID()
    var timestamp: Date
    var stream: BackendProcessStream
    var message: String

    enum CodingKeys: String, CodingKey {
        case timestamp
        case stream
        case message
    }
}
