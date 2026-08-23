import { isAbsolute, relative } from "node:path";

/**
 * True when `targetPath` is `root` itself or strictly inside it. Both must already be
 * realpath-resolved by the caller. This is the single realpath-containment check shared by the
 * workspace file routes and the editor catalog asset route, so the security boundary cannot drift
 * between them.
 */
export function isInside(root: string, targetPath: string): boolean {
  const relativePath = relative(root, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Lexically reject path traversal and return a forward-slash, segment-joined relative path.
 * Rejects NUL bytes, absolute paths, and any `..` segment by calling `reject` (the caller supplies
 * its own typed error so the message/status stays caller-specific). Empty or `.`-only input
 * returns "" — callers that forbid an empty path check the result. Shared by WorkspaceExplorer and
 * EditorCatalogStore so the lexical half of the bound is defined once on the security boundary.
 */
export function boundedRelativeSegments(input: string, reject: (message: string) => never): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed || trimmed === ".") return "";
  if (trimmed.includes("\0") || isAbsolute(trimmed)) {
    reject("Path must stay inside the root");
  }
  const parts = trimmed.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    reject("Path must stay inside the root");
  }
  return parts.join("/");
}
