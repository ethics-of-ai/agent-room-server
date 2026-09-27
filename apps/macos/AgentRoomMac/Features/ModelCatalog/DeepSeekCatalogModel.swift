import Foundation

/// A DeepSeek model id and how the picker names it.
struct DeepSeekCatalogModel: ModelCatalogRow, Codable, Equatable {
    var rowID = UUID()
    var id: String
    var label: String
    var description = ""

    private enum CodingKeys: String, CodingKey {
        case id, label, description
    }

    init(id: String, label: String, description: String = "") {
        self.id = id
        self.label = label
        self.description = description
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        if !description.isEmpty {
            try container.encode(description, forKey: .description)
        }
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.label == rhs.label && lhs.description == rhs.description
    }
}
