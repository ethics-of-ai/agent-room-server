import { describe, expect, it } from "vitest";
import {
  SKETCH_DEFAULT_EXTRUSION_DEPTH,
  SKETCH_DEFAULT_TEXT_FONT_SIZE,
  SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS,
  SKETCH_MAX_TEXT_SPANS,
  SKETCH_SCHEMA_VERSION,
  createSketchState,
  evaluateSketchCommit,
  parseSketchDocument,
  parseSketchState,
  redoSketchTransaction,
  serializeSketchDocument,
  serializeSketchState,
  sketchDocumentV2Schema,
  sketchStateV2Schema,
  undoSketchTransaction,
  type SketchCommitRequest,
  type SketchState,
  type SketchTextParagraph,
  type SketchTextSpan
} from "../src/sketch/core";

const human = { kind: "human", name: "Tester" } as const;
type TextBoxCreate = Extract<SketchCommitRequest["operations"][number], { op: "create"; kind: "textBox" }>;
type TextBoxUpdate = Extract<SketchCommitRequest["operations"][number], { op: "update"; kind: "textBox" }>;

const body: SketchTextParagraph = { style: "body", alignment: "leading", list: "none" };
const title: SketchTextParagraph = { style: "title", alignment: "center", list: "none" };

function textBox(objectId: string, overrides: Partial<TextBoxCreate> = {}): TextBoxCreate {
  return {
    op: "create",
    objectId,
    kind: "textBox",
    text: "A short note",
    size: [0.3, 0.2],
    appearance: "fill",
    fillColor: "#ffffff",
    outlineColor: "#000000",
    outlineWidth: 0.004,
    ...overrides
  };
}

function update(objectId: string, fields: Omit<TextBoxUpdate, "op" | "objectId" | "kind">): TextBoxUpdate {
  return { op: "update", objectId, kind: "textBox", ...fields };
}

function commit(state: SketchState, requestId: string, operations: SketchCommitRequest["operations"]) {
  return evaluateSketchCommit(state, {
    requestId,
    baseRevision: state.document.revision,
    actor: human,
    operations
  });
}

function created(operations: SketchCommitRequest["operations"]): SketchState {
  const result = commit(createSketchState("text-format"), "create", operations);
  if (!result.ok) throw new Error(`create failed: ${result.error.message}`);
  return result.state;
}

function expectRefusal(
  result: ReturnType<typeof commit>,
  code: string,
  limit?: string
) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  if (limit !== undefined) expect(result.error.limit).toBe(limit);
}

describe("text box formatting", () => {
  it("fills plain defaults when a create leaves formatting out", () => {
    const state = created([textBox("note", { text: "One\n\nThree" })]);
    expect(state.document.objects[0]).toMatchObject({
      font: { family: "system", size: SKETCH_DEFAULT_TEXT_FONT_SIZE },
      paragraphs: [body, body, body],
      spans: [],
      rendering: "flat",
      extrusionDepth: SKETCH_DEFAULT_EXTRUSION_DEPTH
    });
  });

  it("stores explicit formatting canonically and round-trips it byte for byte", () => {
    const state = created([textBox("note", {
      text: "Launch plan\nShip it 😀",
      font: { family: "serif", size: 0.02 },
      paragraphs: [title, { style: "body", alignment: "leading", list: "bullet" }],
      spans: [
        { start: 0, length: 6, bold: true },
        { start: 6, length: 5, italic: true, bold: true },
        { start: 12, length: 4, strikethrough: true, underline: true }
      ],
      rendering: "extruded",
      extrusionDepth: 0.01
    })]);
    const serialized = serializeSketchDocument(state.document);
    const stored = JSON.parse(serialized).objects[0];
    expect(stored.spans[1]).toEqual({ start: 6, length: 5, bold: true, italic: true });
    expect(Object.keys(stored.spans[2])).toEqual(["start", "length", "underline", "strikethrough"]);
    const parsed = parseSketchDocument(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeSketchDocument(parsed.value)).toBe(serialized);
  });

  it("refuses a text change that leaves out paragraphs or spans", () => {
    const state = created([textBox("note")]);
    expectRefusal(commit(state, "text-only", [update("note", { text: "New" })]), "invalid_operation");
    expectRefusal(commit(state, "no-spans", [update("note", { text: "New", paragraphs: [body] })]), "invalid_operation");
    const accepted = commit(state, "full", [update("note", { text: "New", paragraphs: [body], spans: [] })]);
    expect(accepted.ok).toBe(true);
  });

  it("requires one paragraph format per line of text", () => {
    expectRefusal(
      commit(createSketchState("paragraphs"), "create", [textBox("note", { text: "a\nb", paragraphs: [body] })]),
      "invalid_operation"
    );
    const state = created([textBox("note", { text: "a\nb" })]);
    expectRefusal(commit(state, "paragraphs", [update("note", { paragraphs: [body] })]), "invalid_operation");
    expect(commit(state, "restyle", [update("note", { paragraphs: [title, body] })]).ok).toBe(true);
  });

  it("enforces span ordering, bounds, surrogate pairs and the merge rule", () => {
    const text = "ab😀cd";
    const refused: SketchTextSpan[][] = [
      [{ start: 4, length: 3, bold: true }],
      [{ start: 0, length: 3, bold: true }, { start: 2, length: 2, italic: true }],
      [{ start: 3, length: 1, bold: true }, { start: 0, length: 1, bold: true }],
      [{ start: 0, length: 3, bold: true }],
      [{ start: 3, length: 1, bold: true }],
      [{ start: 0, length: 1, bold: true }, { start: 1, length: 1, bold: true }]
    ];
    for (const [index, spans] of refused.entries()) {
      expectRefusal(
        commit(createSketchState("spans"), `spans-${index}`, [textBox("note", { text, spans })]),
        "invalid_operation"
      );
    }
    const accepted: SketchTextSpan[][] = [
      [{ start: 0, length: 4, bold: true }, { start: 4, length: 2, bold: true, italic: true }],
      [{ start: 0, length: 1, bold: true }, { start: 2, length: 2, bold: true }]
    ];
    for (const [index, spans] of accepted.entries()) {
      expect(commit(createSketchState("spans"), `ok-${index}`, [textBox("note", { text, spans })]).ok).toBe(true);
    }
  });

  it("rejects malformed formatting fields as invalid requests", () => {
    const invalid: Partial<TextBoxCreate>[] = [
      { font: { family: "system", size: 0.0049 } },
      { font: { family: "system", size: 0.2501 } },
      { font: { family: "fantasy", size: 0.02 } } as unknown as Partial<TextBoxCreate>,
      { extrusionDepth: 0.0009 },
      { extrusionDepth: 0.1001 },
      { rendering: "hologram" } as unknown as Partial<TextBoxCreate>,
      { paragraphs: [{ ...body, style: "subtitle" }] } as unknown as Partial<TextBoxCreate>,
      { spans: [{ start: 0, length: 1 }] },
      { spans: [{ start: 0, length: 1, bold: false }] } as unknown as Partial<TextBoxCreate>,
      { spans: [{ start: 0, length: 0, bold: true }] },
      {
        text: "x".repeat(SKETCH_MAX_TEXT_SPANS * 2 + 2),
        spans: Array.from({ length: SKETCH_MAX_TEXT_SPANS + 1 }, (_, index) => ({
          start: index * 2,
          length: 1,
          bold: true as const
        }))
      }
    ];
    for (const [index, overrides] of invalid.entries()) {
      expectRefusal(commit(createSketchState("fields"), `bad-${index}`, [textBox("note", overrides)]), "invalid_request");
    }
  });
});

describe("extruded text", () => {
  const extruded = (objectId: string, length: number) =>
    textBox(objectId, { text: "x".repeat(length), rendering: "extruded" });

  it("caps each extruded box and the document total", () => {
    expect(commit(createSketchState("cap"), "at-cap", [extruded("a", SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS)]).ok).toBe(true);
    expectRefusal(
      commit(createSketchState("cap"), "over-cap", [extruded("a", SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS + 1)]),
      "limit_exceeded",
      "extrudedTextCharacters"
    );
    const full = created([extruded("a", 280), extruded("b", 280), textBox("flat", { text: "x".repeat(900) })]);
    expectRefusal(commit(full, "third", [extruded("c", 1)]), "limit_exceeded", "totalExtrudedTextCharacters");
  });

  it("refuses converting a long flat box to extruded", () => {
    const state = created([textBox("long", { text: "x".repeat(300) })]);
    expectRefusal(
      commit(state, "convert", [update("long", { rendering: "extruded" })]),
      "limit_exceeded",
      "extrudedTextCharacters"
    );
  });

  it("counts half the extrusion depth on each side in world bounds", () => {
    const nearFace = { translation: [0, 0, 4.97] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
    expect(commit(createSketchState("bounds"), "flat", [textBox("note", { transform: nearFace })]).ok).toBe(true);
    expectRefusal(
      commit(createSketchState("bounds"), "deep", [textBox("note", {
        transform: nearFace,
        rendering: "extruded",
        extrusionDepth: 0.08
      })]),
      "out_of_bounds"
    );
  });

  it("undoes and redoes text, formatting and conversion in one step each", () => {
    const state = created([textBox("note", { text: "Plan" })]);
    const edited = commit(state, "edit", [update("note", {
      text: "Plan\nNext",
      paragraphs: [title, body],
      spans: [{ start: 0, length: 4, italic: true }],
      font: { family: "rounded", size: 0.03 },
      rendering: "extruded",
      extrusionDepth: 0.05
    })]);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const after = structuredClone(edited.state.document.objects[0]);

    const undone = undoSketchTransaction(edited.state, { requestId: "undo", baseRevision: 2, actor: human });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.document.objects[0]).toEqual(state.document.objects[0]);

    const redone = redoSketchTransaction(undone.state, { requestId: "redo", baseRevision: 3, actor: human });
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.state.document.objects[0]).toEqual(after);
  });
});

describe("version 2 text boxes", () => {
  // A version-3 state holding only unformatted text boxes, rewritten into
  // the version-2 shape the way an older backend stored it.
  function toVersion2(state: SketchState): Record<string, any> {
    const raw = JSON.parse(serializeSketchState(state));
    raw.schemaVersion = 2;
    raw.document.schemaVersion = 2;
    const strip = (object: Record<string, unknown>) => {
      if (object.kind !== "textBox") return;
      for (const key of ["font", "paragraphs", "spans", "rendering", "extrusionDepth"]) delete object[key];
    };
    for (const object of raw.document.objects) strip(object);
    for (const entry of [...raw.history.undo, ...raw.history.redo]) {
      for (const operation of [...entry.forwardOps, ...entry.inverseOps]) {
        if (operation.op === "update" && operation.kind === "textBox") {
          delete operation.paragraphs;
          delete operation.spans;
        }
        if (operation.op === "restore") for (const object of operation.objects) strip(object);
      }
    }
    return raw;
  }

  it("reads a version-2 document as plain text without changing its bytes", () => {
    const v2 = toVersion2(created([textBox("note", { text: "One\nTwo" })])).document;
    const bytes = JSON.stringify(v2);
    const parsed = parseSketchDocument(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(SKETCH_SCHEMA_VERSION);
    expect(parsed.value.objects[0]).toMatchObject({ paragraphs: [body, body], spans: [], rendering: "flat" });
    expect(JSON.stringify(v2)).toBe(bytes);
  });

  it("refuses a version-2 file that already carries version-3 fields", () => {
    const v2 = toVersion2(created([textBox("note")])).document;
    v2.objects[0].rendering = "flat";
    const parsed = parseSketchDocument(JSON.stringify(v2));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("invalid_document");
  });

  // The version-2 schemas are what a version-2 build accepted. A file this
  // build writes must fail there on its version, and a formatted text box
  // must fail even when the file is relabeled as version 2.
  it("fails the version-2 reader on version-3 documents and states", () => {
    const state = created([textBox("note", { appearance: "none", rendering: "extruded" })]);
    const v3State = JSON.parse(serializeSketchState(state));
    const v3Document = JSON.parse(serializeSketchDocument(state.document));
    for (const parsed of [sketchDocumentV2Schema.safeParse(v3Document), sketchStateV2Schema.safeParse(v3State)]) {
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.join(".") === "schemaVersion")).toBe(true);
    }
    const relabeled = sketchDocumentV2Schema.safeParse({ ...v3Document, schemaVersion: 2 });
    expect(relabeled.success).toBe(false);
    if (!relabeled.success) {
      expect(relabeled.error.issues.every((issue) => issue.path[0] === "objects")).toBe(true);
    }
  });

  it("migrates text edits and deletes in history so undo and redo keep working", () => {
    let state = created([textBox("note", { text: "First" }), textBox("gone", { text: "Bye\nNow" })]);
    const edited = commit(state, "edit", [update("note", { text: "Second\nLine", paragraphs: [body, body], spans: [] })]);
    if (!edited.ok) throw new Error(edited.error.message);
    const deleted = commit(edited.state, "delete", [{ op: "delete", objectId: "gone" }]);
    if (!deleted.ok) throw new Error(deleted.error.message);
    state = deleted.state;

    const parsed = parseSketchState(JSON.stringify(toVersion2(state)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.receipts).toEqual(state.receipts);

    const restored = undoSketchTransaction(parsed.value, { requestId: "undo-delete", baseRevision: 3, actor: human });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.state.document.objects.find((object) => object.id === "gone")).toMatchObject({
      paragraphs: [body, body]
    });
    const reverted = undoSketchTransaction(restored.state, { requestId: "undo-edit", baseRevision: 4, actor: human });
    if (!reverted.ok) throw new Error(reverted.error.message);
    expect(reverted.state.document.objects[0]).toMatchObject({ text: "First", paragraphs: [body] });
    const reapplied = redoSketchTransaction(reverted.state, { requestId: "redo-edit", baseRevision: 5, actor: human });
    expect(reapplied.ok).toBe(true);
    if (reapplied.ok) expect(reapplied.state.document.objects[0]).toMatchObject({ text: "Second\nLine" });
  });

  it("reads a version-1 text box that matches version 2 with plain defaults", () => {
    const parsed = parseSketchDocument(JSON.stringify({
      schemaVersion: 1,
      kind: "sketch",
      sketchId: "legacy",
      revision: 1,
      objects: [{
        id: "legacy-note",
        kind: "textBox",
        text: "Hi",
        size: [0.1, 0.1],
        appearance: "fill",
        fillColor: "#ffffff",
        outlineColor: "#000000",
        outlineWidth: 0.004
      }]
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.objects[0]).toMatchObject({ paragraphs: [body], rendering: "flat" });
  });
});
