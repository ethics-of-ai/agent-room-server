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
      snapshot.workspaces[index] = refreshed;
      await this.save(snapshot);
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

  async gitStatus(workspaceId: string): Promise<LocalWorkspaceGitStatus> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.git.status(workspace.id, workspace.path);
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
    snapshot.workspaces[existingIndex] = refreshed;
    await this.save(snapshot);
    return refreshed;
  }

  async register(input: RegisterLocalWorkspaceInput): Promise<RegisterLocalWorkspaceResult> {
    const workspacePath = await this.resolveExistingDirectory(input.path);
    const now = new Date().toISOString();
    const snapshot = await this.load();
    const existingIndex = snapshot.workspaces.findIndex((workspace) => workspace.id === localWorkspaceId(workspacePath));
    const existing = existingIndex >= 0 ? snapshot.workspaces[existingIndex] : undefined;
    const workspace: LocalWorkspace = {
      id: existing?.id ?? localWorkspaceId(workspacePath),
      name: displayName(input.name, workspacePath, existing?.name),
      path: workspacePath,
      kind: input.kind ?? existing?.kind ?? "user_selected",
      trustedAt: existing?.trustedAt ?? now,
      lastOpenedAt: now,
      git: await this.gitSnapshots.refresh(workspacePath)
    };

    if (existingIndex >= 0) {
      snapshot.workspaces[existingIndex] = workspace;
    } else {
      snapshot.workspaces.push(workspace);
      snapshot.workspaces.sort((left, right) => left.name.localeCompare(right.name));
    }
    await this.save(snapshot);
    return { workspace, created: existingIndex < 0 };
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

    // Fast path for the per-turn session-branch restore: when the working tree is
    // already on the requested branch, one fresh `git branch --show-current`
    // replaces the full five-command snapshot and its whole-worktree status scan.
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
      snapshot.workspaces[existingIndex] = workspace;
      await this.save(snapshot);
      return {
        workspace,
        ...(previousBranch ? { previousBranch } : {}),
        branch: requestedBranch,
        changed: false
      };
    }

    if (workspace.git.hasUncommittedChanges) {
      snapshot.workspaces[existingIndex] = workspace;
      await this.save(snapshot);
      throw new LocalWorkspaceRegistryError("Workspace has uncommitted changes; commit or stash them before switching branches", 409);
    }

    try {
      await this.git.switchBranch(workspace.path, requestedBranch);
    } catch (error) {
      throw new LocalWorkspaceRegistryError(gitErrorMessage(error, "Git branch switch failed"), 409);
    }

    const updated = await this.refreshWorkspaceGitSnapshot(workspace, { fresh: true });
    snapshot.workspaces[existingIndex] = updated;
    await this.save(snapshot);
    return {
      workspace: updated,
      ...(previousBranch ? { previousBranch } : {}),
      branch: requestedBranch,
      changed: true
    };
  }

  async unregister(workspaceId: string): Promise<UnregisterLocalWorkspaceResult> {
    const snapshot = await this.load();
    const existingIndex = snapshot.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (existingIndex < 0) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }

    const [workspace] = snapshot.workspaces.splice(existingIndex, 1);
    await this.save(snapshot);
    return { workspace };
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
    const changed = workspaces.some((workspace, index) => !sameWorkspace(workspace, snapshot.workspaces[index]));
    const refreshedSnapshot = {
      defaultWorkspaceRoot: this.config.workspaceRoot,
      workspaces
    };
    if (changed) {
      await this.save(refreshedSnapshot);
    }
    return refreshedSnapshot;
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
