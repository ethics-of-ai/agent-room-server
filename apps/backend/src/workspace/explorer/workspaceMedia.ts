import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { isInside } from "../../util/pathBounding";
import type { WorkspaceTarget } from "./paths";
import { indexableRelativePath, normalizeWorkspaceRelativePath } from "./paths";
import { workspaceMediaContentType, workspaceMediaKind, type WorkspaceMediaKind } from "./mediaKind";

export type WorkspaceMediaErrorCode =
  | "invalid_path"
  | "workspace_not_found"
  | "forbidden_path"
  | "file_not_found"
  | "file_changed"
  | "unsupported_media"
  | "media_busy"
  | "media_cancelled";

export class WorkspaceMediaError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: WorkspaceMediaErrorCode
  ) {
    super(message);
  }
}

export interface WorkspaceMediaRead {
  path: string;
  name: string;
  kind: WorkspaceMediaKind;
  contentType: string;
  stream: Readable;
  byteLength: bigint;
  modifiedAt: Date;
}

/** Owns the process-wide admission bound through snapshot creation and response streaming. */
export class WorkspaceMediaReader {
  private activeReads = 0;

  constructor(private readonly operation: typeof readWorkspaceMedia = readWorkspaceMedia) {}

  async read(target: WorkspaceTarget, input: { path: string; signal?: AbortSignal }): Promise<WorkspaceMediaRead> {
    if (this.activeReads >= 2) {
      throw new WorkspaceMediaError("Media preview is busy", 503, "media_busy");
    }
    this.activeReads += 1;
    try {
      const media = await this.operation(target, input);
      media.stream.once("close", () => { this.activeReads -= 1; });
      return media;
    } catch (error) {
      this.activeReads -= 1;
      throw error;
    }
  }
}

export async function readWorkspaceMedia(
  target: WorkspaceTarget,
  input: { path: string; signal?: AbortSignal }
): Promise<WorkspaceMediaRead> {
  const safePath = normalizeMediaPath(input.path);
  const kind = workspaceMediaKind(safePath);
  const contentType = workspaceMediaContentType(safePath);
  if (!kind || !contentType) unsupported("Workspace file type is not supported for media preview");
  throwIfAborted(input.signal);

  const targetPath = resolve(target.workspaceRoot, safePath);
  let parentRealPath: string;
  try {
    parentRealPath = await realpath(dirname(targetPath));
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (!isInside(target.workspaceRoot, parentRealPath)) forbidden("Workspace path leaves the registered workspace");
  assertAllowedResolvedPath(target.workspaceRoot, resolve(parentRealPath, basename(targetPath)));

  let validatedStat;
  try {
    validatedStat = await lstat(targetPath, { bigint: true });
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (validatedStat.isSymbolicLink()) forbidden("Media preview does not follow file symlinks");
  if (!validatedStat.isFile()) unsupported("Workspace media path must name a regular file");

  let handle;
  try {
    // A regular entry can be replaced by a FIFO between lstat and open.
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  let snapshot: Awaited<ReturnType<typeof open>> | undefined;
  let handedOff = false;
  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!sameSnapshot(validatedStat, openedStat) || !openedStat.isFile()) changed();
    snapshot = await openAnonymousSnapshot();
    const header = await copySnapshot(handle, snapshot, openedStat.size, input.signal);
    const postReadStat = await handle.stat({ bigint: true });
    if (!sameSnapshot(openedStat, postReadStat)) changed();

    let currentStat;
    let currentRealPath: string;
    try {
      currentStat = await lstat(targetPath, { bigint: true });
      currentRealPath = await realpath(targetPath);
    } catch (error) {
      if (isFilesystemCode(error, "ENOENT")) changed();
      throw mapFilesystemError(error);
    }
    if (
      currentStat.isSymbolicLink() ||
      !sameSnapshot(postReadStat, currentStat) ||
      !isInside(target.workspaceRoot, currentRealPath)
    ) {
      changed();
    }
    assertAllowedResolvedPath(target.workspaceRoot, currentRealPath);
    validateSignature(kind, contentType, header, openedStat.size);
    await handle.close();
    throwIfAborted(input.signal);
    const stream = snapshot.createReadStream({ start: 0, signal: input.signal });
    handedOff = true;
    return {
      path: safePath,
      name: basename(safePath),
      kind,
      contentType,
      stream,
      byteLength: openedStat.size,
      modifiedAt: new Date(Number(postReadStat.mtimeMs))
    };
  } finally {
    if (!handedOff) {
      try {
        await snapshot?.close();
      } finally {
        await handle.close();
      }
    }
  }
}

// Unlink the private temporary file immediately. Its descriptor owns the disk
// allocation until the response stream closes, including disconnects and errors.
async function openAnonymousSnapshot(): Promise<Awaited<ReturnType<typeof open>>> {
  const directory = await mkdtemp(join(tmpdir(), "agentroom-media-"));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = join(directory, "snapshot");
    handle = await open(path, "wx+", 0o600);
    await unlink(path);
    await rm(directory, { recursive: true });
    return handle;
  } catch (error) {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function copySnapshot(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  expectedSize: bigint,
  signal?: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const header = Buffer.alloc(Number(expectedSize < 30n ? expectedSize : 30n));
  let copied = 0n;
  while (true) {
    throwIfAborted(signal);
    // Read no more than the original size plus one byte, even if the file grows.
    const length = Number(expectedSize - copied < BigInt(buffer.length)
      ? expectedSize - copied + 1n : BigInt(buffer.length));
    const { bytesRead } = await source.read(buffer, 0, length, null);
    if (bytesRead === 0) break;
    if (copied < BigInt(header.length)) {
      buffer.copy(header, Number(copied), 0, Math.min(bytesRead, header.length - Number(copied)));
    }
    copied += BigInt(bytesRead);
    if (copied > expectedSize) changed();
    let written = 0;
    while (written < bytesRead) {
      throwIfAborted(signal);
      const result = await destination.write(buffer, written, bytesRead - written, null);
      if (result.bytesWritten === 0) throw new Error("Media snapshot write made no progress");
      written += result.bytesWritten;
    }
  }
  if (copied !== expectedSize) changed();
  return header;
}

function validateSignature(kind: WorkspaceMediaKind, contentType: string, bytes: Buffer, byteLength: bigint): void {
  if (kind === "image") {
    if (contentType === "image/png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
    if (contentType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return;
    if (
      contentType === "image/webp" &&
      bytes.length >= 12 &&
      bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
      bytes.subarray(8, 12).equals(Buffer.from("WEBP")) &&
      BigInt(bytes.readUInt32LE(4)) + 8n === byteLength
    ) return;
    unsupported("Workspace image signature does not match its file extension");
  }
  if (kind === "pdf") {
    if (bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return;
    unsupported("Workspace PDF signature is invalid");
  }
  // Only identify the container here. Quick Look, in its own process, validates
  // and renders the package; AgentRoom never extracts it or resolves USD assets.
  if (kind === "usdz" && bytes.length >= 30 && bytes.readUInt32LE(0) === 0x04034b50) return;
  unsupported("Workspace USDZ ZIP signature is invalid");
}

function normalizeMediaPath(inputPath: string): string {
  let safePath: string;
  try {
    safePath = normalizeWorkspaceRelativePath(inputPath);
  } catch {
    throw new WorkspaceMediaError("Workspace media path is invalid", 400, "invalid_path");
  }
  if (!safePath) throw new WorkspaceMediaError("Workspace media path is required", 400, "invalid_path");
  if (indexableRelativePath(safePath) !== safePath) forbidden("Workspace media path is protected");
  return safePath;
}

function assertAllowedResolvedPath(workspaceRoot: string, resolvedPath: string): void {
  const resolvedRelativePath = relative(workspaceRoot, resolvedPath);
  if (indexableRelativePath(resolvedRelativePath) !== resolvedRelativePath) {
    forbidden("Workspace media path is protected");
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

type BigIntStats = Awaited<ReturnType<typeof lstat>> & {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
};

function mapFilesystemError(error: unknown): Error {
  if (isFilesystemCode(error, "ENOENT") || isFilesystemCode(error, "ENOTDIR")) {
    return new WorkspaceMediaError("Workspace media file was not found", 404, "file_not_found");
  }
  if (
    isFilesystemCode(error, "EACCES") ||
    isFilesystemCode(error, "EPERM") ||
    isFilesystemCode(error, "ELOOP")
  ) {
    return new WorkspaceMediaError("Workspace media path is forbidden", 403, "forbidden_path");
  }
  return new Error("Workspace media file could not be read", { cause: error });
}

function isFilesystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceMediaError("Media read was cancelled", 499, "media_cancelled");
}

function forbidden(message: string): never {
  throw new WorkspaceMediaError(message, 403, "forbidden_path");
}

function unsupported(message: string): never {
  throw new WorkspaceMediaError(message, 415, "unsupported_media");
}

function changed(): never {
  throw new WorkspaceMediaError("Workspace media file changed while it was being read", 409, "file_changed");
}
