import type { AgentSession } from "./models";

/**
 * The longest title a thread takes. A title the backend derives counts code
 * points. The routes and child tools that accept a title share the number but
 * count UTF-16 code units, as zod does, so an accepted title is never longer.
 */
export const THREAD_TITLE_MAX_CHARACTERS = 120;

// A line that only opens or closes a fenced code block: ``` or ~~~, with an
// optional language word.
const FENCE_LINE = /^(?:`{3,}|~{3,})[\w+#.-]*$/;
// Heading (`# `) and quote (`> `) markers at the start of a line, nested or not.
// A `#` with no space after it, such as `#123`, is text and stays.
const LEADING_MARKERS = /^(?:(?:#{1,6}(?=\s|$)|>)\s*)+/;

/**
 * The title a person's message gives a thread: its first line of real text,
 * cut to `THREAD_TITLE_MAX_CHARACTERS` at a word boundary when one is in reach.
 * `undefined` when the message has no such line, such as one made only of
 * fences and whitespace.
 */
export function threadTitleFromMessage(message: string): string | undefined {
  for (const rawLine of message.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || FENCE_LINE.test(trimmed)) continue;
    const line = trimmed.replace(LEADING_MARKERS, "").replace(/\s+/g, " ").trim();
    if (line) return capTitle(line);
  }
  return undefined;
}

/**
 * Give an untitled thread the title of a person's message. Only a person's
 * turn names a thread, so callers skip turns the backend starts. A thread that
 * has a title keeps it.
 */
export function fillThreadTitle(session: AgentSession, message: string): void {
  if (session.title) return;
  const title = threadTitleFromMessage(message);
  if (title) session.title = title;
}

function capTitle(line: string): string {
  const characters = Array.from(line);
  if (characters.length <= THREAD_TITLE_MAX_CHARACTERS) return line;
  // A space right after the cap is a word boundary too, so look one further.
  const lastSpace = characters.slice(0, THREAD_TITLE_MAX_CHARACTERS + 1).lastIndexOf(" ");
  return characters.slice(0, lastSpace > 0 ? lastSpace : THREAD_TITLE_MAX_CHARACTERS).join("");
}
