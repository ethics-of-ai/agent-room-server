import Foundation

public struct AgentSessionTurnResponse: Codable, Hashable {
    public var turn: AgentSessionTurn

    public init(turn: AgentSessionTurn) {
        self.turn = turn
    }
}
