import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ServiceConfig } from "../src/domain/models";
import { prepareDeepSeekComposition } from "../src/runner/deepseek/cordis/composition";
import { validateAgentRoomCordisComposition } from "../src/runner/deepseek/cordis/runtime";
import { prepareDeepSeekBootstrap } from "../src/runner/deepseek/bootstrap";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const jsTag = { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] };

async function fixture(): Promise<ServiceConfig> {
  const root = await mkdtemp(join(tmpdir(), "deepseek managed 'source-"));
  roots.push(root);
  const source = join(root, "cordis.patch.yml");
  await writeFile(source, "# operator-owned, never modified\n- insert:\n    - name: arbitrary-custom-plugin\n");
  return { stateDir: join(root, "app support", "state"), deepseekCordisConfig: source,
    deepseekCompositionMode: "managed", deepseekArgs: [] } as unknown as ServiceConfig;
}

type Row = { id: string; name: string; inject?: string[]; config?: Record<string, unknown> };
const rowsOf = (content: string): Row[] => (parse(content, jsTag) as Array<{ insert: Row[] }>)[0].insert;

describe("DeepSeek managed composition", () => {
  it("generates one insert patch with fixed policy and private immutable generations after app relocation", async () => {
    const config = await fixture();
    const original = await readFile(config.deepseekCordisConfig!, "utf8");
    const first = await prepareDeepSeekComposition(config, "/Applications/AgentRoom.app/plugin.js");
    expect(await prepareDeepSeekComposition(config, "/Applications/AgentRoom.app/plugin.js")).toBe(first);
    const moved = await prepareDeepSeekComposition(config, "/Applications/My AgentRoom.app/plugin.js");
    expect(moved).not.toBe(first);
    expect(moved).toMatch(/v2-[0-9a-f]{64}\.yml$/);
    const content = await readFile(moved, "utf8");
    expect(content).not.toContain("arbitrary-custom-plugin");
    expect((await stat(moved)).mode & 0o777).toBe(0o600);
    expect(await readFile(config.deepseekCordisConfig!, "utf8")).toBe(original);

    // Unknown tags are read as scalar data; the backend never evaluates !!js.
    const rows = rowsOf(content);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("agentroom-tools")?.name).toBe("/Applications/My AgentRoom.app/plugin.js");
    expect(byId.get("sdk-jsonrpc-server")).toMatchObject({ inject: ["sdkAppStartup", "loader"] });
    expect(byId.get("sandbox-policy")?.config).toEqual({ mode: "workspace-write", workspaceRoot: "process.env.DSH_CWD" });
    expect(byId.get("fs")).toMatchObject({ name: "@deepseek-ai/dsh-fs-sandbox", config: { cwd: "process.env.DSH_CWD" } });
    expect(byId.get("bash")).toMatchObject({ name: "@deepseek-ai/dsh-bash-sandbox", config: { timeoutMs: 60000 } });
    expect(byId.get("tool-bash")?.config).toEqual({ enableRunInBackground: true });
    expect(byId.get("sessions")?.config).toEqual({ root: "process.env.DSH_SESSION_ROOT", compression: "none" });
    // Background shell jobs wake the agent when they settle, at most three
    // times before a person's message refills the budget.
    expect(byId.get("jobs")?.name).toBe("@deepseek-ai/dsh-jobs-local");
    expect(byId.get("tool-jobs")).toMatchObject({
      name: "@deepseek-ai/dsh-tool-jobs",
      config: { completionDelivery: "wakeup", maxConsecutiveWakes: 3 }
    });
    // Background subagents run in process through the one `subagent` tool.
    expect(byId.get("subagent")?.name).toBe("@deepseek-ai/dsh-subagent");
    expect(byId.get("subagent-spawn")).toMatchObject({
      name: "@deepseek-ai/dsh-subagent-spawn-in-process",
      config: { providerName: "spawn" }
    });
    expect(byId.get("tool-subagent")).toMatchObject({
      name: "@deepseek-ai/dsh-tool-subagent",
      config: { provider: "spawn", toolName: "subagent" }
    });
    // Forked subagents, workspace instructions, skills, and session-log upload
    // stay unmounted; the graph names nothing it does not use.
    const names = rows.map((row) => row.name);
    for (const absent of ["subagent-fork", "agent-instructions", "skill", "session-log-deepseek"]) {
      expect(names.some((name) => name.includes(absent)), absent).toBe(false);
    }
  });

  it("drops every model-facing tool from the provider check", async () => {
    const config = await fixture();
    const rows = rowsOf(await readFile(await prepareDeepSeekComposition(config, undefined, "connection_test"), "utf8"));
    const names = rows.map((row) => row.name);
    expect(names).toContain("@deepseek-ai/dsh-sdk-jsonrpc-server");
    for (const tool of ["tool-bash", "tool-fs", "bash-sandbox", "shell-env", "jobs-local", "tool-jobs", "subagent", "subagent-spawn-in-process", "tool-subagent"]) {
      expect(names).not.toContain(`@deepseek-ai/dsh-${tool}`);
    }
    expect(rows.some((row) => row.id === "agentroom-tools")).toBe(false);
  });

  it("passes the custom patch through without creating generated storage", async () => {
    const config = await fixture();
    expect(await prepareDeepSeekComposition({ ...config, deepseekCompositionMode: "custom" })).toBe(config.deepseekCordisConfig);
    await expect(stat(config.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses modified or symlinked generations", async () => {
    const config = await fixture();
    const path = await prepareDeepSeekComposition(config);
    await writeFile(path, "tampered");
    await expect(prepareDeepSeekComposition(config)).rejects.toThrow("modified");
    await rm(path);
    await symlink(config.deepseekCordisConfig!, path);
    await expect(prepareDeepSeekComposition(config)).rejects.toThrow("modified");
  });
});

describe("DeepSeek profile launch", () => {
  it("boots AgentRoom's empty profile in a pinned home with the overlay as the whole graph", async () => {
    const config = await fixture();
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = "/Users/me/.dsh";
    try {
      const launch = await prepareDeepSeekBootstrap({ ...config, deepseekArgs: ["/opt/dsh/apps/cli/lib/bin.js"] }, "/Users/me/repos/app", false);
      const home = join(config.stateDir, "deepseek", "home");
      expect(launch.cwd).toBe(home);
      expect(launch.env.DSH_HOME).toBe(home);
      expect(launch.env.DSH_CWD).toBe("/Users/me/repos/app");
      expect(launch.args.slice(0, 4)).toEqual(["/opt/dsh/apps/cli/lib/bin.js", "--profile", "agentroom", "--patch"]);
      expect(launch.args[4]).toMatch(/deepseek\/compositions\/v2-/);
      const profile = join(home, "profiles", "agentroom");
      expect(JSON.parse(await readFile(join(profile, "package.json"), "utf8")).dsh).toEqual({ profile: { bundles: [] } });
      expect(await readFile(join(profile, "cordis.patch.yml"), "utf8")).toBe("[]\n");

      // A stray home-level patch would add rows to every profile; the next
      // launch clears it.
      await writeFile(join(home, "cordis.patch.yml"), "- insert:\n    - name: injected\n");
      await prepareDeepSeekBootstrap(config, "/Users/me/repos/app", false);
      expect(await readFile(join(home, "cordis.patch.yml"), "utf8")).toBe("[]\n");
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  });

  it("mounts the AgentRoom plugin in every managed session, so background work can be stopped", async () => {
    const config = await fixture();
    const launch = await prepareDeepSeekBootstrap(config, "/Users/me/repos/app", false);

    expect(launch.pluginPath).toMatch(/agentRoomToolsPlugin\.js$/);
    expect(launch.env.AGENTROOM_DEEPSEEK_TOOLS_FD).toBe("3");
    const rows = rowsOf(await readFile(launch.args.at(-1)!, "utf8"));
    expect(rows.find((row) => row.id === "agentroom-tools")?.name).toBe(launch.pluginPath);
  });

  it("mounts the plugin a custom graph names even when the session needs no tools, and reports a missing one only when it does", async () => {
    const config = { ...await fixture(), deepseekCompositionMode: "custom" } as ServiceConfig;
    const plugin = (await prepareDeepSeekBootstrap(await fixture(), "/", false)).pluginPath!;

    const without = await prepareDeepSeekBootstrap(config, "/", false);
    expect(without).toMatchObject({ pluginPath: undefined, toolsError: undefined });
    expect((await prepareDeepSeekBootstrap(config, "/", true)).toolsError).toMatch("agentroom-tools");

    await writeFile(config.deepseekCordisConfig!, `- insert:\n    - id: agentroom-tools\n      name: ${plugin}\n`);
    const withPlugin = await prepareDeepSeekBootstrap(config, "/", false);
    expect(withPlugin.pluginPath).toBe(plugin);
    expect(withPlugin.env.AGENTROOM_DEEPSEEK_TOOLS_FD).toBe("3");
  });

  it("validates the CLI entrypoint before spawn", async () => {
    const config = await fixture();
    await expect(prepareDeepSeekBootstrap({ ...config, deepseekExecutable: process.execPath,
      deepseekArgs: ["relative.js"] }, "/", false)).rejects.toThrow("absolute dsh CLI entrypoint");
    await expect(prepareDeepSeekBootstrap({ ...config, deepseekExecutable: process.execPath,
      deepseekArgs: ["/missing/entrypoint.js"] }, "/", false)).rejects.toThrow("missing or unreadable");
  });

  it("finds the custom tools row only inside an insert list", async () => {
    const config = await fixture();
    const plugin = "/opt/agentroom/agentRoomToolsPlugin.js";
    const path = config.deepseekCordisConfig!;
    await writeFile(path, `- insert:\n    - id: agentroom-tools\n      name: ${plugin}\n`);
    await expect(validateAgentRoomCordisComposition(path, plugin)).resolves.toBeUndefined();
    // A top-level row is a patch target, which inserts nothing.
    await writeFile(path, `- id: agentroom-tools\n  name: ${plugin}\n`);
    await expect(validateAgentRoomCordisComposition(path, plugin)).rejects.toThrow("inserted Cordis row");
    await writeFile(path, `- insert:\n    - id: agentroom-tools\n      name: !!js process.env.AGENTROOM_DEEPSEEK_CORDIS_PLUGIN\n`);
    await expect(validateAgentRoomCordisComposition(path, plugin)).rejects.toThrow("inserted Cordis row");
  });
});
