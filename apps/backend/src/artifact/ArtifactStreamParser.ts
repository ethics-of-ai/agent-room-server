import type { CodingArtifactKind } from "../protocol/coding/eventSchemas";

// In-band artifact channel. The model sketches by writing a tagged region into
// its ordinary streamed assistant text:
//
//   <artifact id="auth-flow" kind="svg" title="Auth flow"> ...svg... </artifact>
//
// This parser sits on the unified assistant-text stream (both runners funnel
// through `agent_update`) and splits each delta into prose (passed through to
// the chat transcript unchanged) and artifact body (republished as
// `coding_artifact_*` events, kept out of the transcript). It is a pure,
// dependency-free state machine so the streaming edge cases can be unit tested
// in isolation.
//
// Robustness rules that keep model variability from silently eating prose:
//   - An open tag is only recognized at the start of a line (matching the prompt
//     contract). An inline `<artifact …>` the model is merely quoting in prose
//     is left untouched instead of swallowing the surrounding text.
//   - The close marker tolerates surrounding whitespace and case
//     (`</artifact >`, `</Artifact>`), so a slightly malformed close still bounds
//     the region instead of consuming the rest of the turn.
//   - A self-closing `<artifact …/>` declares no body; it is dropped as a control
//     tag and the following text stays prose.

const OPEN_PREFIX = "<artifact";
// The close marker is `</artifact` + optional whitespace + `>`, matched
// case-insensitively. Stored lowercase for case-insensitive scanning.
const CLOSE_PREFIX = "</artifact";
const ARTIFACT_KINDS = new Set<CodingArtifactKind>(["svg", "mermaid"]);
// Matches a trailing `/` (optionally followed by whitespace) inside the tag, i.e.
// a self-closing `<artifact …/>`. A `/` inside a quoted attribute value is not
// at the end of `inner`, so it cannot trigger a false positive.
const SELF_CLOSE_TAG = /\/\s*$/;
// A held "partial" tag is bounded: a real open tag is one short line of
// attributes and a close marker is `</artifact` + whitespace + `>`. Without a
// cap, a malformed tag that never terminates (e.g. an unclosed attribute quote)
// would absorb every subsequent delta into the carry and rescan it on each push
// — quadratic in streamed bytes. On overflow the held text is reclassified:
// prose when outside a region, artifact body when inside.
const MAX_OPEN_TAG_CARRY = 4096;
const MAX_CLOSE_TAG_CARRY = 256;

export type ArtifactStreamOp =
  | { type: "start"; artifactId: string; kind: CodingArtifactKind; title?: string }
  | { type: "delta"; artifactId: string; delta: string }
  | { type: "complete"; artifactId: string };

export interface ArtifactStreamResult {
  prose: string;
  ops: ArtifactStreamOp[];
}

type OpenScan =
  | {
      kind: "found";
      start: number;
      end: number;
      id: string;
      artifactKind: CodingArtifactKind;
      selfClosing: boolean;
      title?: string;
    }
  | { kind: "partial"; start: number }
  | { kind: "none" };

type CloseScan =
  | { kind: "found"; start: number; end: number }
  | { kind: "partial"; start: number }
  | { kind: "none" };

export class ArtifactStreamParser {
  private state: "outside" | "inside" = "outside";
  private carry = "";
  private currentId: string | null = null;
  private counter = 0;
  // Whether the next character to be processed sits at the start of a line.
  // Carried across deltas so a line-start open tag split on a delta boundary is
  // still recognized, and an inline one is still rejected.
  private atLineStart = true;

  constructor(private readonly idPrefix: string = "artifact") {}

  /** Feed one streamed text delta; returns prose to pass through plus artifact ops. */
  push(delta: string): ArtifactStreamResult {
    const ops: ArtifactStreamOp[] = [];
    let prose = "";
    let work = this.carry + delta;
    this.carry = "";

    const emitProse = (text: string): void => {
      if (!text) return;
      prose += text;
      this.atLineStart = lineStartAfter(this.atLineStart, text);
    };

    while (work.length > 0) {
      if (this.state === "outside") {
        const open = this.findOpen(work);
        if (open.kind === "found") {
          emitProse(work.slice(0, open.start));
          work = work.slice(open.end);
          if (open.selfClosing) {
            // A self-closing tag declares no body; drop the control tag and keep
            // parsing the following text as ordinary prose.
            this.atLineStart = false;
            continue;
          }
          this.currentId = open.id;
          ops.push({
            type: "start",
            artifactId: open.id,
            kind: open.artifactKind,
            ...(open.title ? { title: open.title } : {})
          });
          this.state = "inside";
          continue;
        }
        if (open.kind === "partial") {
          if (work.length - open.start > MAX_OPEN_TAG_CARRY) {
            // The "tag" never terminated within any plausible tag length; it is
            // malformed model output, so flush it as ordinary prose.
            emitProse(work);
            break;
          }
          // Hold the incomplete `<artifact …` tag until the next delta completes it.
          emitProse(work.slice(0, open.start));
          this.carry = work.slice(open.start);
          break;
        }
        // No open tag. Hold a trailing fragment only if it could grow into a
        // line-start open marker; otherwise flush all of it as prose now.
        const hold = suffixPrefixLength(work, OPEN_PREFIX);
        if (hold > 0 && this.candidateAtLineStart(work, work.length - hold)) {
          emitProse(work.slice(0, work.length - hold));
          this.carry = work.slice(work.length - hold);
        } else {
          emitProse(work);
        }
        break;
      }

      // inside an open artifact: look for the close marker
      const close = findClose(work);
      if (close.kind === "found") {
        const body = work.slice(0, close.start);
        if (body) ops.push({ type: "delta", artifactId: this.currentId!, delta: body });
        ops.push({ type: "complete", artifactId: this.currentId! });
        this.state = "outside";
        this.currentId = null;
        // Text immediately after `</artifact>` continues the same line; a real
        // line start is detected from a newline in the remaining work.
        this.atLineStart = false;
        work = work.slice(close.end);
        continue;
      }
      // Emit everything except a tail that could still grow into the close marker.
      let holdStart = close.kind === "partial" ? close.start : work.length;
      if (work.length - holdStart > MAX_CLOSE_TAG_CARRY) {
        // A close marker is `</artifact` + bounded whitespace + `>`; a hold this
        // long is not one, so reclassify it as artifact body.
        holdStart = work.length;
      }
      const body = work.slice(0, holdStart);
      if (body) ops.push({ type: "delta", artifactId: this.currentId!, delta: body });
      this.carry = work.slice(holdStart);
      break;
    }

    return { prose, ops };
  }

  /** Close out any in-flight state at turn end (dangling/malformed artifact or held prose). */
  flush(): ArtifactStreamResult {
    const ops: ArtifactStreamOp[] = [];
    let prose = "";
    if (this.state === "inside") {
      if (this.carry) ops.push({ type: "delta", artifactId: this.currentId!, delta: this.carry });
      ops.push({ type: "complete", artifactId: this.currentId! });
    } else if (this.carry) {
      // A held `<artifact …` prefix that never completed was ordinary prose.
      prose = this.carry;
    }
    this.state = "outside";
    this.currentId = null;
    this.carry = "";
    this.atLineStart = true;
    return { prose, ops };
  }

  private findOpen(work: string): OpenScan {
    let from = 0;
    for (;;) {
      const i = work.indexOf(OPEN_PREFIX, from);
      if (i < 0) return { kind: "none" };
      if (!this.candidateAtLineStart(work, i)) {
        // Not at a line start — an inline mention, not an artifact open. Treat as
        // prose and keep scanning past it.
        from = i + OPEN_PREFIX.length;
        continue;
      }
      const afterChar = work[i + OPEN_PREFIX.length];
      if (afterChar === undefined) {
        // `<artifact` exactly at the buffer end — could be our tag once more arrives.
        return { kind: "partial", start: i };
      }
      if (!isTagNameBoundary(afterChar)) {
        // e.g. `<artifacts>` / `<artifactory>` — not our tag; keep scanning.
        from = i + OPEN_PREFIX.length;
        continue;
      }
      const closeBracket = findTagEnd(work, i + OPEN_PREFIX.length);
      if (closeBracket < 0) {
        // Tag opened but not yet terminated (or `>` still inside an unclosed
        // attribute value); wait for more input.
        return { kind: "partial", start: i };
      }
      const inner = work.slice(i + OPEN_PREFIX.length, closeBracket);
      const kind = parseAttribute(inner, "kind");
      if (!kind || !ARTIFACT_KINDS.has(kind as CodingArtifactKind)) {
        // A kind-less or unsupported tag is treated as prose; keep scanning past it.
        from = closeBracket + 1;
        continue;
      }
      const id = parseAttribute(inner, "id") ?? this.nextId();
      const title = parseAttribute(inner, "title");
      return {
        kind: "found",
        start: i,
        end: closeBracket + 1,
        id,
        artifactKind: kind as CodingArtifactKind,
        selfClosing: SELF_CLOSE_TAG.test(inner),
        ...(title ? { title } : {})
      };
    }
  }

  /**
   * Whether an `<artifact` candidate at index `i` sits at the start of a line:
   * only spaces/tabs separate it from the previous newline within this buffer,
   * or from the start of the stream (`this.atLineStart`) when no newline
   * precedes it here.
   */
  private candidateAtLineStart(work: string, i: number): boolean {
    for (let k = i - 1; k >= 0; k -= 1) {
      const char = work[k];
      if (char === "\n" || char === "\r") return true;
      if (char !== " " && char !== "\t") return false;
    }
    return this.atLineStart;
  }

  private nextId(): string {
    this.counter += 1;
    return `${this.idPrefix}:artifact-${this.counter}`;
  }
}

/**
 * Remove well-formed `<artifact …>…</artifact>` spans from a full text blob.
 * Delegates to the streaming state machine so there is a single definition of
 * what counts as an artifact region: feed the whole blob, then flush, and keep
 * only the prose. This keeps the strip in lockstep with live streaming (e.g. a
 * `>` inside an attribute value, unsupported kinds, unclosed regions, line-start
 * anchoring).
 */
export function stripArtifactRegions(text: string): string {
  const parser = new ArtifactStreamParser();
  const head = parser.push(text);
  const tail = parser.flush();
  return head.prose + tail.prose;
}

function isTagNameBoundary(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === ">" || char === "/";
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * Index of the first `>` at or after `from` that is not inside a quoted
 * attribute value, or -1 if the tag is not yet terminated. Naive `indexOf(">")`
 * would stop on a `>` inside e.g. `title="a>b"` and mis-parse the tag.
 */
function findTagEnd(work: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = from; i < work.length; i += 1) {
    const char = work[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Locate the close marker `</artifact` + optional whitespace + `>` within an
 * in-flight artifact body. Tolerant of whitespace before `>` and of case, so a
 * slightly malformed close still bounds the region. Returns `partial` for a
 * trailing fragment that could still grow into a close marker (held until the
 * next delta) and `none` when the whole buffer is artifact body.
 */
function findClose(work: string): CloseScan {
  const lower = work.toLowerCase();
  let from = 0;
  for (;;) {
    const i = lower.indexOf(CLOSE_PREFIX, from);
    if (i < 0) {
      // No full `</artifact` yet; hold only a trailing fragment that could be the
      // beginning of one.
      const hold = suffixPrefixLength(lower, CLOSE_PREFIX);
      return hold > 0 ? { kind: "partial", start: work.length - hold } : { kind: "none" };
    }
    let j = i + CLOSE_PREFIX.length;
    while (j < work.length && isWhitespace(work[j])) j += 1;
    if (j >= work.length) {
      // `</artifact` (+ optional whitespace) at the buffer end; wait for the `>`.
      return { kind: "partial", start: i };
    }
    if (work[j] === ">") {
      return { kind: "found", start: i, end: j + 1 };
    }
    // e.g. `</artifacts>` — not our close marker; keep scanning.
    from = i + CLOSE_PREFIX.length;
  }
}

// Attribute patterns are anchored on a tag-name boundary (start or whitespace)
// so `id` does not match inside `uuid="…"` nor `kind` inside `data-kind="…"`.
// Compiled once per attribute name and reused across the hot streaming path.
const attributePatternCache = new Map<string, { double: RegExp; single: RegExp }>();

function attributePatterns(name: string): { double: RegExp; single: RegExp } {
  let patterns = attributePatternCache.get(name);
  if (!patterns) {
    patterns = {
      double: new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`),
      single: new RegExp(`(?:^|\\s)${name}\\s*=\\s*'([^']*)'`)
    };
    attributePatternCache.set(name, patterns);
  }
  return patterns;
}

function parseAttribute(inner: string, name: string): string | undefined {
  const patterns = attributePatterns(name);
  const double = inner.match(patterns.double);
  if (double) return double[1];
  const single = inner.match(patterns.single);
  if (single) return single[1];
  return undefined;
}

/** Longest suffix of `value` that is also a prefix of `marker` (0 if none). */
function suffixPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length);
  for (let k = max; k > 0; k -= 1) {
    if (value.slice(value.length - k) === marker.slice(0, k)) return k;
  }
  return 0;
}

/**
 * Whether the write position immediately after `text` sits at a line start,
 * given whether `prev` (the position before `text`) did. True when the last
 * non-space/tab character of `text` is a line terminator, or `text` is all
 * spaces/tabs and `prev` was already at a line start.
 */
function lineStartAfter(prev: boolean, text: string): boolean {
  for (let k = text.length - 1; k >= 0; k -= 1) {
    const char = text[k];
    if (char === "\n" || char === "\r") return true;
    if (char !== " " && char !== "\t") return false;
  }
  return prev;
}
