import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { z } from "zod";
import type { AgentSession } from "../../domain/models";
import type { RepositorySketchAgent, RepositorySketchService } from "../RepositorySketchService";
import { SketchServiceError } from "../sketchErrors";
import { sketchFileSlug } from "../SketchWorkspaceFiles";
import type { SketchState } from "../core";
import { confirmationRefusal, confirmationSet, deletePrompt, type SketchAsk } from "./sketchConfirmations";
import { compactObjectLines } from "./sketchInspect";
import { sketchToolInputSchemas, type SketchToolId } from "./sketchToolContract";
import { invalidRequest, serviceFailure } from "./sketchToolResults";

/**
 * The sketch lifecycle an agent can drive beyond editing: create, undo or
 * redo its own steps, rename, and delete. Each changing call first passes the
 * runner's write posture, and a delete waits for the person's yes.
 */

export interface SketchToolContext {
  readonly session: Pick<AgentSession, "id" | "workspaceId" | "runnerKind">;
  readonly turnId: string;
  readonly service: Pick<RepositorySketchService, "read" | "editAsAgent" | "create" | "rename" | "delete">;
  readonly ask?: SketchAsk;
  locate(reference: string): Promise<LocatedSketch | { refusal: string }>;
  remember(path: string, revision: number, fileVersion: string): void;
  writeRefusal(): string | undefined;
  /** Whether a history entry's turn belongs to the calling session. */
  ownsTurn(turnId: string | undefined): boolean;
  agent(guard?: RepositorySketchAgent["guard"]): RepositorySketchAgent;
}

/** A resolved sketch, with the file version the index last read when an index found it. */
export interface LocatedSketch {
  path: string;
  indexedFileVersion?: string;
}

type ChangingTool = Exclude<SketchToolId, "sketches.list" | "sketches.inspect" | "sketches.create">;

/**
 * The common start of a call that changes a named sketch: validate the
 * input, check the runner's write posture, then find the sketch. Returns the
 * refusal text when any step refuses.
 */
export async function prepareChange<Id extends ChangingTool>(context: SketchToolContext, id: Id, input: unknown):
  Promise<{ data: z.infer<(typeof sketchToolInputSchemas)[Id]>; sketch: LocatedSketch } | string> {
  const parsed = sketchToolInputSchemas[id].safeParse(input);
  if (!parsed.success) return invalidRequest(parsed.error);
  const refusal = context.writeRefusal();
  if (refusal) return refusal;
  const located = await context.locate(parsed.data.sketch);
  if ("refusal" in located) return located.refusal;
  return { data: parsed.data as z.infer<(typeof sketchToolInputSchemas)[Id]>, sketch: located };
}

export async function createSketch(context: SketchToolContext, input: unknown): Promise<string> {
  const parsed = sketchToolInputSchemas["sketches.create"].safeParse(input);
  if (!parsed.success) return invalidRequest(parsed.error);
  const refusal = context.writeRefusal();
  if (refusal) return refusal;
  const name = parsed.data.name.trim();
  if (name.length === 0) return "error invalid_request: name must not be blank.";
  try {
    const created = await context.service.create(context.session.workspaceId, name, context.agent());
    context.remember(created.path, created.revision, created.fileVersion);
    return `ok: created "${name}" at ${created.path}, id ${created.sketchId}, revision ${created.revision}. ` +
      `Edit it with sketch ${created.path} and baseRevision ${created.revision}.`;
  } catch (error) {
    return serviceFailure(error, name);
  }
}

export async function stepHistory(context: SketchToolContext, input: unknown): Promise<string> {
  const prepared = await prepareChange(context, "sketches.history", input);
  if (typeof prepared === "string") return prepared;
  const { path } = prepared.sketch;
  const step = prepared.data.step;
  try {
    // The step applies to whatever is newest now; the guard, checked under
    // the file lock, refuses unless that step is this session's own.
    const current = await context.service.read(context.session.workspaceId, path);
    const result = await context.service.editAsAgent(context.session.workspaceId, path, step, {
      requestId: `agent-${randomUUID()}`, baseRevision: current.revision, fileVersion: current.fileVersion
    }, context.agent((state) => notOwnStep(state, step, context)));
    context.remember(path, result.response.revision, result.response.fileVersion);
    const lines = [`ok: ${step === "undo" ? "undid" : "redid"} your step as revision ${result.response.revision} of ${path}. Use baseRevision ${result.response.revision} next.`];
    if (result.changedObjectIds) lines.push(...compactObjectLines(result.document, new Set(result.changedObjectIds)));
    return lines.join("\n");
  } catch (error) {
    if (error instanceof SketchServiceError && error.code === "not_own_step") return `error not_own_step: ${error.message}`;
    return serviceFailure(error, prepared.data.sketch);
  }
}

export async function renameSketch(context: SketchToolContext, input: unknown): Promise<string> {
  const prepared = await prepareChange(context, "sketches.rename", input);
  if (typeof prepared === "string") return prepared;
  const { path } = prepared.sketch;
  const slug = sketchFileSlug(prepared.data.newName);
  if (!slug) return "error invalid_request: newName needs at least one letter or digit.";
  const folder = dirname(path);
  const newPath = `${folder === "." ? "" : `${folder}/`}${slug}.sketch.json`;
  if (newPath === path) return `ok: ${path} already has that name.`;
  try {
    // The index's version, when there is one, so a file changed outside
    // AgentRoom since the index read it is refused rather than renamed.
    const expected = prepared.sketch.indexedFileVersion ?? (await context.service.read(context.session.workspaceId, path)).fileVersion;
    const renamed = await context.service.rename(context.session.workspaceId, path, newPath, expected, context.agent());
    context.remember(renamed.path, renamed.revision, renamed.fileVersion);
    return `ok: renamed ${path} to ${renamed.path}. Its id ${renamed.sketchId} and undo history moved with it; use baseRevision ${renamed.revision}.`;
  } catch (error) {
    if (error instanceof SketchServiceError && error.code === "file_changed") return changedSinceIndexed(path, "renamed");
    return serviceFailure(error, prepared.data.sketch);
  }
}

export async function deleteSketch(context: SketchToolContext, input: unknown, signal: AbortSignal): Promise<string> {
  const prepared = await prepareChange(context, "sketches.delete", input);
  if (typeof prepared === "string") return prepared;
  const { path, indexedFileVersion } = prepared.sketch;
  try {
    const current = await context.service.read(context.session.workspaceId, path);
    if (indexedFileVersion !== undefined && current.fileVersion !== indexedFileVersion) return changedSinceIndexed(path, "deleted");
    if (!context.ask) return "error confirmation_unavailable: AgentRoom cannot ask the person here, so nothing was deleted.";
    // Asked before any lock, so the person can keep drawing while it is open.
    const outcome = await context.ask(confirmationSet(deletePrompt(path, current.document), "Delete it"), signal);
    const declined = confirmationRefusal(outcome, "nothing was deleted");
    if (declined) return declined;
    await context.service.delete(context.session.workspaceId, path, current.fileVersion, context.agent());
    return `ok: deleted ${path}.`;
  } catch (error) {
    if (error instanceof SketchServiceError && error.code === "file_changed") {
      return "error sketch_changed_during_confirmation: the sketch changed after the person was asked, so nothing was deleted. Ask again if it should still go.";
    }
    return serviceFailure(error, prepared.data.sketch);
  }
}

/** The refusal for a file whose identity changed outside AgentRoom since the index last read it. */
function changedSinceIndexed(path: string, verb: "renamed" | "deleted"): string {
  return `error file_changed: ${path} changed outside AgentRoom since AgentRoom last listed it, so nothing was ${verb}. ` +
    "Call agentroom_sketch_list to re-read it, check it is still the sketch the person means, and try again.";
}

function notOwnStep(state: SketchState, step: "undo" | "redo", context: SketchToolContext): SketchServiceError | undefined {
  const head = (step === "undo" ? state.history.undo : state.history.redo).at(-1);
  if (head === undefined) return undefined;
  if (head.actor.kind === "agent" && context.ownsTurn(head.turnId)) return undefined;
  const who = head.actor.kind === "human" ? "the person" : "another agent thread";
  return new SketchServiceError(
    `The newest step to ${step} is "${head.label}" by ${who}. You can ${step} only your own newest step; tell the person if theirs is in the way.`,
    409, "not_own_step");
}
