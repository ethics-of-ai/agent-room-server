import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { LanguageServiceError } from "./errors";

/** Resolve a package-owned JavaScript entry point without admitting symlinks. */
export async function bundledRegularFile(moduleId: string, displayName: string): Promise<string> {
  let resolved: string;
  try {
    resolved = require.resolve(moduleId);
  } catch {
    throw new LanguageServiceError("service_unavailable", `${displayName} is unavailable`);
  }
  if (!isAbsolute(resolved)) {
    throw new LanguageServiceError("service_unavailable", `${displayName} path is invalid`);
  }
  const entry = await lstat(resolved).catch(() => undefined);
  if (!entry?.isFile() || entry.isSymbolicLink()) {
    throw new LanguageServiceError("service_unavailable", `${displayName} path is invalid`);
  }
  return realpath(resolved);
}
