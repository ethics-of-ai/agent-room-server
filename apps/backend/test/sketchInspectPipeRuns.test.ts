import { describe, expect, it } from "vitest";
import { SKETCH_TOOL_RESULT_BYTES, formatSketchInspection } from "../src/sketch/agent/sketchInspect";
import { SKETCH_SCHEMA_VERSION, parseSketchDocument } from "../src/sketch/core";

// Inspect lists pipe runs after the objects, one JSON line each, so an agent
// reads flow without working it out from cells and rotations.

function inspect(objects: Record<string, unknown>[], table?: { cellSize: number; cells: number }): string {
  const parsed = parseSketchDocument(JSON.stringify({
    schemaVersion: SKETCH_SCHEMA_VERSION, kind: "sketch", sketchId: "pipes", revision: 3, table, objects
  }));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return formatSketchInspection({ path: "docs/sketches/pipes.sketch.json", title: "Pipes", sketchId: "pipes", revision: 3, document: parsed.value });
}

const piece = (id: string, catalogId: string, cell: [number, number], rotation = 0, level = 0) =>
  ({ id, kind: "piece", catalogId, cell, level, rotation });

describe("inspect's pipe runs", () => {
  it("lists a flowing run in flow order with what its ends meet", () => {
    const text = inspect([
      piece("tank", "block.cube", [3, 2]),
      piece("b", "block.pipe", [2, 2], 1),
      piece("a", "block.pipe", [1, 2], 1)
    ]);
    const lines = text.split("\n");
    const heading = lines.findIndex((line) => line.startsWith("Pipe runs, one JSON line each"));
    expect(heading).toBeGreaterThan(lines.indexOf("Objects, one JSON line each:"));
    expect(lines[heading + 1]).toBe('{"pipes":["a","b"],"ends":[null,"tank"],"flow":"flows"}');
  });

  it("names the pipes that point against each other", () => {
    const text = inspect([piece("a", "block.pipe", [2, 3], 1), piece("b", "block.pipe", [3, 3], 3)]);
    expect(text).toContain('{"pipes":["a","b"],"ends":[null,null],"flow":"conflict","conflicts":[["a","b"]]}');
  });

  it("marks a loop instead of listing ends", () => {
    const text = inspect([
      piece("a", "block.pipe-angle", [0, 0], 0),
      piece("b", "block.pipe-angle", [1, 0], 1),
      piece("c", "block.pipe-angle", [1, 1], 2),
      piece("d", "block.pipe-angle", [0, 1], 3)
    ]);
    expect(text).toContain('{"pipes":["a","b","c","d"],"loop":true,"flow":"none"}');
  });

  it("counts the runs it leaves out to stay within the result limit", () => {
    // A checkerboard of quarter turns keeps every pipe off its neighbours, so
    // 1,024 pipes make 1,024 runs, more lines than one result holds.
    const pipes = Array.from({ length: 1024 }, (_, index) => {
      const cell: [number, number] = [index % 32, Math.floor(index / 32)];
      return piece(`pipe-${cell[0]}-${cell[1]}`, "block.pipe", cell, (cell[0] + cell[1]) % 2);
    });
    const text = inspect(pipes, { cellSize: 0.02, cells: 40 });

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(SKETCH_TOOL_RESULT_BYTES);
    const kept = text.split("\n").filter((line) => line.startsWith('{"pipes":')).length;
    expect(kept).toBeGreaterThan(0);
    expect(text).toContain(`(${1024 - kept} more pipe run(s) left out to stay within the result limit.)`);
    expect(text).toContain("(1024 more object(s) left out to stay within the result limit.)");
  });

  it("prints no section for a sketch without pipes", () => {
    const text = inspect([piece("k", "block.cube", [0, 0])]);
    expect(text).not.toContain("Pipe runs");
  });
});
