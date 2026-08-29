import { stat } from "node:fs/promises";
import type { WorkspaceFilePreview, WorkspaceTreeEntry } from "../../domain/models";
import { contextTreeDepth, maxPreviewBytes } from "./bounds";
import { readDirectoryEntries } from "./directoryRead";
import { readFilePreview } from "./filePreview";
import { normalizeWorkspaceRelativePath, resolveInsideWorkspace, type WorkspaceTarget } from "./paths";

/**
 * Turn-prompt context for the paths a person explicitly selected: each one is
 * bounded and resolved by the same read path a browse uses, and the original
 * user message is preserved verbatim beneath the blocks. Nothing here selects
 * files on its own.
 */
export async function buildPromptWithContext(
  target: WorkspaceTarget,
  message: string,
  paths: string[]
): Promise<string> {
  const blocks: string[] = [];
  for (const inputPath of paths) {
    const safePath = normalizeWorkspaceRelativePath(inputPath);
    const targetPath = await resolveInsideWorkspace(target.workspaceRoot, safePath);
    const targetStat = await stat(targetPath);
    if (targetStat.isDirectory()) {
      const tree = await readDirectoryEntries(target.workspaceRoot, targetPath, safePath, contextTreeDepth);
      blocks.push(formatDirectoryContext(safePath, tree));
    } else {
      const preview = await readFilePreview(target.workspaceId, targetPath, safePath, maxPreviewBytes);
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
