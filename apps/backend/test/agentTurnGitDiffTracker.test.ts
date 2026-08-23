import { describe, expect, it } from "vitest";
import { AgentTurnGitDiffTracker } from "../src/agent/AgentTurnGitDiffTracker";
import type { LocalWorkspaceGitChangedFile, LocalWorkspaceGitStatus } from "../src/domain/models";

const workspaceId = "workspace-test";

function gitStatus(
  files: LocalWorkspaceGitChangedFile[],
  overrides: Partial<LocalWorkspaceGitStatus> = {}
): LocalWorkspaceGitStatus {
  return {
    workspaceId,
    isRepository: true,
    branch: "main",
    clean: files.length === 0,
    counts: {
      total: files.length,
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged && file.status !== "untracked").length,
      untracked: files.filter((file) => file.status === "untracked").length,
      conflicts: 0
    },
    files,
    truncated: false,
    refreshedAt: new Date().toISOString(),
    ...overrides
  };
}

function trackerReturning(statuses: LocalWorkspaceGitStatus[]): AgentTurnGitDiffTracker {
  let reads = 0;
  return new AgentTurnGitDiffTracker({
    async gitStatus() {
      const status = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      if (!status) throw new Error("no status configured");
      return status;
    }
  });
}

describe("agent turn git diff tracker", () => {
  it("reports files that changed since the baseline, with counts for files clean at turn start", async () => {
    const tracker = trackerReturning([
      gitStatus([]),
      gitStatus([
        { path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 4, deletions: 1 },
        { path: "src/new-file.ts", status: "untracked", staged: false, unstaged: true }
      ])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);
    const diff = await tracker.settleTurn("turn-1");

    expect(diff).toEqual({
      files: [
        { path: "src/app.ts", status: "modified", additions: 4, deletions: 1 },
        { path: "src/new-file.ts", status: "added" }
      ],
      truncated: false
    });
  });

  it("skips files whose change signature did not move, including pure staging flips", async () => {
    const unchanged: LocalWorkspaceGitChangedFile = {
      path: "docs/notes.md",
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 2,
      deletions: 2
    };
    const tracker = trackerReturning([
      gitStatus([unchanged]),
      // Same status and counts, now staged: a bare `git add` is not a content change.
      gitStatus([{ ...unchanged, staged: true, unstaged: false }])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toBeUndefined();
  });

  it("reports a further-edited pre-dirty file without counts", async () => {
    const tracker = trackerReturning([
      gitStatus([{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 2, deletions: 0 }]),
      gitStatus([{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 9, deletions: 3 }])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toEqual({
      files: [{ path: "src/app.ts", status: "modified" }],
      truncated: false
    });
  });

  it("matches a turn-renamed pre-dirty file through its old path", async () => {
    const tracker = trackerReturning([
      gitStatus([{ path: "src/old.ts", status: "modified", staged: false, unstaged: true, additions: 1, deletions: 1 }]),
      gitStatus([{
        path: "src/new.ts",
        oldPath: "src/old.ts",
        status: "renamed",
        staged: true,
        unstaged: false,
        additions: 1,
        deletions: 1
      }])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toEqual({
      // oldPath rides along so downstream consumers (the diagram render
      // feedback tracker) can treat the renamed-away source as removed.
      files: [{ path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" }],
      truncated: false
    });
  });

  it("does not report files that disappeared from status during the turn", async () => {
    // A file reverted to HEAD content, or committed by the turn, has no status
    // entry left to attribute; reporting it would need a status the working
    // tree no longer supports.
    const tracker = trackerReturning([
      gitStatus([{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 4, deletions: 1 }]),
      gitStatus([])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toBeUndefined();
  });

  it("does not attribute counts to a file omitted from a truncated baseline", async () => {
    const tracker = trackerReturning([
      gitStatus([], { truncated: true }),
      gitStatus([{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 1, deletions: 0 }])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toEqual({
      files: [{ path: "src/app.ts", status: "modified" }],
      truncated: true
    });
  });

  it("publishes an empty truncated summary when a bounded status read hides every changed file", async () => {
    const tracker = trackerReturning([
      gitStatus([], { truncated: true }),
      gitStatus([], { truncated: true })
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toEqual({
      files: [],
      truncated: true
    });
  });

  it("stores no baseline for a non-repository workspace", async () => {
    const tracker = trackerReturning([
      gitStatus([], { isRepository: false }),
      gitStatus([{ path: "src/app.ts", status: "modified", staged: false, unstaged: true }])
    ]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toBeUndefined();
  });

  it("settles a turn exactly once", async () => {
    const settled = gitStatus([{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 1, deletions: 0 }]);
    const tracker = trackerReturning([gitStatus([]), settled, settled]);
    await tracker.beginTurn("turn-1", workspaceId);

    expect(await tracker.settleTurn("turn-1")).toBeDefined();
    expect(await tracker.settleTurn("turn-1")).toBeUndefined();
  });

  it("returns nothing for a released or never-begun turn", async () => {
    const tracker = trackerReturning([gitStatus([])]);
    await tracker.beginTurn("turn-1", workspaceId);
    tracker.releaseTurn("turn-1");

    expect(await tracker.settleTurn("turn-1")).toBeUndefined();
    expect(await tracker.settleTurn("turn-never-begun")).toBeUndefined();
  });

  it("swallows status read failures on both sides", async () => {
    const failing = new AgentTurnGitDiffTracker({
      async gitStatus(): Promise<LocalWorkspaceGitStatus> {
        throw new Error("git unavailable");
      }
    });
    await failing.beginTurn("turn-1", workspaceId);
    expect(await failing.settleTurn("turn-1")).toBeUndefined();

    let reads = 0;
    const failingAtSettle = new AgentTurnGitDiffTracker({
      async gitStatus() {
        reads += 1;
        if (reads > 1) throw new Error("git unavailable");
        return gitStatus([]);
      }
    });
    await failingAtSettle.beginTurn("turn-2", workspaceId);
    expect(await failingAtSettle.settleTurn("turn-2")).toBeUndefined();
  });
});
