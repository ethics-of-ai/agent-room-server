import Foundation

/// A Claude Code fallback model. `reasoningEfforts` is `nil` when the model takes
/// every level in the section's vocabulary and `[]` when it takes none.
struct ClaudeCodeCatalogModel: ModelCatalogRow, Codable, Equatable {
    var rowID = UUID()
    var id: String
    var label: String
    var description = ""
    var reasoningEfforts: [String]?

    private enum CodingKeys: String, CodingKey {
        case id, label, description, reasoningEfforts
    }

    init(id: String, label: String, description: String = "", reasoningEfforts: [String]? = nil) {
        self.id = id
        self.label = label
        self.description = description
        self.reasoningEfforts = reasoningEfforts
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        reasoningEfforts = try container.decodeIfPresent([String].self, forKey: .reasoningEfforts)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        if !description.isEmpty {
            try container.encode(description, forKey: .description)
        }
        try container.encodeIfPresent(reasoningEfforts, forKey: .reasoningEfforts)
    }

    /// Whether the model takes `effort`. Setting it writes `nil` back once the
    /// model takes the whole vocabulary again, so the file stays in its short form.
    subscript(effort effort: String, vocabulary vocabulary: [String]) -> Bool {
        get { reasoningEfforts?.contains(effort) ?? true }
        set {
            var accepted = Set(reasoningEfforts ?? vocabulary)
            if newValue {
                accepted.insert(effort)
            } else {
                accepted.remove(effort)
            }
            reasoningEfforts = accepted == Set(vocabulary) ? nil : vocabulary.filter(accepted.contains)
        }
    }

    /// Equal ignoring `rowID`, so an untouched section compares equal to its bundled copy.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.label == rhs.label && lhs.description == rhs.description
            && lhs.reasoningEfforts == rhs.reasoningEfforts
    }
}
