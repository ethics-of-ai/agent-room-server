import { z } from "zod";

/**
 * What a `managed_worktree` workspace records about the linked worktree it
 * lives in. The backend mints every value; no client supplies one. The
 * durable schema stays lenient on purpose: a stricter check that failed on a
 * stored record would drop the whole registry on load, so the Git service
 * checks the shapes below before it runs anything.
 */
export const localWorkspaceWorktreeSchema = z.object({
  /** The registered workspace whose checkout the worktree was added from. */
  parentWorkspaceId: z.string().min(1),
  /** The worktree root, which differs from the workspace path when the parent is a registered subdirectory. */
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  /** The full id of the parent's HEAD commit when the worktree was added. */
  baseCommit: z.string().min(1)
});

export type LocalWorkspaceWorktree = z.infer<typeof localWorkspaceWorktreeSchema>;

/** A minted child branch: `agentroom/<slug>-<hex>`. */
export const managedWorktreeBranchPattern = /^agentroom\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6,16}$/;
/** A minted worktree folder name: `<slug>-<hex>`, the branch without its prefix. */
export const managedWorktreeNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6,16}$/;

/** Bounds every child thread works within. Rule 11 sets the two caps. */
export const CHILD_THREAD_LIMITS = {
  /** Open children one parent may have. */
  openPerParent: 4,
  /** Open children across the backend. */
  openTotal: 8,
  /** A child's title, in characters. */
  title: 120,
  /** A child's task, in UTF-8 bytes. */
  taskBytes: 16 * 1024,
  /** The last message a summary carries, in characters. */
  lastMessage: 2_000,
  /** Reports one parent wake carries. */
  reportsPerWake: 16
} as const;

/**
 * The parent a child session belongs to. `operationId` is the start tool's id
 * when the parent agent created the child, used to replay that call.
 */
export const agentSessionParentSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  operationId: z.string().min(1).max(200).optional()
});

export type AgentSessionParent = z.infer<typeof agentSessionParentSchema>;

// Both child trigger kinds carry an empty `tasks`. The Swift `AgentTurnTrigger`
// decodes `tasks` as non-optional, so a client already in the field would
// otherwise fail to decode every turn of such a session.
const noBackgroundTasks = z.tuple([]);

/** A child turn the parent started, by its agent or by a person's New child. */
export const parentTaskTriggerSchema = z.object({
  kind: z.literal("parent_task"),
  parentSessionId: z.string().min(1),
  tasks: noBackgroundTasks
});

/** A parent turn that reports children whose turns settled. */
export const childReportTriggerSchema = z.object({
  kind: z.literal("child_report"),
  reports: z.array(z.object({
    childSessionId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.enum(["succeeded", "failed", "cancelled"])
  })).min(1).max(CHILD_THREAD_LIMITS.reportsPerWake),
  tasks: noBackgroundTasks
});

/**
 * What opened a turn whose first message the backend wrote with role `system`:
 * a child's first task, a later message from its parent, or a parent wake that
 * carries child reports. Clients label the row by it, never by its text.
 */
export const agentSessionMessageOriginSchema = z.enum(["parent_task", "parent_message", "child_report"]);

export type AgentSessionMessageOrigin = z.infer<typeof agentSessionMessageOriginSchema>;

/** Whose idea a child was: a person's New child, an accepted offer, or a person's plain request. */
export type ChildThreadInitiation = "button" | "offer" | "person_asked";

export type ChildThreadChange = "created" | "landed" | "updated" | "closed";

/**
 * The child tools' logical ids (`children/agent/childToolContract.ts`). A
 * parent whose thread registered all of them can see its children; a thread
 * started before they existed, or on a runner without the `children`
 * capability, reports `parentToolsAvailable: false`.
 */
export const CHILD_TOOL_IDS = ["children.start", "children.list", "children.read", "children.message", "children.stop"] as const;

/**
 * What a parent sees of one child: bounded, with no path list and no file
 * content. Git fields describe the whole worktree from `baseCommit`, which is
 * what a Land would carry.
 */
export interface ChildThreadSummary {
  sessionId: string;
  title: string;
  runnerKind: string;
  status: "idle" | "running" | "failed" | "cancelled";
  activeTurnId?: string;
  closedAt?: string;
  workspaceId: string;
  branch: string;
  baseCommit: string;
  /**
   * Commits on the child's branch that the parent checkout's current commit
   * does not have, so 0 once a Land carried them. Counted from `baseCommit`
   * when the parent's commit cannot be read.
   */
  commitsAhead: number;
  /** Tracked changes or untracked files in the worktree. */
  uncommitted: boolean;
  untrackedCount: number;
  /** The worktree folder is gone, or the child's workspace record is. Close still works. */
  missing: boolean;
  /** Whether the child can take another turn. */
  continuable: boolean;
  /** Tracked changes from `baseCommit`, working tree included: a file count and line totals. */
  diff: { files: number; insertions: number; deletions: number };
  waitingOn?: "permission" | "question";
  lastTurn?: { turnId: string; status: "running" | "succeeded" | "failed" | "cancelled"; lastMessage?: string };
  updatedAt: string;
}

const maxSlugLength = 32;

/**
 * A child's worktree folder name, `<slug>-<hex>`, from its title. The branch is
 * the same name under `agentroom/`. A title with no usable characters gets the
 * slug `child`.
 */
export function childWorktreeName(title: string, hex: string): string {
  const slug = title
    .normalize("NFKD")
    // Drop the combining marks NFKD splits off, so `é` slugs as `e`.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxSlugLength)
    .replace(/^-+|-+$/g, "");
  const name = `${slug || "child"}-${hex}`;
  if (!managedWorktreeNamePattern.test(name)) throw new Error("Minted child worktree name does not match its pattern");
  return name;
}
