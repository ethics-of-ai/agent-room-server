import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ServiceConfig } from "../src/domain/models";
import { prepareDeepSeekComposition } from "../src/runner/deepseek/cordis/composition";
import { prepareDeepSeekBootstrap } from "../src/runner/deepseek/bootstrap";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<ServiceConfig> {
  const root = await mkdtemp(join(tmpdir(), "deepseek managed 'source-"));
  roots.push(root);
  const source = join(root, "cordis.yml");
  await writeFile(source, "# operator-owned, never modified\n- name: arbitrary-custom-plugin\n");
  for (const name of ["sdk-jsonrpc-server", "llm-deepseek", "subprocess-local", "sandbox-local", "sandbox-policy", "fs-sandbox", "bash-sandbox", "agent-spine-demo", "tool-fs", "session-persistence-jsonl"]) {
    const dir = join(root, "node_modules", "@deepseek-ai", `dsh-${name}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await writeFile(join(dir, "index.js"), "throw new Error('resolution must not execute package code');");
  }
  return { stateDir: join(root, "app support", "state"), deepseekCordisConfig: source,
    deepseekCompositionMode: "managed", deepseekArgs: [] } as unknown as ServiceConfig;
}

describe("DeepSeek managed composition", () => {
  it("resolves packages without executing custom code and creates private immutable generations after app relocation", async () => {
    const config = await fixture();
    const original = await readFile(config.deepseekCordisConfig!, "utf8");
    const first = await prepareDeepSeekComposition(config, "/Applications/AgentRoom.app/plugin.js");
    expect(await prepareDeepSeekComposition(config, "/Applications/AgentRoom.app/plugin.js")).toBe(first);
    const moved = await prepareDeepSeekComposition(config, "/Applications/My AgentRoom.app/plugin.js");
    expect(moved).not.toBe(first);
    const content = await readFile(moved, "utf8");
    expect(content).toContain('/Applications/My AgentRoom.app/plugin.js');
    expect(content).not.toContain("arbitrary-custom-plugin");
    expect(content).toContain("mode: workspace-write");
    expect(content).toContain("dsh-fs-sandbox");
    expect(content).toContain("dsh-bash-sandbox");
    expect(content).toContain("!!js process.env.DSH_CWD");
    expect(content).toContain("!!js process.env.DSH_SESSION_ROOT");
    expect((await stat(moved)).mode & 0o777).toBe(0o600);
    expect(await readFile(config.deepseekCordisConfig!, "utf8")).toBe(original);
    // Unknown tags are read as scalar data; the backend never evaluates !!js.
    expect(parse(content, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] })).toHaveLength(11);
  });

  it("preserves custom mode without creating generated storage", async () => {
    const config = await fixture();
    expect(await prepareDeepSeekComposition({ ...config, deepseekCompositionMode: "custom" })).toBe(config.deepseekCordisConfig);
    await expect(stat(config.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses missing packages and modified or symlinked generations", async () => {
    const config = await fixture();
    const path = await prepareDeepSeekComposition(config);
    await writeFile(path, "tampered");
    await expect(prepareDeepSeekComposition(config)).rejects.toThrow("modified");
    await rm(path);
    await symlink(config.deepseekCordisConfig!, path);
    await expect(prepareDeepSeekComposition(config)).rejects.toThrow("modified");
    await rm(join(config.deepseekCordisConfig!, "..", "node_modules", "@deepseek-ai", "dsh-tool-fs"), { recursive: true });
    await expect(prepareDeepSeekComposition(config)).rejects.toThrow("tool-fs package");
  });

  it("validates the SDK entrypoint before spawn", async () => {
    const config = await fixture();
    await expect(prepareDeepSeekBootstrap({ ...config, deepseekExecutable: process.execPath,
      deepseekArgs: ["relative.js"] }, "/", false)).rejects.toThrow("absolute SDK entrypoint");
    await expect(prepareDeepSeekBootstrap({ ...config, deepseekExecutable: process.execPath,
      deepseekArgs: ["/missing/entrypoint.js"] }, "/", false)).rejects.toThrow("missing or unreadable");
  });
});
