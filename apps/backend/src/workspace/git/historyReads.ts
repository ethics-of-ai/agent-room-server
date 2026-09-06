import type {
  WorkspaceGitCommit, WorkspaceGitCommitDetail, WorkspaceGitCommitDiff,
  WorkspaceGitHistory, WorkspaceGitRef
} from "../../domain/gitHistory";
import { gitObjectIdSchema } from "../../domain/gitHistory";
import { indexableRelativePath } from "../explorer/paths";
import { WorkspaceGitServiceError } from "./errors";
import { type GitBlobExecutor, type GitCommandExecutor } from "./execution";
import { redactSecrets } from "../../util/redactSecrets";

const maxFiles = 200;
const maxBlobBytes = 256 * 1024;
const logFormat = "--format=%H%x00%P%x00%an%x00%cI%x00%s";
const readOptions = ["--no-pager", "--no-replace-objects", "-c", "log.showSignature=false"];
interface FileEntry { path: string; status: string; before: string; after: string; regular: boolean }

/** Fixed, bounded repository history reads. Ref names are admitted from the local
 * catalog and immediately pinned to object ids. No revision expressions, hooks,
 * textconv, external diff, shell, fetch, or working-tree content are involved. */
export class GitHistoryReader {
  constructor(private readonly run: GitCommandExecutor, private readonly blob: GitBlobExecutor) {}

  private async read(cwd: string, args: string[]): Promise<string> {
    try {
      return (await this.run(cwd, [...readOptions, ...args], {
        GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0"
      })).stdout;
    } catch {
      // Never echo command output: it may contain committed content or credentials.
      throw new WorkspaceGitServiceError("Git history could not be read. Refresh and try again.", 503);
    }
  }

  private async optional(cwd: string, args: string[]): Promise<string | undefined> {
    try { return (await this.read(cwd, args)).trim() || undefined; } catch { return undefined; }
  }

  async history(cwd: string, workspaceId: string, input: {
    branch?: string; compare?: string; limit: number;
  }): Promise<WorkspaceGitHistory> {
    const base: WorkspaceGitHistory = {
      workspaceId, isRepository: false, refs: [], refsTruncated: false, commits: [],
      truncated: false, shallow: false, refreshedAt: new Date().toISOString()
    };
    try {
      const result = await this.run(cwd, [...readOptions, "rev-parse", "--is-inside-work-tree"]);
      if (result.stdout.trim() !== "true") return base;
    } catch (error) {
      if ((error as { code?: unknown }).code === 128) return base;
      throw new WorkspaceGitServiceError("Git is unavailable for this workspace.", 503);
    }
    base.isRepository = true;
    const head = await this.optional(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const current = await this.optional(cwd, ["symbolic-ref", "-q", "HEAD"]);
    const raw = await this.read(cwd, ["for-each-ref", "--count=201",
      "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads", "refs/remotes"]);
    const rows = raw.trimEnd().split("\n").filter(Boolean);
    const refs: WorkspaceGitRef[] = rows.slice(0, 200).flatMap((line) => {
      const [id, commit, symbolic] = line.split("\0");
      if (!id || !gitObjectIdSchema.safeParse(commit).success || symbolic) return [];
      return [{ id, commit, name: id.replace(/^refs\/(heads|remotes)\//, ""),
        current: id === current, kind: id.startsWith("refs/heads/") ? "local" : "remote" }];
    });
    if (head) refs.unshift({ id: "HEAD", name: current ? "HEAD" : "Detached HEAD", commit: head, current: !current, kind: "head" });
    base.refs = refs;
    base.refsTruncated = rows.length > 200;
    base.head = head;
    base.shallow = (await this.read(cwd, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
    if (!head && !refs.length) return base;
    const selected = refs.find((ref) => ref.id === (input.branch ?? current)) ??
      (!input.branch ? refs.find((ref) => ref.id === "HEAD") ?? refs[0] : undefined);
    const comparison = input.compare ? refs.find((ref) => ref.id === input.compare) : undefined;
    if (!selected || (input.compare && !comparison)) {
      throw new WorkspaceGitServiceError("Choose a branch from the current Git history catalog.", 400);
    }
    const upstreamName = selected.kind === "local"
      ? await this.optional(cwd, ["for-each-ref", "--format=%(upstream)", "--", selected.id]) : undefined;
    const upstream = refs.find((ref) => ref.id === upstreamName);
    const roots = [...new Set([selected.commit, comparison?.commit, upstream?.commit].filter((id): id is string => Boolean(id)))];
    const commits = parseCommits(await this.read(cwd, ["log", "--topo-order", "--no-decorate",
      "--no-show-signature", "--encoding=UTF-8", "-z", logFormat, `--max-count=${input.limit + 1}`, ...roots, "--"]));
    base.selectedRef = selected.id;
    base.comparisonRef = comparison?.id;
    base.upstreamRef = upstream?.id;
    base.commits = commits.slice(0, input.limit);
    base.truncated = commits.length > input.limit;
    if (comparison) {
      // Exit 1 means no common ancestor. Keep other failures visible.
      let bases: string[] = [];
      try {
        const result = await this.run(cwd, [...readOptions, "merge-base", "--all", selected.commit, comparison.commit],
          { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
        bases = result.stdout.trim().split("\n").filter(Boolean);
      } catch (error) {
        if ((error as { code?: unknown }).code !== 1) throw new WorkspaceGitServiceError("Git branch comparison failed.", 503);
      }
      const sides = (await this.read(cwd, ["rev-list", "--left-right", "--max-count=201",
        `${selected.commit}...${comparison.commit}`, "--"])).trim().split("\n").filter(Boolean);
      base.comparison = {
        mergeBases: bases.slice(0, 16),
        leftOnly: sides.slice(0, 200).filter((line) => line.startsWith("<")).map((line) => line.slice(1)),
        rightOnly: sides.slice(0, 200).filter((line) => line.startsWith(">")).map((line) => line.slice(1)),
        truncated: sides.length > 200 || bases.length > 16 || base.shallow
      };
    }
    return base;
  }

  private async admittedCommit(cwd: string, commit: string): Promise<WorkspaceGitCommit> {
    if (!gitObjectIdSchema.safeParse(commit).success) throw new WorkspaceGitServiceError("A full commit id is required.");
    // A hex blob id or an unreachable object must not become a content-read capability.
    if (await this.optional(cwd, ["cat-file", "-t", commit]) !== "commit") {
      throw new WorkspaceGitServiceError("Commit was not found.", 404);
    }
    const containing = await this.read(cwd, ["for-each-ref", `--contains=${commit}`, "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes"]);
    if (!containing.trim()) {
      try {
        await this.run(cwd, [...readOptions, "merge-base", "--is-ancestor", commit, "HEAD"],
          { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
      } catch { throw new WorkspaceGitServiceError("Commit is no longer reachable from a branch or HEAD.", 404); }
    }
    const result = parseCommits(await this.read(cwd, ["log", "--no-walk", "--no-show-signature", "--encoding=UTF-8", "-z", logFormat, commit, "--"]));
    if (result.length !== 1) throw new WorkspaceGitServiceError("Git returned an invalid commit.", 503);
    return result[0];
  }

  private async entries(cwd: string, commit: WorkspaceGitCommit): Promise<FileEntry[]> {
    const revisions = commit.parents[0] ? [commit.parents[0], commit.id] : [commit.id];
    const raw = await this.read(cwd, ["diff-tree", "--root", "--no-commit-id", "-r", "--raw", "--no-abbrev", "-z",
      "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", ...revisions, "--", "."]);
    const fields = raw.split("\0");
    const result: FileEntry[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(fields[i]);
      if (!match) throw new WorkspaceGitServiceError("Git returned an invalid file list.", 503);
      result.push({ path: fields[i + 1], status: match[5], before: match[3], after: match[4],
        regular: [match[1], match[2]].every((mode) => ["000000", "100644", "100755"].includes(mode)) });
    }
    return result;
  }

  async detail(cwd: string, workspaceId: string, id: string): Promise<WorkspaceGitCommitDetail> {
    const commit = await this.admittedCommit(cwd, id);
    const entries = await this.entries(cwd, commit);
    const safe = entries.filter((entry) => indexableRelativePath(entry.path) === entry.path);
    return { workspaceId, commit, parent: commit.parents[0], filtered: safe.length !== entries.length,
      truncated: safe.length > maxFiles,
      files: safe.slice(0, maxFiles).map((entry) => ({ path: entry.path, status: entry.status, previewable: entry.regular })) };
  }

  async diff(cwd: string, workspaceId: string, id: string, path: string): Promise<WorkspaceGitCommitDiff> {
    if (indexableRelativePath(path) !== path) throw new WorkspaceGitServiceError("Workspace file is not previewable.", 415);
    const commit = await this.admittedCommit(cwd, id);
    const entry = (await this.entries(cwd, commit)).find((item) => item.path === path);
    if (!entry) throw new WorkspaceGitServiceError("This file is not changed in the selected commit.", 404);
    if (!entry.regular) throw new WorkspaceGitServiceError("Only regular text files can be compared.", 415);
    // The tree-derived blob ids pin both sides across branch switches, deletion,
    // renames, and later working-tree symlinks. Literal paths never reach a shell.
    const [before, after] = await Promise.all([this.textBlob(cwd, entry.before), this.textBlob(cwd, entry.after)]);
    return { workspaceId, commit: id, parent: commit.parents[0], path, before, after };
  }

  private async textBlob(cwd: string, id: string): Promise<string> {
    if (/^0+$/.test(id)) return "";
    const size = Number((await this.read(cwd, ["cat-file", "-s", id])).trim());
    if (!Number.isSafeInteger(size) || size > maxBlobBytes || size < 0) {
      throw new WorkspaceGitServiceError("This file exceeds the 256 KiB historical preview limit.", 413);
    }
    let raw: Buffer;
    try { raw = await this.blob(cwd, [...readOptions, "cat-file", "blob", id], { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }); }
    catch { throw new WorkspaceGitServiceError("The committed file could not be read.", 503); }
    const text = raw.toString("utf8");
    if (raw.length !== size || raw.includes(0) || !Buffer.from(text).equals(raw)) {
      throw new WorkspaceGitServiceError("This committed file is not UTF-8 text.", 415);
    }
    return text;
  }
}

function parseCommits(output: string): WorkspaceGitCommit[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5 !== 0) throw new WorkspaceGitServiceError("Git returned invalid history.", 503);
  const commits: WorkspaceGitCommit[] = [];
  for (let i = 0; i < fields.length; i += 5) {
    const [id, parentText, author, committedAt, subject] = fields.slice(i, i + 5);
    const parents = parentText.split(" ").filter(Boolean);
    if (!gitObjectIdSchema.safeParse(id).success || parents.length > 64 || parents.some((p) => !gitObjectIdSchema.safeParse(p).success)) {
      throw new WorkspaceGitServiceError("Git returned invalid commit ids.", 503);
    }
    const clean = (text: string, cap: number) => redactSecrets(text.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, cap);
    commits.push({ id, parents, author: clean(author, 100), subject: clean(subject, 500), committedAt });
  }
  return commits;
}
