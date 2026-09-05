import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { LocalWorkspace } from "../../domain/models";
import { isInside } from "../../util/pathBounding";
import { indexableRelativePath, normalizeWorkspaceRelativePath } from "../../workspace/explorer/paths";
import { LanguageServiceError } from "./errors";
import type { LanguageServiceDescriptor, LanguageServiceProjectMarker } from "./types";

export interface ResolvedLanguageServiceProject {
  readonly descriptor: LanguageServiceDescriptor;
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly relativePath: string;
  readonly projectRoot: string;
  readonly relativeProjectRoot: string;
  readonly marker?: string;
}

interface MarkerMatch {
  name: string;
  marker: LanguageServiceProjectMarker;
}

/** Resolve a client path and reject every symlink segment, including contained aliases. */
async function resolveRegularWorkspaceFile(workspace: LocalWorkspace, rawPath: string): Promise<{
  workspaceRoot: string;
  filePath: string;
  relativePath: string;
}> {
  let relativePath: string;
  try {
    relativePath = normalizeWorkspaceRelativePath(rawPath);
  } catch {
    throw new LanguageServiceError("invalid_path", "Document path must stay inside the workspace");
  }
  if (!indexableRelativePath(relativePath)) {
    throw new LanguageServiceError("invalid_path", "Document path is not editor-readable");
  }

  const workspaceRoot = await realpath(workspace.path).catch(() => {
    throw new LanguageServiceError("workspace_not_found", "Workspace is unavailable");
  });
  let cursor = workspaceRoot;
  for (const segment of relativePath.split("/")) {
    cursor = join(cursor, segment);
    const entry = await lstat(cursor).catch(() => undefined);
    if (!entry) throw new LanguageServiceError("invalid_path", "Document was not found");
    if (entry.isSymbolicLink()) {
      throw new LanguageServiceError("invalid_path", "Symbolic-link documents are not supported");
    }
  }
  const fileRealPath = await realpath(cursor);
  if (!isInside(workspaceRoot, fileRealPath) || !(await lstat(fileRealPath)).isFile()) {
    throw new LanguageServiceError("invalid_path", "Document must be a regular workspace file");
  }
  // The LSP URI, lease, and version sequence must identify the same file, even
  // when a case-insensitive filesystem accepts another spelling of its path.
  return { workspaceRoot, filePath: fileRealPath, relativePath: relative(workspaceRoot, fileRealPath) };
}

function matchingMarkers(
  entries: readonly { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[],
  descriptor: LanguageServiceDescriptor
): MarkerMatch[] {
  const matches: MarkerMatch[] = [];
  for (const marker of descriptor.projectMarkers) {
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (marker.entryType === "file" && !entry.isFile()) continue;
      if (marker.entryType === "directory" && !entry.isDirectory()) continue;
      const name = entry.name;
      const matched = marker.kind === "exact" ? name === marker.value : name.endsWith(marker.value);
      if (matched) matches.push({ name, marker });
    }
  }
  return matches;
}

async function findDescriptorRoot(
  descriptor: LanguageServiceDescriptor,
  workspaceRoot: string,
  filePath: string
): Promise<{ projectRoot: string; marker?: string; distance: number; priority: number } | undefined> {
  let directory = dirname(filePath);
  let distance = 0;
  while (isInside(workspaceRoot, directory)) {
    const entries = await readdir(directory, { withFileTypes: true });
    const matches = matchingMarkers(entries, descriptor);
    if (matches.length > 0) {
      const priority = Math.max(...matches.map((match) => match.marker.priority));
      const winners = matches.filter((match) => match.marker.priority === priority);
      if (winners.length !== 1) {
        throw new LanguageServiceError("ambiguous_project", "More than one project marker has equal priority");
      }
      return { projectRoot: directory, marker: winners[0].name, distance, priority };
    }
    if (directory === workspaceRoot) break;
    directory = dirname(directory);
    distance += 1;
  }
  return descriptor.standaloneWorkspaceRoot
    ? { projectRoot: workspaceRoot, distance: Number.MAX_SAFE_INTEGER, priority: -1 }
    : undefined;
}

export async function resolveLanguageServiceProject(
  workspace: LocalWorkspace,
  rawPath: string,
  languageId: string,
  descriptors: readonly LanguageServiceDescriptor[]
): Promise<ResolvedLanguageServiceProject> {
  const file = await resolveRegularWorkspaceFile(workspace, rawPath);
  const candidates = descriptors.filter((descriptor) => descriptor.languageIds.includes(languageId));
  if (candidates.length === 0) {
    throw new LanguageServiceError("unsupported_language", "No language service supports this language");
  }

  const resolved = (
    await Promise.all(candidates.map(async (descriptor) => ({
      descriptor,
      root: await findDescriptorRoot(descriptor, file.workspaceRoot, file.filePath)
    })))
  ).filter((candidate): candidate is { descriptor: LanguageServiceDescriptor; root: NonNullable<typeof candidate.root> } =>
    candidate.root !== undefined
  );
  if (resolved.length === 0) {
    throw new LanguageServiceError("project_not_found", "No language-service project contains this document");
  }
  resolved.sort((left, right) =>
    left.root.distance - right.root.distance || right.root.priority - left.root.priority
  );
  const winner = resolved[0];
  const runnerUp = resolved[1];
  if (runnerUp && runnerUp.root.distance === winner.root.distance && runnerUp.root.priority === winner.root.priority) {
    throw new LanguageServiceError("ambiguous_project", "More than one language service matches this project");
  }
  const relativeProjectRoot = relative(file.workspaceRoot, winner.root.projectRoot).split("\\").join("/");
  return {
    descriptor: winner.descriptor,
    ...file,
    projectRoot: winner.root.projectRoot,
    relativeProjectRoot,
    ...(winner.root.marker ? { marker: winner.root.marker } : {})
  };
}

export function languageServiceInstanceKey(
  workspaceId: string,
  descriptorId: string,
  projectRoot: string
): string {
  return `${workspaceId}\0${descriptorId}\0${projectRoot}`;
}
