import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ServiceConfig } from "../../../domain/models";

/** The selected composition locates operator-installed packages; its code is never evaluated here. */
export async function prepareDeepSeekComposition(
  config: ServiceConfig,
  pluginPath?: string,
  purpose: "session" | "connection_test" = "session"
): Promise<string> {
  if (!config.deepseekCordisConfig) throw new Error("Choose a DeepSeek composition source in Mac runner settings.");
  if (config.deepseekCompositionMode !== "managed") return resolve(config.deepseekCordisConfig);
  const source = resolve(config.deepseekCordisConfig);
  const requireFromSource = createRequire(source);
  const modulePath = async (name: string): Promise<string> => {
    try {
      const path = requireFromSource.resolve(`@deepseek-ai/dsh-${name}`);
      if (!isAbsolute(path) || !(await lstat(path)).isFile()) throw new Error("Missing file");
      return path;
    } catch {
      throw new Error(`DeepSeek managed setup cannot find the installed ${name} package. Build the selected Harness checkout or choose its composition source again.`);
    }
  };
  // These fixed entries own execution policy. Arbitrary custom YAML is neither
  // copied nor merged, so changing the selected source cannot inject a plugin.
  const definitions: Array<[string, string, string[]?]> = [
    ["sdk-jsonrpc-server", "sdk-jsonrpc-server"],
    ["llm-deepseek", "llm-deepseek", ["apiKeyEnv: DEEPSEEK_API_KEY"]],
    ["subprocess", "subprocess-local"],
    ["sandbox", "sandbox-local"],
    ["sandbox-policy", "sandbox-policy", ["mode: workspace-write", "workspaceRoot: !!js process.env.DSH_CWD"]],
    ["fs", "fs-sandbox", ["cwd: !!js process.env.DSH_CWD"]],
    ["bash", "bash-sandbox", ["cwd: !!js process.env.DSH_CWD", "timeoutMs: 60000"]],
    ["agent-spine", "agent-spine-demo", [
      "workspaceContext: false", "skills:", "  enabled: false", "toolBash:", "  enableRunInBackground: false", "toolJobs: false"
    ]],
    ["tool-fs", "tool-fs"],
    ["sessions", "session-persistence-jsonl", ["root: !!js process.env.DSH_SESSION_ROOT", "compression: none"]]
  ];
  const lines = ["# AgentRoom managed DeepSeek composition v1. Regenerated from bundled policy."];
  for (const [id, name, settings] of definitions) {
    if (purpose === "connection_test" && !["sdk-jsonrpc-server", "llm-deepseek", "agent-spine", "sessions"].includes(id)) continue;
    lines.push(`- id: ${id}`, `  name: ${JSON.stringify(await modulePath(name))}`);
    const effective = purpose === "connection_test" && id === "agent-spine"
      ? ["workspaceContext: false", "skills:", "  enabled: false", "toolBash: false", "toolJobs: false"] : settings;
    if (effective) lines.push("  config:", ...effective.map((line) => `    ${line}`));
  }
  if (pluginPath) lines.push("- id: agentroom-tools", `  name: ${JSON.stringify(pluginPath)}`);
  const content = `${lines.join("\n")}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const root = resolve(config.stateDir, "deepseek", "compositions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("DeepSeek managed composition storage must be a regular directory.");
  // Immutable generations avoid changing configuration beneath a live child.
  // Relocation creates a new generation; existing custom files are never written.
  const destination = join(root, `v1-${digest}.yml`);
  try {
    const info = await lstat(destination);
    if (!info.isFile() || await readFile(destination, "utf8") !== content) {
      throw new Error("DeepSeek managed composition was modified. Remove the generated file and retry setup.");
    }
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}
