import Foundation

// Semantic solution-diagram additions to the composed spatial document.
//
// A diagram is authored as `<name>.diagram.json` — nodes, edges, and flat
// groups, never coordinates — and the backend compiles it into the same
// composed document a geometry-first `*.scene.json` produces, plus connectors.
// The client renders what it is handed: it does not interpret roles, run the
// layout, or place anything itself.
//
// Human placement lives in the sibling `<name>.diagram.human.json` override
// layer, written through the bounded workspace file PUT exactly like a scene's.

/// Where a composed entity or connector came from in the semantic source.
/// Absent for geometry-first scenes, which have no semantic layer above them.
public struct SpatialSceneProvenance: Codable, Hashable, Sendable {
    /// Set on an entity compiled from a diagram node.
    public var nodeId: String?
    /// Set on a connector compiled from a diagram edge.
    public var edgeId: String?
    /// Set on a group platter, and on a node entity that belongs to a group.
    public var groupId: String?
    /// Set on a compiled flow.
    public var flowId: String?

    public init(nodeId: String? = nil, edgeId: String? = nil, groupId: String? = nil, flowId: String? = nil) {
        self.nodeId = nodeId
        self.edgeId = edgeId
        self.groupId = groupId
        self.flowId = flowId
    }
}

/// One named path through the diagram — the route a request, an order, or a
/// message actually takes — resolved by the backend to the connectors that were
/// actually drawn, in traversal order.
///
/// Steps the compose step could not draw are already gone: an edge inside a
/// collapsed group, or one whose endpoint the human hid, has no connector, so
/// the renderer never has to reconcile a step against a connector that is not
/// in the document. A flow left with nothing to light is omitted entirely.
public struct SpatialSceneFlow: Codable, Hashable, Identifiable, Sendable {
    /// Composed id (`flow:<flowId>`), namespaced like entities and connectors.
    public var id: String
    public var label: String
    public var provenance: SpatialSceneProvenance?
    /// Composed connector ids (`edge:<edgeId>`) in the order the flow walks
    /// them. A connector may appear more than once: a flow may cross the same
    /// edge twice, and each occurrence is its own step.
    public var connectorIds: [String]

    public init(
        id: String,
        label: String,
        provenance: SpatialSceneProvenance? = nil,
        connectorIds: [String] = []
    ) {
        self.id = id
        self.label = label
        self.provenance = provenance
        self.connectorIds = connectorIds
    }
}

/// One compiled edge. `from`/`to` are absolute positions in document space —
/// the backend derives them from the composed entity transforms, so they
/// already reflect any human override, and a connector re-routes on the next
/// composed read after a node is moved.
public struct SpatialSceneConnector: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var provenance: SpatialSceneProvenance?
    /// Composed entity ids (`node:<nodeId>`), not bare semantic ids.
    public var fromId: String
    public var toId: String
    public var from: [Double]
    public var to: [Double]
    /// `sync`, `async`, or `read_write` from the engine palette. The schema
    /// accepts other bounded id-style values for forward compatibility, so the
    /// renderer treats an unrecognized kind generically rather than dropping
    /// the edge.
    public var kind: String
    public var label: String?
    /// The source edge's own description (diagram schema v3): what the edge
    /// carries, passed through compose for the selection card.
    public var description: String?
    /// `to` or `both`.
    public var arrowheads: String?
    /// Position among the edges sharing this connector's unordered endpoint
    /// pair, present only past the first. The renderer staggers each parallel
    /// edge's midpoint label along its shaft with it; absent means the label
    /// sits at the drawn midpoint, exactly as before the field existed.
    public var parallelIndex: Int?
    /// Waypoint bowing a multi-tier edge out of the tier plane, present only
    /// on edges spanning two or more tiers: the drawn midpoint pushed toward
    /// the viewer, so a skip edge no longer skewers the tiers between its
    /// endpoints. The renderer draws a connector with a waypoint as two shaft
    /// segments through it; absent draws the straight shaft, exactly as
    /// before the field existed.
    public var via: [Double]?

    public init(
        id: String,
        provenance: SpatialSceneProvenance? = nil,
        fromId: String,
        toId: String,
        from: [Double],
        to: [Double],
        kind: String,
        label: String? = nil,
        description: String? = nil,
        arrowheads: String? = nil,
        parallelIndex: Int? = nil,
        via: [Double]? = nil
    ) {
        self.id = id
        self.provenance = provenance
        self.fromId = fromId
        self.toId = toId
        self.from = from
        self.to = to
        self.kind = kind
        self.label = label
        self.description = description
        self.arrowheads = arrowheads
        self.parallelIndex = parallelIndex
        self.via = via
    }
}

/// One structured validation failure from a diagram the backend could not
/// compile. An invalid diagram is a successful, renderable read whose document
/// carries `errors` instead of entities, so the volume can show what is wrong
/// and the human can feed it back to the agent.
public struct SpatialSceneDocumentError: Codable, Hashable, Sendable {
    /// Pointer into the source document, e.g. `base.edges.0.to`.
    public var path: String
    public var message: String

    public init(path: String, message: String) {
        self.path = path
        self.message = message
    }
}

// MARK: - Mermaid import bridge

/// Request body for `POST /api/spatial-scene/mermaid-import`: Mermaid
/// flowchart/graph source (typically a `kind="mermaid"` artifact's content)
/// and an optional display name that beats a frontmatter `title:`.
public struct SpatialDiagramMermaidImportRequest: Codable, Hashable, Sendable {
    public var source: String
    public var name: String?

    public init(source: String, name: String? = nil) {
        self.source = source
        self.name = name
    }
}

/// One bounded conversion warning, e.g. a sanitized id or a dropped self-loop.
/// `line` is 1-based in the submitted source when the issue is line-anchored.
public struct SpatialDiagramMermaidImportIssue: Codable, Hashable, Sendable {
    public var line: Int?
    public var message: String

    public init(line: Int? = nil, message: String) {
        self.line = line
        self.message = message
    }
}

/// The conversion result. `content` is the canonical `.diagram.json` text the
/// client writes verbatim through the bounded workspace file PUT — never
/// re-serialized, so re-importing an unchanged sketch stays byte-identical.
/// `slug` is the backend-derived filename stem (`<slug>.diagram.json`), so
/// filename rules live in one place.
public struct SpatialDiagramMermaidImportResponse: Codable, Hashable, Sendable {
    public var content: String
    public var name: String
    public var slug: String
    public var warnings: [SpatialDiagramMermaidImportIssue]

    public init(
        content: String,
        name: String,
        slug: String,
        warnings: [SpatialDiagramMermaidImportIssue] = []
    ) {
        self.content = content
        self.name = name
        self.slug = slug
        self.warnings = warnings
    }
}

// MARK: - Diagram edit bridge

/// The engine's starting vocabulary, mirrored from the backend authoring
/// contract for the client's own controls (a role menu, an edge-kind menu).
/// The backend accepts any id-grammar value — the palette is what it renders
/// specially — so these lists are presentation, not validation.
public enum SpatialDiagramPalette {
    public static let roles = [
        "service", "datastore", "queue", "cache", "external", "actor", "gateway", "function",
        "load_balancer", "cdn", "auth", "scheduler", "blob_storage", "ml_model", "stream"
    ]
    public static let edgeKinds = ["sync", "async", "read_write", "event", "replicates"]
}

/// One semantic operation for `POST /api/spatial-scene/diagram-edit`.
///
/// The vocabulary edits labels, roles, kinds, membership, and existence —
/// deliberately never ids, which the backend derives from labels, because ids
/// are the keys human overrides attach to and a renamed id orphans them.
public enum SpatialDiagramEditOp: Hashable, Sendable {
    case addNode(label: String, role: String, groupId: String? = nil)
    case addEdge(fromId: String, toId: String, kind: String? = nil, label: String? = nil)
    case setNodeLabel(nodeId: String, label: String)
    case setNodeRole(nodeId: String, role: String)
    case setEdgeKind(edgeId: String, kind: String)
    /// `label: nil` clears the edge label — encoded as an explicit JSON `null`,
    /// which is how the backend distinguishes "clear" from "leave alone".
    case setEdgeLabel(edgeId: String, label: String?)
    case deleteNode(nodeId: String)
    case deleteEdge(edgeId: String)
    case addGroup(label: String)
    /// `groupId: nil` moves the node out of its group — an explicit JSON `null`
    /// on the wire, like a cleared edge label.
    case setNodeGroup(nodeId: String, groupId: String?)
    case deleteGroup(groupId: String)
    case setName(name: String)
    /// The v3 description ops. `description: nil` clears — an explicit JSON
    /// `null` on the wire, like a cleared edge label.
    case setNodeDescription(nodeId: String, description: String?)
    case setEdgeDescription(edgeId: String, description: String?)
    case setGroupDescription(groupId: String, description: String?)
    case setDescription(description: String?)
}

extension SpatialDiagramEditOp: Codable {
    private enum CodingKeys: String, CodingKey {
        case op, label, role, groupId, fromId, toId, kind, nodeId, edgeId, name, description
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .addNode(label, role, groupId):
            try container.encode("addNode", forKey: .op)
            try container.encode(label, forKey: .label)
            try container.encode(role, forKey: .role)
            try container.encodeIfPresent(groupId, forKey: .groupId)
        case let .addEdge(fromId, toId, kind, label):
            try container.encode("addEdge", forKey: .op)
            try container.encode(fromId, forKey: .fromId)
            try container.encode(toId, forKey: .toId)
            try container.encodeIfPresent(kind, forKey: .kind)
            try container.encodeIfPresent(label, forKey: .label)
        case let .setNodeLabel(nodeId, label):
            try container.encode("setNodeLabel", forKey: .op)
            try container.encode(nodeId, forKey: .nodeId)
            try container.encode(label, forKey: .label)
        case let .setNodeRole(nodeId, role):
            try container.encode("setNodeRole", forKey: .op)
            try container.encode(nodeId, forKey: .nodeId)
            try container.encode(role, forKey: .role)
        case let .setEdgeKind(edgeId, kind):
            try container.encode("setEdgeKind", forKey: .op)
            try container.encode(edgeId, forKey: .edgeId)
            try container.encode(kind, forKey: .kind)
        case let .setEdgeLabel(edgeId, label):
            try container.encode("setEdgeLabel", forKey: .op)
            try container.encode(edgeId, forKey: .edgeId)
            // An absent key would fail the backend's strict op schema; the null
            // is the payload.
            try container.encode(label, forKey: .label)
        case let .deleteNode(nodeId):
            try container.encode("deleteNode", forKey: .op)
            try container.encode(nodeId, forKey: .nodeId)
        case let .deleteEdge(edgeId):
            try container.encode("deleteEdge", forKey: .op)
            try container.encode(edgeId, forKey: .edgeId)
        case let .addGroup(label):
            try container.encode("addGroup", forKey: .op)
            try container.encode(label, forKey: .label)
        case let .setNodeGroup(nodeId, groupId):
            try container.encode("setNodeGroup", forKey: .op)
            try container.encode(nodeId, forKey: .nodeId)
            try container.encode(groupId, forKey: .groupId)
        case let .deleteGroup(groupId):
            try container.encode("deleteGroup", forKey: .op)
            try container.encode(groupId, forKey: .groupId)
        case let .setName(name):
            try container.encode("setName", forKey: .op)
            try container.encode(name, forKey: .name)
        case let .setNodeDescription(nodeId, description):
            try container.encode("setNodeDescription", forKey: .op)
            try container.encode(nodeId, forKey: .nodeId)
            // An absent key would fail the backend's strict op schema; the null
            // is the payload.
            try container.encode(description, forKey: .description)
        case let .setEdgeDescription(edgeId, description):
            try container.encode("setEdgeDescription", forKey: .op)
            try container.encode(edgeId, forKey: .edgeId)
            try container.encode(description, forKey: .description)
        case let .setGroupDescription(groupId, description):
            try container.encode("setGroupDescription", forKey: .op)
            try container.encode(groupId, forKey: .groupId)
            try container.encode(description, forKey: .description)
        case let .setDescription(description):
            try container.encode("setDescription", forKey: .op)
            try container.encode(description, forKey: .description)
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let op = try container.decode(String.self, forKey: .op)
        switch op {
        case "addNode":
            self = .addNode(
                label: try container.decode(String.self, forKey: .label),
                role: try container.decode(String.self, forKey: .role),
                groupId: try container.decodeIfPresent(String.self, forKey: .groupId)
            )
        case "addEdge":
            self = .addEdge(
                fromId: try container.decode(String.self, forKey: .fromId),
                toId: try container.decode(String.self, forKey: .toId),
                kind: try container.decodeIfPresent(String.self, forKey: .kind),
                label: try container.decodeIfPresent(String.self, forKey: .label)
            )
        case "setNodeLabel":
            self = .setNodeLabel(
                nodeId: try container.decode(String.self, forKey: .nodeId),
                label: try container.decode(String.self, forKey: .label)
            )
        case "setNodeRole":
            self = .setNodeRole(
                nodeId: try container.decode(String.self, forKey: .nodeId),
                role: try container.decode(String.self, forKey: .role)
            )
        case "setEdgeKind":
            self = .setEdgeKind(
                edgeId: try container.decode(String.self, forKey: .edgeId),
                kind: try container.decode(String.self, forKey: .kind)
            )
        case "setEdgeLabel":
            self = .setEdgeLabel(
                edgeId: try container.decode(String.self, forKey: .edgeId),
                label: try container.decodeIfPresent(String.self, forKey: .label)
            )
        case "deleteNode":
            self = .deleteNode(nodeId: try container.decode(String.self, forKey: .nodeId))
        case "deleteEdge":
            self = .deleteEdge(edgeId: try container.decode(String.self, forKey: .edgeId))
        case "addGroup":
            self = .addGroup(label: try container.decode(String.self, forKey: .label))
        case "setNodeGroup":
            self = .setNodeGroup(
                nodeId: try container.decode(String.self, forKey: .nodeId),
                groupId: try container.decodeIfPresent(String.self, forKey: .groupId)
            )
        case "deleteGroup":
            self = .deleteGroup(groupId: try container.decode(String.self, forKey: .groupId))
        case "setName":
            self = .setName(name: try container.decode(String.self, forKey: .name))
        case "setNodeDescription":
            self = .setNodeDescription(
                nodeId: try container.decode(String.self, forKey: .nodeId),
                description: try container.decodeIfPresent(String.self, forKey: .description)
            )
        case "setEdgeDescription":
            self = .setEdgeDescription(
                edgeId: try container.decode(String.self, forKey: .edgeId),
                description: try container.decodeIfPresent(String.self, forKey: .description)
            )
        case "setGroupDescription":
            self = .setGroupDescription(
                groupId: try container.decode(String.self, forKey: .groupId),
                description: try container.decodeIfPresent(String.self, forKey: .description)
            )
        case "setDescription":
            self = .setDescription(
                description: try container.decodeIfPresent(String.self, forKey: .description)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .op,
                in: container,
                debugDescription: "Unknown diagram edit op \"\(op)\""
            )
        }
    }
}

/// Request body for `POST /api/spatial-scene/diagram-edit`. `baseContent` is
/// the current base document text, verbatim from the bounded file-preview read;
/// omitting it starts from an empty document (the New Diagram path), and only
/// then may `name` be supplied.
public struct SpatialDiagramEditRequest: Codable, Hashable, Sendable {
    public var baseContent: String?
    public var name: String?
    public var ops: [SpatialDiagramEditOp]

    public init(baseContent: String? = nil, name: String? = nil, ops: [SpatialDiagramEditOp]) {
        self.baseContent = baseContent
        self.name = name
        self.ops = ops
    }
}

/// One bounded warning or error from the edit engine. `opIndex` is 0-based
/// into the submitted op list; absent for base-document problems, where `path`
/// locates the issue instead.
public struct SpatialDiagramEditIssue: Codable, Hashable, Sendable {
    public var opIndex: Int?
    public var path: String?
    public var message: String

    public init(opIndex: Int? = nil, path: String? = nil, message: String) {
        self.opIndex = opIndex
        self.path = path
        self.message = message
    }
}

/// One id the edit allocated (`addNode`, `addEdge`, `addGroup`), so a client
/// can co-write a placement override for a dropped node without parsing the
/// document. `type` is `node`, `edge`, or `group`.
public struct SpatialDiagramEditCreated: Codable, Hashable, Sendable {
    public var opIndex: Int
    public var type: String
    public var id: String

    public init(opIndex: Int, type: String, id: String) {
        self.opIndex = opIndex
        self.type = type
        self.id = id
    }
}

/// The edit result: new canonical document text the client writes through the
/// bounded workspace file PUT with the base layer's optimistic-lock token —
/// same serializer as the Mermaid import, so a no-op edit round-trips
/// byte-identically.
public struct SpatialDiagramEditResponse: Codable, Hashable, Sendable {
    public var content: String
    public var name: String
    public var slug: String
    public var warnings: [SpatialDiagramEditIssue]
    public var created: [SpatialDiagramEditCreated]

    public init(
        content: String,
        name: String,
        slug: String,
        warnings: [SpatialDiagramEditIssue] = [],
        created: [SpatialDiagramEditCreated] = []
    ) {
        self.content = content
        self.name = name
        self.slug = slug
        self.warnings = warnings
        self.created = created
    }
}
