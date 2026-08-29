// The caps and name rules every workspace read and write is bounded by. They
// live in one module because the read path, the write path, the file index, and
// the content search must apply exactly the same refusals — a rule stated twice
// is a rule that drifts. See `docs/safety/TRUST_AND_SAFETY.md`.

export const ignoredNames = new Set([
  ".DS_Store",
  ".agentroom",
  ".git",
  ".next",
  ".turbo",
  "DerivedData",
  "build",
  "dist",
  "node_modules"
]);
const secretNames = new Set([".env", ".env.local", ".env.production", ".npmrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const secretExtensions = [".key", ".pem", ".p12", ".pfx"];

export const maxDepth = 4;
export const maxEntriesPerDirectory = 120;
export const maxPreviewBytes = 24 * 1024;
// The write cap is also the read-back cap, so a successfully written file always
// echoes in full rather than through the smaller browse-preview truncation. The
// route enforces this same cap on incoming bytes (UTF-8), keeping the invariant.
export const maxWriteBytes = 256 * 1024;
// The two recursive operations — directory deletion and entry copy — are
// intentionally narrower than arbitrary `rm`/`cp`: the backend inventories the
// complete subtree first and refuses a request that exceeds either cap.
// Protected names, generated directories, symlinks, and non-file entries fail
// the whole operation rather than being skipped. Copy shares these caps because
// its bytes never transit the API, so `maxWriteBytes` (a request-body bound)
// says nothing about it; see `docs/safety/TRUST_AND_SAFETY.md`.
export const maxSubtreeEntries = 20_000;
export const maxSubtreeBytes = 1024 * 1024 * 1024;
// A copy whose destination name is taken walks `-2`…`-5` and then refuses,
// mirroring `DiagramWritePlan`: past that the workspace is saying something,
// and a bounded refusal beats a filename lottery.
export const maxCollisionOrdinal = 5;
export const contextTreeDepth = 2;
/** The temp suffix every staged write publishes from; never a listed entry. */
export const tempEntrySuffix = ".agentroom-tmp";

export function isPreviewableName(name: string): boolean {
  return !isSecretName(name);
}

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return secretNames.has(lower) || lower.startsWith(".env.") || secretExtensions.some((extension) => lower.endsWith(extension));
}

// Shared by the reads that expose committed content but may still address a
// generated path. Mutations use `hasHiddenPathSegment` below because they must
// also refuse the internal staging suffix that every listing hides.
export function hasSecretPathSegment(path: string, extraIgnored?: Set<string>): boolean {
  return path.split("/").some((segment) => isSecretName(segment) || (extraIgnored?.has(segment) ?? false));
}

/** True for a name the tree read, the file index, and the walk all hide. */
export function isHiddenEntryName(name: string): boolean {
  return ignoredNames.has(name) || isSecretName(name) || name.endsWith(tempEntrySuffix);
}

/** True when any caller-controlled segment is absent from tree and index reads. */
export function hasHiddenPathSegment(path: string): boolean {
  return path.split("/").some(isHiddenEntryName);
}

/** Clamps a caller-supplied result limit into `1..max`, defaulting to `max`. */
export function clampLimit(limit: number, max: number): number {
  if (!Number.isFinite(limit)) return max;
  return Math.min(Math.max(Math.floor(limit), 1), max);
}
