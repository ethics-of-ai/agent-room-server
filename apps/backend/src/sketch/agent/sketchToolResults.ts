import type { ZodError, ZodIssue } from "zod";
import { WorkspaceExplorerError } from "../../workspace/WorkspaceExplorer";
import type { SketchIndexEntry, StoredSketchIndex } from "../index/SketchIndexStore";
import type { SketchResolution } from "../index/sketchReference";
import { SketchServiceError } from "../sketchErrors";
import { SKETCH_TOOL_RESULT_BYTES } from "./sketchInspect";

/**
 * The text a sketch tool returns for refusals and listings. Every result
 * starts with `ok:` or `error <code>:` and stays within the 48 KiB cap.
 */

export function unknownSketch(reference: string, suggestions: readonly string[] = []): string {
  const closest = suggestions.length > 0 ? ` Closest titles: ${suggestions.map((title) => `"${title}"`).join(", ")}.` : "";
  return `error unknown_sketch: no sketch "${reference.slice(0, 200)}" in this session's workspace.${closest} ` +
    "Call agentroom_sketch_list to see the workspace's sketches.";
}

/** The refusal for a reference that did not resolve to one valid sketch, or undefined when it did. */
export function resolutionRefusal(reference: string, resolution: SketchResolution): string | undefined {
  if (resolution.kind === "unknown") return unknownSketch(reference, resolution.suggestions);
  if (resolution.kind === "ambiguous") {
    return `error ambiguous_sketch: "${reference.slice(0, 200)}" matches several sketches: ${resolution.paths.join(", ")}. Pass one of these paths.`;
  }
  if (resolution.entry.state === "invalid") {
    return `error invalid_document: ${resolution.entry.path} is not a readable sketch (${resolution.entry.invalidReason ?? "unreadable"}). Tell the person.`;
  }
  return undefined;
}

export function formatSketchList(index: StoredSketchIndex, filter: string | undefined): string {
  const needle = filter?.toLowerCase();
  const entries = needle === undefined ? index.entries
    : index.entries.filter((entry) => entry.title.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle));
  const header = [`ok: ${entries.length} sketch(es)${needle === undefined ? "" : ` matching "${filter}"`} in this session's workspace, one JSON line each.`];
  if (index.total > index.entries.length || index.truncated) {
    header.push(`The index holds ${index.entries.length} of ${index.total}${index.truncated ? " or more" : ""} sketch files. A filter or title searches only those, so pass a sketch's exact path to reach the rest.`);
  }
  let budget = SKETCH_TOOL_RESULT_BYTES - Buffer.byteLength(header.join("\n"), "utf8") - 256;
  const lines: string[] = [];
  for (const entry of entries) {
    const line = JSON.stringify(listLine(entry));
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (size > budget) break;
    lines.push(line);
    budget -= size;
  }
  if (lines.length < entries.length) lines.push(`(${entries.length - lines.length} more left out to stay within the result limit; pass a filter.)`);
  return [...header, ...lines].join("\n");
}

function listLine(entry: SketchIndexEntry): Record<string, unknown> {
  if (entry.state === "invalid") return { title: entry.title, path: entry.path, state: "invalid", reason: entry.invalidReason };
  return {
    title: entry.title, path: entry.path, id: entry.sketchId, revision: entry.revision, objects: entry.objectCount,
    ...(entry.lastChangedAt ? { changed: entry.lastChangedAt } : {}),
    by: entry.lastActorKind === "agent" ? "agent" : entry.lastActorKind === "human" ? "person" : "unknown"
  };
}

export function invalidRequest(error: ZodError): string {
  const issues = specificIssues(error.issues).slice(0, 8).map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`);
  return `error invalid_request: ${issues.join("; ")}`;
}

/**
 * A failed union reports only "Invalid input". The operations are a union
 * keyed by `op` and `kind`, so report the branch that matched those and
 * failed on something else, which names the field the agent got wrong.
 */
function specificIssues(issues: readonly ZodIssue[]): ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    const branches = issue.unionErrors.map((branch) => specificIssues(branch.issues));
    const discriminated = (branch: ZodIssue[]) => branch.some((entry) =>
      entry.code === "invalid_literal" && ["op", "kind"].includes(String(entry.path.at(-1))));
    const matching = branches.filter((branch) => !discriminated(branch));
    const best = (matching.length > 0 ? matching : branches).sort((left, right) => left.length - right.length)[0];
    return best && best.length > 0 ? best : [issue];
  });
}

export function serviceFailure(error: unknown, reference: string): string {
  if (error instanceof SketchServiceError) {
    if (["file_missing", "invalid_path", "parent_missing", "unknown_workspace"].includes(error.code)) return unknownSketch(reference);
    if (error.code === "file_changed") {
      return "error file_changed: the file changed outside AgentRoom since that revision. Call agentroom_sketch_inspect and retry with its revision.";
    }
    const opIndex = typeof error.details.opIndex === "number" ? ` (operation ${error.details.opIndex})` : "";
    return `error ${error.code}${opIndex}: ${error.message}`;
  }
  if (error instanceof WorkspaceExplorerError) return unknownSketch(reference);
  throw error;
}
