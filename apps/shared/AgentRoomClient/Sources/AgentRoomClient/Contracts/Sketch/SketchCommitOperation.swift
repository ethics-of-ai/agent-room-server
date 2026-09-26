import Foundation

/// One caller operation of the sketch vocabulary, as the backend accepts it
/// from clients. Transforms are absolute (set, not delta), which is
/// what makes commit-once-per-gesture idempotent retries safe.
public enum SketchCommitOperation: Encodable, Hashable {
    case create(SketchObjectCreation)
    case update(SketchObjectUpdate)
    case setTransform(objectId: String, transform: SketchTransform)
    case delete(objectId: String)
    /// Removes every object in one undoable transaction.
    case clear
    case group(groupId: String, memberIds: [String], parentId: String?)
    case ungroup(groupId: String)

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .create(creation):
            try container.encode("create", forKey: .op)
            try container.encodeIfPresent(creation.objectId, forKey: .objectId)
            try container.encodeIfPresent(creation.kind, forKey: .kind)
            try container.encodeIfPresent(creation.points, forKey: .points)
            try container.encodeIfPresent(creation.width, forKey: .width)
            try container.encodeIfPresent(creation.brush, forKey: .brush)
            try container.encodeIfPresent(creation.lineStyle, forKey: .lineStyle)
            try container.encodeIfPresent(creation.shapeType, forKey: .shapeType)
            try container.encodeIfPresent(creation.appearance, forKey: .appearance)
            try container.encodeIfPresent(creation.fillColor, forKey: .fillColor)
            try container.encodeIfPresent(creation.outlineColor, forKey: .outlineColor)
            try container.encodeIfPresent(creation.outlineWidth, forKey: .outlineWidth)
            try container.encodeIfPresent(creation.size, forKey: .size)
            try container.encodeIfPresent(creation.text, forKey: .text)
            try container.encodeIfPresent(creation.color, forKey: .color)
            try container.encodeIfPresent(creation.transform, forKey: .transform)
        case let .update(update):
            try container.encode("update", forKey: .op)
            try container.encodeIfPresent(update.objectId, forKey: .objectId)
            try container.encodeIfPresent(update.kind, forKey: .kind)
            try container.encodeIfPresent(update.points, forKey: .points)
            try container.encodeIfPresent(update.width, forKey: .width)
            try container.encodeIfPresent(update.brush, forKey: .brush)
            try container.encodeIfPresent(update.lineStyle, forKey: .lineStyle)
            try container.encodeIfPresent(update.shapeType, forKey: .shapeType)
            try container.encodeIfPresent(update.appearance, forKey: .appearance)
            try container.encodeIfPresent(update.fillColor, forKey: .fillColor)
            try container.encodeIfPresent(update.outlineColor, forKey: .outlineColor)
            try container.encodeIfPresent(update.outlineWidth, forKey: .outlineWidth)
            try container.encodeIfPresent(update.size, forKey: .size)
            try container.encodeIfPresent(update.text, forKey: .text)
            try container.encodeIfPresent(update.color, forKey: .color)
        case let .setTransform(objectId, transform):
            try container.encode("transform", forKey: .op)
            try container.encode(objectId, forKey: .objectId)
            try container.encode(transform, forKey: .transform)
        case let .delete(objectId):
            try container.encode("delete", forKey: .op)
            try container.encode(objectId, forKey: .objectId)
        case .clear:
            try container.encode("clear", forKey: .op)
        case let .group(groupId, memberIds, parentId):
            try container.encode("group", forKey: .op)
            try container.encode(groupId, forKey: .groupId)
            try container.encode(memberIds, forKey: .memberIds)
            try container.encodeIfPresent(parentId, forKey: .parentId)
        case let .ungroup(groupId):
            try container.encode("ungroup", forKey: .op)
            try container.encode(groupId, forKey: .groupId)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case op
        case objectId
        case kind
        case points
        case width
        case brush
        case lineStyle
        case shapeType
        case appearance
        case fillColor
        case outlineColor
        case outlineWidth
        case size
        case text
        case color
        case transform
        case groupId
        case memberIds
        case parentId
    }
}
