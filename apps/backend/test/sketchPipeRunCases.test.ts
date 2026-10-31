import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKETCH_SCHEMA_VERSION, parseSketchDocument, sketchPipeRuns, type SketchPipeFlow, type SketchPipeRun } from "../src/sketch/core";

// Pipe run cases shared with the visionOS suite (`SketchPipeRunCasesTests`),
// which reads the same pieces through the client's copy of the rules. Each
// case's pieces load as a real document first, so they obey gravity.
//
// A run compares by its set of pipes, flow, loop and conflict pairs. A run
// that flows also compares its pipes and ends in flow order, a loop from its
// expected first pipe; any other run compares them as sets.

interface ExpectedRun {
  pipes: string[];
  ends: (string | null)[];
  flow: SketchPipeFlow;
  conflicts: [string, string][];
  loop?: boolean;
}

interface PipeRunCase {
  name: string;
  pieces: Record<string, unknown>[];
  runs: ExpectedRun[];
}

const cases: PipeRunCase[] = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/sketchPipeRunCases.json"), "utf8")
);

function pieces(pipeCase: PipeRunCase) {
  const parsed = parseSketchDocument(JSON.stringify({
    schemaVersion: SKETCH_SCHEMA_VERSION,
    kind: "sketch",
    sketchId: "pipes",
    revision: 0,
    objects: pipeCase.pieces
  }));
  if (!parsed.ok) throw new Error(`${pipeCase.name}: the case's pieces do not load: ${parsed.error.message}`);
  return parsed.value.objects;
}

const sorted = (ids: readonly (string | null)[]) => ids.map((id) => id ?? "(open)").sort();
const pairs = (conflicts: readonly (readonly [string, string])[]) => conflicts.map((pair) => [...pair].sort().join("|")).sort();

/** `ids` turned so it starts at `first`, as a loop reads the same from any pipe. */
function startingAt(ids: string[], first: string): string[] {
  const index = ids.indexOf(first);
  return index < 0 ? ids : [...ids.slice(index), ...ids.slice(0, index)];
}

function compare(name: string, actual: SketchPipeRun, expected: ExpectedRun) {
  expect(actual.flow, `${name}: flow of ${expected.pipes.join(", ")}`).toBe(expected.flow);
  expect(actual.loop, `${name}: loop`).toBe(expected.loop ?? false);
  expect(pairs(actual.conflicts), `${name}: conflicts`).toEqual(pairs(expected.conflicts));
  if (expected.flow === "flows") {
    const order = actual.loop ? startingAt(actual.pipeIds, expected.pipes[0]) : actual.pipeIds;
    expect(order, `${name}: pipes in flow order`).toEqual(expected.pipes);
    expect(actual.ends, `${name}: ends in flow order`).toEqual(expected.ends);
  } else {
    expect(sorted(actual.ends), `${name}: ends`).toEqual(sorted(expected.ends));
  }
}

describe("shared pipe run cases", () => {
  it.each(cases.map((pipeCase) => [pipeCase.name, pipeCase] as const))("%s", (name, pipeCase) => {
    const runs = sketchPipeRuns(pieces(pipeCase));
    expect(runs.map((run) => sorted(run.pipeIds)).sort(), `${name}: runs`)
      .toEqual(pipeCase.runs.map((run) => sorted(run.pipes)).sort());
    for (const expected of pipeCase.runs) {
      const key = sorted(expected.pipes).join("|");
      const actual = runs.find((run) => sorted(run.pipeIds).join("|") === key);
      if (actual === undefined) throw new Error(`${name}: no run of ${key}`);
      compare(name, actual, expected);
    }
  });

  it("names every case uniquely", () => {
    const names = cases.map((pipeCase) => pipeCase.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
