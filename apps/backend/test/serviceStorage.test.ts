import { describe, expect, it } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServiceConfig } from "../src/config/serviceConfig";
import { initializeServiceStorage } from "../src/config/serviceStorage";

describe("service storage initialization", () => {
  it("creates the app-managed config, workspace, and state directories", async () => {
    await withCleanEnv(async () => {
      const agentRoomHome = await mkdtemp(join(tmpdir(), "agentroom-home-"));
      process.env.AGENTROOM_HOME = agentRoomHome;
      const config = getServiceConfig();

      await initializeServiceStorage(config);

      await expectDirectory(join(agentRoomHome, "config"));
      await expectDirectory(config.workspaceRoot);
      await expectDirectory(config.stateDir);
      // The backend serves only its bundled editor catalog, so it no longer
      // creates the retired operator override directory.
      await expect(stat(join(agentRoomHome, "catalog-assets"))).rejects.toThrow();
    });
  });
});

async function expectDirectory(path: string): Promise<void> {
  expect((await stat(path)).isDirectory()).toBe(true);
}

async function withCleanEnv(run: () => Promise<void>): Promise<void> {
  const names = ["AGENTROOM_HOME", "WORKSPACE_ROOT", "STATE_DIR"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    delete process.env[name];
  }
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
