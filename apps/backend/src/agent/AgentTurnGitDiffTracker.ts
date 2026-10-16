import type { LocalWorkspaceGitChangedFile, LocalWorkspaceGitStatus } from "../domain/models";

export interface AgentTurnGitDiffFile {
  path: string;
  /** The pre-rename path for a renamed file, matching the Git status entry. */
  oldPath?: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface AgentTurnGitDiff {
  files: AgentTurnGitDiffFile[];
  truncated: boolean;
}

interface TurnGitBaseline {
  workspaceId: string;
  /**
   * The commit HEAD named at turn start, so settlement can see what the turn
   * committed. Absent on an unborn branch: the range then starts at the empty tree.
   */
  head?: string;
  files: Map<string, LocalWorkspaceGitChangedFile>;
  truncated: boolean;
}

interface CommittedChanges {
  files: LocalWorkspaceGitChangedFile[];
  truncated: boolean;
}

const noCommittedChanges: CommittedChanges = { files: [], truncated: false };

/**
 * Derives a per-turn file change summary from workspace Git status for runners
 * that report no turn diff of their own (the Claude Agent SDK stream has no
 * analog of Codex `turn/diff/updated`). The tracker snapshots the fixed
 * read-only Git status before the runner starts and diffs it against a second
 * read at settlement; the delta becomes the turn's `coding_diff_updated`.
 *
 * The comparison is working-tree state against HEAD at two moments. Work the
 * turn commits leaves no status entry, so the tracker also records HEAD at turn
 * start and, when HEAD moved, adds what the commits from there (or from the
 * empty tree, for a turn that started on an unborn branch) changed. That
 * range also covers a branch switch: it is the tree difference between the
 * two commits, whatever the turn did to get there. The honest limits that
 * remain: work reverted to HEAD content has nothing to report, and any
 * concurrent change to the workspace (a human editor write, another session's
 * turn) is attributed to this turn — the same concurrency caveat the bounded
 * file write already documents. Every read goes through the registry's fixed
 * Git invocations; a read failure only means the turn settles without a diff,
 * or with an incomplete one, never that the turn fails.
 */
export class AgentTurnGitDiffTracker {
  private readonly baselines = new Map<string, TurnGitBaseline>();

  constructor(
    private readonly deps: {
      gitStatus(workspaceId: string): Promise<LocalWorkspaceGitStatus>;
      gitHeadCommit(workspaceId: string): Promise<string | undefined>;
      gitCommittedChanges(workspaceId: string, fromCommit: string | undefined, toCommit: string): Promise<CommittedChanges>;
    }
  ) {}

  async beginTurn(turnId: string, workspaceId: string): Promise<void> {
    try {
      const status = await this.deps.gitStatus(workspaceId);
      if (!status.isRepository) return;
      const head = await this.deps.gitHeadCommit(workspaceId);
      this.baselines.set(turnId, {
        workspaceId,
        ...(head ? { head } : {}),
        files: new Map(status.files.map((file) => [file.path, file])),
        truncated: status.truncated
      });
    } catch {
      // No baseline stored; the turn settles without a diff.
    }
  }

  /**
   * Consumes the turn's baseline (idempotent: a second settle, or a settle
   * racing a release, finds none and returns undefined) and returns the files
   * whose status changed since it. A capped status read may return an empty,
   * truncated list to report that the delta is incomplete; undefined means
   * there is no baseline or a complete read found no change.
   */
  async settleTurn(turnId: string): Promise<AgentTurnGitDiff | undefined> {
    const baseline = this.baselines.get(turnId);
    this.baselines.delete(turnId);
    if (!baseline) return undefined;
    try {
      const status = await this.deps.gitStatus(baseline.workspaceId);
      if (!status.isRepository) return undefined;
      const working = status.files.flatMap((file) => {
        const before = baseline.files.get(file.path) ??
          (file.oldPath ? baseline.files.get(file.oldPath) : undefined);
        // A truncated baseline may have omitted a file that was already dirty,
        // so it cannot prove the final file was clean at turn start. Preserve
        // the file signal but never attribute its vs-HEAD line counts.
        if (!before) return [diffFile(file, { withCounts: !baseline.truncated })];
        if (sameChange(before, file)) return [];
        // Already dirty at turn start: this file's vs-HEAD counts include
        // pre-turn edits, so report the file without counts rather than
        // attribute lines the turn did not write.
        return [diffFile(file, { withCounts: false })];
      });
      const committed = await this.committedSince(baseline);
      const truncated = baseline.truncated || status.truncated || committed.truncated;
      const files = withCommittedFiles(committed.files, working, baseline);
      // An empty list is conclusive only when both bounded status reads were
      // complete. Otherwise publish a truncated, file-less summary so clients
      // do not mistake the omitted portion for a clean turn.
      if (files.length === 0 && !truncated) return undefined;
      return { files, truncated };
    } catch {
      return undefined;
    }
  }

  releaseTurn(turnId: string): void {
    this.baselines.delete(turnId);
  }

  // A failed read cannot prove the range empty, so it marks the summary
  // incomplete rather than dropping the turn's commits silently.
  private async committedSince(baseline: TurnGitBaseline): Promise<CommittedChanges> {
    try {
      const head = await this.deps.gitHeadCommit(baseline.workspaceId);
      if (!head || head === baseline.head) return noCommittedChanges;
      return await this.deps.gitCommittedChanges(baseline.workspaceId, baseline.head, head);
    } catch {
      return { files: [], truncated: true };
    }
  }
}

/**
 * Puts the committed files first, in range order, then the working-tree delta
 * for every other path. Range counts are kept only for a file that was clean at
 * turn start and has no further uncommitted edit; otherwise they would count
 * lines the turn did not write, or miss lines it did.
 */
function withCommittedFiles(
  committed: LocalWorkspaceGitChangedFile[],
  working: AgentTurnGitDiffFile[],
  baseline: TurnGitBaseline
): AgentTurnGitDiffFile[] {
  if (committed.length === 0) return working;
  const workingByPath = new Map(working.map((file) => [file.path, file]));
  const merged = committed.map((file) => {
    const uncommitted = workingByPath.get(file.path);
    workingByPath.delete(file.path);
    // A file the turn committed and then deleted is gone; say so.
    if (uncommitted?.status === "deleted") return uncommitted;
    const withCounts = !uncommitted && !baseline.truncated && !baseline.files.has(file.path);
    return diffFile(file, { withCounts });
  });
  return [...merged, ...workingByPath.values()];
}

function sameChange(before: LocalWorkspaceGitChangedFile, after: LocalWorkspaceGitChangedFile): boolean {
  // Staged/unstaged flags are deliberately ignored: a bare `git add` moves
  // counts between the two numstat reads but their per-file sum — and the
  // content — is unchanged.
  return before.status === after.status &&
    before.additions === after.additions &&
    before.deletions === after.deletions;
}

function diffFile(file: LocalWorkspaceGitChangedFile, options: { withCounts: boolean }): AgentTurnGitDiffFile {
  return {
    path: file.path,
    ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    // A file the turn created is "untracked" to status but "added" to a diff
    // reader; keep the event's vocabulary aligned with the runner-reported one.
    status: file.status === "untracked" ? "added" : file.status,
    ...(options.withCounts && file.additions !== undefined ? { additions: file.additions } : {}),
    ...(options.withCounts && file.deletions !== undefined ? { deletions: file.deletions } : {})
  };
}
