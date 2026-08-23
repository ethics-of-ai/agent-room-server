import { describe, expect, it } from "vitest";
import {
  ArtifactStreamParser,
  stripArtifactRegions,
  type ArtifactStreamOp,
  type ArtifactStreamResult
} from "../src/artifact/ArtifactStreamParser";

function run(deltas: string[], options: { idPrefix?: string; flush?: boolean } = {}): {
  prose: string;
  ops: ArtifactStreamOp[];
} {
  const parser = new ArtifactStreamParser(options.idPrefix ?? "turn");
  let prose = "";
  const ops: ArtifactStreamOp[] = [];
  const collect = (result: ArtifactStreamResult) => {
    prose += result.prose;
    ops.push(...result.ops);
  };
  for (const delta of deltas) collect(parser.push(delta));
  if (options.flush !== false) collect(parser.flush());
  return { prose, ops };
}

describe("ArtifactStreamParser", () => {
  it("passes ordinary prose through untouched", () => {
    const { prose, ops } = run(["Hello ", "world. ", "No artifacts here."]);
    expect(prose).toBe("Hello world. No artifacts here.");
    expect(ops).toEqual([]);
  });

  it("splits a complete artifact out of surrounding prose", () => {
    const { prose, ops } = run([
      'Here is a sketch:\n<artifact id="flow" kind="svg" title="Flow"><svg/></artifact> done.'
    ]);
    expect(prose).toBe("Here is a sketch:\n done.");
    expect(ops).toEqual([
      { type: "start", artifactId: "flow", kind: "svg", title: "Flow" },
      { type: "delta", artifactId: "flow", delta: "<svg/>" },
      { type: "complete", artifactId: "flow" }
    ]);
  });

  it("reassembles an open tag and close marker split across deltas", () => {
    const { prose, ops } = run(["before\n<arti", 'fact kind="svg">body', "more</artif", "act>after"]);
    expect(prose).toBe("before\nafter");
    expect(ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "body" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "more" },
      { type: "complete", artifactId: "turn:artifact-1" }
    ]);
  });

  it("does not read an id out of a different attribute (anchored attribute match)", () => {
    const { ops } = run(['<artifact kind="svg" uuid="zzz">a</artifact>']);
    // `id` must not match the tail of `uuid="zzz"`; the artifact gets an auto id.
    expect(ops[0]).toEqual({ type: "start", artifactId: "turn:artifact-1", kind: "svg" });
  });

  it("does not read kind out of a hyphenated attribute name", () => {
    // `data-kind="html"` must not satisfy the supported-kind check; the real
    // `kind="svg"` does, so this is a valid svg artifact.
    const { prose, ops } = run(['<artifact data-kind="html" kind="svg">a</artifact>']);
    expect(prose).toBe("");
    expect(ops[0]).toMatchObject({ type: "start", kind: "svg" });
  });

  it("ignores a > inside a quoted attribute value when finding the tag end", () => {
    const { prose, ops } = run(['x\n<artifact kind="svg" title="a>b">body</artifact> y']);
    expect(prose).toBe("x\n y");
    expect(ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg", title: "a>b" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "body" },
      { type: "complete", artifactId: "turn:artifact-1" }
    ]);
  });

  it("waits for a closing quote before treating an embedded > as the tag end", () => {
    // The `>` inside the unterminated title must not close the tag mid-stream.
    const { prose, ops } = run(['<artifact kind="svg" title="a>', 'b">body</artifact>']);
    expect(prose).toBe("");
    expect(ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg", title: "a>b" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "body" },
      { type: "complete", artifactId: "turn:artifact-1" }
    ]);
  });

  it("handles two artifacts in one stream with auto-incrementing ids", () => {
    const { ops } = run([
      '<artifact kind="svg">a</artifact>\n<artifact kind="mermaid">b</artifact>'
    ]);
    expect(ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "a" },
      { type: "complete", artifactId: "turn:artifact-1" },
      { type: "start", artifactId: "turn:artifact-2", kind: "mermaid" },
      { type: "delta", artifactId: "turn:artifact-2", delta: "b" },
      { type: "complete", artifactId: "turn:artifact-2" }
    ]);
  });

  it("flushes a dangling unclosed artifact at turn end", () => {
    const { prose, ops } = run(['intro\n<artifact kind="svg">partial body never closed']);
    expect(prose).toBe("intro\n");
    expect(ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "partial body never closed" },
      { type: "complete", artifactId: "turn:artifact-1" }
    ]);
  });

  it("releases a held open-marker prefix as prose when it never completes", () => {
    const { prose, ops } = run(["text ending with <arti"]);
    expect(prose).toBe("text ending with <arti");
    expect(ops).toEqual([]);
  });

  it("treats a plural <artifacts> tag as prose, not an artifact", () => {
    const { prose, ops } = run(["see <artifacts> below"]);
    expect(prose).toBe("see <artifacts> below");
    expect(ops).toEqual([]);
  });

  it("treats a kind-less or unsupported-kind tag as prose", () => {
    const missing = run(["<artifact id=\"x\">body</artifact>"]);
    expect(missing.ops).toEqual([]);
    expect(missing.prose).toBe("<artifact id=\"x\">body</artifact>");

    const unsupported = run(['<artifact kind="html">body</artifact>']);
    expect(unsupported.ops).toEqual([]);
    expect(unsupported.prose).toBe('<artifact kind="html">body</artifact>');
  });

  it("honors a model-supplied id and single-quoted attributes", () => {
    const { ops } = run(["<artifact kind='mermaid' id='diagram' title='My Diagram'>graph TD;A-->B</artifact>"]);
    expect(ops[0]).toEqual({ type: "start", artifactId: "diagram", kind: "mermaid", title: "My Diagram" });
  });

  it("leaves an inline (non-line-start) artifact tag as prose", () => {
    // The model is quoting the syntax mid-sentence, not rendering: keep it verbatim
    // instead of swallowing the surrounding text.
    const { prose, ops } = run(['Use `<artifact kind="svg">x</artifact>` to draw.']);
    expect(prose).toBe('Use `<artifact kind="svg">x</artifact>` to draw.');
    expect(ops).toEqual([]);
  });

  it("recognizes an indented line-start artifact tag", () => {
    const { ops } = run(['intro\n   <artifact kind="svg">x</artifact> done']);
    expect(ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "x" },
      { type: "complete", artifactId: "turn:artifact-1" }
    ]);
  });

  it("tolerates whitespace and case in the close marker", () => {
    const spaced = run(['<artifact kind="svg">CONTENT</artifact > trailing prose']);
    expect(spaced.prose).toBe(" trailing prose");
    expect(spaced.ops).toEqual([
      { type: "start", artifactId: "turn:artifact-1", kind: "svg" },
      { type: "delta", artifactId: "turn:artifact-1", delta: "CONTENT" },
      { type: "complete", artifactId: "turn:artifact-1" }
    ]);

    const cased = run(['<artifact kind="svg">CONTENT</Artifact> trailing']);
    expect(cased.prose).toBe(" trailing");
    expect(cased.ops.at(-1)).toEqual({ type: "complete", artifactId: "turn:artifact-1" });
  });

  it("drops a self-closing artifact tag without swallowing following prose", () => {
    const { prose, ops } = run(['<artifact kind="svg"/> Final summary here.']);
    expect(prose).toBe(" Final summary here.");
    expect(ops).toEqual([]);
  });

  it("does not let SVG content with < and </svg> prematurely close the artifact", () => {
    const svg = '<svg width="10"><rect/><g></g></svg>';
    const { ops } = run([`<artifact kind="svg">${svg}</artifact>`]);
    const body = ops.filter((op) => op.type === "delta").map((op) => (op as { delta: string }).delta).join("");
    expect(body).toBe(svg);
    expect(ops.at(-1)).toEqual({ type: "complete", artifactId: "turn:artifact-1" });
  });

  it("streams SVG content one character at a time without loss", () => {
    const svg = "<svg><path d='M0 0L1 1'/></svg>";
    const full = `prefix\n<artifact kind="svg">${svg}</artifact> suffix`;
    const { prose, ops } = run(full.split(""));
    expect(prose).toBe("prefix\n suffix");
    const body = ops.filter((op) => op.type === "delta").map((op) => (op as { delta: string }).delta).join("");
    expect(body).toBe(svg);
    expect(ops[0]).toMatchObject({ type: "start", kind: "svg" });
    expect(ops.at(-1)).toMatchObject({ type: "complete" });
  });
});

describe("stripArtifactRegions", () => {
  it("removes well-formed artifact spans and keeps prose", () => {
    expect(stripArtifactRegions('a\n<artifact kind="svg"><svg/></artifact> b')).toBe("a\n b");
  });

  it("keeps an inline (non-line-start) artifact tag verbatim", () => {
    const text = 'see `<artifact kind="svg"><svg/></artifact>` here';
    expect(stripArtifactRegions(text)).toBe(text);
  });

  it("keeps a plural or unsupported-kind tag", () => {
    expect(stripArtifactRegions("see <artifacts> ok")).toBe("see <artifacts> ok");
    expect(stripArtifactRegions('<artifact kind="html">x</artifact>')).toBe('<artifact kind="html">x</artifact>');
  });

  it("drops an unclosed artifact region through end of text", () => {
    expect(stripArtifactRegions('keep\n<artifact kind="svg">unclosed forever')).toBe("keep\n");
  });

  it("returns identical text when there is no artifact", () => {
    const text = "nothing to strip here";
    expect(stripArtifactRegions(text)).toBe(text);
  });
});
