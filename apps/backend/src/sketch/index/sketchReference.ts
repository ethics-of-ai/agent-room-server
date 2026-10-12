import type { SketchIndexEntry } from "./SketchIndexStore";

/**
 * How a sketch named by a person or an agent is found: an exact path or
 * sketch id first, then a fixed title ladder. Exact title, then
 * case-insensitive title, then case-insensitive prefix; the first rung with
 * one match wins, and a rung with several is ambiguous.
 */

export type SketchResolution =
  | { kind: "found"; entry: SketchIndexEntry }
  | { kind: "ambiguous"; paths: string[] }
  | { kind: "unknown"; suggestions: string[] };

/** The file name without `.sketch.json`, with `-` and `_` shown as spaces. The directory is not part of it. */
export function sketchTitleFromPath(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.sketch\.json$/, "").replace(/[-_]+/g, " ").trim() || name;
}

export function matchSketchReference(entries: readonly SketchIndexEntry[], reference: string): SketchResolution {
  const wanted = reference.trim().replace(/^\.\//, "");
  const byPath = entries.find((entry) => entry.path === wanted);
  if (byPath) return { kind: "found", entry: byPath };
  const rungs: Array<(entry: SketchIndexEntry) => boolean> = [
    (entry) => entry.sketchId === wanted,
    (entry) => entry.title === wanted,
    (entry) => entry.title.toLowerCase() === wanted.toLowerCase(),
    (entry) => wanted.length > 0 && entry.title.toLowerCase().startsWith(wanted.toLowerCase())
  ];
  for (const rung of rungs) {
    const matches = entries.filter(rung);
    if (matches.length === 1) return { kind: "found", entry: matches[0]! };
    if (matches.length > 1) return { kind: "ambiguous", paths: matches.map((entry) => entry.path) };
  }
  return { kind: "unknown", suggestions: closestTitles(entries, wanted) };
}

/** Up to five titles nearest the reference, for an `unknown_sketch` answer. */
function closestTitles(entries: readonly SketchIndexEntry[], reference: string): string[] {
  const wanted = reference.toLowerCase();
  return entries
    .map((entry) => ({ title: entry.title, distance: entry.title.toLowerCase().includes(wanted) ? 0 : editDistance(entry.title.toLowerCase(), wanted) }))
    .filter((candidate) => candidate.distance <= Math.max(3, Math.floor(wanted.length / 2)))
    .sort((left, right) => left.distance - right.distance || left.title.localeCompare(right.title))
    .slice(0, 5)
    .map((candidate) => candidate.title);
}

function editDistance(left: string, right: string): number {
  if (left.length > 200 || right.length > 200) return Number.MAX_SAFE_INTEGER;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}
