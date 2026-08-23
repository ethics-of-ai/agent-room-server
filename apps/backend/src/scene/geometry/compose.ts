import { sha256Hex } from "../../util/hash";
import type {
  ComposedSpatialSceneDocument,
  ComposedSpatialSceneEntity,
  SpatialSceneDocument,
  SpatialSceneHumanDocument,
  SpatialSceneHumanOverride,
  SpatialSceneTransform
} from "./schemas";

// Compose rules: base order is preserved; ids in `removed` are dropped;
// overrides merge field-wise (an override position replaces the base position,
// unset fields fall through). Overrides referencing unknown ids are ignored —
// the agent may re-add that entity later and the human placement re-attaches.
export function composeSpatialScene(
  base: SpatialSceneDocument,
  human: SpatialSceneHumanDocument | undefined
): ComposedSpatialSceneDocument {
  const removed = new Set(human?.removed ?? []);
  const overridesById = new Map<string, SpatialSceneHumanOverride>();
  for (const override of human?.overrides ?? []) {
    overridesById.set(override.id, override);
  }

  const entities: ComposedSpatialSceneEntity[] = [];
  for (const entity of base.entities) {
    if (removed.has(entity.id)) {
      continue;
    }
    const override = overridesById.get(entity.id);
    const rotation = override?.transform?.rotationEulerDegrees ?? entity.transform.rotationEulerDegrees;
    const scale = override?.transform?.scale ?? entity.transform.scale;
    const transform: SpatialSceneTransform = {
      position: override?.transform?.position ?? entity.transform.position,
      ...(rotation ? { rotationEulerDegrees: rotation } : {}),
      ...(scale ? { scale } : {})
    };
    entities.push({
      id: entity.id,
      ...(entity.name ? { name: entity.name } : {}),
      geometry: entity.geometry,
      transform,
      ...(entity.material ? { material: entity.material } : {}),
      visible: override?.visible ?? entity.visible ?? true,
      locked: override?.locked ?? false,
      humanEdited: override !== undefined
    });
  }

  return {
    schemaVersion: base.schemaVersion,
    ...(base.name ? { name: base.name } : {}),
    entities
  };
}

// Deterministic because composeSpatialScene constructs every object with a
// fixed key insertion order and omits undefined fields. Clients use the version
// to dedupe re-reads of the composed route.
export function composedSceneVersion(document: ComposedSpatialSceneDocument): string {
  return sha256Hex(JSON.stringify(document));
}
