import Foundation

public struct CodingPlanStep: Codable, Hashable, Identifiable, Sendable {
    public var step: String
    public var status: String

    public var id: String {
        "\(step):\(status)"
    }

    public init(step: String, status: String) {
        self.step = step
        self.status = status
    }
}
