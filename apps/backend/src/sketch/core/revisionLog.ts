import { SKETCH_MAX_REVISION_LOG_ENTRIES, SKETCH_MAX_REVISION_LOG_IDS } from "./limits";
import type { SketchCoreError } from "./errors";
import type { SketchFootprint } from "./footprint";
import type { SketchRevisionLog, SketchRevisionLogEntry, SketchState } from "./schemas";

// The relaxed revision rule. A request names the revision it was built
// against. When that is the current revision it applies as before. When it is
// older, the request still applies if no transaction after its base touched an
// object id the request reads or writes, so two people (or a person and an
// agent) working on different objects stop refusing each other.
//
// The log is the only evidence of what changed after a base. Undo history is
// no help: undo moves entries to the redo stack, a commit clears redo, and
// trimming drops old entries. A state without a log, or a base older than the
// log's floor, gets the strict rule.

export type LaterRevisions =
  | { ok: true; entries: SketchRevisionLogEntry[] }
  | { ok: false; error: SketchCoreError };

export function revisionsAfter(state: SketchState, baseRevision: number): LaterRevisions {
  const current = state.document.revision;
  if (baseRevision === current) return { ok: true, entries: [] };
  const log = state.revisionLog;
  if (baseRevision > current || log === undefined || baseRevision < log.floor) {
    return { ok: false, error: staleRevision(current, `Base revision ${baseRevision} does not match current revision ${current}; refresh and retry explicitly`) };
  }
  const entries = log.entries.filter((entry) => entry.revision > baseRevision);
  if (entries.length !== current - baseRevision) {
    // A gap means the log no longer describes every later revision.
    return { ok: false, error: staleRevision(current, `Revision ${baseRevision} is too old to check against later edits; refresh and retry explicitly`) };
  }
  return { ok: true, entries };
}

/**
 * The later-revision ids that overlap `ids`, sorted, or undefined when there
 * is no overlap. An empty array means a later clear touched every object.
 */
export function overlappingIds(
  entries: SketchRevisionLogEntry[],
  ids: Iterable<string>,
  touchesAll: boolean
): string[] | undefined {
  if (entries.length === 0) return undefined;
  const changed = new Set<string>();
  for (const entry of entries) {
    if ("all" in entry) return [];
    for (const id of entry.objectIds) changed.add(id);
  }
  if (touchesAll) return changed.size === 0 ? undefined : [...changed].sort();
  const overlap = [...new Set(ids)].filter((id) => changed.has(id)).sort();
  return overlap.length === 0 ? undefined : overlap;
}

export function conflictError(currentRevision: number, baseRevision: number, ids: string[]): SketchCoreError {
  const what = ids.length === 0 ? "A later clear changed every object" : `Objects ${ids.map((id) => `"${id}"`).join(", ")} changed`;
  return {
    ...staleRevision(currentRevision, `${what} after revision ${baseRevision}; refresh and retry explicitly`),
    conflictingObjectIds: ids
  };
}

/** The log after a transaction moved the document from `previous` to `revision`. */
export function appendRevision(
  log: SketchRevisionLog | undefined,
  previous: number,
  revision: number,
  footprint: SketchFootprint
): SketchRevisionLog {
  // A state without a log starts one at its current revision: only later
  // revisions are known, so only bases from here on can be checked.
  // A log whose newest revision is not `previous` has a gap and restarts too.
  const newest = log?.entries.at(-1)?.revision ?? log?.floor;
  const next: SketchRevisionLog = log === undefined || newest !== previous
    ? { floor: previous, entries: [] }
    : { floor: log.floor, entries: [...log.entries] };
  const ids = [...footprint.writes].sort();
  next.entries.push(footprint.all || ids.length > SKETCH_MAX_REVISION_LOG_IDS
    ? { revision, all: true }
    : { revision, objectIds: ids });
  while (next.entries.length > SKETCH_MAX_REVISION_LOG_ENTRIES) {
    const dropped = next.entries.shift();
    if (dropped !== undefined) next.floor = dropped.revision;
  }
  return next;
}

function staleRevision(currentRevision: number, message: string): SketchCoreError {
  return { code: "stale_revision", currentRevision, message };
}
