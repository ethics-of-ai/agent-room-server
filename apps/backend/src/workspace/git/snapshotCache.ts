import type { LocalWorkspaceGitSnapshot } from "../../domain/models";

/**
 * Short-TTL per-path cache for the multi-subprocess workspace snapshot, with
 * single-flight reads so concurrent misses for one workspace share a batch
 * instead of racing duplicate git invocations. A mutating operation refreshes
 * past the TTL: the state a client gets back has to describe the tree after its
 * own command, not up to `ttlMs` before it.
 */
export class GitSnapshotCache {
  private readonly cache = new Map<string, { snapshot: LocalWorkspaceGitSnapshot; atMs: number }>();
  private readonly inFlight = new Map<string, Promise<LocalWorkspaceGitSnapshot>>();

  constructor(
    private readonly read: (workspacePath: string) => Promise<LocalWorkspaceGitSnapshot>,
    private readonly ttlMs: number
  ) {}

  async get(workspacePath: string): Promise<LocalWorkspaceGitSnapshot> {
    const cached = this.cache.get(workspacePath);
    if (cached && Date.now() - cached.atMs < this.ttlMs) {
      return cached.snapshot;
    }
    const inFlight = this.inFlight.get(workspacePath);
    if (inFlight) return inFlight;
    const pending = this.refresh(workspacePath).finally(() => {
      this.inFlight.delete(workspacePath);
    });
    this.inFlight.set(workspacePath, pending);
    return pending;
  }

  /** Reads past the cache and stores the result as the new entry. */
  async refresh(workspacePath: string): Promise<LocalWorkspaceGitSnapshot> {
    const snapshot = await this.read(workspacePath);
    this.cache.set(workspacePath, { snapshot, atMs: Date.now() });
    return snapshot;
  }
}
