import { SKETCH_SCHEMA_VERSION } from "./limits";
import type {
  SketchCallerOperation,
  SketchDocument,
  SketchObject,
  SketchStrokeObject
} from "./schemas";

// Deterministic fixtures for tests and later contract work (B03 routes,
// B05 client hydration). Everything here is plain data with no randomness,
// so a failing test names the exact numbers that surprised it. The helix is
// the same shape family the B01 probe renders: genuinely non-planar, with
// depth extent on z rather than a flat sheet tipped into 3D.

export const FIXTURE_SKETCH_ID = "sketch-fixture-1";

export function helixStrokePoints(
  turns = 3,
  radius = 0.12,
  zAmplitude = 0.16,
  samplesPerTurn = 20
): SketchStrokeObject["points"] {
  const points: SketchStrokeObject["points"] = [];
  const total = turns * samplesPerTurn;
  for (let i = 0; i <= total; i += 1) {
    const angle = (i / samplesPerTurn) * Math.PI * 2;
    // z oscillates through the full amplitude every turn, matching the B01
    // probe's ±depth helix rather than a ramp that only rises. `+ 0` folds
    // the negative zeros trig rounding produces into plain zero, so a
    // serialize/parse round trip is byte-identical.
    const z = Math.sin(angle) * zAmplitude + 0;
    points.push([
      Math.round(Math.cos(angle) * radius * 1e6) / 1e6 + 0,
      Math.round((i / total) * 0.3 * 1e6) / 1e6 + 0,
      Math.round(z * 1e6) / 1e6 + 0
    ]);
  }
  return points;
}

function identityTransform() {
  return {
    translation: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number]
  };
}

export function nonPlanarSketchObjects(): SketchObject[] {
  return [
    {
      id: "fixture-helix",
      kind: "stroke",
      points: helixStrokePoints(),
      width: 0.006,
      brush: "finePen",
      lineStyle: "solid",
      color: "#e0b34a",
      transform: identityTransform()
    },
    {
      id: "fixture-box",
      kind: "box",
      size: [0.12, 0.12, 0.12],
      color: "#5aa7e0",
      transform: {
        translation: [0.28, 0.02, 0.14],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      }
    },
    {
      id: "fixture-label",
      kind: "text",
      text: "Route sketch",
      transform: {
        translation: [0, 0.24, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      }
    },
    {
      id: "fixture-group",
      kind: "group",
      transform: identityTransform()
    }
  ].map((object) =>
    object.id === "fixture-helix" || object.id === "fixture-box"
      ? { ...object, parentId: "fixture-group" }
      : object
  );
}

export function nonPlanarSketchDocument(revision = 4): SketchDocument {
  return {
    schemaVersion: SKETCH_SCHEMA_VERSION,
    kind: "sketch",
    sketchId: FIXTURE_SKETCH_ID,
    revision,
    objects: nonPlanarSketchObjects()
  };
}

// The canonical creation flow as a caller would express it: draw the leaf
// objects, then collect them under a group. B03 route tests and B05 client
// parity work replay exactly this sequence.
export function nonPlanarSketchCreateOperations(): SketchCallerOperation[] {
  return [
    {
      op: "create",
      objectId: "fixture-helix",
      kind: "stroke",
      points: helixStrokePoints(),
      width: 0.006,
      brush: "finePen",
      lineStyle: "solid",
      color: "#e0b34a"
    },
    {
      op: "create",
      objectId: "fixture-box",
      kind: "box",
      size: [0.12, 0.12, 0.12],
      color: "#5aa7e0",
      transform: {
        translation: [0.28, 0.02, 0.14],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      }
    },
    {
      op: "create",
      objectId: "fixture-label",
      kind: "text",
      text: "Route sketch",
      transform: {
        translation: [0, 0.24, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      }
    },
    {
      op: "group",
      groupId: "fixture-group",
      memberIds: ["fixture-helix", "fixture-box"]
    }
  ];
}

// An older reader must retain objects whose kind it does not know, including
// fields it cannot interpret. This fixture is the contract B05's Apple tests
// pin: the object survives round trips byte-for-byte in its unknown fields.
export function unknownKindObject(): SketchObject {
  return {
    id: "fixture-hexahedron",
    kind: "hexahedron",
    parentId: "fixture-group",
    vertices: [
      [0, 0, 0],
      [0.1, 0, 0],
      [0.1, 0.1, 0],
      [0, 0.1, 0],
      [0, 0, 0.1],
      [0.1, 0, 0.1],
      [0.1, 0.1, 0.1],
      [0, 0.1, 0.1]
    ],
    faces: 6,
    metadata: { source: "future-version" }
  } as SketchObject;
}

export function documentWithUnknownObject(): SketchDocument {
  return {
    ...nonPlanarSketchDocument(),
    objects: [...nonPlanarSketchObjects(), unknownKindObject()]
  };
}
