import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKETCH_PIECE_CATALOG } from "../src/sketch/core";
import { SKETCH_PIECE_EDGES } from "../src/sketch/core/pieceCatalog";
import { SKETCH_MAX_PIECE_TEXT_CHARACTERS, SKETCH_PIECE_MAX_LEVELS } from "../src/sketch/core/limits";

// The shared Swift contract mirrors the backend's piece catalog. Clients use
// it to predict where a piece lands, so the two must agree field for field.
const swiftContracts = resolve(__dirname, "../../shared/AgentRoomClient/Sources/AgentRoomClient/Contracts/Sketch");
const swiftPath = resolve(swiftContracts, "SketchPieceCatalogEntry.swift");
const swiftEdgePath = resolve(swiftContracts, "SketchPieceEdge.swift");
const entryLine =
  /SketchPieceCatalogEntry\(id: "([^"]+)", title: "([^"]+)", footprint: \[(\d+), (\d+)\], levels: (\d+), height: ([\d.]+), stacksOnTop: (true|false), carriesText: (true|false), ends: \[([^\]]*)\], setsFlow: (true|false)\)/;

function swiftCatalog() {
  const source = readFileSync(swiftPath, "utf8");
  const block = source.slice(source.indexOf("public static let catalog"), source.indexOf("public static let unknown"));
  return block.split("\n").flatMap((line) => {
    const match = entryLine.exec(line);
    if (match === null) return [];
    const [, id, title, columns, rows, levels, height, stacksOnTop, carriesText, ends, setsFlow] = match;
    return [{
      id,
      title,
      footprint: [Number(columns), Number(rows)],
      levels: Number(levels),
      height: Number(height),
      stacksOnTop: stacksOnTop === "true",
      carriesText: carriesText === "true",
      ends: ends === "" ? [] : ends.split(", ").map((edge) => edge.replace(/^\./, "")),
      setsFlow: setsFlow === "true"
    }];
  });
}

describe("piece catalog parity", () => {
  it("matches the shared Swift catalog entry for entry", () => {
    const swift = swiftCatalog();
    expect(swift).toHaveLength(SKETCH_PIECE_CATALOG.length);
    expect(swift).toEqual(SKETCH_PIECE_CATALOG.map((entry) => ({ ...entry, footprint: [...entry.footprint], ends: [...entry.ends] })));
  });

  it("names the same limits", () => {
    const source = readFileSync(swiftPath, "utf8");
    expect(source).toContain(`public static let maximumColumnLevels = ${SKETCH_PIECE_MAX_LEVELS}`);
    expect(source).toContain(`public static let maximumTextCharacters = ${SKETCH_MAX_PIECE_TEXT_CHARACTERS}`);
  });

  it("names the same edges in the same clockwise order", () => {
    const source = readFileSync(swiftEdgePath, "utf8");
    expect(source).toContain(`case ${SKETCH_PIECE_EDGES.join(", ")}`);
  });
});
