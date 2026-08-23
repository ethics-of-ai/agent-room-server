import Foundation

// Spatial scene engine contracts. A scene is two ordinary workspace files:
// the agent-authored base layer (`<name>.scene.json`) and the client-written
// human override layer (`<name>.scene.human.json`). The backend composes them
// on read; `GET /api/workspaces/:id/spatial-scene` returns the composed
// document plus the optimistic-lock tokens (`modifiedAt`) the client needs for
// its next override write through the existing bounded workspace file PUT.
//
// Units are meters, y-up, right-handed (RealityKit-native). Rotation is euler
// degrees [x, y, z] applied as qZ * qY * qX, mirrored by the backend contract.

public struct SpatialSceneTransform: Codable, Hashable, Sendable {
    public var position: [Double]
    public var rotationEulerDegrees: [Double]?
    public var scale: [Double]?

    public init(position: [Double], rotationEulerDegrees: [Double]? = nil, scale: [Double]? = nil) {
        self.position = position
        self.rotationEulerDegrees = rotationEulerDegrees
        self.scale = scale
    }
}

/// Override-layer transform: any subset of fields; unset fields fall through
/// to the base layer.
public struct SpatialSceneTransformOverride: Codable, Hashable, Sendable {
    public var position: [Double]?
    public var rotationEulerDegrees: [Double]?
    public var scale: [Double]?

    public init(position: [Double]? = nil, rotationEulerDegrees: [Double]? = nil, scale: [Double]? = nil) {
        self.position = position
        self.rotationEulerDegrees = rotationEulerDegrees
        self.scale = scale
    }
}

/// Flat geometry shape: the renderer switches on `kind` (`box`, `sphere`,
/// `cylinder`, `cone`, `plane`, `stack`) and nil-guards the fields that kind
/// uses. A `stack` is `count` disks of `radius`/`height` each, `gap` apart —
/// the stacked-disk database silhouette.
public struct SpatialSceneGeometry: Codable, Hashable, Sendable {
    public var kind: String
    public var size: [Double]?
    public var radius: Double?
    public var height: Double?
    public var width: Double?
    public var depth: Double?
    public var cornerRadius: Double?
    /// Stack only: how many disks.
    public var count: Int?
    /// Stack only: the air between neighbouring disks.
    public var gap: Double?

    public init(
        kind: String,
        size: [Double]? = nil,
        radius: Double? = nil,
        height: Double? = nil,
        width: Double? = nil,
        depth: Double? = nil,
        cornerRadius: Double? = nil,
        count: Int? = nil,
        gap: Double? = nil
    ) {
        self.kind = kind
        self.size = size
        self.radius = radius
        self.height = height
        self.width = width
        self.depth = depth
        self.cornerRadius = cornerRadius
        self.count = count
        self.gap = gap
    }
}

public struct SpatialSceneMaterial: Codable, Hashable, Sendable {
    /// `#RRGGBB` or `#RRGGBBAA`.
    public var baseColor: String?
    public var metallic: Double?
    public var roughness: Double?
    public var opacity: Double?

    public init(baseColor: String? = nil, metallic: Double? = nil, roughness: Double? = nil, opacity: Double? = nil) {
        self.baseColor = baseColor
        self.metallic = metallic
        self.roughness = roughness
        self.opacity = opacity
    }
}

/// One scene entity. In a composed document the backend always resolves
/// `visible`, `locked`, and `humanEdited`; in a raw base document they may be
/// absent, so all three stay optional here.
public struct SpatialSceneEntity: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// Geometry-first scenes name their entities; compiled diagram entities
    /// carry `label` instead. Use `displayName` rather than either directly.
    public var name: String?
    /// The semantic label of a compiled diagram node or group platter.
    public var label: String?
    /// The source node's or group's own description (diagram schema v3): why
    /// the component exists, passed through compose for the selection card.
    /// Absent for geometry scenes and for diagrams that declare none.
    public var description: String?
    /// Set only for entities compiled from a semantic diagram.
    public var provenance: SpatialSceneProvenance?
    public var geometry: SpatialSceneGeometry
    public var transform: SpatialSceneTransform
    public var material: SpatialSceneMaterial?
    public var visible: Bool?
    public var locked: Bool?
    public var humanEdited: Bool?

    public init(
        id: String,
        name: String? = nil,
        label: String? = nil,
        description: String? = nil,
        provenance: SpatialSceneProvenance? = nil,
        geometry: SpatialSceneGeometry,
        transform: SpatialSceneTransform,
        material: SpatialSceneMaterial? = nil,
        visible: Bool? = nil,
        locked: Bool? = nil,
        humanEdited: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.label = label
        self.description = description
        self.provenance = provenance
        self.geometry = geometry
        self.transform = transform
        self.material = material
        self.visible = visible
        self.locked = locked
        self.humanEdited = humanEdited
    }

    /// What a renderer shows and what VoiceOver reads: the semantic label when
    /// the entity came from a diagram, the scene name otherwise, and the id as
    /// the last resort so an entity is never anonymous.
    public var displayName: String {
        label ?? name ?? id
    }

    /// True for a group platter — a backdrop, not a component. Renderers place
    /// its label differently and keep it out of node-level affordances.
    public var isGroupPlatter: Bool {
        provenance?.groupId != nil && provenance?.nodeId == nil
    }
}

/// One hidden item the ornament can restore through the existing human
/// override write. Most are composed entities with `visible: false`; a
/// collapsed diagram group also supplies this compact metadata for a hidden
/// member that is intentionally absent from the render entity list.
public struct SpatialSceneRestorableEntity: Codable, Hashable, Identifiable, Sendable {
    /// The source-layer id used by the human override document.
    public var id: String
    public var label: String
    public var isGroup: Bool

    public init(id: String, label: String, isGroup: Bool) {
        self.id = id
        self.label = label
        self.isGroup = isGroup
    }
}

/// One override entry that no longer lands on anything: the human adjusted a
/// node or group the agent has since renamed or removed.
///
/// The backend keeps such an entry rather than deleting it, so an id that comes
/// back picks its placement up again. That is what lets a regenerated diagram
/// keep the human's work — and the cost is that a rename leaves an adjustment
/// with nothing to show for it. This is how the human finds out, and the way
/// they can adopt the agent's new layout instead.
public struct SpatialSceneStaleOverride: Codable, Hashable, Identifiable, Sendable {
    /// The source-layer id the override document keys on.
    public var id: String
    /// The entry carries a placement.
    public var moved: Bool
    public var visible: Bool?
    public var locked: Bool?
    public var collapsed: Bool?

    public init(
        id: String,
        moved: Bool = false,
        visible: Bool? = nil,
        locked: Bool? = nil,
        collapsed: Bool? = nil
    ) {
        self.id = id
        self.moved = moved
        self.visible = visible
        self.locked = locked
        self.collapsed = collapsed
    }

    /// Only `id` is load-bearing: it is what a discard writes against. The flags
    /// describe the entry for the human, so a missing one degrades to a less
    /// specific sentence rather than failing the decode of the whole composed
    /// document and blanking the volume.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        moved = try container.decodeIfPresent(Bool.self, forKey: .moved) ?? false
        visible = try container.decodeIfPresent(Bool.self, forKey: .visible)
        locked = try container.decodeIfPresent(Bool.self, forKey: .locked)
        collapsed = try container.decodeIfPresent(Bool.self, forKey: .collapsed)
    }

    /// The adjustments this entry would drop, in the override layer's own
    /// vocabulary, for a client to present. Empty only for a hand-written entry
    /// that set no field at all — still cruft keyed to an id that is gone.
    public var adjustments: [String] {
        var adjustments: [String] = []
        if moved { adjustments.append("moved") }
        if visible == false { adjustments.append("hidden") }
        if visible == true { adjustments.append("shown") }
        if locked == true { adjustments.append("locked") }
        if collapsed == true { adjustments.append("collapsed") }
        return adjustments
    }
}

/// The composed document, in either of the two shapes the one read route
/// serves: a geometry-first scene (entities only) or a compiled solution
/// diagram (entities, connectors, warnings). A diagram the backend could not
/// compile arrives as the same successful response carrying `errors` and
/// nothing else, so every collection here tolerates absence rather than
/// failing the decode and hiding the reason.
public struct SpatialSceneDocument: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    /// `solution` for a compiled diagram; absent for a geometry-first scene.
    public var kind: String?
    public var name: String?
    /// The source document's own description (diagram schema v3).
    public var description: String?
    public var entities: [SpatialSceneEntity]
    /// Bounded, non-renderable restore metadata for hidden diagram members
    /// omitted because their group is collapsed. Empty for geometry scenes.
    public var suppressedHiddenEntities: [SpatialSceneRestorableEntity]
    /// Override entries keyed to ids the diagram no longer declares. Bounded by
    /// the override layer's own cap, and empty for geometry scenes.
    public var staleOverrides: [SpatialSceneStaleOverride]
    public var connectors: [SpatialSceneConnector]
    /// Named paths through the connectors above. Empty for a geometry scene and
    /// for a diagram whose source predates them (composed schemaVersion 2).
    public var flows: [SpatialSceneFlow]
    /// Non-fatal compile notes, e.g. an unknown role rendered generically.
    public var warnings: [String]
    /// Present only for a diagram that failed validation.
    public var errors: [SpatialSceneDocumentError]?

    public init(
        schemaVersion: Int = 1,
        kind: String? = nil,
        name: String? = nil,
        description: String? = nil,
        entities: [SpatialSceneEntity] = [],
        suppressedHiddenEntities: [SpatialSceneRestorableEntity] = [],
        staleOverrides: [SpatialSceneStaleOverride] = [],
        connectors: [SpatialSceneConnector] = [],
        flows: [SpatialSceneFlow] = [],
        warnings: [String] = [],
        errors: [SpatialSceneDocumentError]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.kind = kind
        self.name = name
        self.description = description
        self.entities = entities
        self.suppressedHiddenEntities = suppressedHiddenEntities
        self.staleOverrides = staleOverrides
        self.connectors = connectors
        self.flows = flows
        self.warnings = warnings
        self.errors = errors
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // The validation-error document carries neither a schema version nor
        // entities; decoding must survive it to render the errors at all.
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        entities = try container.decodeIfPresent([SpatialSceneEntity].self, forKey: .entities) ?? []
        suppressedHiddenEntities = try container.decodeIfPresent([SpatialSceneRestorableEntity].self, forKey: .suppressedHiddenEntities) ?? []
        staleOverrides = try container.decodeIfPresent([SpatialSceneStaleOverride].self, forKey: .staleOverrides) ?? []
        connectors = try container.decodeIfPresent([SpatialSceneConnector].self, forKey: .connectors) ?? []
        flows = try container.decodeIfPresent([SpatialSceneFlow].self, forKey: .flows) ?? []
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
        errors = try container.decodeIfPresent([SpatialSceneDocumentError].self, forKey: .errors)
    }

    /// The structured reason a diagram did not compile, or an empty list.
    public var validationErrors: [SpatialSceneDocumentError] {
        errors ?? []
    }
}

public struct SpatialSceneHumanOverride: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var transform: SpatialSceneTransformOverride?
    public var visible: Bool?
    public var locked: Bool?
    /// Compiled-diagram group ids only: the backend composes a collapsed group
    /// as a single stand-in entity instead of its member nodes. A geometry-first
    /// scene has no groups, so the flag is never written into a
    /// `*.scene.human.json` — and that layer's schema would ignore it if it were.
    public var collapsed: Bool?

    public init(
        id: String,
        transform: SpatialSceneTransformOverride? = nil,
        visible: Bool? = nil,
        locked: Bool? = nil,
        collapsed: Bool? = nil
    ) {
        self.id = id
        self.transform = transform
        self.visible = visible
        self.locked = locked
        self.collapsed = collapsed
    }
}

/// The human override layer document. Written only by clients — never by the
/// coding agent — through the existing bounded workspace file write.
public struct SpatialSceneHumanDocument: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    /// Composed version the edit was made against; informational.
    public var baseline: String?
    public var overrides: [SpatialSceneHumanOverride]
    public var removed: [String]?

    public init(
        schemaVersion: Int = 1,
        baseline: String? = nil,
        overrides: [SpatialSceneHumanOverride] = [],
        removed: [String]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.baseline = baseline
        self.overrides = overrides
        self.removed = removed
    }
}

/// File metadata for one scene layer; `modifiedAt` is the optimistic-lock
/// token for the next `writeWorkspaceFile` of that layer.
public struct SpatialSceneFileInfo: Codable, Hashable, Sendable {
    public var path: String
    public var modifiedAt: String
    public var sizeBytes: Int

    public init(path: String, modifiedAt: String, sizeBytes: Int) {
        self.path = path
        self.modifiedAt = modifiedAt
        self.sizeBytes = sizeBytes
    }
}

public struct SpatialSceneSnapshotResponse: Codable, Hashable, Sendable {
    public var workspaceId: String
    public var path: String
    /// Aggregate content hash of the composed document. There is no scene
    /// change event: clients re-fetch on the existing signals
    /// (`workspace_file_written` for a scene layer, turn settlement) and use
    /// this hash only to recognize an unchanged document.
    public var version: String
    public var document: SpatialSceneDocument
    public var base: SpatialSceneFileInfo
    public var human: SpatialSceneFileInfo?
    public var humanDocument: SpatialSceneHumanDocument?

    public init(
        workspaceId: String,
        path: String,
        version: String,
        document: SpatialSceneDocument,
        base: SpatialSceneFileInfo,
        human: SpatialSceneFileInfo? = nil,
        humanDocument: SpatialSceneHumanDocument? = nil
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.version = version
        self.document = document
        self.base = base
        self.human = human
        self.humanDocument = humanDocument
    }
}
