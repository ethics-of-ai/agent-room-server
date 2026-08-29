import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";
import { isHiddenEntryName, maxSubtreeBytes, maxSubtreeEntries } from "./bounds";
import { WorkspaceExplorerError } from "./errors";

export interface SubtreeInventory {
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
}

// Complete, bounded inventory of a subtree, shared by recursive deletion and
// recursive copy. It walks everything before either caller touches a byte, so
// an over-cap or protected tree is refused whole rather than half-processed.
// `verb` only reaches the two cap messages; every refusal below it is a
// property of the tree rather than of what was going to happen to it.
export async function inspectBoundedSubtree(rootPath: string, verb: "delete" | "copy"): Promise<SubtreeInventory> {
  let entryCount = 1;
  let fileCount = 0;
  let directoryCount = 1;
  let sizeBytes = 0;
  const pendingDirectories = [rootPath];

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop()!;
    for await (const { entryPath, entryStat } of boundedSubtreeEntries(directoryPath)) {
      entryCount += 1;
      if (entryCount > maxSubtreeEntries) {
        throw new WorkspaceExplorerError(`Workspace directory has too many entries to ${verb}`, 413);
      }
      if (entryStat.isDirectory()) {
        directoryCount += 1;
        pendingDirectories.push(entryPath);
      } else if (entryStat.isFile()) {
        fileCount += 1;
        sizeBytes += entryStat.size;
        if (sizeBytes > maxSubtreeBytes) {
          throw new WorkspaceExplorerError(`Workspace directory is too large to ${verb}`, 413);
        }
      } else {
        throw new WorkspaceExplorerError("Workspace directory contains an unsupported entry", 415);
      }
    }
  }

  return { fileCount, directoryCount, sizeBytes };
}

// Recursive copy of an already-inventoried tree into a fresh staging directory.
// It re-checks every entry as it walks rather than trusting the inventory: the
// two passes run over a live filesystem — the same race the recursive delete
// documents — and re-checking is what keeps a symlink planted in between from
// being followed. `node:fs.cp` is deliberately not used: it would decide about
// symlinks, filters, and overwrites on its own.
export async function copyBoundedSubtree(
  sourcePath: string,
  destinationPath: string,
  sourceStat: Stats
): Promise<SubtreeInventory> {
  assertUnchangedDirectory(await restatCopySource(sourcePath), sourceStat);
  await mkdir(destinationPath, { mode: sourceStat.mode & 0o777 });
  const pending: Array<{ source: string; destination: string; expected: Stats }> = [
    { source: sourcePath, destination: destinationPath, expected: sourceStat }
  ];
  let entryCount = 1;
  let fileCount = 0;
  let directoryCount = 1;
  let sizeBytes = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    for await (const { name, entryPath, entryStat } of boundedSubtreeEntries(directory.source, directory.expected)) {
      const entryDestination = join(directory.destination, name);
      entryCount += 1;
      if (entryCount > maxSubtreeEntries) {
        throw new WorkspaceExplorerError("Workspace directory has too many entries to copy", 413);
      }
      if (entryStat.isDirectory()) {
        directoryCount += 1;
        await mkdir(entryDestination, { mode: entryStat.mode & 0o777 });
        pending.push({ source: entryPath, destination: entryDestination, expected: entryStat });
      } else if (entryStat.isFile()) {
        fileCount += 1;
        sizeBytes += await copyBoundedFile(entryPath, entryDestination, entryStat);
        if (sizeBytes > maxSubtreeBytes) {
          throw new WorkspaceExplorerError("Workspace directory is too large to copy", 413);
        }
      } else {
        throw new WorkspaceExplorerError("Workspace directory contains an unsupported entry", 415);
      }
    }
  }

  return { fileCount, directoryCount, sizeBytes };
}

/**
 * Copies one regular file through an already-open, no-follow source handle.
 * The handle pins the inode that passed validation, so replacing the source
 * path cannot redirect the read. A second stat after the copy rejects an
 * in-place change, and the byte counter keeps a growing file under the cap.
 */
export async function copyBoundedFile(
  sourcePath: string,
  destinationPath: string,
  expectedSource: Stats
): Promise<number> {
  let source;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw copySourceReadError(error);
  }

  try {
    const openedSource = await source.stat();
    assertUnchangedFile(openedSource, expectedSource);
    if (openedSource.size > maxSubtreeBytes) {
      throw new WorkspaceExplorerError("Workspace file is too large to copy", 413);
    }

    const destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      openedSource.mode & 0o777
    );
    let copiedBytes = 0;
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, copiedBytes);
        if (bytesRead === 0) break;
        if (copiedBytes + bytesRead > maxSubtreeBytes) {
          throw new WorkspaceExplorerError("Workspace file is too large to copy", 413);
        }
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(buffer, written, bytesRead - written, null);
          written += result.bytesWritten;
        }
        copiedBytes += bytesRead;
      }
    } finally {
      await destination.close();
    }

    assertUnchangedFile(await source.stat(), openedSource);
    return copiedBytes;
  } finally {
    await source.close();
  }
}

/**
 * One directory's entries with the refusals both subtree passes share: a
 * protected or generated name and a symlink fail the whole operation, and a
 * directory or entry that vanished mid-walk is reported as the optimistic-lock
 * answer rather than as a raw ENOENT. Yielding lazily keeps a caller's cap
 * check between entries, so a hostile tree stops the walk where the cap says
 * rather than after the whole directory is stat'd.
 */
async function* boundedSubtreeEntries(
  directoryPath: string,
  expectedDirectory?: Stats
): AsyncGenerator<{ name: string; entryPath: string; entryStat: Stats }> {
  if (expectedDirectory) {
    assertUnchangedDirectory(await restatCopySource(directoryPath), expectedDirectory);
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    throw subtreeReadError(error);
  }

  for (const entry of entries) {
    if (isHiddenEntryName(entry.name)) {
      throw new WorkspaceExplorerError("Workspace directory contains protected entries", 415);
    }
    const entryPath = join(directoryPath, entry.name);
    let entryStat: Stats;
    try {
      entryStat = await lstat(entryPath);
    } catch (error) {
      throw subtreeReadError(error);
    }
    if (entryStat.isSymbolicLink()) {
      throw new WorkspaceExplorerError("Workspace directory contains a symbolic link", 415);
    }
    yield { name: entry.name, entryPath, entryStat };
  }
  if (expectedDirectory) {
    assertUnchangedDirectory(await restatCopySource(directoryPath), expectedDirectory);
  }
}

function subtreeReadError(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new WorkspaceExplorerError("Workspace directory changed since it was loaded", 409);
  }
  return error;
}

async function restatCopySource(sourcePath: string): Promise<Stats> {
  try {
    return await lstat(sourcePath);
  } catch (error) {
    throw copySourceReadError(error);
  }
}

function copySourceReadError(error: unknown): unknown {
  if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
    return new WorkspaceExplorerError("Workspace entry changed since it was loaded", 409);
  }
  return error;
}

function assertUnchangedDirectory(current: Stats, expected: Stats): void {
  if (!current.isDirectory() || current.isSymbolicLink() || !sameEntryVersion(current, expected)) {
    throw new WorkspaceExplorerError("Workspace directory changed since it was loaded", 409);
  }
}

function assertUnchangedFile(current: Stats, expected: Stats): void {
  if (!current.isFile() || current.isSymbolicLink() || !sameEntryVersion(current, expected)) {
    throw new WorkspaceExplorerError("Workspace entry changed since it was loaded", 409);
  }
}

function sameEntryVersion(current: Stats, expected: Stats): boolean {
  return current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs;
}
