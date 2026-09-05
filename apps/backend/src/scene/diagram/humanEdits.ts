// Human-edit context for spatial solution diagrams, including salience for
// what the human changed in a diagram between turns.
//
// The standing contract (diagram/prompt.ts) already tells the agent to Read a
// diagram's sibling `.human.json` before editing it — that is the capability, and
// it stays the floor. What it cannot do is tell the agent that something *changed*,
// so an agent editing a diagram it wrote earlier in the same session has no reason
// to look again. This module supplies that: a bounded, per-session "since your last
// turn" line composed into the turn prompt. The human is a semantic
// author too (the diagram-edit route + bounded PUT), so the line covers both halves
// of the two-file contract: placement adjustments in the override layer, structure
// edits to the base document, and — the one thing only reading both files together
// can reveal — override entries whose ids the base document no longer declares.
//
// It is deliberately event-driven rather than a scan. Both layers have exactly one
// human write path — the client's bounded, optimistic-locked
// `PUT /api/workspaces/:id/file` — and that write already publishes
// `workspace_file_written` with its path, while agent file edits never do. That
// asymmetry is the whole authorship discrimination: subscribing to an event the
// backend already emits keeps the V1 Simplifications intact (no fs-watcher, no new
// event type, no tracked-open state, and no per-turn enumeration of the workspace
// on the turn-start path) and guarantees every write it reports was a human's.
//
// What it therefore does NOT cover, by construction: a file that already existed
// before this backend process started, one hand-edited outside AgentRoom, and an
// agent edit that lands between two human writes (the delta is computed against
// the state this session was last shown, so such an edit folds into the next
// human delta). All of them stay on the self-serve rule in the contract — re-read
// the file — the same acceptance the plan records for out-of-band edits.

import type { EventBus } from "../../events/EventBus";
import { maxWriteBytes, type WorkspaceExplorer } from "../../workspace/WorkspaceExplorer";
import {
  diagramBasePathForHumanPath,
  diagramDocumentSchema,
  diagramHumanDocumentSchema,
  diagramHumanPathForBasePath,
  isDiagramBasePath,
  isDiagramHumanPath,
  type DiagramDocument,
  type DiagramHumanDocument
} from "./schemas";

// Bounds. Every one degrades to "the agent is told less and falls back to the
// contract's Read-the-sibling rule", never to an unbounded read or prompt.
const maxTrackedWorkspaces = 32;
const maxTrackedPathsPerWorkspace = 16;
const maxTrackedSessions = 512;
const maxReportedDiagrams = 4;
const maxReportedIdsPerCategory = 8;
const maxSummaryChars = 1200;

interface TrackedDiagram {
  // Per-layer revisions at which each half was last written. Monotonic counters,
  // not timestamps: `Date.now()` has no ordering guarantee at this resolution and
  // the only question asked is "newer than what this session last saw".
  structureRevision: number;
  placementRevision: number;
}

interface TrackedWorkspace {
  // Keyed by the diagram's base path, so one diagram's two layers share an entry.
  paths: Map<string, TrackedDiagram>;
  revision: number;
}

interface SessionPointer {
  revision: number;
  delivered: boolean;
  // A compact, per-session view of each reported diagram at the last accepted
  // turn: override fingerprints and the base document's id-keyed structure.
  // Coordinates never leave this module, and the summary itself names only ids
  // and change categories — the labels behind them are one Read away.
  baselines: Map<string, DiagramBaseline>;
}

interface DiagramBaseline {
  structure?: DiagramStructureSnapshot;
  placement?: DiagramOverrideSnapshot;
  // The orphan set this session was last shown (override ids the base document
  // did not declare). Held separately from the two snapshots so a transient
  // failed read does not forget what was already reported.
  orphanedIds?: ReadonlySet<string>;
}

interface DiagramStructureSnapshot {
  name: string;
  // Present only when the document carries one (schema v3). The delta names
  // the change category — "described" — never the text itself, exactly like
  // labels.
  description?: string;
  nodes: Map<string, { label: string; description?: string; role: string; group?: string }>;
  edges: Map<string, { from: string; to: string; label?: string; description?: string; kind: string }>;
  groups: Map<string, { label: string; description?: string }>;
}

interface DiagramOverrideSnapshot {
  overrides: Map<string, OverrideFingerprint>;
}

interface OverrideFingerprint {
  transform?: string;
  visible?: boolean;
  locked?: boolean;
  collapsed?: boolean;
}

export interface PreparedDiagramHumanEditSummary {
  // Undefined is still meaningful: an invalid or unchanged layer must advance
  // once the turn is accepted, but it should not add anything to the prompt.
  summary?: string;
  acknowledge(): void;
}

export interface DiagramHumanEditTrackerDeps {
  eventBus: Pick<EventBus, "subscribe">;
  explorer: Pick<WorkspaceExplorer, "filePreview">;
}

export class DiagramHumanEditTracker {
  private readonly workspaces = new Map<string, TrackedWorkspace>();
  private readonly sessions = new Map<string, SessionPointer>();
  private revision = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: DiagramHumanEditTrackerDeps) {
    this.unsubscribe = deps.eventBus.subscribe((event) => {
      if (event.type === "workspace_file_written") {
        this.recordWrite(event.payload as { workspaceId?: unknown; path?: unknown });
        return;
      }
      if (event.type === "agent_session_deleted") {
        const payload = event.payload as { sessionId?: unknown };
        if (typeof payload?.sessionId === "string") this.sessions.delete(payload.sessionId);
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.workspaces.clear();
    this.sessions.clear();
  }

  // Prepares the prompt fragment for a prospective turn. Its acknowledgement is
  // deliberately separate: malformed attachment input or an unsupported runner
  // part can reject a request after prompt assembly, and that request never gave
  // the agent this information. Only an accepted turn may advance the pointer.
  async prepareSummaryForTurn(
    session: { id: string; workspaceId: string }
  ): Promise<PreparedDiagramHumanEditSummary | undefined> {
    const tracked = this.workspaces.get(session.workspaceId);
    // No human diagram write has been seen in this workspace, so there is nothing
    // to point at yet. Leave the session unrecorded rather than filling the
    // pointer map with an entry for every turn in every workspace without diagrams.
    if (!tracked) return undefined;
    const pointer = this.sessions.get(session.id) ?? {
      revision: 0,
      delivered: false,
      baselines: new Map<string, DiagramBaseline>()
    };

    const changed = [...tracked.paths.entries()]
      .map(([basePath, diagram]) => ({
        basePath,
        revision: Math.max(diagram.structureRevision, diagram.placementRevision),
        structureChanged: diagram.structureRevision > pointer.revision,
        placementChanged: diagram.placementRevision > pointer.revision
      }))
      .filter((entry) => entry.revision > pointer.revision)
      .sort((left, right) => left.revision - right.revision);
    if (changed.length === 0) return undefined;

    const lines: string[] = [];
    const baselines = new Map(pointer.baselines);
    for (const [index, entry] of changed.entries()) {
      const previous = baselines.get(entry.basePath);
      // Both layers are read even when only one changed: the orphan check is
      // exactly the comparison of the two, and it is how an agent rename made
      // in an earlier turn (which published no event) finally surfaces.
      const structure = await this.readBaseDocument(session.workspaceId, entry.basePath);
      const placement = await this.readOverrideDocument(
        session.workspaceId,
        diagramHumanPathForBasePath(entry.basePath)
      );
      const structureSnapshot = structure ? snapshotStructure(structure) : undefined;
      const placementSnapshot = placement ? snapshotOverrides(placement) : undefined;
      const orphaned = structure && placement ? orphanedOverrideIds(structure, placement) : undefined;

      // A file that vanished, grew past the cap, or does not parse is simply not
      // reported: the compose route already surfaces an invalid layer to the
      // human as an error document, and the prompt is not the place to relay it.
      const sections: string[] = [];
      if (entry.structureChanged && structureSnapshot) {
        const description = previous?.structure
          ? // The compact categories intentionally do not enumerate every base
            // field (for example, a schema-v2 flow sequence). An observed human
            // base write must still prompt a re-read rather than be consumed
            // silently when none of the named deltas applies.
            describeStructureDelta(previous.structure, structureSnapshot) ?? "edited (re-read the document)"
          : // The state before the first observed human base write is gone from
            // disk and agent writes announce nothing, so the first report is a
            // pointer rather than a delta this module would have to invent.
            "edited (re-read the document)";
        if (description) sections.push(`structure: ${description}`);
      }
      if (entry.placementChanged && placement && placementSnapshot) {
        const description = pointer.delivered
          ? describeOverrideDelta(previous?.placement, placementSnapshot)
          : describeOverrides(placement);
        if (description) {
          sections.push(description === clearedPlacementMessage ? description : `placement: ${description}`);
        }
      }
      if (orphaned) {
        const fresh = previous?.orphanedIds
          ? orphaned.filter((id) => !previous.orphanedIds?.has(id))
          : orphaned;
        const category = formatCategory(orphanedCategoryLabel, fresh);
        if (category) sections.push(category);
      }

      const nextBaseline: DiagramBaseline = {
        ...(structureSnapshot ? { structure: structureSnapshot } : {}),
        ...(placementSnapshot ? { placement: placementSnapshot } : {}),
        ...(orphaned
          ? { orphanedIds: new Set(orphaned) }
          : previous?.orphanedIds
            ? { orphanedIds: previous.orphanedIds }
            : {})
      };
      if (nextBaseline.structure || nextBaseline.placement || nextBaseline.orphanedIds) {
        baselines.set(entry.basePath, nextBaseline);
      } else {
        baselines.delete(entry.basePath);
      }

      if (index < maxReportedDiagrams && sections.length > 0) {
        lines.push(`- ${entry.basePath} — ${sections.join(" | ")}`);
      }
    }

    const omitted = Math.max(0, changed.length - maxReportedDiagrams);
    if (omitted > 0 && lines.length > 0) {
      lines.push(`- (+${omitted} more diagram${omitted === 1 ? "" : "s"} adjusted)`);
    }
    const nextPointer: SessionPointer = {
      revision: tracked.revision,
      delivered: pointer.delivered || lines.length > 0,
      baselines
    };
    return {
      ...(lines.length > 0
        ? {
            summary: capText(
              [pointer.delivered ? sinceLastTurnHeader : firstDeliveryHeader, ...lines].join("\n"),
              maxSummaryChars
            )
          }
        : {}),
      acknowledge: () => this.rememberPointer(session.id, nextPointer)
    };
  }

  private rememberPointer(sessionId: string, pointer: SessionPointer): void {
    // `agent_session_deleted` is the normal release path; this cap is the backstop
    // for a process that outlives a great many sessions without deleting them.
    if (!this.sessions.has(sessionId) && this.sessions.size >= maxTrackedSessions) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
    this.sessions.set(sessionId, pointer);
  }

  private async readBaseDocument(workspaceId: string, path: string): Promise<DiagramDocument | undefined> {
    try {
      const preview = await this.deps.explorer.filePreview(workspaceId, { path, maxBytes: maxWriteBytes });
      if (preview.truncated) return undefined;
      const parsed = diagramDocumentSchema.safeParse(JSON.parse(preview.content) as unknown);
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Absent (an override can be tracked before its base exists), refused, or
      // malformed: the summary simply says less about this diagram.
      return undefined;
    }
  }

  private async readOverrideDocument(
    workspaceId: string,
    path: string
  ): Promise<DiagramHumanDocument | undefined> {
    try {
      const preview = await this.deps.explorer.filePreview(workspaceId, { path, maxBytes: maxWriteBytes });
      if (preview.truncated) return undefined;
      const parsed = diagramHumanDocumentSchema.safeParse(JSON.parse(preview.content) as unknown);
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Every failure here is a non-event for the turn: a 404 (the file moved, or
      // the workspace was unregistered), a bounded-read refusal, or malformed
      // JSON. None of them is worth failing or delaying a turn over, and the
      // compose route already surfaces a broken override to the human.
      return undefined;
    }
  }

  private recordWrite(payload: { workspaceId?: unknown; path?: unknown }): void {
    const { workspaceId, path } = payload;
    if (typeof workspaceId !== "string" || typeof path !== "string") return;
    const layer = isDiagramHumanPath(path) ? "placement" : isDiagramBasePath(path) ? "structure" : undefined;
    if (!layer) return;
    const basePath = layer === "placement" ? diagramBasePathForHumanPath(path) : path;

    this.revision += 1;
    let tracked = this.workspaces.get(workspaceId);
    if (!tracked) {
      if (this.workspaces.size >= maxTrackedWorkspaces) evictOldestWorkspace(this.workspaces);
      tracked = { paths: new Map(), revision: 0 };
      this.workspaces.set(workspaceId, tracked);
    }
    let diagram = tracked.paths.get(basePath);
    if (!diagram) {
      if (tracked.paths.size >= maxTrackedPathsPerWorkspace) evictLowestRevision(tracked.paths);
      diagram = { structureRevision: 0, placementRevision: 0 };
      tracked.paths.set(basePath, diagram);
    }
    if (layer === "structure") diagram.structureRevision = this.revision;
    else diagram.placementRevision = this.revision;
    tracked.revision = this.revision;
  }
}

const firstDeliveryHeader =
  "Human diagram edits on record (structure edits land in the `*.diagram.json` base document — re-read it before editing; placement lands in the human's own `*.diagram.human.json` layer — read it before editing the diagram, and never write it):";

const sinceLastTurnHeader =
  "Human diagram edits since your last turn (structure edits land in the `*.diagram.json` base document — re-read it before editing; placement lands in the human's own `*.diagram.human.json` layer — read it before editing the diagram, and never write it):";

// The contract's stable-id rule exists because a renamed or removed id orphans
// the human's adjustments keyed to it. This is that rule's report: the agent is
// the only author who can orphan an entry (the client's own edits derive ids and
// prune overrides on delete), so naming the ids lets it restore one deliberately.
const orphanedCategoryLabel = "orphaned human adjustments (override ids the base no longer declares)";

const clearedPlacementMessage = "placement cleared (no adjustments on record)";

// The override layer carries semantic ids plus placement flags — no labels, no
// coordinates worth relaying. So the summary names what changed and stays out of
// the geometry.
export function describeOverrides(document: DiagramHumanDocument): string {
  const moved: string[] = [];
  const shown: string[] = [];
  const hidden: string[] = [];
  const locked: string[] = [];
  const collapsed: string[] = [];
  for (const override of document.overrides) {
    if (override.transform) moved.push(override.id);
    if (override.visible === false) hidden.push(override.id);
    if (override.visible === true) shown.push(override.id);
    if (override.locked === true) locked.push(override.id);
    if (override.collapsed === true) collapsed.push(override.id);
  }

  const parts = [
    formatCategory("moved", moved),
    formatCategory("hidden", hidden),
    formatCategory("shown", shown),
    formatCategory("locked", locked),
    formatCategory("collapsed", collapsed)
  ].filter((part): part is string => part !== undefined);
  // An override entry is deleted when its last adjustment is undone, so an empty
  // (or all-default) layer means the human cleared their placement rather than
  // that nothing ever happened — worth saying, since it is the one case where
  // re-reading the file tells the agent less than this line does.
  return parts.length > 0 ? parts.join("; ") : clearedPlacementMessage;
}

// The before/after comparison is deliberately only as detailed as the prompt
// needs. Transform fingerprints remain in memory so a second drag of the same
// id is still a move, but coordinates themselves never leave this module.
function describeOverrideDelta(
  previous: DiagramOverrideSnapshot | undefined,
  current: DiagramOverrideSnapshot
): string | undefined {
  if (!previous) return describeSnapshot(current);

  const moved: string[] = [];
  const placementReset: string[] = [];
  const hidden: string[] = [];
  const shown: string[] = [];
  const locked: string[] = [];
  const unlocked: string[] = [];
  const collapsed: string[] = [];
  const expanded: string[] = [];
  const ids = new Set([...previous.overrides.keys(), ...current.overrides.keys()]);
  for (const id of ids) {
    const before = previous.overrides.get(id);
    const after = current.overrides.get(id);
    if (before?.transform !== after?.transform) {
      (after?.transform ? moved : placementReset).push(id);
    }
    if (before?.visible !== after?.visible) {
      (after?.visible === false ? hidden : shown).push(id);
    }
    if (before?.locked !== after?.locked) {
      (after?.locked === true ? locked : unlocked).push(id);
    }
    if (before?.collapsed !== after?.collapsed) {
      (after?.collapsed === true ? collapsed : expanded).push(id);
    }
  }
  const parts = [
    formatCategory("moved", moved),
    formatCategory("placement reset", placementReset),
    formatCategory("hidden", hidden),
    formatCategory("shown", shown),
    formatCategory("locked", locked),
    formatCategory("unlocked", unlocked),
    formatCategory("collapsed", collapsed),
    formatCategory("expanded", expanded)
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// Ids are the currency of the structure delta too: they are what the edit-ops
// vocabulary addresses and what the override layer keys on, and the labels
// behind them are one Read away. Edges are compared by id but described by
// endpoints — edge ids deliberately refill delete gaps (diagram/editOps.ts), so an
// id whose endpoints changed is a deletion plus a creation, not a rewiring.
function describeStructureDelta(
  previous: DiagramStructureSnapshot,
  current: DiagramStructureSnapshot
): string | undefined {
  const added: string[] = [];
  const removed: string[] = [];
  const relabelled: string[] = [];
  const reRoled: string[] = [];
  const regrouped: string[] = [];
  const described: string[] = [];
  for (const id of new Set([...previous.nodes.keys(), ...current.nodes.keys()])) {
    const before = previous.nodes.get(id);
    const after = current.nodes.get(id);
    if (!before && after) {
      added.push(id);
      continue;
    }
    if (before && !after) {
      removed.push(id);
      continue;
    }
    if (!before || !after) continue;
    if (before.label !== after.label) relabelled.push(id);
    if (before.role !== after.role) reRoled.push(id);
    if (before.group !== after.group) regrouped.push(id);
    // Added, changed, and cleared are all one category: what the agent needs
    // to know is that the annotation moved, and the text is one Read away.
    if (before.description !== after.description) described.push(id);
  }

  const connected: string[] = [];
  const disconnected: string[] = [];
  const reKinded: string[] = [];
  const edgeRelabelled: string[] = [];
  const edgeDescribed: string[] = [];
  for (const id of new Set([...previous.edges.keys(), ...current.edges.keys()])) {
    const before = previous.edges.get(id);
    const after = current.edges.get(id);
    if (!before && after) {
      connected.push(endpoints(after));
      continue;
    }
    if (before && !after) {
      disconnected.push(endpoints(before));
      continue;
    }
    if (!before || !after) continue;
    if (before.from !== after.from || before.to !== after.to) {
      disconnected.push(endpoints(before));
      connected.push(endpoints(after));
      continue;
    }
    if (before.kind !== after.kind) reKinded.push(endpoints(after));
    if (before.label !== after.label) edgeRelabelled.push(endpoints(after));
    if (before.description !== after.description) edgeDescribed.push(endpoints(after));
  }

  const groupAdded: string[] = [];
  const groupRemoved: string[] = [];
  const groupRelabelled: string[] = [];
  const groupDescribed: string[] = [];
  for (const id of new Set([...previous.groups.keys(), ...current.groups.keys()])) {
    const before = previous.groups.get(id);
    const after = current.groups.get(id);
    if (before === undefined && after !== undefined) groupAdded.push(id);
    else if (before !== undefined && after === undefined) groupRemoved.push(id);
    else if (before !== undefined && after !== undefined) {
      if (before.label !== after.label) groupRelabelled.push(id);
      if (before.description !== after.description) groupDescribed.push(id);
    }
  }

  const parts = [
    formatCategory("added", added),
    formatCategory("removed", removed),
    formatCategory("relabelled", relabelled),
    formatCategory("re-roled", reRoled),
    formatCategory("regrouped", regrouped),
    formatCategory("described", described),
    formatCategory("connected", connected),
    formatCategory("disconnected", disconnected),
    formatCategory("edge kind changed", reKinded),
    formatCategory("edge relabelled", edgeRelabelled),
    formatCategory("edge described", edgeDescribed),
    formatCategory("group added", groupAdded),
    formatCategory("group removed", groupRemoved),
    formatCategory("group relabelled", groupRelabelled),
    formatCategory("group described", groupDescribed),
    previous.name !== current.name ? "document renamed" : undefined,
    previous.description !== current.description ? "document described" : undefined
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function endpoints(edge: { from: string; to: string }): string {
  return `${edge.from} → ${edge.to}`;
}

function orphanedOverrideIds(base: DiagramDocument, overrides: DiagramHumanDocument): string[] {
  const declared = new Set<string>([
    ...base.nodes.map((node) => node.id),
    ...base.groups.map((group) => group.id)
  ]);
  return overrides.overrides.map((override) => override.id).filter((id) => !declared.has(id));
}

function snapshotStructure(document: DiagramDocument): DiagramStructureSnapshot {
  return {
    name: document.name,
    ...(document.description !== undefined ? { description: document.description } : {}),
    nodes: new Map(
      document.nodes.map((node) => [
        node.id,
        {
          label: node.label,
          role: node.role,
          ...(node.description !== undefined ? { description: node.description } : {}),
          ...(node.group !== undefined ? { group: node.group } : {})
        }
      ])
    ),
    edges: new Map(
      document.edges.map((edge) => [
        edge.id,
        {
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          ...(edge.label !== undefined ? { label: edge.label } : {}),
          ...(edge.description !== undefined ? { description: edge.description } : {})
        }
      ])
    ),
    groups: new Map(document.groups.map((group) => [
      group.id,
      {
        label: group.label,
        ...(group.description !== undefined ? { description: group.description } : {})
      }
    ]))
  };
}

function snapshotOverrides(document: DiagramHumanDocument): DiagramOverrideSnapshot {
  return {
    overrides: new Map(document.overrides.map((override) => [
      override.id,
      {
        ...(override.transform ? { transform: transformFingerprint(override.transform) } : {}),
        ...(override.visible !== undefined ? { visible: override.visible } : {}),
        ...(override.locked !== undefined ? { locked: override.locked } : {}),
        ...(override.collapsed !== undefined ? { collapsed: override.collapsed } : {})
      }
    ]))
  };
}

function transformFingerprint(transform: NonNullable<DiagramHumanDocument["overrides"][number]["transform"]>): string {
  return JSON.stringify({
    ...(transform.position ? { position: transform.position } : {}),
    ...(transform.rotationEulerDegrees ? { rotationEulerDegrees: transform.rotationEulerDegrees } : {}),
    ...(transform.scale ? { scale: transform.scale } : {})
  });
}

function describeSnapshot(snapshot: DiagramOverrideSnapshot): string {
  const overrides = [...snapshot.overrides].map(([id, override]) => ({
    id,
    ...(override.transform ? { transform: {} } : {}),
    ...(override.visible !== undefined ? { visible: override.visible } : {}),
    ...(override.locked !== undefined ? { locked: override.locked } : {}),
    ...(override.collapsed !== undefined ? { collapsed: override.collapsed } : {})
  }));
  return describeOverrides({ schemaVersion: 1, overrides });
}

function formatCategory(label: string, ids: string[]): string | undefined {
  if (ids.length === 0) return undefined;
  const shown = ids.slice(0, maxReportedIdsPerCategory);
  const omitted = ids.length - shown.length;
  return `${label}: ${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function capText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function evictOldestWorkspace(workspaces: Map<string, TrackedWorkspace>): void {
  let oldestId: string | undefined;
  let oldestRevision = Number.POSITIVE_INFINITY;
  for (const [id, tracked] of workspaces) {
    if (tracked.revision < oldestRevision) {
      oldestRevision = tracked.revision;
      oldestId = id;
    }
  }
  if (oldestId !== undefined) workspaces.delete(oldestId);
}

function evictLowestRevision(paths: Map<string, TrackedDiagram>): void {
  let lowestPath: string | undefined;
  let lowestRevision = Number.POSITIVE_INFINITY;
  for (const [path, diagram] of paths) {
    const revision = Math.max(diagram.structureRevision, diagram.placementRevision);
    if (revision < lowestRevision) {
      lowestRevision = revision;
      lowestPath = path;
    }
  }
  if (lowestPath !== undefined) paths.delete(lowestPath);
}
