import { describe, expect, it } from "vitest";
import { composeSpatialScene, composedSceneVersion } from "../src/scene/geometry/compose";
import {
  MAX_SCENE_ENTITIES,
  basePathForHumanPath,
  humanPathForBasePath,
  isSpatialSceneBasePath,
  isSpatialSceneHumanPath,
  spatialSceneDocumentSchema,
  spatialSceneHumanDocumentSchema,
  type SpatialSceneDocument,
  type SpatialSceneEntity,
  type SpatialSceneHumanDocument
} from "../src/scene/geometry/schemas";

function entity(id: string, overrides: Partial<SpatialSceneEntity> = {}): SpatialSceneEntity {
  return {
    id,
    geometry: { kind: "box", size: [0.2, 0.2, 0.2] },
    transform: { position: [0, 0.1, 0] },
    ...overrides
  };
}

function baseDocument(entities: SpatialSceneEntity[]): SpatialSceneDocument {
  return { schemaVersion: 1, name: "Test scene", entities };
}

function humanDocument(input: Partial<SpatialSceneHumanDocument> = {}): SpatialSceneHumanDocument {
  return { schemaVersion: 1, overrides: [], ...input };
}

describe("spatialSceneDocumentSchema", () => {
  it("accepts a full valid document", () => {
    const parsed = spatialSceneDocumentSchema.safeParse({
      schemaVersion: 1,
      name: "Living room draft",
      entities: [
        {
          id: "crate-1",
          name: "Crate",
          geometry: { kind: "box", size: [0.2, 0.2, 0.2], cornerRadius: 0.01 },
          transform: { position: [0, 0.1, 0], rotationEulerDegrees: [0, 45, 0], scale: [1, 1, 1] },
          material: { baseColor: "#C8873A", metallic: 0.1, roughness: 0.7, opacity: 1 },
          visible: true
        },
        { id: "ball-2", geometry: { kind: "sphere", radius: 0.1 }, transform: { position: [0.4, 0.1, 0] } },
        {
          id: "post-3",
          geometry: { kind: "cylinder", radius: 0.03, height: 0.5 },
          transform: { position: [-0.4, 0.25, 0] }
        },
        { id: "tip-4", geometry: { kind: "cone", radius: 0.05, height: 0.1 }, transform: { position: [-0.4, 0.55, 0] } },
        { id: "floor-5", geometry: { kind: "plane", width: 1, depth: 1 }, transform: { position: [0, 0, 0] } },
        {
          id: "db-6",
          geometry: { kind: "stack", count: 3, radius: 0.055, height: 0.024, gap: 0.009 },
          transform: { position: [0.4, 0.05, 0.4] }
        }
      ]
    });
    expect(parsed.success).toBe(true);
  });

  it("bounds the stacked-disk kind's count", () => {
    const stack = (count: number) => baseDocument([
      entity("db-1", {
        geometry: { kind: "stack", count, radius: 0.05, height: 0.02, gap: 0.01 }
      })
    ]);
    // One disk is a cylinder and nine is a tower of instanced meshes; the cap
    // keeps a stack in the same render-cost class as the other primitives.
    expect(spatialSceneDocumentSchema.safeParse(stack(2)).success).toBe(true);
    expect(spatialSceneDocumentSchema.safeParse(stack(8)).success).toBe(true);
    expect(spatialSceneDocumentSchema.safeParse(stack(1)).success).toBe(false);
    expect(spatialSceneDocumentSchema.safeParse(stack(9)).success).toBe(false);
    expect(spatialSceneDocumentSchema.safeParse(stack(2.5)).success).toBe(false);
  });

  it("rejects invalid entity ids", () => {
    const parsed = spatialSceneDocumentSchema.safeParse(baseDocument([entity("Crate One" as string)]));
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate entity ids", () => {
    const parsed = spatialSceneDocumentSchema.safeParse(baseDocument([entity("crate-1"), entity("crate-1")]));
    expect(parsed.success).toBe(false);
  });

  it("rejects documents above the entity cap", () => {
    const entities = Array.from({ length: MAX_SCENE_ENTITIES + 1 }, (_, index) => entity(`entity-${index}`));
    const parsed = spatialSceneDocumentSchema.safeParse(baseDocument(entities));
    expect(parsed.success).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    const parsed = spatialSceneDocumentSchema.safeParse(
      baseDocument([entity("crate-1", { transform: { position: [Number.POSITIVE_INFINITY, 0, 0] } })])
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown geometry kinds", () => {
    const parsed = spatialSceneDocumentSchema.safeParse(
      baseDocument([
        { ...entity("crate-1"), geometry: { kind: "torus", radius: 0.2 } as unknown as SpatialSceneEntity["geometry"] }
      ])
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unsupported schema versions", () => {
    const parsed = spatialSceneDocumentSchema.safeParse({ schemaVersion: 2, entities: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("spatialSceneHumanDocumentSchema", () => {
  it("accepts a valid override document", () => {
    const parsed = spatialSceneHumanDocumentSchema.safeParse({
      schemaVersion: 1,
      baseline: "abc123",
      overrides: [{ id: "crate-1", transform: { position: [0.25, 0.1, -0.1] }, locked: true }],
      removed: ["ball-2"]
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects duplicate override ids", () => {
    const parsed = spatialSceneHumanDocumentSchema.safeParse(
      humanDocument({ overrides: [{ id: "crate-1" }, { id: "crate-1" }] })
    );
    expect(parsed.success).toBe(false);
  });
});

describe("scene path helpers", () => {
  it("classifies base and human paths", () => {
    expect(isSpatialSceneBasePath("main.scene.json")).toBe(true);
    expect(isSpatialSceneBasePath("scenes/room.scene.json")).toBe(true);
    expect(isSpatialSceneBasePath("main.scene.human.json")).toBe(false);
    expect(isSpatialSceneBasePath("main.json")).toBe(false);
    expect(isSpatialSceneHumanPath("main.scene.human.json")).toBe(true);
    expect(isSpatialSceneHumanPath("main.scene.json")).toBe(false);
  });

  it("maps between base and human paths", () => {
    expect(humanPathForBasePath("scenes/room.scene.json")).toBe("scenes/room.scene.human.json");
    expect(basePathForHumanPath("scenes/room.scene.human.json")).toBe("scenes/room.scene.json");
  });
});

describe("composeSpatialScene", () => {
  it("applies overrides field-wise and keeps unset fields from the base", () => {
    const base = baseDocument([
      entity("crate-1", {
        transform: { position: [0, 0.1, 0], rotationEulerDegrees: [0, 45, 0], scale: [1, 1, 1] }
      })
    ]);
    const composed = composeSpatialScene(
      base,
      humanDocument({ overrides: [{ id: "crate-1", transform: { position: [0.25, 0.1, -0.1] } }] })
    );
    expect(composed.entities[0]?.transform.position).toEqual([0.25, 0.1, -0.1]);
    expect(composed.entities[0]?.transform.rotationEulerDegrees).toEqual([0, 45, 0]);
    expect(composed.entities[0]?.transform.scale).toEqual([1, 1, 1]);
    expect(composed.entities[0]?.humanEdited).toBe(true);
  });

  it("drops removed entities and ignores unknown override ids", () => {
    const base = baseDocument([entity("crate-1"), entity("ball-2")]);
    const composed = composeSpatialScene(
      base,
      humanDocument({ overrides: [{ id: "ghost-9", locked: true }], removed: ["ball-2"] })
    );
    expect(composed.entities.map((composedEntity) => composedEntity.id)).toEqual(["crate-1"]);
    expect(composed.entities[0]?.humanEdited).toBe(false);
  });

  it("resolves visibility and lock flags", () => {
    const base = baseDocument([entity("crate-1", { visible: false }), entity("ball-2")]);
    const composed = composeSpatialScene(
      base,
      humanDocument({ overrides: [{ id: "crate-1", visible: true }, { id: "ball-2", locked: true }] })
    );
    expect(composed.entities[0]?.visible).toBe(true);
    expect(composed.entities[0]?.locked).toBe(false);
    expect(composed.entities[1]?.visible).toBe(true);
    expect(composed.entities[1]?.locked).toBe(true);
  });

  it("composes without a human document", () => {
    const composed = composeSpatialScene(baseDocument([entity("crate-1")]), undefined);
    expect(composed.entities[0]?.visible).toBe(true);
    expect(composed.entities[0]?.locked).toBe(false);
    expect(composed.entities[0]?.humanEdited).toBe(false);
  });
});

describe("composedSceneVersion", () => {
  it("is stable for identical documents and changes with any field", () => {
    const base = baseDocument([entity("crate-1")]);
    const human = humanDocument({ overrides: [{ id: "crate-1", transform: { position: [0.2, 0.1, 0] } }] });
    const versionA = composedSceneVersion(composeSpatialScene(base, human));
    const versionB = composedSceneVersion(composeSpatialScene(base, human));
    expect(versionA).toBe(versionB);

    const moved = humanDocument({ overrides: [{ id: "crate-1", transform: { position: [0.3, 0.1, 0] } }] });
    const versionC = composedSceneVersion(composeSpatialScene(base, moved));
    expect(versionC).not.toBe(versionA);
  });
});
