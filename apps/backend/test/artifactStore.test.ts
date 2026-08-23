import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifact/ArtifactStore";

const at = "2026-06-14T00:00:00.000Z";

describe("ArtifactStore", () => {
  it("accumulates deltas per artifact and exposes a per-session snapshot", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", title: "Flow", at });
    store.append({ sessionId: "s1", artifactId: "a1", delta: "<svg>", at });
    store.append({ sessionId: "s1", artifactId: "a1", delta: "</svg>", at });
    store.complete({ sessionId: "s1", artifactId: "a1", at });

    const [artifact] = store.snapshot("s1");
    expect(artifact).toMatchObject({
      id: "a1",
      sessionId: "s1",
      turnId: "t1",
      kind: "svg",
      title: "Flow",
      content: "<svg></svg>",
      isOpen: false,
      truncated: false
    });
    expect(artifact.version).toBe(2);
  });

  it("ignores appends after completion", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", at });
    store.complete({ sessionId: "s1", artifactId: "a1", at });
    const result = store.append({ sessionId: "s1", artifactId: "a1", delta: "late", at });
    expect(result).toBeUndefined();
    expect(store.snapshot("s1")[0].content).toBe("");
  });

  it("isolates artifacts per session", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", at });
    store.start({ sessionId: "s2", turnId: "t2", artifactId: "a1", kind: "mermaid", at });
    expect(store.snapshot("s1")).toHaveLength(1);
    expect(store.snapshot("s2")[0].kind).toBe("mermaid");
  });

  it("caps total content length and marks it truncated", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", at });
    const result = store.append({ sessionId: "s1", artifactId: "a1", delta: "x".repeat(100_000), at });
    const [artifact] = store.snapshot("s1");
    expect(artifact.truncated).toBe(true);
    // ASCII: 64*1024 bytes == 64*1024 chars; append reports exactly what it kept.
    expect(artifact.content.length).toBe(64 * 1024);
    expect(result).toEqual({ appended: "x".repeat(64 * 1024), truncated: true });
  });

  it("trims the byte cap on a code-point boundary without splitting a multibyte char", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", at });
    // 4-byte astral emoji repeated past the byte cap; the cap is not a multiple of
    // 4, so a naive code-unit slice would split a surrogate pair.
    const result = store.append({ sessionId: "s1", artifactId: "a1", delta: "😀".repeat(20_000), at });
    const [artifact] = store.snapshot("s1");
    expect(artifact.truncated).toBe(true);
    // No replacement characters: content is whole emoji only.
    expect(artifact.content).toBe(result?.appended);
    expect(artifact.content.endsWith("😀")).toBe(true);
    expect(artifact.content).not.toContain("�");
    expect(Buffer.byteLength(artifact.content, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(artifact.content, "utf8")).toBeGreaterThan(64 * 1024 - 4);
  });

  it("reports the final byte length and truncation state on complete", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", at });
    store.append({ sessionId: "s1", artifactId: "a1", delta: "<svg/>", at });
    expect(store.complete({ sessionId: "s1", artifactId: "a1", at })).toEqual({
      byteLength: 6,
      truncated: false
    });
  });

  it("enforces a per-session artifact count cap", () => {
    const store = new ArtifactStore();
    for (let i = 0; i < 32; i += 1) {
      expect(store.start({ sessionId: "s1", turnId: "t1", artifactId: `a${i}`, kind: "svg", at })).toBeDefined();
    }
    expect(store.start({ sessionId: "s1", turnId: "t1", artifactId: "a32", kind: "svg", at })).toBeUndefined();
    expect(store.snapshot("s1")).toHaveLength(32);
  });

  it("releases all artifacts for a session", () => {
    const store = new ArtifactStore();
    store.start({ sessionId: "s1", turnId: "t1", artifactId: "a1", kind: "svg", at });
    store.releaseSession("s1");
    expect(store.snapshot("s1")).toEqual([]);
  });
});
