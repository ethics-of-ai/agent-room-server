import Foundation

public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public extension JSONValue {
    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self, !value.isEmpty else { return nil }
        return value
    }

    var intValue: Int? {
        guard let numberValue else { return nil }
        return Int(exactly: numberValue)
    }

    var numberValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    /// A stable, non-localized scalar representation for settings fields and
    /// diagnostic rows. Exact in-range integers omit the decimal point; every
    /// other finite JSON number stays a `Double` string without an unsafe cast.
    var numberText: String? {
        guard let numberValue else { return nil }
        return Int(exactly: numberValue).map(String.init) ?? String(numberValue)
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var displayString: String? {
        switch self {
        case .string(let value):
            return value.isEmpty ? nil : value
        case .number(let value):
            if value.rounded() == value {
                return String(Int(value))
            }
            return String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null:
            return nil
        case .object, .array:
            guard let data = try? JSONEncoder().encode(self),
                  let text = String(data: data, encoding: .utf8) else {
                return nil
            }
            return text
        }
    }
}
