import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceConfig } from "../domain/models";

export async function initializeServiceStorage(config: ServiceConfig): Promise<void> {
  const directories = [config.workspaceRoot, config.stateDir, config.editorCatalogDir];
  if (config.agentRoomHome) {
    directories.push(config.agentRoomHome, join(config.agentRoomHome, "config"));
  }

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }
}
