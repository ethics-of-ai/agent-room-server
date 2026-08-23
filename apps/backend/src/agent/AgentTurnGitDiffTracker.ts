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
  files: Map<string, LocalWorkspaceGitChangedFile>;
  truncated: boolean;
}

/**
 * Derives a per-turn file change summary from workspace Git status for runners
 * that report no turn diff of their own (the Claude Agent SDK stream has no
 * analog of Codex `turn/diff/updated`). The tracker snapshots the fixed
 * read-only Git status before the runner starts and diffs it against a second
 * read at settlement; the delta becomes the turn's `coding_diff_updated`.
 *
 * The comparison is working-tree state against HEAD at two moments, which sets
 * its honest limits: work the turn commits or reverts to HEAD content leaves no
 * status entry to report, and any concurrent change to the workspace (a human
 * editor write, another session's turn) is attributed to this turn — the same
 * concurrency caveat the bounded file write already documents. Both reads go
 * through the registry's fixed Git invocations; a read failure only means the
 * turn settles without a diff, never that the turn fails.
 */
export class AgentTurnGitDiffTracker {
  private readonly baselines = new Map<string, TurnGitBaseline>();

  constructor(
    private readonly deps: {
      gitStatus(workspaceId: string): Promise<LocalWorkspaceGitStatus>;
    }
  ) {}

  async beginTurn(turnId: string, workspaceId: string): Promise<void> {
    try {
      const status = await this.deps.gitStatus(workspaceId);
      if (!status.isRepository) return;
      this.baselines.set(turnId, {
        workspaceId,
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
      const truncated = baseline.truncated || status.truncated;
      const files = status.files.flatMap((file) => {
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
