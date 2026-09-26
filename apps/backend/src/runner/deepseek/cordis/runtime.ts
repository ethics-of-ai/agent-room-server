import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export const AGENTROOM_DEEPSEEK_CORDIS_PLUGIN_ENV = "AGENTROOM_DEEPSEEK_CORDIS_PLUGIN";
export const AGENTROOM_DEEPSEEK_TOOLS_FD_ENV = "AGENTROOM_DEEPSEEK_TOOLS_FD";
export const AGENTROOM_DEEPSEEK_TOOLS_FD = 3;

export async function resolveAgentRoomCordisPlugin(): Promise<string> {
  const besideRuntime = resolve(__dirname, "agentRoomToolsPlugin.js");
  const builtFromSource = resolve(__dirname, "../../../../dist/runner/deepseek/cordis/agentRoomToolsPlugin.js");
  for (const candidate of [besideRuntime, builtFromSource]) {
    try {
      if ((await lstat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next deterministic compiled location.
    }
  }
  throw new Error(
    "AgentRoom tools require the compiled Cordis plugin at backend dist/runner/deepseek/cordis/agentRoomToolsPlugin.js"
  );
}

export async function validateAgentRoomCordisComposition(configPath: string, pluginPath: string): Promise<void> {
  const info = await lstat(resolve(configPath));
  if (!info.isFile() || info.size > 256 * 1024) throw new Error("Custom Cordis composition must be a regular file of at most 256 KiB.");
  const source = await readFile(resolve(configPath), "utf8");
  const document = parseDocument(source, {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }]
  });
  const entries = isSeq(document.contents) ? document.contents.items.filter((entry) => {
    const id: unknown = isMap(entry) ? entry.get("id", true) : undefined;
    return isScalar(id) && id.value === "agentroom-tools";
  }) : [];
  const entry = entries.length === 1 && isMap(entries[0]) ? entries[0] : undefined;
  const name: unknown = entry?.get("name", true);
  if (document.errors.length || !isScalar(name) || name.tag && name.tag !== "tag:yaml.org,2002:str" || name?.value !== pluginPath) {
    throw new Error(
      `DeepSeek AgentRoom tools require an explicit Cordis entry named agentroom-tools whose name is the compiled plugin path ${pluginPath}`
    );
  }
}

export function agentRoomCordisEnv(pluginPath: string): NodeJS.ProcessEnv {
  return {
    [AGENTROOM_DEEPSEEK_CORDIS_PLUGIN_ENV]: pluginPath,
    [AGENTROOM_DEEPSEEK_TOOLS_FD_ENV]: String(AGENTROOM_DEEPSEEK_TOOLS_FD)
  };
}
