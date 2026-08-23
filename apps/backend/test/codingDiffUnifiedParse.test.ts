import { describe, expect, it } from "vitest";
import { codingEventFromRunnerActivity } from "../src/protocol/coding/events";
import { mapCodexNotification } from "../src/runner/codex/notificationMapper";
import type { AgentRunnerActivity } from "../src/runner/AgentRunner";

/// codex-cli 0.142.5's `turn/diff/updated` carries only a single unified-diff
/// string under `diff` (no structured `files` array), so the Codex adapter
/// parses the per-file summaries out of it before handing the canonical mapper
/// a `CanonicalDiffFile[]`. These drive the real notification, so they cover
/// the adapter's parse and the mapper's bounding together; the structured-array
/// path is also covered by the end-to-end mapping test.
function diffEvent(params: Record<string, unknown>) {
  const events = mapCodexNotification({ jsonrpc: "2.0", method: "turn/diff/updated", params });
  const activity = (events[0] as { activity: AgentRunnerActivity } | undefined)?.activity;
  if (!activity) throw new Error("expected turn/diff/updated to map to one activity");
  return codingEventFromRunnerActivity({
    sessionId: "agent-session-1",
    turnId: "agent-turn-1",
    runnerKind: "codex",
    activity
  });
}

describe("coding_diff_updated unified-diff parsing", () => {
  it("prefers a structured files array when present", () => {
    const event = diffEvent({
      files: [{ path: "src/app.ts", status: "modified", additions: 3, deletions: 1 }]
    });
    expect(event?.payload).toMatchObject({
      type: "coding_diff_updated",
      files: [{ path: "src/app.ts", status: "modified", additions: 3, deletions: 1 }]
    });
  });

  it("parses file paths, status, and line counts from a unified diff string", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " const keep = 1;",
      "-const before = 2;",
      "+const after = 2;",
      "+const added = 3;",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,1 @@",
      "+export const created = true;",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-export const removed = true;"
    ].join("\n");

    const event = diffEvent({ summary: "3 files changed", diff });
    const files = (event?.payload as { files: Array<{ path: string; status: string; additions?: number; deletions?: number }> }).files;

    expect(files).toEqual([
      { path: "src/app.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "new.ts", status: "added", additions: 1, deletions: 0 },
      { path: "gone.ts", status: "deleted", additions: 0, deletions: 1 }
    ]);
  });

  it("keeps parsed paths repo-relative (git prefixes stripped)", () => {
    const diff = [
      "diff --git a/apps/backend/src/x.ts b/apps/backend/src/x.ts",
      "--- a/apps/backend/src/x.ts",
      "+++ b/apps/backend/src/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b"
    ].join("\n");
    const event = diffEvent({ diff });
    const files = (event?.payload as { files: Array<{ path: string }> }).files;
    expect(files[0].path).toBe("apps/backend/src/x.ts");
  });

  it("does not apply the 1,000-character display-text clamp to unified diffs", () => {
    const additions = Array.from({ length: 80 }, (_, index) => `+line-${index}-${"x".repeat(12)}`);
    const diff = [
      "diff --git a/first.ts b/first.ts",
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -0,0 +1,80 @@",
      ...additions,
      "diff --git a/second.ts b/second.ts",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    expect(diff.length).toBeGreaterThan(1_000);

    const event = diffEvent({ diff });
    expect((event?.payload as { files: unknown[] }).files).toEqual([
      { path: "first.ts", status: "modified", additions: 80, deletions: 0 },
      { path: "second.ts", status: "modified", additions: 1, deletions: 1 }
    ]);
  });

  it("decodes Git-quoted paths with spaces and escaped UTF-8 bytes", () => {
    const diff = [
      'diff --git "a/path with space.ts" "b/path with space.ts"',
      '--- "a/path with space.ts"',
      '+++ "b/path with space.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");

    const event = diffEvent({ diff });
    expect((event?.payload as { files: unknown[] }).files).toEqual([
      { path: "path with space.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "café.ts", status: "modified", additions: 1, deletions: 1 }
    ]);
  });

  it("keeps unquoted paths with spaces for sections without ---/+++ headers", () => {
    // Git quotes paths only for special characters, not for spaces, and binary
    // and mode-only sections emit no correcting `---`/`+++` headers — so the
    // `diff --git a/P b/P` line is the only path source for them.
    const diff = [
      "diff --git a/assets/my image.png b/assets/my image.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/my image.png and b/assets/my image.png differ",
      "diff --git a/scripts/run me.sh b/scripts/run me.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/docs/a b/tricky b/docs/a b/tricky",
      "index 3333333..4444444 100644",
      "Binary files differ"
    ].join("\n");

    const event = diffEvent({ diff });
    expect((event?.payload as { files: unknown[] }).files).toEqual([
      { path: "assets/my image.png", status: "modified", additions: 0, deletions: 0 },
      { path: "scripts/run me.sh", status: "modified", additions: 0, deletions: 0 },
      { path: "docs/a b/tricky", status: "modified", additions: 0, deletions: 0 }
    ]);
  });

  it("resolves a spaced rename through its rename-to header", () => {
    // A rename's `diff --git` sides differ, so the same-path recovery cannot
    // apply; the `rename to` header supplies the destination path instead.
    const diff = [
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 100%",
      "rename from old name.ts",
      "rename to new name.ts"
    ].join("\n");

    const event = diffEvent({ diff });
    expect((event?.payload as { files: unknown[] }).files).toEqual([
      { path: "new name.ts", oldPath: "old name.ts", status: "renamed", additions: 0, deletions: 0 }
    ]);
  });

  it("counts hunk content whose source text begins with repeated diff markers", () => {
    const diff = [
      "diff --git a/operators.ts b/operators.ts",
      "--- a/operators.ts",
      "+++ b/operators.ts",
      "@@ -1 +1 @@",
      "--- oldValue",
      "+++ newValue"
    ].join("\n");

    const event = diffEvent({ diff });
    expect((event?.payload as { files: unknown[] }).files).toEqual([
      { path: "operators.ts", status: "modified", additions: 1, deletions: 1 }
    ]);
  });

  it("marks a parsed unified diff truncated when more than 100 files are present", () => {
    const diff = Array.from({ length: 101 }, (_, index) => [
      `diff --git a/file-${index}.ts b/file-${index}.ts`,
      `--- a/file-${index}.ts`,
      `+++ b/file-${index}.ts`,
      "@@ -0,0 +1 @@",
      `+export const value${index} = true;`
    ].join("\n")).join("\n");

    const event = diffEvent({ diff });
    expect((event?.payload as { files: unknown[] }).files).toHaveLength(100);
    expect((event?.payload as { truncated?: boolean }).truncated).toBe(true);
  });

  it("marks a unified diff truncated when the parser input exceeds its size bound", () => {
    const diff = [
      "diff --git a/large.txt b/large.txt",
      "--- a/large.txt",
      "+++ b/large.txt",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(1024 * 1024)}`
    ].join("\n");

    const event = diffEvent({ diff });
    expect((event?.payload as { truncated?: boolean }).truncated).toBe(true);
  });

  it("marks a structured summary truncated when more than 100 files are present", () => {
    const files = Array.from({ length: 101 }, (_, index) => ({
      path: `file-${index}.ts`,
      status: "modified"
    }));

    const event = diffEvent({ files });
    expect((event?.payload as { files: unknown[] }).files).toHaveLength(100);
    expect((event?.payload as { truncated?: boolean }).truncated).toBe(true);
  });

  it("yields no files when neither a structured array nor a diff string is present", () => {
    const event = diffEvent({ summary: "nothing" });
    expect((event?.payload as { files: unknown[] }).files).toEqual([]);
  });
});
