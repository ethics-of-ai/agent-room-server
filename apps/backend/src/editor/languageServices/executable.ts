import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ServiceConfig } from "../../domain/models";
import { LanguageServiceError } from "./errors";
import type { LanguageServiceDescriptor } from "./types";

export async function admittedLanguageServiceExecutable(
  path: string | undefined,
  displayName: string
): Promise<string> {
  if (!path) throw new LanguageServiceError("service_unavailable", `${displayName} is not configured`);
  if (!isAbsolute(path)) {
    throw new LanguageServiceError("service_unavailable", `${displayName} path must be absolute`);
  }
  const entry = await lstat(path).catch(() => undefined);
  if (!entry?.isFile() || entry.isSymbolicLink()) {
    throw new LanguageServiceError(
      "service_unavailable",
      `${displayName} path is not an executable regular file`
    );
  }
  await access(path, constants.X_OK).catch(() => {
    throw new LanguageServiceError("service_unavailable", `${displayName} path is not executable`);
  });
  return realpath(path);
}

export function configuredExecutableDescriptorFields(
  configuredPath: (config: ServiceConfig) => string | undefined,
  displayName: string,
  args: readonly string[]
): Pick<LanguageServiceDescriptor, "configured" | "resolveExecutable"> {
  return {
    configured: (config) => Boolean(configuredPath(config)),
    resolveExecutable: async (config) => ({
      command: await admittedLanguageServiceExecutable(configuredPath(config), displayName),
      args
    })
  };
}
