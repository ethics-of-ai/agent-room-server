import { CHILD_THREAD_LIMITS, type ChildThreadSummary } from "../domain/childThreads";
import type { AgentSession, AgentSessionTurn, LocalWorkspace } from "../domain/models";
import { redactSecrets } from "../util/redactSecrets";
import type { GitChangedEntry, GitDiffSinceCommit, LocalWorkspaceGit } from "../workspace/LocalWorkspaceGit";

export interface ChildThreadSummaryInput {
  session: AgentSession;
  /** The child's registered workspace; undefined when its record is gone. */
  workspace: LocalWorkspace | undefined;
  latestTurn: AgentSessionTurn | undefined;
  waitingOn: ChildThreadSummary["waitingOn"];
  continuable: boolean;
  /** The parent checkout's current commit, which `commitsAhead` counts from. */
  parentHead: string | undefined;
}

interface WorktreeState {
  missing: boolean;
  commitsAhead: number;
  uncommitted: boolean;
  untrackedCount: number;
  diff: ChildThreadSummary["diff"];
}

const emptyDiff = { files: 0, insertions: 0, deletions: 0 };
const missingWorktree: WorktreeState = { missing: true, commitsAhead: 0, uncommitted: false, untrackedCount: 0, diff: emptyDiff };

/**
 * One child as its parent sees it. The Git reads run at the worktree root,
 * not at a registered subdirectory, because a Land carries the whole branch.
 * The diff is counts only: `diffSinceCommit` returns raw paths that have not
 * passed the secret/generated filter, so none leave here.
 */
export async function buildChildThreadSummary(git: LocalWorkspaceGit, input: ChildThreadSummaryInput): Promise<ChildThreadSummary> {
  const { session, workspace, latestTurn } = input;
  const worktree = workspace?.worktree;
  const state = worktree ? await readWorktreeState(git, worktree.worktreePath, worktree.baseCommit, input.parentHead) : missingWorktree;
  const lastMessage = latestTurn ? boundedMessage(latestTurn.lastMessage ?? latestTurn.error) : undefined;
  return {
    sessionId: session.id,
    title: session.title ?? "",
    runnerKind: session.runnerKind,
    status: session.status,
    ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
    ...(session.closedAt ? { closedAt: session.closedAt } : {}),
    workspaceId: session.workspaceId,
    // A record that lost its worktree block still names the branch the
    // session last ran on.
    branch: worktree?.branch ?? session.gitBranch ?? "",
    baseCommit: worktree?.baseCommit ?? "",
    ...state,
    continuable: input.continuable && !session.closedAt,
    ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}),
    ...(latestTurn
      ? { lastTurn: { turnId: latestTurn.id, status: latestTurn.status, ...(lastMessage ? { lastMessage } : {}) } }
      : {}),
    updatedAt: session.updatedAt
  };
}

/**
 * What a worktree changed since its base: tracked changes, working tree
 * included, and the raw status entries, untracked files among them. Undefined
 * when the folder is no longer a repository. A failed read leaves its part
 * empty. Paths here are raw, so a caller that shows any filters them first.
 */
export async function readWorktreeChanges(
  git: LocalWorkspaceGit,
  worktreePath: string,
  baseCommit: string
): Promise<{ entries: GitChangedEntry[]; diff: GitDiffSinceCommit | undefined } | undefined> {
  if (!(await git.isRepository(worktreePath))) return undefined;
  const [entries, diff] = await Promise.all([
    git.changedEntries(worktreePath).catch(() => []),
    git.diffSinceCommit(worktreePath, baseCommit).catch(() => undefined)
  ]);
  return { entries, diff };
}

/** A failed read reports what it could not see as zero; Land and Update check again before they act. */
async function readWorktreeState(
  git: LocalWorkspaceGit,
  worktreePath: string,
  baseCommit: string,
  parentHead: string | undefined
): Promise<WorktreeState> {
  const [changes, commitsAhead] = await Promise.all([
    readWorktreeChanges(git, worktreePath, baseCommit),
    git.commitsSince(worktreePath, parentHead ?? baseCommit).catch(() => 0)
  ]);
  if (!changes) return missingWorktree;
  const { entries, diff } = changes;
  return {
    missing: false,
    commitsAhead,
    uncommitted: entries.length > 0,
    untrackedCount: entries.filter((entry) => entry.indexStatus === "?").length,
    diff: diff ? { files: diff.fileCount, insertions: diff.insertions, deletions: diff.deletions } : emptyDiff
  };
}

/** A child's last message or error as a parent may see it: secret-redacted and capped. */
export function boundedMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return redactSecrets(message).slice(0, CHILD_THREAD_LIMITS.lastMessage);
}
