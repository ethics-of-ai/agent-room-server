import Foundation

public struct AgentRoomEvent: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var type: String
    public var at: String
    public var payload: JSONValue
    /// Typed view of `payload` for `coding_*` events, decoded once when the
    /// event is decoded. The previous computed property re-encoded and
    /// re-decoded the payload JSON on every access, which ran several times per
    /// event on the streaming hot path. Derived from `payload`; excluded from
    /// the wire encoding.
    public var codingPayload: CodingAgentEventPayload?

    private enum CodingKeys: String, CodingKey {
        case id, type, at, payload
    }

    public init(id: String, type: String, at: String, payload: JSONValue) {
        self.id = id
        self.type = type
        self.at = at
        self.payload = payload
        self.codingPayload = AgentRoomEvent.decodedCodingPayload(type: type, payload: payload)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        at = try container.decode(String.self, forKey: .at)
        payload = try container.decode(JSONValue.self, forKey: .payload)
        // Decode the typed payload straight from the wire JSON — no re-encode
        // round trip. Tolerant like the old computed property: a payload that
        // does not match the typed shape leaves `codingPayload` nil.
        codingPayload = type.hasPrefix("coding_")
            ? try? container.decode(CodingAgentEventPayload.self, forKey: .payload)
            : nil
    }

    private static func decodedCodingPayload(type: String, payload: JSONValue) -> CodingAgentEventPayload? {
        guard type.hasPrefix("coding_"),
              let data = try? JSONEncoder().encode(payload) else {
            return nil
        }
        return try? JSONDecoder().decode(CodingAgentEventPayload.self, from: data)
    }
}

public extension AgentRoomEvent {
    func stringValue(for key: String) -> String? {
        payload.objectValue?[key]?.stringValue
    }

    func nestedStringValue(_ keys: String...) -> String? {
        var current: JSONValue? = payload
        for key in keys {
            current = current?.objectValue?[key]
        }
        return current?.stringValue
    }

    func intValue(for key: String) -> Int? {
        payload.objectValue?[key]?.intValue
    }

    func hasExplicitNullValue(for key: String) -> Bool {
        guard let value = payload.objectValue?[key] else { return false }
        if case .null = value { return true }
        return false
    }

    func nestedIntValue(_ keys: String...) -> Int? {
        var current: JSONValue? = payload
        for key in keys {
            current = current?.objectValue?[key]
        }
        return current?.intValue
    }

    var sessionId: String? {
        stringValue(for: "sessionId") ??
            nestedStringValue("session", "id")
    }

    var turnId: String? {
        stringValue(for: "turnId")
    }

    var message: String? {
        stringValue(for: "message") ?? nestedStringValue("session", "lastMessage")
    }

    var error: String? {
        stringValue(for: "error") ?? nestedStringValue("session", "error")
    }

    var workspacePath: String? {
        stringValue(for: "workspacePath") ??
            nestedStringValue("session", "workspacePath")
    }

    var totalTokens: Int? {
        intValue(for: "totalTokens") ?? nestedIntValue("session", "totalTokens")
    }

    var turnCount: Int? {
        intValue(for: "turnCount") ?? nestedIntValue("session", "turnCount")
    }
}
