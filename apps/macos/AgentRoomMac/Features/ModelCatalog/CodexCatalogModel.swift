import Foundation

/// A Codex fallback model: its effort levels, default effort, and whether it
/// offers the fast service tier beside standard speed.
struct CodexCatalogModel: ModelCatalogRow, Codable, Equatable {
    var rowID = UUID()
    var id: String
    var label: String
    var description = ""
    var reasoningEfforts: [String] = []
    var defaultReasoningEffort: String?
    var fast = false
    var isDefault = false

    private enum CodingKeys: String, CodingKey {
        case id, label, description, reasoningEfforts, defaultReasoningEffort, fast, isDefault
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
        reasoningEfforts = try container.decode([String].self, forKey: .reasoningEfforts)
        defaultReasoningEffort = try container.decodeIfPresent(String.self, forKey: .defaultReasoningEffort)
        fast = try container.decodeIfPresent(Bool.self, forKey: .fast) ?? false
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        if !description.isEmpty {
            try container.encode(description, forKey: .description)
        }
        try container.encode(reasoningEfforts, forKey: .reasoningEfforts)
        try container.encodeIfPresent(defaultReasoningEffort, forKey: .defaultReasoningEffort)
        try container.encode(fast, forKey: .fast)
        if isDefault {
            try container.encode(true, forKey: .isDefault)
        }
    }

    /// The effort levels. Removing the default level also clears the default.
    var efforts: [String] {
        get { reasoningEfforts }
        set {
            reasoningEfforts = newValue
            if let current = defaultReasoningEffort, !newValue.contains(current) {
                defaultReasoningEffort = nil
            }
        }
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.label == rhs.label && lhs.description == rhs.description
            && lhs.reasoningEfforts == rhs.reasoningEfforts && lhs.defaultReasoningEffort == rhs.defaultReasoningEffort
            && lhs.fast == rhs.fast && lhs.isDefault == rhs.isDefault
    }
}
