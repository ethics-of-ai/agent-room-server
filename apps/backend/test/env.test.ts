import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadDotenvFiles, resolveDotenvPaths } from "../src/config/env";

describe("env loading", () => {
  const managedNames = ["AGENTROOM_HOME", "AUTH_TOKEN", "STATE_DIR", "WORKSPACE_ROOT"];
  const previousEnv = new Map(managedNames.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("checks the backend cwd and repo root for .env files", () => {
    delete process.env.AGENTROOM_HOME;

    const repoRoot = resolve(__dirname, "../../..");
    const backendRoot = resolve(repoRoot, "apps/backend");
    const configDir = resolve(backendRoot, "src/config");

    expect(resolveDotenvPaths(backendRoot, configDir)).toEqual([
      resolve(backendRoot, ".env"),
      resolve(repoRoot, ".env")
    ]);
  });

  it("also checks the app-managed config directory when AGENTROOM_HOME is set", () => {
    const repoRoot = resolve(__dirname, "../../..");
    const backendRoot = resolve(repoRoot, "apps/backend");
    const configDir = resolve(backendRoot, "dist/config");
    const agentRoomHome = join("/tmp", "AgentRoom");

    expect(resolveDotenvPaths(backendRoot, configDir, agentRoomHome)).toEqual([
      resolve(backendRoot, ".env"),
      resolve(repoRoot, ".env"),
      join(agentRoomHome, "config", ".env")
    ]);
  });

  it("lets app-managed .env override dev .env without overriding launcher env", async () => {
    for (const name of managedNames) {
      delete process.env[name];
    }

    const repoRoot = await mkdtemp(join(tmpdir(), "agentroom-env-"));
    const backendRoot = join(repoRoot, "apps", "backend");
    const configDir = join(backendRoot, "dist", "config");
    const agentRoomHome = join(repoRoot, "home");
    await mkdir(configDir, { recursive: true });
    await mkdir(join(agentRoomHome, "config"), { recursive: true });
    await writeFile(
      join(backendRoot, ".env"),
      [
        `AGENTROOM_HOME=${agentRoomHome}`,
        "AUTH_TOKEN=dev-token",
        `STATE_DIR=${join(repoRoot, "dev-state")}`,
        `WORKSPACE_ROOT=${join(repoRoot, "dev-workspaces")}`
      ].join("\n")
    );
    await writeFile(
      join(agentRoomHome, "config", ".env"),
      [
        "AUTH_TOKEN=app-token",
        `STATE_DIR=${join(agentRoomHome, "state")}`,
        `WORKSPACE_ROOT=${join(agentRoomHome, "workspaces")}`
      ].join("\n")
    );
    process.env.AUTH_TOKEN = "launcher-token";

    loadDotenvFiles(backendRoot, configDir, new Set(["AUTH_TOKEN"]));

    expect(process.env.AUTH_TOKEN).toBe("launcher-token");
    expect(process.env.STATE_DIR).toBe(join(agentRoomHome, "state"));
    expect(process.env.WORKSPACE_ROOT).toBe(join(agentRoomHome, "workspaces"));
  });
});
