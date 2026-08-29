import type { LocalWorkspaceGitBranch, LocalWorkspaceGitSnapshot } from "../../domain/models";
import { optionalGitValue } from "./execution";
import { parseUpstreamTrack } from "./statusParsing";

// The read-only halves of the Git surface that need several invocations to
// answer one question: the workspace snapshot a client renders its branch and
// sync controls from, and the HEAD blob an editor diffs against. Both take the
// already-bound readers below rather than the class, so what they can run is
// exactly what the class chose to hand them.

/** Runs one fixed argv and returns its stdout, or undefined when git failed. */
export type GitTextReader = (args: string[]) => Promise<string | undefined>;
/** Runs one fixed argv and returns raw stdout bytes. */
export type GitBlobReader = (args: string[]) => Promise<Buffer>;

export interface GitFileAtHeadResult {
  isRepository: boolean;
  existsInHead: boolean;
  objectKind?: "blob" | "other";
  sizeBytes?: number;
  content?: string;
  truncated?: boolean;
  /** The blob exists and is in range, but its bytes are not valid UTF-8 text. */
  binary?: boolean;
}

// The git tree-entry file mode for a symlink. `git cat-file -t` reports "blob"
// for a symlink's target exactly as for a regular file (that distinction lives
// in the tree entry's mode, not on the blob object), so a symlink is only
// detectable by reading its mode via `ls-tree`.
const symlinkMode = "120000";

/**
 * The workspace snapshot: current branch, remotes, every local branch with its
 * tracking state, and whether the tree is dirty. The current branch's tracking
 * state comes out of the same `for-each-ref` that builds the branch list, so
 * surfacing it at the top level costs no extra subprocess.
 */
export async function readGitSnapshot(readText: GitTextReader): Promise<LocalWorkspaceGitSnapshot> {
  const branch = optionalGitValue(await readText(["branch", "--show-current"]));
  const remotes = parseRemoteNames(await readText(["remote"]));
  const remote = optionalGitValue(await readText(["remote", "get-url", "origin"]));
  const branches = await readGitBranches(readText, branch);
  const status = await readText(["status", "--porcelain=v1", "--untracked-files=all", "--", "."]);
  const current = branches.find((candidate) => candidate.current);
  return {
    isRepository: true,
    ...(branch ? { branch } : {}),
    ...(remote ? { remote } : {}),
    hasRemote: remotes.length > 0,
    ...(current?.upstream ? { upstream: current.upstream } : {}),
    ...(current?.upstreamGone ? { upstreamGone: true } : {}),
    ...(current?.ahead !== undefined ? { ahead: current.ahead } : {}),
    ...(current?.behind !== undefined ? { behind: current.behind } : {}),
    branches,
    hasUncommittedChanges: Boolean(status?.trim())
  };
}

/** `git remote` output as a list; shared so the snapshot and the push path agree. */
export function parseRemoteNames(output: string | undefined): string[] {
  return (output ?? "")
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
}

// One `for-each-ref` supplies every local branch plus its upstream and
// ahead/behind counts, so the tracking state the client's sync controls need
// costs no subprocess beyond the branch list this already ran. The counts come
// from the remote-tracking ref, so they reflect the last fetch — which is
// exactly the semantics a "Fetch" button exists to refresh.
async function readGitBranches(
  readText: GitTextReader,
  currentBranch: string | undefined
): Promise<LocalWorkspaceGitBranch[]> {
  const output = await readText([
    "for-each-ref",
    "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
    "refs/heads"
  ]);
  return (output ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name = "", upstream = "", track = ""] = line.split("\t");
      return { name: name.trim(), upstream: upstream.trim(), track: track.trim() };
    })
    .filter((entry) => entry.name.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      current: entry.name === currentBranch,
      ...(entry.upstream ? { upstream: entry.upstream } : {}),
      ...parseUpstreamTrack(entry.track, Boolean(entry.upstream))
    }));
}

/**
 * The committed baseline behind the editor's diff decorations. Every step reads
 * against one pinned commit rather than the moving `HEAD` ref, so a concurrent
 * branch switch or commit cannot make the type, mode, size, and content checks
 * observe different commits.
 */
export async function readGitFileAtHead(
  readText: GitTextReader,
  readBlob: GitBlobReader,
  relPath: string,
  maxBytes: number
): Promise<GitFileAtHeadResult> {
  const commit = (await readText(["rev-parse", "HEAD"]))?.trim();
  // Any failure here (unborn HEAD) reads as "no baseline".
  if (!commit) return { isRepository: true, existsInHead: false };

  // `<commit>:./<path>` resolves the pathspec relative to the working directory
  // (the registered workspace), not the repository root, so a workspace
  // registered inside a larger repository stays bounded to its own subtree. The
  // path is already lexically bounded (no `..`, no absolute segments) by the caller.
  const spec = `${commit}:./${relPath}`;
  const objectType = (await readText(["cat-file", "-t", spec]))?.trim();
  // Any failure here (path not tracked at this commit) reads as "no baseline".
  if (!objectType) return { isRepository: true, existsInHead: false };
  if (objectType !== "blob") return { isRepository: true, existsInHead: true, objectKind: "other" };

  // A "blob" object type alone doesn't say whether the tree entry pointing to
  // it is a symlink -- git records that as the entry's file mode, not on the
  // blob itself, so a committed symlink and a committed regular file report the
  // identical object type here. Read the tree entry's mode and refuse a symlink
  // instead of surfacing its raw target-path text as if it were the file's real
  // committed content.
  const mode = await readBlobMode(readText, commit, relPath);
  if (mode === symlinkMode) return { isRepository: true, existsInHead: true, objectKind: "other" };

  const sizeOutput = (await readText(["cat-file", "-s", spec]))?.trim();
  const sizeBytes = sizeOutput ? Number.parseInt(sizeOutput, 10) : Number.NaN;
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return { isRepository: true, existsInHead: false };
  if (sizeBytes > maxBytes) {
    // A baseline is only useful whole (a partial baseline would diff wrongly), so
    // an over-cap blob returns metadata without content instead of streaming an
    // unbounded buffer through the executor.
    return { isRepository: true, existsInHead: true, objectKind: "blob", sizeBytes, truncated: true };
  }

  let raw: Buffer;
  try {
    raw = await readBlob(["cat-file", "blob", spec]);
  } catch {
    return { isRepository: true, existsInHead: false };
  }
  // Reject an embedded NUL (a valid but non-previewable UTF-8 code point, so the
  // round-trip check below wouldn't catch it) and reject content that doesn't
  // round-trip through UTF-8 unchanged (catches any invalid byte sequence, e.g.
  // Latin-1 text, which `Buffer#toString("utf8")` would otherwise silently
  // replace with U+FFFD instead of surfacing as the binary content it actually
  // is). Checking the raw bytes -- not the already-decoded string -- is what
  // makes the round-trip check catch invalid sequences a NUL-only check would miss.
  const content = raw.toString("utf8");
  if (raw.includes(0) || Buffer.compare(Buffer.from(content, "utf8"), raw) !== 0) {
    return { isRepository: true, existsInHead: true, objectKind: "blob", sizeBytes, binary: true };
  }
  return { isRepository: true, existsInHead: true, objectKind: "blob", sizeBytes, content, truncated: false };
}

async function readBlobMode(
  readText: GitTextReader,
  commit: string,
  relPath: string
): Promise<string | undefined> {
  const output = await readText(["ls-tree", "-z", commit, "--", `./${relPath}`]);
  const entry = output?.split("\0").find((line) => line.length > 0);
  return entry?.split(" ")[0];
}
