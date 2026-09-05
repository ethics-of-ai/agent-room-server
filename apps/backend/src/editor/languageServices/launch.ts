import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../../domain/models";
import type { LanguageServiceDescriptor, ResolvedLanguageServiceExecutable } from "./types";

export interface PreparedLanguageServiceLaunch extends ResolvedLanguageServiceExecutable {
  cleanup(): Promise<void>;
}

export async function prepareLanguageServiceLaunch(
  descriptor: LanguageServiceDescriptor,
  config: ServiceConfig
): Promise<PreparedLanguageServiceLaunch> {
  const executable = await descriptor.resolveExecutable(config);
  const storage = descriptor.temporaryStorage;
  const storagePath = storage ? await mkdtemp(join(tmpdir(), storage.prefix)) : undefined;
  let cleaned = false;
  return {
    ...executable,
    args: storagePath && storage
      ? [...executable.args, storage.argument, storagePath]
      : executable.args,
    cleanup: async () => {
      if (cleaned || !storagePath) return;
      cleaned = true;
      await rm(storagePath, { recursive: true, force: true });
    }
  };
}
