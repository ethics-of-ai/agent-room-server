import { z } from "zod";

// The spatial scene engine's document contracts. A scene is two ordinary
// workspace text files under the existing read/write bounding:
//
// - `<name>.scene.json` (base layer): the declarative scene the coding agent
//   authors and edits like any other file in its turn.
// - `<name>.scene.human.json` (override layer): written only by clients, it
//   carries per-entity human overrides (transform, visibility, lock) plus a
//   removed list. The backend composes base + override; human placement is
//   never stored in — and can never be clobbered by — the base layer.
//
// Units are meters, y-up, right-handed (RealityKit-native, no conversion).
// Rotation is euler degrees [x, y, z] applied extrinsically as
// q = qZ(z) * qY(y) * qX(x) — hand-writable by the agent, mirrored by the
// Swift entity builder.

export const SPATIAL_SCENE_SCHEMA_VERSION = 1;
export const MAX_SCENE_ENTITIES = 64;

export const SPATIAL_SCENE_BASE_SUFFIX = ".scene.json";
export const SPATIAL_SCENE_HUMAN_SUFFIX = ".scene.human.json";

const entityIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
  message: "Entity ids must match ^[a-z0-9][a-z0-9_-]{0,63}$"
});

const finiteNumber = z.number().finite();
const positionComponentSchema = finiteNumber.min(-50).max(50);
const rotationDegreesSchema = finiteNumber.min(-36000).max(36000);
const scaleComponentSchema = finiteNumber.min(0.001).max(100);
const dimensionSchema = finiteNumber.min(0.0001).max(50);
const cornerRadiusSchema = finiteNumber.min(0).max(50);
const unitIntervalSchema = finiteNumber.min(0).max(1);

const positionSchema = z.tuple([positionComponentSchema, positionComponentSchema, positionComponentSchema]);
const rotationSchema = z.tuple([rotationDegreesSchema, rotationDegreesSchema, rotationDegreesSchema]);
const scaleSchema = z.tuple([scaleComponentSchema, scaleComponentSchema, scaleComponentSchema]);

export const spatialSceneTransformSchema = z.object({
  position: positionSchema,
  rotationEulerDegrees: rotationSchema.optional(),
  scale: scaleSchema.optional()
});

// Override transforms may set any subset of fields; unset fields fall through
// to the base layer.
export const spatialSceneTransformOverrideSchema = z.object({
  position: positionSchema.optional(),
  rotationEulerDegrees: rotationSchema.optional(),
  scale: scaleSchema.optional()
});

export const spatialSceneGeometrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("box"),
    size: z.tuple([dimensionSchema, dimensionSchema, dimensionSchema]),
    cornerRadius: cornerRadiusSchema.optional()
  }),
  z.object({
    kind: z.literal("sphere"),
    radius: dimensionSchema
  }),
  z.object({
    kind: z.literal("cylinder"),
    radius: dimensionSchema,
    height: dimensionSchema
  }),
  z.object({
    kind: z.literal("cone"),
    radius: dimensionSchema,
    height: dimensionSchema
  }),
  z.object({
    kind: z.literal("plane"),
    width: dimensionSchema,
    depth: dimensionSchema,
    cornerRadius: cornerRadiusSchema.optional()
  }),
  // A vertical stack of identical disks — the one silhouette everyone reads
  // as a database. `radius`/`height` describe each disk; `gap` is the air
  // between neighbours (zero is legal and composes them into one column).
  // The count is bounded because each disk is a rendered instance: the cap
  // keeps a 64-entity document's mesh cost in the same class as the other
  // primitives.
  z.object({
    kind: z.literal("stack"),
    count: z.number().int().min(2).max(8),
    radius: dimensionSchema,
    height: dimensionSchema,
    gap: finiteNumber.min(0).max(50)
  })
]);

export const spatialSceneMaterialSchema = z.object({
  baseColor: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, { message: "baseColor must be #RRGGBB or #RRGGBBAA" })
    .optional(),
  metallic: unitIntervalSchema.optional(),
  roughness: unitIntervalSchema.optional(),
  opacity: unitIntervalSchema.optional()
});

export const spatialSceneEntitySchema = z.object({
  id: entityIdSchema,
  name: z.string().min(1).max(120).optional(),
  geometry: spatialSceneGeometrySchema,
  transform: spatialSceneTransformSchema,
  material: spatialSceneMaterialSchema.optional(),
  visible: z.boolean().optional()
});

export const spatialSceneDocumentSchema = z
  .object({
    schemaVersion: z.literal(SPATIAL_SCENE_SCHEMA_VERSION),
    name: z.string().min(1).max(120).optional(),
    entities: z.array(spatialSceneEntitySchema).max(MAX_SCENE_ENTITIES)
  })
  .superRefine((document, context) => {
    const seen = new Set<string>();
    for (const entity of document.entities) {
      if (seen.has(entity.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate entity id "${entity.id}"`,
          path: ["entities"]
        });
      }
      seen.add(entity.id);
    }
  });

export const spatialSceneHumanOverrideSchema = z.object({
  id: entityIdSchema,
  transform: spatialSceneTransformOverrideSchema.optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional()
});

export const spatialSceneHumanDocumentSchema = z
  .object({
    schemaVersion: z.literal(SPATIAL_SCENE_SCHEMA_VERSION),
    baseline: z.string().max(128).optional(),
    overrides: z.array(spatialSceneHumanOverrideSchema).max(MAX_SCENE_ENTITIES),
    removed: z.array(entityIdSchema).max(MAX_SCENE_ENTITIES).optional()
  })
  .superRefine((document, context) => {
    const seen = new Set<string>();
    for (const override of document.overrides) {
      if (seen.has(override.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate override id "${override.id}"`,
          path: ["overrides"]
        });
      }
      seen.add(override.id);
    }
  });

export type SpatialSceneTransform = z.infer<typeof spatialSceneTransformSchema>;
export type SpatialSceneTransformOverride = z.infer<typeof spatialSceneTransformOverrideSchema>;
export type SpatialSceneGeometry = z.infer<typeof spatialSceneGeometrySchema>;
export type SpatialSceneMaterial = z.infer<typeof spatialSceneMaterialSchema>;
export type SpatialSceneEntity = z.infer<typeof spatialSceneEntitySchema>;
export type SpatialSceneDocument = z.infer<typeof spatialSceneDocumentSchema>;
export type SpatialSceneHumanOverride = z.infer<typeof spatialSceneHumanOverrideSchema>;
export type SpatialSceneHumanDocument = z.infer<typeof spatialSceneHumanDocumentSchema>;

export interface ComposedSpatialSceneEntity {
  id: string;
  name?: string;
  geometry: SpatialSceneGeometry;
  transform: SpatialSceneTransform;
  material?: SpatialSceneMaterial;
  visible: boolean;
  locked: boolean;
  humanEdited: boolean;
}

export interface ComposedSpatialSceneDocument {
  schemaVersion: typeof SPATIAL_SCENE_SCHEMA_VERSION;
  name?: string;
  entities: ComposedSpatialSceneEntity[];
}

export function isSpatialSceneHumanPath(path: string): boolean {
  return path.endsWith(SPATIAL_SCENE_HUMAN_SUFFIX);
}

export function isSpatialSceneBasePath(path: string): boolean {
  return path.endsWith(SPATIAL_SCENE_BASE_SUFFIX) && !isSpatialSceneHumanPath(path);
}

export function humanPathForBasePath(basePath: string): string {
  return `${basePath.slice(0, -SPATIAL_SCENE_BASE_SUFFIX.length)}${SPATIAL_SCENE_HUMAN_SUFFIX}`;
}

export function basePathForHumanPath(humanPath: string): string {
  return `${humanPath.slice(0, -SPATIAL_SCENE_HUMAN_SUFFIX.length)}${SPATIAL_SCENE_BASE_SUFFIX}`;
}
