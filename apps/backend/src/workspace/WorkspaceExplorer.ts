import { link, lstat, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { boundedRelativeSegments, isInside } from "../util/pathBounding";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type {
  AgentRunnerKind,
  WorkspaceFileIndexEntry,
  WorkspaceFileIndexSnapshot,
  WorkspaceFilePreview,
  WorkspaceGitFileBaseline,
  WorkspaceSearchFileMatches,
  WorkspaceSearchMatch,
  WorkspaceSearchSnapshot,
  WorkspaceSkill,
  WorkspaceTreeEntry,
  WorkspaceTreeSnapshot
} from "../domain/models";
import { runnerDescriptor } from "../runner/registry";
import type { LocalWorkspaceRegistry } from "./LocalWorkspaceRegistry";

const ignoredNames = new Set([
  ".DS_Store",
  ".agentroom",
  ".git",
  ".next",
  ".turbo",
  "DerivedData",
  "build",
  "dist",
  "node_modules"
]);
const secretNames = new Set([".env", ".env.local", ".env.production", ".npmrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const secretExtensions = [".key", ".pem", ".p12", ".pfx"];
const maxDepth = 4;
const maxEntriesPerDirectory = 120;
const maxPreviewBytes = 24 * 1024;
// The write cap is also the read-back cap, so a successfully written file always
// echoes in full rather than through the smaller browse-preview truncation. The
// route enforces this same cap on incoming bytes (UTF-8), keeping the invariant.
export const maxWriteBytes = 256 * 1024;
const contextTreeDepth = 2;

// --- Bounded workspace file index and content search -------------------------
// One enumeration backs both the quick-open/`@`-mention file list and the
// "search in all files" route, cached per workspace for a short TTL so a client
// typing into either surface does not re-enumerate (or re-fork git) per
// keystroke. Every path that leaves the index passes exactly the tree read's
// filters: lexical bounding, secret names, generated directories, and symlink
// containment.
const maxIndexPaths = 20_000;
const fileIndexTtlMs = 15_000;
const maxIndexWalkDepth = 12;
/** Upper bound on `limit` for the file-index route. */
export const maxFileIndexResults = 200;
const defaultFileIndexResults = 50;
/** Upper bound on `limit` (total matches) for the content-search route. */
export const maxSearchMatches = 500;
const maxSearchFilesScanned = 2000;
const maxSearchMatchesPerFile = 20;
const searchBudgetMs = 3000;
// Per-file read cap for search; the same 256 KB ceiling the read/write path uses.
const maxSearchFileBytes = maxWriteBytes;
const maxSearchPreviewChars = 200;
const maxIncludePatternChars = 200;
const wordCharacterPattern = /[\p{L}\p{N}_]/u;

interface WorkspaceFileIndex {
  paths: string[];
  truncated: boolean;
  source: "git" | "walk";
}

// The fixed committed skill directories a runner kind natively loads, and the
// token a composer inserts to invoke one, are registry descriptor fields
// (`runner/registry.ts`) rather than per-kind records here — this listing is
// discovery metadata for composer autocompletion, never a loading mechanism of
// its own, so it must describe whatever the runner itself would load.
const maxSkills = 50;
// Only frontmatter is needed; a SKILL.md whose frontmatter has not closed
// within this head is treated as having none rather than read further.
const maxSkillFileHeadBytes = 16 * 1024;
const maxSkillDescriptionChars = 200;
// Composer-safe skill names only: a name outside this set could not round-trip
// through the slash/mention token the clients insert.
const skillNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class WorkspaceExplorerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export class WorkspaceExplorer {
  private readonly fileIndexCache = new Map<string, { index: WorkspaceFileIndex; atMs: number }>();
  // In-flight index builds, single-flight per workspace. An invalidation marks
  // the entry superseded and detaches it, so its result is neither cached nor
  // joined by later requests; entries live only as long as their build.
  private readonly fileIndexInFlight = new Map<string, { promise: Promise<WorkspaceFileIndex>; supersede: () => void }>();

  constructor(private readonly registry: LocalWorkspaceRegistry) {}

  async tree(workspaceId: string, input: { path?: string; depth?: number } = {}): Promise<WorkspaceTreeSnapshot> {
    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const safePath = normalizeWorkspaceRelativePath(input.path ?? "");
    const targetPath = await resolveInsideWorkspace(workspaceRoot, safePath);
    const targetStat = await stat(targetPath);
    if (!targetStat.isDirectory()) {
      throw new WorkspaceExplorerError("Workspace path must be a directory");
    }

    const depth = clampDepth(input.depth ?? 2);
    return {
      workspaceId,
      path: safePath,
      entries: await this.readDirectory(workspaceRoot, targetPath, safePath, depth)
    };
  }

  async filePreview(workspaceId: string, input: { path: string; maxBytes?: number }): Promise<WorkspaceFilePreview> {
    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const safePath = normalizeWorkspaceRelativePath(input.path);
    const targetPath = await resolveInsideWorkspace(workspaceRoot, safePath);
    return readPreview(workspaceId, targetPath, safePath, input.maxBytes ?? maxPreviewBytes);
  }

  // Bounded read of the git HEAD version of a workspace file, so an editor can
  // diff the working tree against the committed baseline. Shares the preview
  // path's lexical bound, secret filtering, byte cap, and NUL/binary contract.
  // Realpath containment cannot apply here because the HEAD blob need not exist
  // on disk (a deleted or renamed working file still has a baseline); the bound
  // is the lexically-normalized, `./`-anchored pathspec resolved by git inside
  // the registered workspace directory.
  async gitFileBaseline(
    workspaceId: string,
    input: { path: string; maxBytes?: number }
  ): Promise<WorkspaceGitFileBaseline> {
    const workspace = await this.requireWorkspace(workspaceId);
    const safePath = normalizeWorkspaceRelativePath(input.path);
    if (safePath === "") {
      throw new WorkspaceExplorerError("Workspace file path is required");
    }
    // Refuse secret-named segments anywhere in the path: a committed `.env` or key
    // file is exactly as sensitive at HEAD as it is in the working tree.
    if (hasSecretPathSegment(safePath)) {
      throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
    }

    const result = await this.registry.gitFileAtHead(workspace.id, safePath, input.maxBytes ?? maxWriteBytes);
    const base = { workspaceId, path: safePath, ref: "HEAD" as const };
    if (!result.isRepository) return { ...base, isRepository: false, existsInHead: false };
    if (!result.existsInHead) return { ...base, isRepository: true, existsInHead: false };
    if (result.objectKind !== "blob") {
      throw new WorkspaceExplorerError("Workspace path must be a file", 415);
    }
    if (result.binary) {
      throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
    }
    if (result.truncated || result.content === undefined) {
      return { ...base, isRepository: true, existsInHead: true, sizeBytes: result.sizeBytes, truncated: true };
    }
    return {
      ...base,
      isRepository: true,
      existsInHead: true,
      sizeBytes: result.sizeBytes,
      encoding: "utf8",
      content: result.content,
      truncated: false
    };
  }

  // Bounded UTF-8 write seam: the mutating dual of `filePreview`. Reuses the same
  // path bounding, symlink guard, and secret filtering as the read path; the only
  // deviation is that the leaf may not exist yet, so containment is asserted
  // against the realpath of the PARENT directory rather than the leaf.
  async writeTextFile(
    workspaceId: string,
    input: { path: string; content: string; baseModifiedAt?: string }
  ): Promise<{ preview: WorkspaceFilePreview; workspacePath: string; created: boolean }> {
    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const safePath = normalizeWorkspaceRelativePath(input.path);
    if (safePath === "") {
      throw new WorkspaceExplorerError("Workspace file path is required");
    }
    // Refuse secret-named or generated-directory segments anywhere in the path so a
    // write can never create or clobber `.env*`, key material, `.git`, etc.
    if (hasSecretPathSegment(safePath, ignoredNames)) {
      throw new WorkspaceExplorerError("Workspace file is not writable", 415);
    }
    // UTF-8 text only, mirroring the preview NUL/binary contract. Encode once: a
    // lone surrogate is well-formed JSON but ill-formed UTF-16, and a utf8 write
    // would silently coerce it to U+FFFD, so reject any content that does not
    // survive a UTF-8 round trip rather than persist mangled bytes. NUL is rejected
    // too (it round-trips, so it needs its own check).
    const encoded = Buffer.from(input.content, "utf8");
    if (input.content.includes("\0") || encoded.toString("utf8") !== input.content) {
      throw new WorkspaceExplorerError("Workspace file is not writable", 415);
    }

    // `realpath` throws on a not-yet-existing leaf, so bound the parent directory
    // instead. The parent must already exist (no recursive mkdir in this slice).
    const targetPath = resolve(workspaceRoot, safePath);
    let parentReal: string;
    try {
      parentReal = await realpath(dirname(targetPath));
    } catch {
      throw new WorkspaceExplorerError("Workspace path was not found", 404);
    }
    if (!isInside(workspaceRoot, parentReal)) {
      throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
    }
    const leafPath = join(parentReal, basename(safePath));

    // Refuse writing through a symlink leaf or clobbering a directory.
    let existed = false;
    try {
      const leafStat = await lstat(leafPath);
      if (leafStat.isSymbolicLink()) {
        throw new WorkspaceExplorerError("Workspace file is not writable", 415);
      }
      if (!leafStat.isFile()) {
        throw new WorkspaceExplorerError("Workspace path must be a file", 415);
      }
      existed = true;
    } catch (error) {
      if (error instanceof WorkspaceExplorerError) throw error;
      existed = false; // ENOENT: a fresh create
    }

    // Optimistic concurrency: reject a blind overwrite of a file that changed since
    // the client loaded it. `baseModifiedAt` is the `modifiedAt` the editor rendered.
    if (existed) {
      const current = (await stat(leafPath)).mtime.toISOString();
      if (!input.baseModifiedAt || input.baseModifiedAt !== current) {
        throw new WorkspaceExplorerError("Workspace file changed since it was loaded", 409);
      }
    }

    // Atomic publish. Use a per-write unique temp name (not just the pid) so two
    // concurrent writes to the same leaf can never collide on the temp file.
    // `flag: "wx"` (O_EXCL) refuses to follow or clobber anything planted at the
    // temp name, closing the TOCTOU window.
    const tmpPath = `${leafPath}.${randomUUID()}.agentroom-tmp`;
    await writeFile(tmpPath, encoded, { flag: "wx" });
    try {
      if (existed) {
        // Optimistic lock already checked; atomically replace the leaf name itself
        // (never writes through a symlink at the destination).
        await rename(tmpPath, leafPath);
      } else {
        // Atomic create-only: `link` fails with EEXIST if another writer created the
        // leaf since the existence check, so a concurrent create is reported as a
        // conflict instead of being silently clobbered or mislabeled as our create.
        await link(tmpPath, leafPath);
      }
    } catch (error) {
      await rm(tmpPath, { force: true });
      if (!existed && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceExplorerError("Workspace file changed since it was loaded", 409);
      }
      throw error;
    }
    if (!existed) {
      // `link` leaves the temp behind (only `rename` consumes it); drop it now.
      await rm(tmpPath, { force: true });
    }

    // Read back with the write cap (not the smaller browse-preview cap) so a
    // just-written file always echoes in full and the editor stays editable.
    const preview = await readPreview(workspaceId, leafPath, safePath, maxWriteBytes);
    return { preview, workspacePath: workspace.path, created: !existed };
  }

  // Bounded, read-only discovery of the skills a runner kind would natively
  // load from a registered workspace, for the clients' composer slash picker.
  // Scans only the fixed committed skill directories, follows the tree read's
  // symlink containment (an escaping link is skipped, not an error), and reads
  // only each SKILL.md's frontmatter head — name and description, never body
  // content. Purely informational: it loads nothing and emits no events/audit.
  async listSkills(workspaceId: string, runnerKind: AgentRunnerKind): Promise<WorkspaceSkill[]> {
    const descriptor = runnerDescriptor(runnerKind);
    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const skills: WorkspaceSkill[] = [];
    const seenNames = new Set<string>();
    for (const sourceDir of descriptor.skillSourceDirs) {
      if (skills.length >= maxSkills) break;
      const sourcePath = await safeRealpath(workspaceRoot, resolve(workspaceRoot, sourceDir));
      if (!sourcePath) continue;
      let dirents;
      try {
        dirents = await readdir(sourcePath, { withFileTypes: true });
      } catch {
        continue; // absent or unreadable skills dir is an ordinary "no skills" state
      }
      for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
        if (skills.length >= maxSkills) break;
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        const skillDirPath = await safeRealpath(workspaceRoot, join(sourcePath, dirent.name));
        if (!skillDirPath) continue;
        const skillFilePath = await safeRealpath(workspaceRoot, join(skillDirPath, "SKILL.md"));
        if (!skillFilePath) continue;
        const head = await readSkillFileHead(skillFilePath);
        if (head === undefined) continue;
        const frontmatter = parseSkillFrontmatter(head);
        const name = resolveSkillName(frontmatter.name, dirent.name);
        if (!name || seenNames.has(name.toLowerCase())) continue;
        seenNames.add(name.toLowerCase());
        skills.push({
          name,
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          invocation: `${descriptor.skillInvocationPrefix}${name}`,
          source: sourceDir
        });
      }
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  // Bounded, read-only file index for quick-open and the composer's `@` mention
  // picker. Ranking happens backend-side over the cached enumeration; only the
  // top `limit` paths are stat'd, and each one is re-checked for containment
  // before it is returned, so an escaping symlink is skipped, never followed.
  // Emits no events and no audit entries.
  async listFiles(
    workspaceId: string,
    input: { query?: string; limit?: number } = {}
  ): Promise<WorkspaceFileIndexSnapshot> {
    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const query = (input.query ?? "").trim();
    const limit = clampLimit(input.limit ?? defaultFileIndexResults, maxFileIndexResults);

    const index = await this.fileIndex(workspaceId, workspaceRoot);
    const ranked = rankIndexPaths(index.paths, query);
    const files: WorkspaceFileIndexEntry[] = [];
    // Probing is bounded as well as the result count: a stale index (files
    // deleted since it was built, or a directory full of escaping symlinks)
    // must not turn one request into an unbounded run of realpath syscalls.
    const maxProbes = limit * 4 + 25;
    let examined = 0;
    for (const path of ranked) {
      if (files.length >= limit || examined >= maxProbes) break;
      examined += 1;
      const entry = await this.describeIndexedFile(workspaceRoot, path);
      if (entry) files.push(entry);
    }
    return {
      workspaceId,
      query,
      files,
      truncated: index.truncated || examined < ranked.length
    };
  }

  // Bounded, read-only literal-substring content search over the same cached
  // index. Deliberately not a regex search: a caller-supplied pattern would be
  // an in-process ReDoS vector, so v1 exposes only literal matching with
  // `matchCase`/`wholeWord`/`include` toggles. Every bound (files scanned,
  // matches per file, total matches, bytes per file, wall clock) reports partial
  // results through a `truncated` flag rather than running long. Emits no events
  // and no audit entries.
  async searchFiles(
    workspaceId: string,
    input: { query: string; matchCase?: boolean; wholeWord?: boolean; include?: string; limit?: number }
  ): Promise<WorkspaceSearchSnapshot> {
    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const query = input.query.trim();
    if (!query) {
      throw new WorkspaceExplorerError("Workspace search query is required");
    }
    const limit = clampLimit(input.limit ?? maxSearchMatches, maxSearchMatches);
    const include = input.include?.trim().slice(0, maxIncludePatternChars) || undefined;
    const deadlineMs = Date.now() + searchBudgetMs;

    const index = await this.fileIndex(workspaceId, workspaceRoot);
    const files: WorkspaceSearchFileMatches[] = [];
    let totalMatches = 0;
    let filesScanned = 0;
    let truncated = index.truncated;

    for (let position = 0; position < index.paths.length; position += 1) {
      if (totalMatches >= limit || filesScanned >= maxSearchFilesScanned || Date.now() >= deadlineMs) {
        // Any remaining candidate could still have matched, so report partial results.
        truncated = truncated || position < index.paths.length;
        break;
      }
      const path = index.paths[position];
      if (include && !matchesIncludePattern(path, include)) continue;

      const file = await this.readSearchableFile(workspaceRoot, path);
      if (!file.opened) continue;
      filesScanned += 1;
      if (file.content === undefined) continue; // binary: read, then skipped

      const remaining = Math.min(maxSearchMatchesPerFile, limit - totalMatches);
      const found = findFileMatches(file.content, query, {
        matchCase: input.matchCase ?? false,
        wholeWord: input.wholeWord ?? false,
        maxMatches: remaining
      });
      if (found.matches.length === 0) continue;
      totalMatches += found.matches.length;
      files.push({ path, matches: found.matches, truncated: found.truncated || file.truncated });
    }

    return { workspaceId, query, files, totalMatches, filesScanned, truncated };
  }

  // Explicit cache invalidation seam for the paths that change what the index
  // should contain (a bounded file write, a branch switch) and for releasing a
  // workspace's slot entirely (unregistration). Without an argument it drops
  // every workspace's index. An in-flight build is marked superseded and
  // detached: its existing joiners still get their pre-invalidation result, but
  // it is never cached and a request arriving after the invalidation starts a
  // fresh build instead of joining the stale one.
  invalidateFileIndex(workspaceId?: string): void {
    if (workspaceId === undefined) {
      this.fileIndexCache.clear();
      for (const entry of this.fileIndexInFlight.values()) {
        entry.supersede();
      }
      this.fileIndexInFlight.clear();
      return;
    }
    this.fileIndexCache.delete(workspaceId);
    const inFlight = this.fileIndexInFlight.get(workspaceId);
    if (inFlight) {
      inFlight.supersede();
      this.fileIndexInFlight.delete(workspaceId);
    }
  }

  async promptWithContext(workspaceId: string, message: string, paths: string[] = []): Promise<string> {
    const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (uniquePaths.length === 0) return message;

    const workspace = await this.requireWorkspace(workspaceId);
    const workspaceRoot = await realpath(workspace.path);
    const blocks: string[] = [];
    for (const inputPath of uniquePaths) {
      const safePath = normalizeWorkspaceRelativePath(inputPath);
      const targetPath = await resolveInsideWorkspace(workspaceRoot, safePath);
      const targetStat = await stat(targetPath);
      if (targetStat.isDirectory()) {
        const tree = await this.readDirectory(workspaceRoot, targetPath, safePath, contextTreeDepth);
        blocks.push(formatDirectoryContext(safePath, tree));
      } else {
        const preview = await readPreview(workspaceId, targetPath, safePath, maxPreviewBytes);
        blocks.push(formatFileContext(preview));
      }
    }

    return [
      "User selected workspace context:",
      blocks.join("\n\n"),
      "User message:",
      message
    ].join("\n\n");
  }

  private async requireWorkspace(workspaceId: string) {
    // Only id -> path resolution is needed for read/write bounding; skipping the
    // git snapshot refresh keeps tree/preview/write requests off the git hot path.
    const workspace = await this.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) {
      throw new WorkspaceExplorerError("Workspace is not registered", 404);
    }
    return workspace;
  }

  private async readDirectory(
    workspaceRoot: string,
    directoryPath: string,
    directoryRelativePath: string,
    depthRemaining: number
  ): Promise<WorkspaceTreeEntry[]> {
    const dirents = await readdir(directoryPath, { withFileTypes: true });
    const candidates = dirents
      .sort(compareDirents)
      .slice(0, maxEntriesPerDirectory)
      .filter((dirent) => !ignoredNames.has(dirent.name) && !isSecretName(dirent.name) && !dirent.name.endsWith(".agentroom-tmp"));
    const entries = await Promise.all(candidates.map(async (dirent): Promise<WorkspaceTreeEntry | undefined> => {
      const childRelativePath = joinWorkspacePath(directoryRelativePath, dirent.name);
      const childPath = join(directoryPath, dirent.name);
      // Only a symlink can point outside the workspace: a regular entry
      // physically lives under its parent, which is already a contained
      // realpath, so it needs one lstat instead of a realpath chain + stat.
      let childResolvedPath = childPath;
      let childStat;
      if (dirent.isSymbolicLink()) {
        const childRealPath = await safeRealpath(workspaceRoot, childPath);
        if (!childRealPath) return undefined;
        childResolvedPath = childRealPath;
        childStat = await stat(childRealPath);
      } else {
        childStat = await lstat(childPath);
      }
      if (childStat.isDirectory()) {
        return {
          type: "directory",
          name: dirent.name,
          path: childRelativePath,
          modifiedAt: childStat.mtime.toISOString(),
          ...(depthRemaining > 0
            ? { children: await this.readDirectory(workspaceRoot, childResolvedPath, childRelativePath, depthRemaining - 1) }
            : {})
        };
      }
      if (childStat.isFile()) {
        return {
          type: "file",
          name: dirent.name,
          path: childRelativePath,
          sizeBytes: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
          // Previewable means "a text file the editor can open and save": a non-binary,
          // non-secret name within the write cap. The editor loads it with `maxBytes` up to
          // `maxWriteBytes` (see `filePreviewQuerySchema`), so the open/edit gate is the
          // write cap, not the smaller 24 KB browse-content default.
          previewable: isPreviewableName(dirent.name) && childStat.size <= maxWriteBytes
        };
      }
      return undefined;
    }));
    return entries.filter((entry): entry is WorkspaceTreeEntry => entry !== undefined);
  }

  // Short-TTL per-workspace cache. Concurrent misses share one build (a client
  // typing hits both routes at once) instead of racing duplicate enumerations.
  private async fileIndex(workspaceId: string, workspaceRoot: string): Promise<WorkspaceFileIndex> {
    const cached = this.fileIndexCache.get(workspaceId);
    if (cached && Date.now() - cached.atMs < fileIndexTtlMs) return cached.index;
    const inFlight = this.fileIndexInFlight.get(workspaceId);
    if (inFlight) return inFlight.promise;

    const startedAtMs = Date.now();
    let superseded = false;
    const promise = this.buildFileIndex(workspaceId, workspaceRoot)
      .then((index) => {
        // An invalidation that landed while this build was in flight wins:
        // caching a snapshot taken before the write/checkout would resurrect
        // stale paths for a full TTL.
        if (!superseded) {
          this.fileIndexCache.set(workspaceId, { index, atMs: startedAtMs });
        }
        return index;
      })
      .finally(() => {
        // A superseded build was already detached and a fresh build may have
        // taken the slot since, so only clear a slot this build still owns.
        if (this.fileIndexInFlight.get(workspaceId)?.promise === promise) {
          this.fileIndexInFlight.delete(workspaceId);
        }
      });
    this.fileIndexInFlight.set(workspaceId, {
      promise,
      supersede: () => {
        superseded = true;
      }
    });
    return promise;
  }

  private async buildFileIndex(workspaceId: string, workspaceRoot: string): Promise<WorkspaceFileIndex> {
    // Git workspaces enumerate through `git ls-files`, which respects
    // `.gitignore` for free; anything else (including a workspace whose git
    // invocation failed) falls back to the bounded walk below.
    const listed = await this.registry.gitListFiles(workspaceId, maxIndexPaths);
    if (!listed.isRepository) return this.walkWorkspaceFiles(workspaceRoot);

    const paths: string[] = [];
    for (const rawPath of listed.paths) {
      const safePath = indexableRelativePath(rawPath);
      if (safePath) paths.push(safePath);
    }
    return { paths: sortPaths(paths), truncated: listed.truncated, source: "git" };
  }

  // Bounded filesystem enumeration for non-git workspaces. Reuses the tree
  // read's `ignoredNames`/secret-name filtering, and — like git's enumeration —
  // never descends through a symlinked directory (a link back to an ancestor
  // would otherwise cycle). A contained symlink to a file is indexed as a leaf,
  // matching what the tree read and file preview already expose; an escaping
  // link is skipped, never followed.
  private async walkWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceFileIndex> {
    const paths: string[] = [];
    const queue: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
      { directoryPath: workspaceRoot, relativePath: "", depth: 0 }
    ];
    let truncated = false;
    let capReached = false;
    for (let cursor = 0; cursor < queue.length && !capReached; cursor += 1) {
      const current = queue[cursor];
      let dirents;
      try {
        dirents = await readdir(current.directoryPath, { withFileTypes: true });
      } catch {
        continue; // unreadable directory is an ordinary "nothing here" state
      }
      for (const dirent of dirents.sort(compareDirents)) {
        if (paths.length >= maxIndexPaths) {
          truncated = true;
          capReached = true;
          break;
        }
        if (ignoredNames.has(dirent.name) || isSecretName(dirent.name) || dirent.name.endsWith(".agentroom-tmp")) {
          continue;
        }
        const childRelativePath = joinWorkspacePath(current.relativePath, dirent.name);
        const childPath = join(current.directoryPath, dirent.name);
        if (dirent.isSymbolicLink()) {
          const childRealPath = await safeRealpath(workspaceRoot, childPath);
          if (!childRealPath) continue;
          let linkStat;
          try {
            linkStat = await stat(childRealPath);
          } catch {
            continue;
          }
          if (linkStat.isFile()) paths.push(childRelativePath);
          continue;
        }
        if (dirent.isDirectory()) {
          if (current.depth < maxIndexWalkDepth) {
            queue.push({ directoryPath: childPath, relativePath: childRelativePath, depth: current.depth + 1 });
          } else {
            truncated = true;
          }
          continue;
        }
        if (dirent.isFile()) paths.push(childRelativePath);
      }
    }
    return { paths: sortPaths(paths), truncated, source: "walk" };
  }

  // Point-of-use validation for an indexed path: full realpath containment (so
  // a leaf or intermediate segment that became a symlink out of the workspace
  // after the index was built is dropped rather than followed) plus the tree
  // read's `previewable` contract.
  private async describeIndexedFile(
    workspaceRoot: string,
    safePath: string
  ): Promise<WorkspaceFileIndexEntry | undefined> {
    const targetPath = await safeRealpath(workspaceRoot, resolve(workspaceRoot, safePath));
    if (!targetPath) return undefined;
    let fileStat;
    try {
      fileStat = await stat(targetPath);
    } catch {
      return undefined;
    }
    if (!fileStat.isFile()) return undefined;
    const name = basename(safePath);
    return {
      path: safePath,
      name,
      previewable: isPreviewableName(name) && fileStat.size <= maxWriteBytes
    };
  }

  // Bounded search read of one indexed file. Shares the preview path's
  // containment, secret-name refusal, byte cap, and NUL/binary contract.
  // `opened` distinguishes "counted against the scan budget" from "skipped
  // before any read"; `content` is absent for a binary file.
  private async readSearchableFile(
    workspaceRoot: string,
    safePath: string
  ): Promise<{ opened: boolean; content?: string; truncated: boolean }> {
    const name = basename(safePath);
    if (!isPreviewableName(name)) return { opened: false, truncated: false };
    const targetPath = await safeRealpath(workspaceRoot, resolve(workspaceRoot, safePath));
    if (!targetPath) return { opened: false, truncated: false };
    let fileStat;
    try {
      fileStat = await stat(targetPath);
    } catch {
      return { opened: false, truncated: false };
    }
    if (!fileStat.isFile()) return { opened: false, truncated: false };

    const bytesToRead = Math.min(fileStat.size, maxSearchFileBytes);
    let buffer: Buffer;
    try {
      const file = await open(targetPath, "r");
      try {
        const target = Buffer.alloc(bytesToRead);
        const result = await file.read(target, 0, bytesToRead, 0);
        buffer = target.subarray(0, result.bytesRead);
      } finally {
        await file.close();
      }
    } catch {
      return { opened: false, truncated: false };
    }
    if (buffer.includes(0)) return { opened: true, truncated: false }; // binary: scanned, not searched
    return { opened: true, content: buffer.toString("utf8"), truncated: fileStat.size > maxSearchFileBytes };
  }
}

async function readPreview(
  workspaceId: string,
  targetPath: string,
  safePath: string,
  maxBytes: number
): Promise<WorkspaceFilePreview> {
  const entryStat = await lstat(targetPath);
  if (!entryStat.isFile() && !entryStat.isSymbolicLink()) {
    throw new WorkspaceExplorerError("Workspace path must be a file");
  }
  const fileStat = await stat(targetPath);
  if (!fileStat.isFile()) {
    throw new WorkspaceExplorerError("Workspace path must be a file");
  }
  if (!isPreviewableName(basename(safePath))) {
    throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
  }

  const bytesToRead = Math.min(fileStat.size, maxBytes);
  const file = await open(targetPath, "r");
  let previewBuffer: Buffer;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, 0);
    previewBuffer = buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
  if (previewBuffer.includes(0)) {
    throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
  }
  return {
    workspaceId,
    path: safePath,
    name: basename(safePath),
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    encoding: "utf8",
    content: previewBuffer.toString("utf8"),
    truncated: fileStat.size > maxBytes,
    previewable: true
  };
}

// Bounded head read of a SKILL.md: only enough bytes for frontmatter, UTF-8
// text only (a NUL byte means "not a skill file", mirroring the preview
// contract). Returns undefined for a missing, non-file, or binary target.
async function readSkillFileHead(targetPath: string): Promise<string | undefined> {
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch {
    return undefined;
  }
  if (!fileStat.isFile()) return undefined;
  const bytesToRead = Math.min(fileStat.size, maxSkillFileHeadBytes);
  const file = await open(targetPath, "r");
  let head: Buffer;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, 0);
    head = buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
  if (head.includes(0)) return undefined;
  return head.toString("utf8");
}

// Extracts only `name` and `description` strings from a leading YAML
// frontmatter block. Anything malformed degrades to "no frontmatter" (the
// directory name still identifies the skill) rather than an error, since the
// file is workspace-authored content.
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const description =
    typeof record.description === "string"
      ? record.description.replace(/\s+/g, " ").trim().slice(0, maxSkillDescriptionChars)
      : undefined;
  return {
    ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    ...(description ? { description } : {})
  };
}

// Frontmatter name wins when composer-safe; otherwise the directory name; a
// skill with no safe name is skipped because its invocation token could not be
// typed or parsed back out of the composer.
function resolveSkillName(frontmatterName: string | undefined, directoryName: string): string | undefined {
  for (const candidate of [frontmatterName, directoryName]) {
    if (candidate && skillNamePattern.test(candidate)) return candidate;
  }
  return undefined;
}

// The index's path filter. Applies the same lexical bound as every other
// workspace read (rejecting NUL, absolute paths, and `..`) and then the tree
// read's per-segment refusals, so a `.env`, key file, `.git` object, or
// generated-directory entry can never enter the index — and therefore can never
// be listed by the file index, scanned by the content search, or named as a
// pathspec by a git operation (`WorkspaceGitService` shares this filter, which is
// what keeps a secret-named file out of the index AgentRoom would then commit).
export function indexableRelativePath(rawPath: string): string | undefined {
  let safePath: string;
  try {
    safePath = normalizeWorkspaceRelativePath(rawPath);
  } catch {
    return undefined;
  }
  if (!safePath) return undefined;
  const segments = safePath.split("/");
  if (segments.some((segment) => ignoredNames.has(segment) || isSecretName(segment) || segment.endsWith(".agentroom-tmp"))) {
    return undefined;
  }
  return safePath;
}

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function clampLimit(limit: number, max: number): number {
  if (!Number.isFinite(limit)) return max;
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

// Server-side ranking for quick-open / `@` mention lists. Tiers, best first:
// exact basename, basename prefix, basename substring, path substring,
// subsequence ("fuzzy") over the path. Ties break on shorter path, then
// alphabetically, so the result order is stable for a given index.
function rankIndexPaths(paths: string[], query: string): string[] {
  if (!query) {
    return [...paths].sort(compareRankedPaths);
  }
  const needle = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const score = scoreIndexPath(path, needle);
    if (score !== undefined) scored.push({ path, score });
  }
  return scored
    .sort((left, right) => (left.score !== right.score ? left.score - right.score : compareRankedPaths(left.path, right.path)))
    .map((entry) => entry.path);
}

function compareRankedPaths(left: string, right: string): number {
  return left.length !== right.length ? left.length - right.length : left.localeCompare(right);
}

function scoreIndexPath(path: string, needle: string): number | undefined {
  const lowerPath = path.toLowerCase();
  const lowerName = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  if (lowerName === needle) return 0;
  if (lowerName.startsWith(needle)) return 1;
  if (lowerName.includes(needle)) return 2;
  if (lowerPath.includes(needle)) return 3;
  return isSubsequence(needle, lowerPath) ? 4 : undefined;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (let position = 0; position < haystack.length && index < needle.length; position += 1) {
    if (haystack[position] === needle[index]) index += 1;
  }
  return index === needle.length;
}

// Optional `include` filter for the content search. Deliberately not a regex:
// `*` matches any run of characters (including `/`), `?` matches one, and there
// is no `*`/`**` distinction. A pattern with no wildcard is a path-prefix (or
// basename) filter. Matching is case-insensitive and runs through the linear
// two-pointer matcher below, so no caller-supplied string ever becomes a regex.
function matchesIncludePattern(path: string, pattern: string): boolean {
  const lowerPath = path.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const lowerName = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  if (!lowerPattern.includes("*") && !lowerPattern.includes("?")) {
    return (
      lowerPath === lowerPattern ||
      lowerPath.startsWith(`${lowerPattern}/`) ||
      (!lowerPattern.includes("/") && lowerName === lowerPattern)
    );
  }
  return wildcardMatch(lowerPattern.includes("/") ? lowerPath : lowerName, lowerPattern);
}

// Classic iterative wildcard match: O(text * pattern) worst case with no
// recursion and no regex engine, so a hostile pattern cannot blow up the event
// loop the way a caller-supplied regex could.
function wildcardMatch(text: string, pattern: string): boolean {
  let textIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || pattern[patternIndex] === text[textIndex])) {
      textIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      starTextIndex = textIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

// Literal substring matching, line by line. Line and column are 1-indexed
// (Monaco convention) and column/length are UTF-16 code-unit offsets into the
// matched line.
function findFileMatches(
  content: string,
  query: string,
  options: { matchCase: boolean; wholeWord: boolean; maxMatches: number }
): { matches: WorkspaceSearchMatch[]; truncated: boolean } {
  const matches: WorkspaceSearchMatch[] = [];
  if (options.maxMatches <= 0) return { matches, truncated: true };
  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // Case-insensitive matching compares lowered copies, but a few code points
    // change length when lowered (e.g. U+0130), which would desync the offsets
    // reported against the original line. Fall back to exact matching for such
    // a line rather than report a wrong column.
    const loweredLine = options.matchCase ? line : line.toLowerCase();
    const caseInsensitive = !options.matchCase && loweredLine.length === line.length;
    const haystack = caseInsensitive ? loweredLine : line;
    const needle = caseInsensitive ? query.toLowerCase() : query;
    if (needle.length === 0) break;

    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      if (options.wholeWord && !isWholeWordMatch(line, at, needle.length)) continue;
      if (matches.length >= options.maxMatches) return { matches, truncated: true };
      matches.push({
        line: lineIndex + 1,
        column: at + 1,
        length: needle.length,
        ...boundedMatchPreview(line, at, needle.length)
      });
    }
  }
  return { matches, truncated: false };
}

function isWholeWordMatch(line: string, at: number, length: number): boolean {
  const before = at > 0 ? line[at - 1] : "";
  const after = at + length < line.length ? line[at + length] : "";
  return !wordCharacterPattern.test(before) && !wordCharacterPattern.test(after);
}

// The matched line, bounded to `maxSearchPreviewChars` centred on the match, so
// a minified or generated file cannot return a megabyte-long line. Also reports
// where the match sits inside the returned window for client-side highlighting.
// The window edges never split a surrogate pair — the preview shrinks by one
// UTF-16 unit per affected edge instead of carrying a lone surrogate a client
// would render as U+FFFD (the same code-point-boundary discipline as the
// artifact cap).
function boundedMatchPreview(line: string, at: number, length: number): { preview: string; previewColumn: number } {
  if (line.length <= maxSearchPreviewChars) {
    return { preview: line, previewColumn: at + 1 };
  }
  const lead = Math.max(0, Math.floor((maxSearchPreviewChars - Math.min(length, maxSearchPreviewChars)) / 2));
  let start = Math.max(0, at - lead);
  if (start + maxSearchPreviewChars > line.length) {
    start = Math.max(0, line.length - maxSearchPreviewChars);
  }
  if (splitsSurrogatePair(line, start)) start += 1;
  let end = Math.min(line.length, start + maxSearchPreviewChars);
  if (splitsSurrogatePair(line, end)) end -= 1;
  return {
    preview: line.slice(start, end),
    previewColumn: Math.max(1, at - start + 1)
  };
}

// True when `index` falls between the halves of a surrogate pair, so slicing
// there would produce a lone surrogate.
function splitsSurrogatePair(line: string, index: number): boolean {
  if (index <= 0 || index >= line.length) return false;
  const before = line.charCodeAt(index - 1);
  const after = line.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function normalizeWorkspaceRelativePath(inputPath: string): string {
  // Shares the lexical bound with the editor catalog asset route; the empty result (workspace
  // root) is intentionally allowed here, unlike the catalog where an empty asset path is rejected.
  return boundedRelativeSegments(inputPath, () => {
    throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
  });
}

async function resolveInsideWorkspace(workspaceRoot: string, safePath: string): Promise<string> {
  const targetPath = resolve(workspaceRoot, safePath);
  let targetRealPath: string;
  try {
    targetRealPath = await realpath(targetPath);
  } catch {
    throw new WorkspaceExplorerError("Workspace path was not found", 404);
  }
  if (!isInside(workspaceRoot, targetRealPath)) {
    throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
  }
  return targetRealPath;
}

async function safeRealpath(workspaceRoot: string, targetPath: string): Promise<string | undefined> {
  try {
    const targetRealPath = await realpath(targetPath);
    return isInside(workspaceRoot, targetRealPath) ? targetRealPath : undefined;
  } catch {
    return undefined;
  }
}

function joinWorkspacePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 2;
  return Math.min(Math.max(Math.floor(depth), 0), maxDepth);
}

function compareDirents(left: { isDirectory(): boolean; name: string }, right: { isDirectory(): boolean; name: string }): number {
  if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function isPreviewableName(name: string): boolean {
  return !isSecretName(name);
}

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return secretNames.has(lower) || lower.startsWith(".env.") || secretExtensions.some((extension) => lower.endsWith(extension));
}

// Shared by `gitFileBaseline` (secret names only) and `writeTextFile` (secret
// names plus generated-directory names) so the two read/write path-segment
// refusal checks can't silently drift apart.
function hasSecretPathSegment(path: string, extraIgnored?: Set<string>): boolean {
  return path.split("/").some((segment) => isSecretName(segment) || (extraIgnored?.has(segment) ?? false));
}

function formatFileContext(preview: WorkspaceFilePreview): string {
  const truncated = preview.truncated ? "\n[File preview truncated]" : "";
  const fence = markdownFenceFor(preview.content);
  return [`File: ${preview.path}`, fence, preview.content + truncated, fence].join("\n");
}

function markdownFenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

function formatDirectoryContext(path: string, entries: WorkspaceTreeEntry[]): string {
  return [`Directory: ${path || "."}`, "```text", ...formatTreeEntries(entries), "```"].join("\n");
}

function formatTreeEntries(entries: WorkspaceTreeEntry[], indent = ""): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const suffix = entry.type === "directory" ? "/" : "";
    lines.push(`${indent}${entry.name}${suffix}`);
    if (entry.children) {
      lines.push(...formatTreeEntries(entry.children, `${indent}  `));
    }
  }
  return lines;
}
