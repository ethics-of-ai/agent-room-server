import { z } from "zod";
import { BACKGROUND_TASK_LIMITS } from "../../domain/backgroundWork";

// Pages read per list call; `listed` tasks fit in far fewer.
const LIST_PAGE_LIMIT = 4;

// The 0.160.0 `ThreadBackgroundTerminalsListResponse` and
// `ThreadBackgroundTerminalsTerminateResponse`, reduced to the fields read
// here. Entries are checked one by one, so one malformed terminal drops only
// itself.
const terminalListPageSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish()
});
const terminalSchema = z.object({
  itemId: z.string().min(1),
  processId: z.string().min(1),
  command: z.string().optional()
});
const terminateResponseSchema = z.object({ terminated: z.boolean() });

export type CodexRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type BackgroundTerminal = z.infer<typeof terminalSchema>;

/** One thread's live terminals, at most `listed` of them. Throws when a page does not match the schema. */
export async function readBackgroundTerminals(request: CodexRequest, threadId: string): Promise<unknown[]> {
  const terminals: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_LIMIT; page += 1) {
    const response = terminalListPageSchema.parse(await request("thread/backgroundTerminals/list", {
      threadId,
      ...(cursor ? { cursor } : {})
    }));
    terminals.push(...response.data);
    cursor = response.nextCursor || undefined;
    if (!cursor || terminals.length >= BACKGROUND_TASK_LIMITS.listed) break;
  }
  return terminals;
}

/** A list entry's ids and command, or undefined when it does not match the schema. */
export function parseBackgroundTerminal(entry: unknown): BackgroundTerminal | undefined {
  const parsed = terminalSchema.safeParse(entry);
  return parsed.success ? parsed.data : undefined;
}

/** Ask the app-server to end one terminal. True only when it answers that it did. */
export async function terminateBackgroundTerminal(request: CodexRequest, threadId: string, processId: string): Promise<boolean> {
  const response = terminateResponseSchema.safeParse(await request("thread/backgroundTerminals/terminate", { threadId, processId }));
  return response.success && response.data.terminated;
}

/** End every terminal a thread has running now. */
export async function terminateBackgroundTerminals(request: CodexRequest, threadId: string): Promise<void> {
  for (const entry of await readBackgroundTerminals(request, threadId)) {
    const terminal = parseBackgroundTerminal(entry);
    if (terminal) await terminateBackgroundTerminal(request, threadId, terminal.processId);
  }
}
