// Phase 5 slice 3 of the spatial-solution-diagrams plan: the Mermaid →
// solution-diagram import bridge.
//
// Agents already stream 2D Mermaid sketches as in-band artifacts (flowcharts
// and graphs, per artifactPrompt.ts); this module turns one into a first-class
// `.diagram.json` base document, so an existing sketch can be rendered — and
// then human-adjusted — spatially without asking the agent to redraw anything.
//
// It is deliberately a hand-rolled, bounded, single-pass parser rather than
// mermaid.js: the backend never executes model-authored markup, and a vendored
// renderer is a rendering dependency, not a parsing contract. No caller input
// is ever compiled into a RegExp (the few regex literals below are fixed and
// applied to length-bounded text); everything structural is character
// scanning, so a hostile source degrades to a structured error, never a stuck
// event loop.
//
// Determinism is a contract, not an accident: identical input produces an
// identical document — ids allocate in first-appearance order, edges number
// densely in source order, and the assembled field order is fixed — so
// re-importing an unchanged sketch produces identical file content.
//
// The lossy edges are warnings, never silence: sanitized ids (the diagram id
// grammar is narrower than Mermaid's), dropped self-loops and
// subgraph-endpoint edges, flattened subgraph nesting, and circle/cross arrow
// ends mapped to plain connections. A renamed id is the warning with a future
// cost — human overrides key on these ids, so re-importing after the *source*
// ids changed orphans the adjustments (surfaced downstream as
// `staleOverrides`). Pure lowercasing is not warned: model sketches capitalize
// nearly every id, and a warning firing on all of them would bury the ones
// that matter.
//
// Unreachable by construction: `queue`, `cache`, `external`, and `gateway`
// have no Mermaid shape, so imported documents use exactly {service,
// datastore, actor, function} × {sync, async, read_write} — all inside the
// closed vocabulary the standing contract teaches, never the compose-side
// unknown-vocab fallback.

import { allocateDiagramId, diagramSlug, sanitizeDiagramIdText } from "./canonical";
import {
  DIAGRAM_SCHEMA_VERSION,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_GROUPS,
  MAX_DIAGRAM_NODES,
  diagramDocumentSchema,
  type DiagramDocument,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramNode
} from "./schemas";

// Matches the artifact content cap: the canonical input is an artifact body.
export const MAX_MERMAID_SOURCE_BYTES = 64 * 1024;
export const MAX_MERMAID_SOURCE_LINES = 4096;
export const MAX_MERMAID_LINE_LENGTH = 4096;

const MAX_REPORTED_ERRORS = 20;
const MAX_REPORTED_WARNINGS = 50;
const MAX_LABEL_LENGTH = 120;
const DEFAULT_DIAGRAM_NAME = "Imported diagram";

export interface MermaidImportIssue {
  // 1-based line in the original source, counting frontmatter and comments.
  line?: number;
  message: string;
}

export type MermaidImportResult =
  | { ok: true; document: DiagramDocument; warnings: MermaidImportIssue[] }
  | { ok: false; errors: MermaidImportIssue[] };

// The filename stem the route offers clients for the written `.diagram.json`,
// derived with the same sanitizer as ids so filename rules live in one place.
export function mermaidDiagramSlug(name: string): string {
  return diagramSlug(name, "imported-diagram");
}

export function convertMermaidToDiagram(
  source: string,
  options: { name?: string } = {}
): MermaidImportResult {
  if (Buffer.byteLength(source, "utf8") > MAX_MERMAID_SOURCE_BYTES) {
    return failure([{ message: `Mermaid source exceeds ${MAX_MERMAID_SOURCE_BYTES} bytes` }]);
  }
  const lines = source.split(/\r\n|\n|\r/);
  if (lines.length > MAX_MERMAID_SOURCE_LINES) {
    return failure([{ message: `Mermaid source exceeds ${MAX_MERMAID_SOURCE_LINES} lines` }]);
  }
  for (const [index, line] of lines.entries()) {
    if (line.length > MAX_MERMAID_LINE_LENGTH) {
      return failure([
        { line: index + 1, message: `Line exceeds ${MAX_MERMAID_LINE_LENGTH} characters` }
      ]);
    }
  }

  const state = new ParseState();

  // Optional YAML frontmatter: only `title:` is meaningful; other keys are
  // Mermaid presentation config with no semantic counterpart here.
  let contentStart = 0;
  while (contentStart < lines.length && lines[contentStart]!.trim().length === 0) {
    contentStart += 1;
  }
  if (contentStart < lines.length && lines[contentStart]!.trim() === "---") {
    const openLine = contentStart;
    let closeLine = -1;
    for (let index = openLine + 1; index < lines.length; index += 1) {
      if (lines[index]!.trim() === "---") {
        closeLine = index;
        break;
      }
    }
    if (closeLine === -1) {
      return failure([{ line: openLine + 1, message: "Unterminated YAML frontmatter" }]);
    }
    for (let index = openLine + 1; index < closeLine; index += 1) {
      const trimmed = lines[index]!.trim();
      if (trimmed.toLowerCase().startsWith("title:")) {
        state.frontmatterTitle = processLabel(
          trimmed.slice("title:".length),
          state,
          index + 1
        );
      }
    }
    contentStart = closeLine + 1;
  }

  for (let index = contentStart; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmedLine = lines[index]!.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("%%")) {
      continue;
    }
    // Legacy `graph LR; A-->B;` one-liners: split on `;` outside brackets and
    // quotes; each piece is its own statement on the same line.
    for (const statement of splitStatements(trimmedLine)) {
      if (state.errors.length >= MAX_REPORTED_ERRORS) {
        state.errors.push({ message: `Stopped after ${MAX_REPORTED_ERRORS} statement errors` });
        return failure(state.errors);
      }
      processStatement(statement, lineNumber, state);
      if (state.fatalError) {
        return failure(state.errors);
      }
    }
  }

  if (!state.sawHeader && state.errors.length === 0) {
    state.errors.push({ message: "Missing flowchart/graph header" });
  }
  for (const scope of state.subgraphStack) {
    state.errors.push({
      line: scope.line,
      message: `Subgraph "${scope.rawId}" is never closed`
    });
  }
  if (state.errors.length > 0) {
    return failure(state.errors);
  }

  return finalize(state, options);
}

// --- parse state ------------------------------------------------------------

interface NodeRecord {
  rawId: string;
  label?: string;
  role?: string;
  groupRawId?: string;
  hasExplicitDeclaration: boolean;
}

interface GroupRecord {
  rawId: string;
  label: string;
  line: number;
}

interface EdgeRecord {
  fromRaw: string;
  toRaw: string;
  kind: string;
  label?: string;
  line: number;
}

class ParseState {
  readonly nodes = new Map<string, NodeRecord>();
  readonly groups = new Map<string, GroupRecord>();
  readonly edges: EdgeRecord[] = [];
  // Raw ids in first-touch order across nodes and subgraphs: the single
  // allocation order that keeps sanitized ids stable across re-imports.
  readonly firstSeen: string[] = [];
  readonly subgraphStack: Array<{ rawId: string; line: number }> = [];
  readonly errors: MermaidImportIssue[] = [];
  readonly warnings: MermaidImportIssue[] = [];
  frontmatterTitle = "";
  sawHeader = false;
  fatalError = false;

  warn(message: string, line?: number): void {
    this.warnings.push({ line, message });
  }

  error(message: string, line?: number): void {
    this.errors.push({ line, message });
  }
}

function failure(errors: MermaidImportIssue[]): MermaidImportResult {
  return { ok: false, errors: errors.slice(0, MAX_REPORTED_ERRORS + 1) };
}

// Split a physical line into `;`-separated statements, respecting quotes,
// bracket depth, and pipe edge labels so a `;` inside a label (including a
// `#59;` entity) never splits.
function splitStatements(line: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let inQuote = false;
  let inPipe = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line.charAt(index);
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) {
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") {
      depth += 1;
    } else if (ch === "]" || ch === ")" || ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "|" && depth === 0) {
      inPipe = !inPipe;
    } else if (ch === ";" && depth === 0 && !inPipe) {
      const piece = line.slice(start, index).trim();
      if (piece.length > 0) {
        statements.push(piece);
      }
      start = index + 1;
    }
  }
  const tail = line.slice(start).trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

// --- statement dispatch -----------------------------------------------------

// Headers for Mermaid diagram types that have no flowchart semantics. Named so
// the error can say "unsupported type", which is actionable, instead of a
// generic parse failure on line 1.
const UNSUPPORTED_HEADERS = new Set([
  "sequencediagram",
  "classdiagram",
  "classdiagram-v2",
  "erdiagram",
  "statediagram",
  "statediagram-v2",
  "gantt",
  "pie",
  "journey",
  "gitgraph",
  "mindmap",
  "timeline",
  "quadrantchart",
  "requirementdiagram",
  "c4context",
  "sankey-beta",
  "xychart-beta",
  "block-beta"
]);

const DIRECTION_TOKENS = new Set(["tb", "td", "bt", "lr", "rl"]);

// Presentation-only statements with no semantic counterpart: skipped silently
// rather than warned, because they carry no information the diagram loses.
const SKIPPED_STATEMENT_KEYWORDS = [
  "direction",
  "style",
  "classdef",
  "class",
  "linkstyle",
  "click",
  "acctitle",
  "accdescr"
];

function processStatement(statement: string, line: number, state: ParseState): void {
  if (!state.sawHeader) {
    const firstToken = statement.split(/\s+/, 1)[0]!.toLowerCase();
    if (UNSUPPORTED_HEADERS.has(firstToken)) {
      state.error(
        `Unsupported Mermaid diagram type "${firstToken}"; only flowchart/graph diagrams can be imported`,
        line
      );
      state.fatalError = true;
      return;
    }
    if (firstToken !== "flowchart" && firstToken !== "flowchart-elk" && firstToken !== "graph") {
      state.error("Missing flowchart/graph header", line);
      state.fatalError = true;
      return;
    }
    const rest = statement.slice(firstToken.length).trim();
    if (rest.length > 0 && !DIRECTION_TOKENS.has(rest.toLowerCase())) {
      state.error(`Could not parse flowchart header on line ${line}`, line);
      state.fatalError = true;
      return;
    }
    state.sawHeader = true;
    return;
  }

  const lowered = statement.toLowerCase();
  for (const keyword of SKIPPED_STATEMENT_KEYWORDS) {
    if (
      lowered === keyword ||
      lowered.startsWith(`${keyword} `) ||
      lowered.startsWith(`${keyword}\t`) ||
      lowered.startsWith(`${keyword}:`)
    ) {
      return;
    }
  }

  if (lowered === "end") {
    if (state.subgraphStack.length === 0) {
      state.error(`"end" without an open subgraph`, line);
      return;
    }
    state.subgraphStack.pop();
    return;
  }

  if (lowered === "subgraph" || lowered.startsWith("subgraph ") || lowered.startsWith("subgraph\t")) {
    processSubgraphHeader(statement.slice("subgraph".length).trim(), line, state);
    return;
  }

  processNodeEdgeStatement(statement, line, state);
}

function processSubgraphHeader(rest: string, line: number, state: ParseState): void {
  if (rest.length === 0) {
    state.error("Subgraph is missing a name", line);
    return;
  }
  // `subgraph id[Label]` when an ident is immediately followed by a shape;
  // otherwise the whole text (quoted or free) is both id-source and label.
  let rawId = rest;
  let labelText = rest;
  const cursor: Cursor = { text: rest, pos: 0 };
  const ident = scanIdent(cursor);
  if (ident.length > 0 && cursor.pos < rest.length && shapeOpenerAt(cursor) !== null) {
    const shape = scanShape(cursor);
    if (shape !== null && cursor.pos >= rest.length) {
      rawId = ident;
      labelText = shape.labelRaw;
    }
  }
  const label = processLabel(labelText, state, line);
  if (state.subgraphStack.length > 0) {
    state.warn(
      `Nested subgraph "${rawId}" flattened; the diagram contract keeps groups flat`,
      line
    );
  }
  if (!state.groups.has(rawId)) {
    state.groups.set(rawId, {
      rawId,
      label: label.length > 0 ? label : rawId,
      line
    });
    if (!state.nodes.has(rawId)) {
      state.firstSeen.push(rawId);
    }
  }
  state.subgraphStack.push({ rawId, line });
}

// --- node/edge statement tokenizer ------------------------------------------

interface Cursor {
  text: string;
  pos: number;
}

interface ShapeToken {
  role: string;
  labelRaw: string;
}

interface LinkToken {
  family: "solid" | "thick" | "dotted" | "invisible";
  leadArrow: boolean;
  tailArrow: boolean;
  leadMark: "o" | "x" | null;
  tailMark: "o" | "x" | null;
  labelRaw?: string;
}

class StatementParseError extends Error {}

function processNodeEdgeStatement(statement: string, line: number, state: ParseState): void {
  const cursor: Cursor = { text: statement, pos: 0 };
  try {
    skipWhitespace(cursor);
    let previous = parseNodeList(cursor, line, state);
    skipWhitespace(cursor);
    while (cursor.pos < cursor.text.length) {
      const link = parseLink(cursor);
      skipWhitespace(cursor);
      const next = parseNodeList(cursor, line, state);
      skipWhitespace(cursor);
      emitEdges(previous, next, link, line, state);
      previous = next;
    }
  } catch (error) {
    if (error instanceof StatementParseError) {
      state.error(`Could not parse statement on line ${line}: ${error.message}`, line);
      return;
    }
    throw error;
  }
}

function skipWhitespace(cursor: Cursor): void {
  while (cursor.pos < cursor.text.length) {
    const ch = cursor.text.charAt(cursor.pos);
    if (ch !== " " && ch !== "\t") {
      return;
    }
    cursor.pos += 1;
  }
}

const STROKE_CHARS = new Set(["-", "=", ".", "~"]);

function isStroke(ch: string): boolean {
  return STROKE_CHARS.has(ch);
}

// Longest-first so `((` never matches as `(` + `(`. The role column is the
// complete shape → role mapping; everything not listed reads as a plain
// service box.
const SHAPE_OPENERS: ReadonlyArray<{
  open: string;
  close: string;
  role: string;
  trapezoid?: boolean;
}> = [
  { open: "(((", close: ")))", role: "actor" },
  { open: "([", close: "])", role: "service" },
  { open: "[[", close: "]]", role: "function" },
  { open: "[(", close: ")]", role: "datastore" },
  { open: "((", close: "))", role: "actor" },
  { open: "{{", close: "}}", role: "service" },
  { open: "[/", close: "]", role: "service", trapezoid: true },
  { open: "[\\", close: "]", role: "service", trapezoid: true },
  { open: "[", close: "]", role: "service" },
  { open: "(", close: ")", role: "service" },
  { open: "{", close: "}", role: "service" },
  { open: ">", close: "]", role: "service" }
];

function shapeOpenerAt(cursor: Cursor): (typeof SHAPE_OPENERS)[number] | null {
  for (const opener of SHAPE_OPENERS) {
    if (cursor.text.startsWith(opener.open, cursor.pos)) {
      return opener;
    }
  }
  return null;
}

function linkStartsAt(cursor: Cursor): boolean {
  const ch = cursor.text.charAt(cursor.pos);
  const next = cursor.text.charAt(cursor.pos + 1);
  if (isStroke(ch) && isStroke(next)) {
    return true;
  }
  return ch === "<" && isStroke(next);
}

function scanIdent(cursor: Cursor): string {
  const start = cursor.pos;
  while (cursor.pos < cursor.text.length) {
    const ch = cursor.text.charAt(cursor.pos);
    if (ch === " " || ch === "\t" || ch === "&" || ch === "|" || ch === ";") {
      break;
    }
    if (shapeOpenerAt(cursor) !== null || linkStartsAt(cursor)) {
      break;
    }
    // Mermaid v11 `id@{ shape: … }` metadata has no counterpart here; naming
    // it beats a generic failure on the `{` that follows.
    if (ch === "@" && cursor.text.charAt(cursor.pos + 1) === "{") {
      throw new StatementParseError(`the "@{…}" node syntax is not supported`);
    }
    cursor.pos += 1;
  }
  return cursor.text.slice(start, cursor.pos);
}

function scanShape(cursor: Cursor): ShapeToken | null {
  const opener = shapeOpenerAt(cursor);
  if (opener === null) {
    return null;
  }
  cursor.pos += opener.open.length;
  const start = cursor.pos;
  let inQuote = false;
  while (cursor.pos < cursor.text.length) {
    const ch = cursor.text.charAt(cursor.pos);
    if (ch === '"') {
      inQuote = !inQuote;
      cursor.pos += 1;
      continue;
    }
    if (!inQuote && cursor.text.startsWith(opener.close, cursor.pos)) {
      let labelRaw = cursor.text.slice(start, cursor.pos);
      if (opener.trapezoid) {
        labelRaw = labelRaw.replace(/[/\\]$/, "");
      }
      cursor.pos += opener.close.length;
      return { role: opener.role, labelRaw };
    }
    cursor.pos += 1;
  }
  throw new StatementParseError(`missing "${opener.close}" closing a node shape`);
}

function parseNodeList(cursor: Cursor, line: number, state: ParseState): string[] {
  const rawIds: string[] = [];
  for (;;) {
    const ident = scanIdent(cursor);
    if (ident.length === 0) {
      throw new StatementParseError("expected a node id");
    }
    const shape = shapeOpenerAt(cursor) !== null ? scanShape(cursor) : null;
    registerNodeMention(ident, shape, line, state);
    rawIds.push(ident);
    skipWhitespace(cursor);
    if (cursor.text.charAt(cursor.pos) !== "&") {
      return rawIds;
    }
    cursor.pos += 1;
    skipWhitespace(cursor);
  }
}

function parseLink(cursor: Cursor): LinkToken {
  let leadArrow = false;
  let leadMark: "o" | "x" | null = null;
  const first = cursor.text.charAt(cursor.pos);
  const second = cursor.text.charAt(cursor.pos + 1);
  if (first === "<" && isStroke(second)) {
    leadArrow = true;
    cursor.pos += 1;
  } else if ((first === "o" || first === "x") && (second === "-" || second === "=")) {
    leadMark = first;
    cursor.pos += 1;
  }

  const run = scanStrokeRun(cursor);
  let family = strokeFamily(run);
  let tailArrow = false;
  let tailMark: "o" | "x" | null = null;
  let labelRaw: string | undefined;

  const terminator = scanTerminator(cursor);
  if (terminator === ">") {
    tailArrow = true;
  } else if (terminator !== null) {
    tailMark = terminator;
  }

  // `A -- label --> B`: a bare two-char open run means the label sits inline
  // and the closing run carries the real direction. A lead-decorated run with
  // no closing run is not that — `B <-- A` is a complete reversed link.
  if (terminator === null && run.length === 2 && family !== "invisible") {
    const inline = scanInlineLabel(cursor);
    if (inline !== null) {
      labelRaw = inline.labelRaw;
      family = combineFamilies(family, strokeFamily(inline.closeRun));
      if (inline.terminator === ">") {
        tailArrow = true;
      } else if (inline.terminator !== null) {
        tailMark = inline.terminator;
      }
    } else if (!leadArrow && leadMark === null) {
      throw new StatementParseError("an inline edge label is missing its closing stroke run");
    }
  }

  skipWhitespace(cursor);
  if (cursor.text.charAt(cursor.pos) === "|") {
    labelRaw = scanPipeLabel(cursor);
  }

  return { family, leadArrow, tailArrow, leadMark, tailMark, labelRaw };
}

function scanStrokeRun(cursor: Cursor): string {
  const start = cursor.pos;
  while (cursor.pos < cursor.text.length && isStroke(cursor.text.charAt(cursor.pos))) {
    cursor.pos += 1;
  }
  const run = cursor.text.slice(start, cursor.pos);
  if (run.length < 2) {
    throw new StatementParseError(`"${run}" is not a link (links need at least two stroke characters)`);
  }
  if (run.includes("~") && !/^~+$/.test(run)) {
    throw new StatementParseError(`"${run}" mixes invisible-link and stroke characters`);
  }
  return run;
}

function strokeFamily(run: string): LinkToken["family"] {
  if (run.includes("~")) {
    return "invisible";
  }
  if (run.includes(".")) {
    return "dotted";
  }
  if (run.includes("=")) {
    return "thick";
  }
  return "solid";
}

function combineFamilies(open: LinkToken["family"], close: LinkToken["family"]): LinkToken["family"] {
  if (open === "dotted" || close === "dotted") {
    return "dotted";
  }
  if (open === "thick" || close === "thick") {
    return "thick";
  }
  return "solid";
}

// `o`/`x` end a link only when what follows could not begin an ident —
// otherwise `A-->orders` would lose its first letter.
function scanTerminator(cursor: Cursor): ">" | "o" | "x" | null {
  const ch = cursor.text.charAt(cursor.pos);
  if (ch === ">") {
    cursor.pos += 1;
    return ">";
  }
  if (ch === "o" || ch === "x") {
    const next = cursor.text.charAt(cursor.pos + 1);
    if (next === "" || next === " " || next === "\t" || next === "|" || next === "&" || next === ";") {
      cursor.pos += 1;
      return ch;
    }
  }
  return null;
}

function scanInlineLabel(cursor: Cursor): {
  labelRaw: string;
  closeRun: string;
  terminator: ">" | "o" | "x" | null;
} | null {
  const start = cursor.pos;
  let inQuote = false;
  let scan = cursor.pos;
  while (scan < cursor.text.length) {
    const ch = cursor.text.charAt(scan);
    if (ch === '"') {
      inQuote = !inQuote;
      scan += 1;
      continue;
    }
    if (!inQuote && isStroke(ch) && isStroke(cursor.text.charAt(scan + 1))) {
      const labelRaw = cursor.text.slice(start, scan);
      cursor.pos = scan;
      const closeRun = scanStrokeRun(cursor);
      const terminator = scanTerminator(cursor);
      return { labelRaw, closeRun, terminator };
    }
    scan += 1;
  }
  return null;
}

function scanPipeLabel(cursor: Cursor): string {
  cursor.pos += 1;
  const start = cursor.pos;
  let inQuote = false;
  while (cursor.pos < cursor.text.length) {
    const ch = cursor.text.charAt(cursor.pos);
    if (ch === '"') {
      inQuote = !inQuote;
      cursor.pos += 1;
      continue;
    }
    if (!inQuote && ch === "|") {
      const labelRaw = cursor.text.slice(start, cursor.pos);
      cursor.pos += 1;
      return labelRaw;
    }
    cursor.pos += 1;
  }
  throw new StatementParseError(`an edge label is missing its closing "|"`);
}

// --- graph building ---------------------------------------------------------

function registerNodeMention(
  rawId: string,
  shape: ShapeToken | null,
  line: number,
  state: ParseState
): void {
  // A raw id already claimed by a subgraph names the subgraph, never a node:
  // Mermaid shares one namespace, and edges to it are dropped at finalize.
  if (state.groups.has(rawId)) {
    return;
  }
  let record = state.nodes.get(rawId);
  if (record === undefined) {
    record = { rawId, hasExplicitDeclaration: false };
    state.nodes.set(rawId, record);
    state.firstSeen.push(rawId);
  }
  if (shape !== null) {
    const label = processLabel(shape.labelRaw, state, line);
    if (
      record.hasExplicitDeclaration &&
      (record.label !== (label.length > 0 ? label : undefined) || record.role !== shape.role)
    ) {
      state.warn(`Node "${rawId}" is declared more than once; the later declaration wins`, line);
    }
    record.hasExplicitDeclaration = true;
    record.role = shape.role;
    record.label = label.length > 0 ? label : undefined;
  }
  // Membership comes only from mentions inside a subgraph; a top-level mention
  // never reassigns, so the declare-edges-first idiom keeps working.
  const scope = state.subgraphStack[state.subgraphStack.length - 1];
  if (scope !== undefined && record.groupRawId !== scope.rawId) {
    if (record.groupRawId !== undefined) {
      state.warn(
        `Node "${rawId}" is listed in more than one subgraph; the later one wins`,
        line
      );
    }
    record.groupRawId = scope.rawId;
  }
}

function emitEdges(
  fromRawIds: string[],
  toRawIds: string[],
  link: LinkToken,
  line: number,
  state: ParseState
): void {
  if (link.family === "invisible") {
    state.warn("Invisible link dropped; it is a layout hint and layout is engine-owned", line);
    return;
  }
  // A Mermaid endpoint list expands as a Cartesian product. Enforce the
  // document cap *before* allocating its EdgeRecords: a small source line such
  // as `a&a&… --> b&b&…` can otherwise materialize millions of entries before
  // `finalize` discovers that the resulting diagram is over-cap.
  const nextEdgeCount = state.edges.length + fromRawIds.length * toRawIds.length;
  if (nextEdgeCount > MAX_DIAGRAM_EDGES) {
    state.error(
      `Diagram has ${nextEdgeCount} edges after expanding list endpoints; the maximum is ${MAX_DIAGRAM_EDGES}`,
      line
    );
    return;
  }
  const swap = link.leadArrow && !link.tailArrow;
  let kind: string;
  if ((link.leadArrow && link.tailArrow) || (link.leadMark !== null && link.tailMark !== null)) {
    kind = "read_write";
  } else {
    kind = link.family === "dotted" ? "async" : "sync";
  }
  if ((link.leadMark !== null || link.tailMark !== null) && kind !== "read_write") {
    state.warn("Circle/cross arrow end imported as a plain connection", line);
  } else if (link.leadMark !== null && link.tailMark !== null) {
    state.warn("Circle/cross arrow ends imported as a read/write connection", line);
  }
  const label = link.labelRaw === undefined ? undefined : processLabel(link.labelRaw, state, line);
  for (const fromRaw of fromRawIds) {
    for (const toRaw of toRawIds) {
      state.edges.push({
        fromRaw: swap ? toRaw : fromRaw,
        toRaw: swap ? fromRaw : toRaw,
        kind,
        label: label !== undefined && label.length > 0 ? label : undefined,
        line
      });
    }
  }
}

// --- finalize ---------------------------------------------------------------

function finalize(state: ParseState, options: { name?: string }): MermaidImportResult {
  // A raw id declared as both a node and a subgraph belongs to the subgraph:
  // groups are structural, and the schema keeps node/group ids disjoint.
  for (const group of state.groups.values()) {
    if (state.nodes.delete(group.rawId)) {
      state.warn(
        `"${group.rawId}" is declared as both a node and a subgraph; the subgraph wins`,
        group.line
      );
    }
  }

  const keptEdges: EdgeRecord[] = [];
  for (const edge of state.edges) {
    if (state.groups.has(edge.fromRaw) || state.groups.has(edge.toRaw)) {
      state.warn(
        `Edge from "${edge.fromRaw}" to "${edge.toRaw}" connects a subgraph and was dropped; diagram edges connect nodes`,
        edge.line
      );
      continue;
    }
    if (edge.fromRaw === edge.toRaw) {
      state.warn(`Self-loop on "${edge.fromRaw}" dropped; edge endpoints must differ`, edge.line);
      continue;
    }
    keptEdges.push(edge);
  }

  if (state.nodes.size === 0) {
    state.error("Diagram contains no nodes");
    return failure(state.errors);
  }
  if (state.nodes.size > MAX_DIAGRAM_NODES) {
    state.error(`Diagram has ${state.nodes.size} nodes; the maximum is ${MAX_DIAGRAM_NODES}`);
  }
  if (keptEdges.length > MAX_DIAGRAM_EDGES) {
    state.error(`Diagram has ${keptEdges.length} edges; the maximum is ${MAX_DIAGRAM_EDGES}`);
  }
  if (state.groups.size > MAX_DIAGRAM_GROUPS) {
    state.error(`Diagram has ${state.groups.size} groups; the maximum is ${MAX_DIAGRAM_GROUPS}`);
  }
  if (state.errors.length > 0) {
    return failure(state.errors);
  }

  const idByRaw = allocateIds(state);

  const nodes: DiagramNode[] = [];
  for (const record of state.nodes.values()) {
    const node: DiagramNode = {
      id: idByRaw.get(record.rawId)!,
      label: record.label ?? fallbackLabel(record.rawId),
      role: record.role ?? "service"
    };
    if (record.groupRawId !== undefined) {
      node.group = idByRaw.get(record.groupRawId)!;
    }
    nodes.push(node);
  }

  const edges: DiagramEdge[] = keptEdges.map((edge, index) => {
    const composed: DiagramEdge = {
      id: `e${index + 1}`,
      from: idByRaw.get(edge.fromRaw)!,
      to: idByRaw.get(edge.toRaw)!,
      kind: edge.kind
    };
    if (edge.label !== undefined) {
      composed.label = edge.label;
    }
    return composed;
  });

  const groups: DiagramGroup[] = [];
  for (const record of state.groups.values()) {
    groups.push({
      id: idByRaw.get(record.rawId)!,
      label: record.label
    });
  }

  // Field order is the document's canonical serialization order — it matches
  // the standing contract's example, and JSON.stringify preserves it.
  const document: DiagramDocument = {
    schemaVersion: DIAGRAM_SCHEMA_VERSION,
    kind: "solution",
    name: resolveName(options.name, state.frontmatterTitle),
    nodes,
    edges,
    groups
  };

  const parsed = diagramDocumentSchema.safeParse(document);
  if (!parsed.success) {
    // Not an input problem: the converter's own invariant broke. Throwing
    // routes the blame to a 500 instead of telling the user their sketch is
    // at fault.
    const issue = parsed.error.issues[0];
    throw new Error(
      `mermaid-import produced an invalid diagram document: ${issue?.message ?? "unknown issue"}`
    );
  }

  return { ok: true, document: parsed.data, warnings: boundWarnings(state.warnings) };
}

function boundWarnings(warnings: MermaidImportIssue[]): MermaidImportIssue[] {
  if (warnings.length <= MAX_REPORTED_WARNINGS) {
    return warnings;
  }
  return [
    ...warnings.slice(0, MAX_REPORTED_WARNINGS),
    { message: `…and ${warnings.length - MAX_REPORTED_WARNINGS} more warnings` }
  ];
}

function resolveName(requested: string | undefined, frontmatterTitle: string): string {
  for (const candidate of [requested?.trim() ?? "", frontmatterTitle]) {
    if (candidate.length > 0) {
      return candidate.slice(0, MAX_LABEL_LENGTH).trim();
    }
  }
  return DEFAULT_DIAGRAM_NAME;
}

// A bare node's label is its source id — `OrderService` reads better than the
// sanitized `orderservice` the document keys on.
function fallbackLabel(rawId: string): string {
  const label = rawId.slice(0, MAX_LABEL_LENGTH).trim();
  return label.length > 0 ? label : "node";
}

// --- ids and labels ---------------------------------------------------------

function allocateIds(state: ParseState): Map<string, string> {
  const used = new Set<string>();
  const idByRaw = new Map<string, string>();
  for (const rawId of state.firstSeen) {
    if (!state.nodes.has(rawId) && !state.groups.has(rawId)) {
      continue;
    }
    const base = sanitizeDiagramIdText(rawId) || "n";
    const candidate = allocateDiagramId(base, used);
    used.add(candidate);
    idByRaw.set(rawId, candidate);
    // Lowercasing alone is not a rename worth a warning — model sketches
    // capitalize nearly every id, and the signal that matters is a charset
    // change or a collision suffix, both of which shift override keys.
    if (candidate !== rawId.toLowerCase()) {
      state.warn(`Renamed "${rawId}" to "${candidate}"`);
    }
  }
  return idByRaw;
}

const NAMED_ENTITIES = new Map<string, string>([
  ["quot", '"'],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"]
]);

function processLabel(raw: string, state: ParseState, line: number): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) {
    text = text.slice(1, -1);
  }
  text = text.replace(/<br\s*\/?>/gi, " ");
  // Mermaid entity escapes: `#quot;`, `#amp;`, and numeric `#35;` forms.
  text = text.replace(/#([a-z]+|\d{1,7});/g, (match, body: string) => {
    const named = NAMED_ENTITIES.get(body);
    if (named !== undefined) {
      return named;
    }
    if (/^\d+$/.test(body)) {
      const codePoint = Number.parseInt(body, 10);
      if (codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_LABEL_LENGTH) {
    text = text.slice(0, MAX_LABEL_LENGTH).trim();
    state.warn(`Label truncated to ${MAX_LABEL_LENGTH} characters`, line);
  }
  return text;
}
