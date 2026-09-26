import { SKETCH_COORDINATE_LIMIT } from "./limits";
import type { SketchObject, SketchTransform } from "./schemas";

// Vector and quaternion math for composing sketch transforms. Pure functions,
// no dependencies on zod parsing: callers hand already-validated numbers.
//
// Conventions: [x, y, z] vectors, [x, y, z, w] quaternions, TRS application
// order (world = T + R * (S ∘ local)), and parent-relative composition
// world(child) = world(parent) ∘ local(child) — matrix terms: M = M_parent ·
// M_local. RealityKit uses the same right-handed y-up conventions, so B05
// mirrors these formulas in Swift rather than converting.

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export const SKETCH_IDENTITY_TRANSFORM: SketchTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1]
};

// An absent transform means identity; the evaluator stores transforms
// explicitly after every mutation, but parsed documents may omit them.
export function resolveSketchTransform(transform: SketchTransform | undefined): SketchTransform {
  return transform ?? SKETCH_IDENTITY_TRANSFORM;
}

function multiplyComponentwise(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function quatNorm(q: Quaternion): number {
  return Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
}

export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

// Rotates v by unit quaternion q: v' = q v q⁻¹, unrolled.
export function rotateVector(q: Quaternion, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx)
  ];
}

export function composeSketchTransform(parent: SketchTransform, child: SketchTransform): SketchTransform {
  const scale = multiplyComponentwise(parent.scale, child.scale);
  const rotation = quatMultiply(parent.rotation, child.rotation);
  const scaledTranslation = multiplyComponentwise(parent.scale, child.translation);
  const rotated = rotateVector(parent.rotation, scaledTranslation);
  return {
    translation: [
      parent.translation[0] + rotated[0],
      parent.translation[1] + rotated[1],
      parent.translation[2] + rotated[2]
    ],
    rotation,
    scale
  };
}

export function transformPoint(transform: SketchTransform, point: Vec3): Vec3 {
  const scaled = multiplyComponentwise(transform.scale, point);
  const rotated = rotateVector(transform.rotation, scaled);
  return [
    transform.translation[0] + rotated[0],
    transform.translation[1] + rotated[1],
    transform.translation[2] + rotated[2]
  ];
}

// Faces are inclusive: geometry may sit exactly on the volume boundary.
export function isWithinSketchCube(v: Vec3): boolean {
  return (
    Math.abs(v[0]) <= SKETCH_COORDINATE_LIMIT &&
    Math.abs(v[1]) <= SKETCH_COORDINATE_LIMIT &&
    Math.abs(v[2]) <= SKETCH_COORDINATE_LIMIT
  );
}

// The eight corners of a box centered on its local origin.
export function boxCorners(size: Vec3): Vec3[] {
  const hx = size[0] / 2;
  const hy = size[1] / 2;
  const hz = size[2] / 2;
  return [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [-hx, hy, -hz],
    [hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [-hx, hy, hz],
    [hx, hy, hz]
  ];
}

// --- parent-chain walks -------------------------------------------------------

export interface ObjectIndex {
  byId: Map<string, SketchObject>;
  // Insertion order preserved for deterministic walks.
  objects: SketchObject[];
}

export function indexSketchObjects(objects: SketchObject[]): ObjectIndex {
  return { byId: new Map(objects.map((object) => [object.id, object])), objects };
}

// Parent ids are typed on known kinds; unknown-kind objects carry theirs
// through passthrough, so read defensively and let the invariant checker
// report anything malformed.
export function readParentId(object: SketchObject): string | undefined {
  const raw = (object as { parentId?: unknown }).parentId;
  return typeof raw === "string" ? raw : undefined;
}

// Transforms need the same defensive read: an unknown-kind object's stored
// transform is passthrough data. Anything malformed composes to NaN, which
// the world-bounds check rejects rather than silently accepting.
export function readStoredTransform(object: SketchObject): SketchTransform | undefined {
  const raw = (object as { transform?: unknown }).transform;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  return raw as SketchTransform;
}

// The object's ancestor ids, nearest parent first. Assumes the invariant
// checker has already rejected missing parents and cycles.
export function ancestorIds(objectId: string, index: ObjectIndex): string[] {
  const chain: string[] = [];
  let currentId: string | undefined = objectId;
  while (currentId !== undefined) {
    const object = index.byId.get(currentId);
    if (object === undefined) {
      break;
    }
    const parent = readParentId(object);
    if (parent === undefined) {
      break;
    }
    chain.push(parent);
    currentId = parent;
  }
  return chain;
}

export function isDescendantOf(candidateId: string, ancestorId: string, index: ObjectIndex): boolean {
  return ancestorIds(candidateId, index).includes(ancestorId);
}

// The object and every descendant, nearest-first by generation. Unknown kinds
// participate: group membership is structural.
export function subtreeOf(objectId: string, index: ObjectIndex): SketchObject[] {
  const childrenOf = new Map<string, string[]>();
  for (const object of index.objects) {
    const parent = readParentId(object);
    if (parent !== undefined) {
      const list = childrenOf.get(parent);
      if (list === undefined) {
        childrenOf.set(parent, [object.id]);
      } else {
        list.push(object.id);
      }
    }
  }
  const collected: SketchObject[] = [];
  const queue = [objectId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      continue;
    }
    const object = index.byId.get(id);
    if (object === undefined) {
      continue;
    }
    collected.push(object);
    for (const child of childrenOf.get(id) ?? []) {
      queue.push(child);
    }
  }
  return collected;
}

// Composes an object's transform with its parent chain (root first). Assumes
// acyclic, resolvable parents — the invariant checker runs before this.
export function worldTransformOf(object: SketchObject, index: ObjectIndex): SketchTransform {
  const chain: SketchTransform[] = [];
  let current: SketchObject | undefined = object;
  while (current !== undefined) {
    chain.unshift(resolveSketchTransform(readStoredTransform(current)));
    const parent = readParentId(current);
    current = parent === undefined ? undefined : index.byId.get(parent);
  }
  return chain.reduce((world, local) => composeSketchTransform(world, local));
}
