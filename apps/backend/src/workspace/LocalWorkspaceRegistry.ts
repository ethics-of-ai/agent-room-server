import { homedir } from "node:os";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sha256Hex } from "../util/hash";
import type {
  LocalWorkspace,
  LocalWorkspaceGitStatus,
  LocalWorkspaceKind,
  LocalWorkspaceRegistrySnapshot,
  ServiceConfig
} from "../domain/models";
import { localWorkspaceRegistrySnapshotSchema } from "../domain/schemas";
import {
  defaultGitBlobExecutor,
  defaultGitExecutor,
  gitErrorMessage,
  LocalWorkspaceGit,
  type GitBlobExecutor,
  type GitCommandExecutor,
  type GitCommittedChanges,
  type GitFileAtHeadResult,
  type GitListFilesResult
} from "./LocalWorkspaceGit";
import { GitSnapshotCache } from "./git/snapshotCache";

export class LocalWorkspaceRegistryError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface RegisterLocalWorkspaceInput {
  path: string;
  name?: string;
  kind?: LocalWorkspaceKind;
}

export interface RegisterLocalWorkspaceResult {
  workspace: LocalWorkspace;
  created: boolean;
}

export interface UnregisterLocalWorkspaceResult {
  workspace: LocalWorkspace;
}

export interface CheckoutLocalWorkspaceBranchResult {
  workspace: LocalWorkspace;
  previousBranch?: string;
  branch: string;
  changed: boolean;
}

const defaultGitSnapshotTtlMs = 3000;
const defaultGitNetworkTimeoutMs = 120_000;

export class LocalWorkspaceRegistry {
  private readonly registryPath: string;
  /**
   * The fixed-argv git seam. Exposed (not private) so `WorkspaceGitService` runs
   * its operations through the *same* executor, timeouts, and non-interactive
   * environment as the reads here — one place where a git command can be formed.
   */
  readonly git: LocalWorkspaceGit;
  private registryCache?: LocalWorkspace[];
  /** The tail of the write queue; see `commit`. */
  private writes: Promise<unknown> = Promise.resolve();
  private readonly gitSnapshots: GitSnapshotCache;

  constructor(
    private readonly config: ServiceConfig,
    options: {
      runGit?: GitCommandExecutor;
      runGitBlob?: GitBlobExecutor;
      runGitNetwork?: GitCommandExecutor;
      gitSnapshotTtlMs?: number;
    } = {}
  ) {
    this.registryPath = join(config.stateDir, "workspaces.json");
    this.git = new LocalWorkspaceGit(
      options.runGit ?? defaultGitExecutor(config.gitCommandTimeoutMs),
      options.runGitBlob ?? defaultGitBlobExecutor(config.gitCommandTimeoutMs),
      // Remote operations get their own, longer timeout so a slow fetch is not
      // mistaken for a hung local command.
      options.runGitNetwork
        ?? options.runGit
        ?? defaultGitExecutor(config.gitNetworkTimeoutMs ?? defaultGitNetworkTimeoutMs)
    );
    this.gitSnapshots = new GitSnapshotCache(
      (workspacePath) => this.git.snapshot(workspacePath),
      options.gitSnapshotTtlMs ?? defaultGitSnapshotTtlMs
    );
  }

  async list(): Promise<LocalWorkspaceRegistrySnapshot> {
    const snapshot = await this.load();
    return this.refreshGitSnapshots(snapshot);
  }

  async findById(workspaceId: string): Promise<LocalWorkspace | undefined> {
    const snapshot = await this.load();
    const index = snapshot.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index < 0) return undefined;
    const refreshed = await this.refreshWorkspaceGitSnapshot(snapshot.workspaces[index]);
    if (!sameWorkspace(refreshed, snapshot.workspaces[index])) {
      await this.replaceWorkspace(refreshed);
    }
    return refreshed;
  }

  // Registry lookup without touching git. Callers that only need id -> path
  // resolution (tree/preview/write bounding, terminal cwd, harness project
  // resolution, turn start) must not pay the five-subprocess git snapshot;
  // the returned `git` block may be stale.
  async findByIdWithoutGitRefresh(workspaceId: string): Promise<LocalWorkspace | undefined> {
    const snapshot = await this.load();
    return snapshot.workspaces.find((workspace) => workspace.id === workspaceId);
  }

  /** Every registered workspace, without touching git; each `git` block may be stale. */
  async listWithoutGitRefresh(): Promise<LocalWorkspace[]> {
    return (await this.load()).workspaces;
  }

  async gitStatus(workspaceId: string): Promise<LocalWorkspaceGitStatus> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.status(workspace.id, workspace.path);
  }

  // The reads below let a turn settle against the repository as the agent left
  // it: the branch it ended on, what it committed since turn start, and which
  // registered workspaces share its checkout.
  async gitCurrentBranch(workspaceId: string): Promise<string | undefined> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.currentBranch(workspace.path);
  }

  async gitHeadCommit(workspaceId: string): Promise<string | undefined> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.headCommit(workspace.path);
  }

  async gitCommittedChanges(workspaceId: string, fromCommit: string | undefined, toCommit: string): Promise<GitCommittedChanges> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.committedChanges(workspace.path, fromCommit, toCommit);
  }

  async gitCheckoutDir(workspaceId: string): Promise<string | undefined> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.checkoutGitDir(workspace.path);
  }

  // Fixed read-only `git cat-file` lookup of a file's HEAD blob. The relative path
  // must already be lexically bounded by the caller (WorkspaceExplorer).
  async gitFileAtHead(workspaceId: string, relPath: string, maxBytes: number): Promise<GitFileAtHeadResult> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.fileAtHead(workspace.path, relPath, maxBytes);
  }

  // Fixed read-only `git ls-files` enumeration backing the bounded workspace file
  // index. Pass-through only: the returned paths are raw git output and must be
  // filtered by the caller (WorkspaceExplorer) before they reach a client.
  async gitListFiles(workspaceId: string, maxPaths: number): Promise<GitListFilesResult> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.listFiles(workspace.path, maxPaths);
  }

  /**
   * Re-reads a registered workspace's git snapshot, bypassing the short-lived
   * snapshot cache, and persists it. Every mutating git operation ends here, so
   * the workspace a client gets back reflects the state after its own command
   * rather than a snapshot cached up to `gitSnapshotTtlMs` before it ran.
   */
  async refreshWorkspaceGit(workspaceId: string): Promise<LocalWorkspace> {
    const snapshot = await this.load();
    const existingIndex = snapshot.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (existingIndex < 0) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }
    const refreshed = await this.refreshWorkspaceGitSnapshot(snapshot.workspaces[existingIndex], { fresh: true });
    if (!(await this.replaceWorkspace(refreshed))) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }
    return refreshed;
  }

  async register(input: RegisterLocalWorkspaceInput): Promise<RegisterLocalWorkspaceResult> {
    const workspacePath = await this.resolveExistingDirectory(input.path);
    const now = new Date().toISOString();
    const id = localWorkspaceId(workspacePath);
    const git = await this.gitSnapshots.refresh(workspacePath);
    let result!: RegisterLocalWorkspaceResult;
    // Built from the registry as it stands once the git read is done, so a
    // change made meanwhile is kept.
    await this.commit((workspaces) => {
      const existingIndex = workspaces.findIndex((workspace) => workspace.id === id);
      const existing = existingIndex >= 0 ? workspaces[existingIndex] : undefined;
      const workspace: LocalWorkspace = {
        id,
        name: displayName(input.name, workspacePath, existing?.name),
        path: workspacePath,
        kind: input.kind ?? existing?.kind ?? "user_selected",
        trustedAt: existing?.trustedAt ?? now,
        lastOpenedAt: now,
        git
      };
      if (existingIndex >= 0) {
        workspaces[existingIndex] = workspace;
      } else {
        workspaces.push(workspace);
        workspaces.sort((left, right) => left.name.localeCompare(right.name));
      }
      result = { workspace, created: existingIndex < 0 };
      return true;
    });
    return result;
  }

  async checkoutBranch(workspaceId: string, branch: string): Promise<CheckoutLocalWorkspaceBranchResult> {
    const requestedBranch = branch.trim();
    if (!requestedBranch) {
      throw new LocalWorkspaceRegistryError("Git branch is required");
    }

    const snapshot = await this.load();
    const existingIndex = snapshot.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (existingIndex < 0) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }

    // Fast path for a switch to the branch the checkout is already on: one fresh
    // `git branch --show-current` replaces the full five-command snapshot and
    // its whole-worktree status scan.
    const registered = snapshot.workspaces[existingIndex];
    const currentBranch = await this.git.currentBranch(registered.path);
    if (currentBranch && currentBranch === requestedBranch) {
      const workspace: LocalWorkspace = {
        ...registered,
        git: {
          ...registered.git,
          isRepository: true,
          branch: currentBranch,
          ...(registered.git.branches
            ? { branches: registered.git.branches.map((candidate) => ({ ...candidate, current: candidate.name === currentBranch })) }
            : {})
        }
      };
      return {
        workspace,
        previousBranch: currentBranch,
        branch: requestedBranch,
        changed: false
      };
    }

    const workspace = await this.refreshWorkspaceGitSnapshot(snapshot.workspaces[existingIndex], { fresh: true });
    if (!workspace.git.isRepository) {
      throw new LocalWorkspaceRegistryError("Workspace is not a Git repository", 400);
    }

    try {
      await this.git.validateBranchName(workspace.path, requestedBranch);
    } catch {
      throw new LocalWorkspaceRegistryError("Invalid Git branch name");
    }
    const branches = workspace.git.branches ?? [];
    if (!branches.some((candidate) => candidate.name === requestedBranch)) {
      throw new LocalWorkspaceRegistryError("Git branch was not found", 404);
    }

    const previousBranch = workspace.git.branch;
    if (previousBranch === requestedBranch) {
      await this.replaceWorkspace(workspace);
      return {
        workspace,
        ...(previousBranch ? { previousBranch } : {}),
        branch: requestedBranch,
        changed: false
      };
    }

    if (workspace.git.hasUncommittedChanges) {
      await this.replaceWorkspace(workspace);
      throw new LocalWorkspaceRegistryError("Workspace has uncommitted changes; commit or stash them before switching branches", 409);
    }

    try {
      await this.git.switchBranch(workspace.path, requestedBranch);
    } catch (error) {
      throw new LocalWorkspaceRegistryError(gitErrorMessage(error, "Git branch switch failed"), 409);
    }

    const updated = await this.refreshWorkspaceGitSnapshot(workspace, { fresh: true });
    await this.replaceWorkspace(updated);
    return {
      workspace: updated,
      ...(previousBranch ? { previousBranch } : {}),
      branch: requestedBranch,
      changed: true
    };
  }

  async unregister(workspaceId: string): Promise<UnregisterLocalWorkspaceResult> {
    let removed: LocalWorkspace | undefined;
    await this.commit((workspaces) => {
      const existingIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId);
      if (existingIndex < 0) return false;
      [removed] = workspaces.splice(existingIndex, 1);
      return true;
    });
    if (!removed) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }
    return { workspace: removed };
  }

  /**
   * Applies `change` to the registry as it is now and persists it when `change`
   * returns true. Changes run one at a time, and none awaits git, so a writer
   * that read the registry before a slow git command can't save over a
   * workspace registered or removed while it waited.
   */
  private async commit(change: (workspaces: LocalWorkspace[]) => boolean): Promise<void> {
    const run = this.writes.then(async () => {
      const snapshot = await this.load();
      if (change(snapshot.workspaces)) await this.save(snapshot);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Stores a refreshed workspace if it is still registered; returns whether it was. */
  private async replaceWorkspace(updated: LocalWorkspace): Promise<boolean> {
    let replaced = false;
    await this.commit((workspaces) => {
      const index = workspaces.findIndex((workspace) => workspace.id === updated.id);
      if (index < 0) return false;
      workspaces[index] = updated;
      replaced = true;
      return true;
    });
    return replaced;
  }

  private async load(): Promise<LocalWorkspaceRegistrySnapshot> {
    if (this.registryCache) {
      return {
        defaultWorkspaceRoot: this.config.workspaceRoot,
        workspaces: [...this.registryCache]
      };
    }
    try {
      const parsed = localWorkspaceRegistrySnapshotSchema.parse(JSON.parse(await readFile(this.registryPath, "utf8")));
      this.registryCache = parsed.workspaces;
    } catch {
      this.registryCache = [];
    }
    return {
      defaultWorkspaceRoot: this.config.workspaceRoot,
      workspaces: [...this.registryCache]
    };
  }

  private async save(snapshot: LocalWorkspaceRegistrySnapshot): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    const tmp = `${this.registryPath}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2));
    await rename(tmp, this.registryPath);
    this.registryCache = [...snapshot.workspaces];
  }

  private async refreshGitSnapshots(snapshot: LocalWorkspaceRegistrySnapshot): Promise<LocalWorkspaceRegistrySnapshot> {
    const workspaces = await Promise.all(
      snapshot.workspaces.map((workspace) => this.refreshWorkspaceGitSnapshot(workspace))
    );
    const changed = workspaces.filter((workspace, index) => !sameWorkspace(workspace, snapshot.workspaces[index]));
    if (changed.length > 0) {
      const byId = new Map(changed.map((workspace) => [workspace.id, workspace]));
      await this.commit((current) => {
        let replaced = false;
        current.forEach((workspace, index) => {
          const refreshed = byId.get(workspace.id);
          if (!refreshed) return;
          current[index] = refreshed;
          replaced = true;
        });
        return replaced;
      });
    }
    return {
      defaultWorkspaceRoot: this.config.workspaceRoot,
      workspaces
    };
  }

  private async refreshWorkspaceGitSnapshot(
    workspace: LocalWorkspace,
    options: { fresh?: boolean } = {}
  ): Promise<LocalWorkspace> {
    return {
      ...workspace,
      // A post-mutation refresh bypasses the TTL because it must observe the
      // state after its own git command.
      git: options.fresh ? await this.gitSnapshots.refresh(workspace.path) : await this.gitSnapshots.get(workspace.path)
    };
  }

  /** The one lookup that refuses an unregistered id, shared by the git reads. */
  private async requireWorkspace(workspaceId: string): Promise<LocalWorkspace> {
    const workspace = await this.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }
    return workspace;
  }

  private async resolveExistingDirectory(inputPath: string): Promise<string> {
    const expanded = expandHome(inputPath.trim());
    if (!isAbsolute(expanded)) {
      throw new LocalWorkspaceRegistryError("Workspace path must be absolute");
    }

    try {
      const directoryStat = await stat(expanded);
      if (!directoryStat.isDirectory()) {
        throw new LocalWorkspaceRegistryError("Workspace path must be an existing directory");
      }
      return await realpath(expanded);
    } catch (error) {
      if (error instanceof LocalWorkspaceRegistryError) throw error;
      throw new LocalWorkspaceRegistryError("Workspace path must be an existing directory");
    }
  }
}

function displayName(inputName: string | undefined, workspacePath: string, fallback: string | undefined): string {
  const trimmed = inputName?.trim();
  if (trimmed) return trimmed;
  if (fallback) return fallback;
  return basename(workspacePath) || "Workspace";
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return resolve(homedir(), inputPath.slice(2));
  return inputPath;
}

function localWorkspaceId(workspacePath: string): string {
  const digest = sha256Hex(workspacePath).slice(0, 12);
  return `workspace-${digest}`;
}

function sameWorkspace(left: LocalWorkspace, right: LocalWorkspace): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
