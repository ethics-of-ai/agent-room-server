import { randomUUID } from "node:crypto";
import { allowedAgentToolLogicalIds } from "../../agentTools/catalog";
import type { AgentToolHandler, AgentToolInvocationContext } from "../../agentTools/dispatch";
import type { AgentSession, ServiceConfig } from "../../domain/models";
import { isRegisteredRunnerKind, runnerDescriptor } from "../../runner/registry";
import { runnerAgentToolCapabilities } from "../../runner/shared/agentToolSets";
import type { RepositorySketchService } from "../RepositorySketchService";
import { SketchServiceError } from "../sketchErrors";
import type { SketchOperation } from "../core";
import { exactSketchPath, type SketchIndex } from "../index/SketchIndex";
import { sketchTitleFromPath } from "../index/sketchReference";
import { compactObjectLines, formatSketchInspection } from "./sketchInspect";
import { SKETCH_TOOLS_INSTRUCTION, SKETCH_TOOL_IDS, sketchToolInputSchemas, type SketchToolId } from "./sketchToolContract";
import { formatSketchList, invalidRequest, resolutionRefusal, serviceFailure, unknownSketch } from "./sketchToolResults";
import { batchClearsSketch, clearPrompt, confirmationRefusal, confirmationSet, type SketchAsk } from "./sketchConfirmations";
import { createSketch, deleteSketch, prepareChange, renameSketch, stepHistory, type LocatedSketch, type SketchToolContext } from "./SketchLifecycleTools";

type SketchSession = Pick<AgentSession, "id" | "workspaceId" | "runnerKind">;

/** The repository service the sketch tools act through, and the index they find sketches in. */
export interface SessionSketches {
  service: Pick<RepositorySketchService, "read" | "editAsAgent" | "create" | "rename" | "delete">;
  /** Absent, sketches are found by exact path only and there is no list tool. */
  index?: Pick<SketchIndex, "list" | "resolve">;
}

/** How many revisions per sketch the file-version memory keeps. */
const REMEMBERED_REVISIONS = 64;

/**
 * Sketch tools inside an agent session. Each call acts only on the session's
 * own registered workspace, through the repository sketch service, so the
 * service's path containment, locking, history, and events all apply.
 *
 * An agent passes the revision it last read. The service needs the file
 * version that revision had, to tell a later AgentRoom edit (checked against
 * the revision log) from an external write (refused). This class remembers
 * the file version of every revision it showed a session, in memory. After a
 * backend restart the agent's next edit is refused until it inspects again.
 */
export class SketchTurnTools {
  private readonly versions = new Map<string, Map<number, string>>();

  constructor(private readonly deps: {
    sketches?: SessionSketches;
    runnerConfig?: ServiceConfig;
    /** The session a turn belongs to, for telling an agent's own history steps apart. */
    sessionOfTurn?(turnId: string): string | undefined;
  }) {}

  /** The sketch logical ids this runner's descriptor lets a session advertise. */
  advertised(runnerKind: string): string[] {
    if (!this.deps.sketches || !isRegisteredRunnerKind(runnerKind)) return [];
    const ids = new Set<string>(this.offered);
    return allowedAgentToolLogicalIds({ gates: {}, capabilities: runnerAgentToolCapabilities(runnerKind, this.deps.runnerConfig) })
      .filter((id) => ids.has(id));
  }

  /** Whether a thread whose catalog holds `ids` has every sketch tool this backend offers. */
  covers(ids: readonly string[]): boolean {
    return this.deps.sketches !== undefined && this.offered.every((id) => ids.includes(id));
  }

  /** Every sketch tool, less list when there is no index to list from. */
  private get offered(): SketchToolId[] {
    return SKETCH_TOOL_IDS.filter((id) => id !== "sketches.list" || this.deps.sketches?.index);
  }

  get instruction(): string {
    return SKETCH_TOOLS_INSTRUCTION;
  }

  /** One handler per sketch tool for one turn. `ask` reaches the person through the session question channel. */
  handlers(session: SketchSession, turnId: string, ask?: SketchAsk): Record<SketchToolId, AgentToolHandler> {
    const context = this.context(session, turnId, ask);
    return {
      "sketches.list": (input) => this.list(session, input),
      "sketches.inspect": (input) => this.inspect(session, input),
      "sketches.create": (input) => createSketch(context, input),
      "sketches.edit": (input, call) => this.edit(context, input, call),
      "sketches.history": (input) => stepHistory(context, input),
      "sketches.rename": (input) => renameSketch(context, input),
      "sketches.delete": (input, call) => deleteSketch(context, input, call.signal)
    };
  }

  private context(session: SketchSession, turnId: string, ask: SketchAsk | undefined): SketchToolContext {
    return {
      session, turnId, ask, service: this.service,
      locate: (reference) => this.locate(session, reference),
      remember: (path, revision, fileVersion) => this.remember(session, path, revision, fileVersion),
      writeRefusal: () => this.writeRefusal(session.runnerKind),
      ownsTurn: (id) => id !== undefined && this.deps.sessionOfTurn?.(id) === session.id,
      agent: (guard) => ({ runnerId: session.runnerKind, sessionId: session.id, turnId, ...(guard ? { guard } : {}) })
    };
  }

  /** Forget a closed session's remembered file versions. */
  forgetSession(sessionId: string): void {
    for (const key of this.versions.keys()) if (key.startsWith(`${sessionId}\0`)) this.versions.delete(key);
  }

  private get service(): SessionSketches["service"] {
    if (!this.deps.sketches) throw new Error("Sketch tools were bound without a sketch service");
    return this.deps.sketches.service;
  }

  private async list(session: SketchSession, input: unknown): Promise<string> {
    const parsed = sketchToolInputSchemas["sketches.list"].safeParse(input);
    if (!parsed.success) return invalidRequest(parsed.error);
    const index = this.deps.sketches?.index;
    if (!index) return "error unavailable: this backend keeps no sketch index. Ask the person for the sketch's path.";
    try {
      const listed = await index.list(session.workspaceId);
      // A listed revision is a valid base for an edit, like an inspected one.
      for (const entry of listed.entries) {
        if (entry.revision !== undefined && entry.fileVersion) this.remember(session, entry.path, entry.revision, entry.fileVersion);
      }
      return formatSketchList(listed, parsed.data.filter);
    } catch (error) {
      return serviceFailure(error, session.workspaceId);
    }
  }

  /** The sketch a reference names, or the refusal to return. */
  private async locate(session: SketchSession, reference: string): Promise<LocatedSketch | { refusal: string }> {
    const index = this.deps.sketches?.index;
    if (!index) {
      const path = exactSketchPath(reference);
      return path === undefined ? { refusal: unknownSketch(reference) } : { path };
    }
    try {
      const resolution = await index.resolve(session.workspaceId, reference);
      const refusal = resolutionRefusal(reference, resolution);
      if (refusal !== undefined || resolution.kind !== "found") return { refusal: refusal ?? unknownSketch(reference) };
      const { path, fileVersion } = resolution.entry;
      return { path, ...(fileVersion === undefined ? {} : { indexedFileVersion: fileVersion }) };
    } catch (error) {
      return { refusal: serviceFailure(error, reference) };
    }
  }

  private async inspect(session: SketchSession, input: unknown): Promise<string> {
    const parsed = sketchToolInputSchemas["sketches.inspect"].safeParse(input);
    if (!parsed.success) return invalidRequest(parsed.error);
    const located = await this.locate(session, parsed.data.sketch);
    if ("refusal" in located) return located.refusal;
    const path = located.path;
    try {
      const sketch = await this.service.read(session.workspaceId, path);
      this.remember(session, path, sketch.revision, sketch.fileVersion);
      return formatSketchInspection({ ...sketch, title: sketchTitleFromPath(sketch.path) }, parsed.data.detail);
    } catch (error) {
      return serviceFailure(error, parsed.data.sketch);
    }
  }

  private async edit(context: SketchToolContext, input: unknown, call: AgentToolInvocationContext): Promise<string> {
    const { session } = context;
    const prepared = await prepareChange(context, "sketches.edit", input);
    if (typeof prepared === "string") return prepared;
    const { data } = prepared;
    const label = data.label.trim();
    if (label.length === 0) return "error invalid_request: label must not be blank.";
    const { path } = prepared.sketch;
    const fileVersion = this.versions.get(this.key(session, path))?.get(data.baseRevision);
    if (fileVersion === undefined) {
      return `error stale_revision: revision ${data.baseRevision} of ${path} was not read in this session. ` +
        "Call agentroom_sketch_inspect or agentroom_sketch_list and use the revision it returns.";
    }
    try {
      const confirmed = await this.confirmClear(context, path, label, data.operations as SketchOperation[], call.signal);
      if (typeof confirmed === "string") return confirmed;
      const result = await this.service.editAsAgent(session.workspaceId, path, "commit", {
        requestId: `agent-${randomUUID()}`,
        baseRevision: data.baseRevision,
        fileVersion,
        label,
        operations: data.operations
      }, context.agent(confirmed === undefined ? undefined : (state) => state.document.revision === confirmed.revision ? undefined
        : new SketchServiceError("The sketch changed after the person was asked", 409, "sketch_changed_during_confirmation")));
      this.remember(session, path, result.response.revision, result.response.fileVersion);
      const present = new Set(result.document.objects.map((object) => object.id));
      const changed = result.changedObjectIds;
      const lines = [`ok: committed "${label}" as revision ${result.response.revision} of ${path}. Use baseRevision ${result.response.revision} next.`];
      if (changed === undefined) {
        lines.push("The step touched every object; call agentroom_sketch_inspect to read the result.");
      } else {
        const removed = changed.filter((id) => !present.has(id));
        lines.push(`Changed: ${changed.filter((id) => present.has(id)).join(", ") || "none"}.`);
        if (removed.length > 0) lines.push(`Deleted: ${removed.join(", ")}.`);
        lines.push(...compactObjectLines(result.document, new Set(changed)));
      }
      return lines.join("\n");
    } catch (error) {
      if (error instanceof SketchServiceError && error.code === "stale_revision") {
        return this.staleResult(session, path, data.baseRevision, error);
      }
      if (error instanceof SketchServiceError && error.code === "sketch_changed_during_confirmation") {
        return "error sketch_changed_during_confirmation: the sketch changed after the person was asked, so nothing was cleared. Inspect it and ask again if it should still go.";
      }
      return serviceFailure(error, data.sketch);
    }
  }

  /**
   * Asks before a batch that would empty the sketch, before any lock, so the
   * person can keep drawing meanwhile. Returns the revision the question
   * described on a yes, the refusal text otherwise, or undefined when the
   * batch needs no question.
   */
  private async confirmClear(context: SketchToolContext, path: string, label: string, operations: SketchOperation[],
    signal: AbortSignal): Promise<{ revision: number } | string | undefined> {
    const current = await this.service.read(context.session.workspaceId, path);
    if (!batchClearsSketch(current.document, operations)) return undefined;
    if (!context.ask) return "error confirmation_unavailable: AgentRoom cannot ask the person here, so nothing was cleared.";
    const outcome = await context.ask(confirmationSet(clearPrompt(path, current.document, label), "Clear it"), signal);
    return confirmationRefusal(outcome, "nothing was cleared") ?? { revision: current.revision };
  }

  /** The refusal for a turn that may not change files, or undefined when it may. */
  private writeRefusal(runnerKind: string): string | undefined {
    if (!isRegisteredRunnerKind(runnerKind)) return "error read_only: this runner cannot change sketches.";
    const descriptor = runnerDescriptor(runnerKind);
    const posture = this.deps.runnerConfig ? descriptor.workspaceWritePosture?.(this.deps.runnerConfig) : undefined;
    if (posture === "writable") return undefined;
    if (posture === "read_only") {
      return `error read_only: ${descriptor.displayName} is configured read-only, so this turn cannot change sketches. Tell the person.`;
    }
    return `error read_only: sketch editing is not available on ${descriptor.displayName} yet, because AgentRoom cannot tell whether its turns may change files. Tell the person.`;
  }

  private async staleResult(session: SketchSession, path: string, baseRevision: number, error: SketchServiceError): Promise<string> {
    const ids = Array.isArray(error.details.conflictingObjectIds) ? error.details.conflictingObjectIds as string[] : undefined;
    const lines = [`error stale_revision: ${error.message}`];
    try {
      const current = await this.service.read(session.workspaceId, path);
      this.remember(session, path, current.revision, current.fileVersion);
      lines.push(`The sketch is now at revision ${current.revision}; nothing from this call was applied.`);
      if (ids && ids.length > 0) {
        const present = new Set(current.document.objects.map((object) => object.id));
        const gone = ids.filter((id) => !present.has(id));
        lines.push("Current state of the objects that changed:", ...compactObjectLines(current.document, new Set(ids)));
        if (gone.length > 0) lines.push(`No longer present: ${gone.join(", ")}.`);
        lines.push(`Re-plan from these and retry with baseRevision ${current.revision}.`);
      } else {
        lines.push(`Call agentroom_sketch_inspect and retry with its revision (base ${baseRevision} is too old to check).`);
      }
    } catch {
      lines.push("Call agentroom_sketch_inspect before retrying.");
    }
    return lines.join("\n");
  }

  private remember(session: SketchSession, path: string, revision: number, fileVersion: string): void {
    const key = this.key(session, path);
    const revisions = this.versions.get(key) ?? new Map<number, string>();
    revisions.set(revision, fileVersion);
    while (revisions.size > REMEMBERED_REVISIONS) revisions.delete(revisions.keys().next().value as number);
    this.versions.set(key, revisions);
  }

  private key(session: SketchSession, path: string): string {
    return `${session.id}\0${session.workspaceId}\0${path}`;
  }
}

