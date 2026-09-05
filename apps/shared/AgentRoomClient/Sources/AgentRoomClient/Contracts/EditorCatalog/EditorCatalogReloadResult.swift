import Foundation

/// Result of an operator-triggered catalog reload. A rejected candidate leaves
/// the previous generation live and returns `accepted == false`.
public struct EditorCatalogReloadResult: Codable, Hashable, Sendable {
    public var reloaded: Bool
    public var accepted: Bool
    public var source: EditorCatalogSource
    public var version: String?
    public var changed: Bool
    public var validation: EditorCatalogValidation

    public init(
        reloaded: Bool,
        accepted: Bool = true,
        source: EditorCatalogSource,
        version: String?,
        changed: Bool,
        validation: EditorCatalogValidation = .accepted
    ) {
        self.reloaded = reloaded
        self.accepted = accepted
        self.source = source
        self.version = version
        self.changed = changed
        self.validation = validation
    }

    private enum CodingKeys: String, CodingKey {
        case reloaded, accepted, source, version, changed, validation
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reloaded = try container.decode(Bool.self, forKey: .reloaded)
        accepted = try container.decodeIfPresent(Bool.self, forKey: .accepted) ?? true
        source = try container.decode(EditorCatalogSource.self, forKey: .source)
        version = try container.decodeIfPresent(String.self, forKey: .version)
        changed = try container.decode(Bool.self, forKey: .changed)
        validation = try container.decodeIfPresent(EditorCatalogValidation.self, forKey: .validation) ?? .accepted
    }
}
