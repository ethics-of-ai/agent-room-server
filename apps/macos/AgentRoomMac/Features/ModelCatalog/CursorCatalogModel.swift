import Foundation

/// A Cursor fallback model, including the parameter names the runner sends a
/// selection back with.
struct CursorCatalogModel: ModelCatalogRow, Codable, Equatable {
    /// The model's depth parameter and the values it takes.
    struct Depth: Codable, Equatable {
        var parameter: String
        var values: [String]
        var defaultValue: String?
    }

    /// Present when the model offers Cursor's fast mode.
    struct Speed: Codable, Equatable {
        var defaultFast: Bool
    }

    static let depthParameters = ["effort", "reasoning"]

    var rowID = UUID()
    var id: String
    var label: String
    var description = ""
    var contextWindowTokens: Int?
    var depth: Depth?
    var speed: Speed?
    var isDefault = false

    private enum CodingKeys: String, CodingKey {
        case id, label, description, contextWindowTokens, depth, speed, isDefault
    }

    init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        contextWindowTokens = try container.decodeIfPresent(Int.self, forKey: .contextWindowTokens)
        depth = try container.decodeIfPresent(Depth.self, forKey: .depth)
        speed = try container.decodeIfPresent(Speed.self, forKey: .speed)
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        if !description.isEmpty {
            try container.encode(description, forKey: .description)
        }
        try container.encodeIfPresent(contextWindowTokens, forKey: .contextWindowTokens)
        try container.encodeIfPresent(depth, forKey: .depth)
        try container.encodeIfPresent(speed, forKey: .speed)
        if isDefault {
            try container.encode(true, forKey: .isDefault)
        }
    }

    /// The depth parameter name, or `nil` when the model has none. Choosing one
    /// keeps any values already entered.
    var depthParameter: String? {
        get { depth?.parameter }
        set {
            if let newValue {
                depth = Depth(parameter: newValue, values: depth?.values ?? [], defaultValue: depth?.defaultValue)
            } else {
                depth = nil
            }
        }
    }

    var depthValues: [String] {
        get { depth?.values ?? [] }
        set {
            depth?.values = newValue
            if let current = depth?.defaultValue, !newValue.contains(current) {
                depth?.defaultValue = nil
            }
        }
    }

    var depthDefault: String? {
        get { depth?.defaultValue }
        set { depth?.defaultValue = newValue }
    }

    /// `nil` when fast mode is not offered, otherwise whether it is on by default.
    var fastByDefault: Bool? {
        get { speed?.defaultFast }
        set { speed = newValue.map(Speed.init(defaultFast:)) }
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.label == rhs.label && lhs.description == rhs.description
            && lhs.contextWindowTokens == rhs.contextWindowTokens && lhs.depth == rhs.depth
            && lhs.speed == rhs.speed && lhs.isDefault == rhs.isDefault
    }
}
