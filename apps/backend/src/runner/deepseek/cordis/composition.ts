import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ServiceConfig } from "../../../domain/models";

interface Row { id: string; name: string; inject?: string; config?: string[] }

/** Turns the agent may start on its own in a row before a person's message. */
export const DEEPSEEK_WAKE_BUDGET = 3;

// These fixed rows own execution policy. Arbitrary custom YAML is neither
// copied nor merged, so changing the selected source cannot inject a plugin.
// Bare names resolve from the `dsh` installation that boots the overlay; the
// launcher guarantees in-box packages come from that same installation.
const SESSION_ROWS: Row[] = [
  { id: "sdk-app-startup", name: "sdk-app", config: ["profile: agentroom"] },
  { id: "sdk-jsonrpc-server", name: "sdk-jsonrpc-server", inject: "[sdkAppStartup, loader]" },
  { id: "timer", name: "cordis-plugin-timer" },
  { id: "llm", name: "llm" },
  { id: "llm-deepseek", name: "llm-deepseek-api-key", config: ["apiKeyEnv: DEEPSEEK_API_KEY"] },
  { id: "llm-retry", name: "llm-retry" },
  { id: "session", name: "session" },
  { id: "session-title", name: "session-title", config: ["fallbackMaxWords: 5", "fallbackMaxBytes: 40", "maxTitleBytes: 80"] },
  { id: "session-projection", name: "session-projection" },
  { id: "system-prompt", name: "system-prompt" },
  { id: "tools", name: "tools" },
  { id: "agent", name: "agent" },
  { id: "agent-loop", name: "agent-loop", config: ["agents: []"] },
  { id: "working-directory", name: "working-directory", config: ["defaultDirectory: !!js process.env.DSH_CWD"] },
  { id: "subprocess", name: "subprocess-local" },
  { id: "sandbox", name: "sandbox-local" },
  { id: "sandbox-policy", name: "sandbox-policy", config: ["mode: workspace-write", "workspaceRoot: !!js process.env.DSH_CWD"] },
  { id: "fs", name: "fs-sandbox", config: ["cwd: !!js process.env.DSH_CWD"] },
  { id: "bash", name: "bash-sandbox", config: ["cwd: !!js process.env.DSH_CWD", "timeoutMs: 60000"] },
  { id: "shell-env", name: "shell-env" },
  { id: "tool-bash", name: "tool-bash", config: ["enableRunInBackground: true"] },
  { id: "tool-fs", name: "tool-fs", config: ["readImage: false"] },
  // A settled background job wakes its idle agent. The budget refills only
  // when a person's message arrives, so an unattended session stops after
  // three wakes. Subagent wakes have no budget upstream, so the runner
  // pauses new subagents after the same number of agent turns instead.
  { id: "jobs", name: "jobs-local" },
  { id: "tool-jobs", name: "tool-jobs", config: ["completionDelivery: wakeup", `maxConsecutiveWakes: ${DEEPSEEK_WAKE_BUDGET}`] },
  { id: "subagent", name: "subagent" },
  { id: "subagent-spawn", name: "subagent-spawn-in-process", config: ["providerName: spawn"] },
  { id: "tool-subagent", name: "tool-subagent", config: ["provider: spawn", "toolName: subagent"] },
  { id: "sessions", name: "session-persistence-jsonl", config: ["root: !!js process.env.DSH_SESSION_ROOT", "compression: none"] }
];

/** The provider check keeps the agent kernel and drops every model-facing tool. */
const TOOL_ROWS = new Set(["bash", "shell-env", "tool-bash", "tool-fs", "jobs", "tool-jobs", "subagent", "subagent-spawn", "tool-subagent"]);

function packageName(name: string): string {
  return name.startsWith("cordis-") ? `@deepseek-ai/${name}` : `@deepseek-ai/dsh-${name}`;
}

/**
 * The launcher composes a profile from patch layers only, so the managed graph
 * is one `insert` patch applied over AgentRoom's empty profile. Custom mode
 * passes the operator's own patch file unchanged.
 */
export async function prepareDeepSeekComposition(
  config: ServiceConfig,
  pluginPath?: string,
  purpose: "session" | "connection_test" = "session"
): Promise<string> {
  if (config.deepseekCompositionMode !== "managed") {
    if (!config.deepseekCordisConfig) throw new Error("Choose a DeepSeek composition patch in Mac runner settings.");
    return resolve(config.deepseekCordisConfig);
  }
  const lines = [
    "# AgentRoom managed DeepSeek composition v2. Regenerated from bundled policy.",
    "- insert:"
  ];
  for (const row of SESSION_ROWS) {
    if (purpose === "connection_test" && TOOL_ROWS.has(row.id)) continue;
    lines.push(`    - id: ${row.id}`, `      name: ${JSON.stringify(packageName(row.name))}`);
    if (row.inject) lines.push(`      inject: ${row.inject}`);
    if (row.config) lines.push("      config:", ...row.config.map((line) => `        ${line}`));
  }
  if (pluginPath) lines.push("    - id: agentroom-tools", `      name: ${JSON.stringify(pluginPath)}`);
  const content = `${lines.join("\n")}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const root = resolve(config.stateDir, "deepseek", "compositions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("DeepSeek managed composition storage must be a regular directory.");
  // Immutable generations avoid changing configuration beneath a live child.
  // Relocation creates a new generation; existing custom files are never written.
  const destination = join(root, `v2-${digest}.yml`);
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
