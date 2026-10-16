import { BACKGROUND_TASK_LIMITS, type AgentBackgroundTask } from "../../domain/backgroundWork";
import { redactSecrets } from "../../util/redactSecrets";
import { compactDisplayText } from "./displayText";
import { stringValue } from "./jsonValues";

/**
 * Model-authored or command-line text about a task, redacted and then
 * compacted to the display bound. A Codex description is the shell's whole
 * command line, which can carry a bearer header or a labelled key.
 */
export function redactedTaskText(value: unknown): string | undefined {
  const text = stringValue(value);
  return compactDisplayText(text === undefined ? undefined : redactSecrets(text));
}

/**
 * A runner's text for one task row: a description or progress line. The
 * live list rides every session read and update, so it keeps to the shorter
 * row bound.
 */
export function backgroundTaskText(value: unknown): string | undefined {
  return redactedTaskText(value)?.slice(0, BACKGROUND_TASK_LIMITS.text);
}

/**
 * Whether two task lists show the same rows. Progress lines are left out:
 * a runner reports a progress change on its own schedule.
 */
export function sameBackgroundTasks(left: ReadonlyMap<string, AgentBackgroundTask>, right: ReadonlyMap<string, AgentBackgroundTask>): boolean {
  if (left.size !== right.size) return false;
  for (const [id, task] of right) {
    const previous = left.get(id);
    if (!previous || previous.description !== task.description || previous.kind !== task.kind) return false;
    if (previous.parentId !== task.parentId || previous.startedAt !== task.startedAt) return false;
  }
  return true;
}
