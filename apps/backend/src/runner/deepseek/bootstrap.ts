import { access, constants, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { ServiceConfig } from "../../domain/models";
import { prepareDeepSeekComposition } from "./cordis/composition";
import { agentRoomCordisEnv, resolveAgentRoomCordisPlugin, validateAgentRoomCordisComposition } from "./cordis/runtime";
import { deepseekChildEnv } from "./settings";

export async function prepareDeepSeekBootstrap(config: ServiceConfig, cwd: string, withTools: boolean): Promise<{
  env: NodeJS.ProcessEnv;
  pluginPath?: string;
  toolsError?: string;
}> {
  if (config.deepseekExecutable && /^node(?:\.exe)?$/.test(basename(config.deepseekExecutable))) {
    const entrypoint = config.deepseekArgs[0];
    if (!entrypoint || !isAbsolute(entrypoint)) {
      throw new Error("DeepSeek needs an absolute SDK entrypoint as its first argument. Choose a built source checkout in Mac runner settings.");
    }
    try {
      await access(entrypoint, constants.R_OK);
      if (!(await stat(entrypoint)).isFile()) throw new Error("Not a file");
    } catch {
      throw new Error("The DeepSeek SDK entrypoint is missing or unreadable. Build the selected checkout or correct Arguments in Mac runner settings.");
    }
  }
  let pluginPath: string | undefined;
  let toolsError: string | undefined;
  if (withTools) {
    try {
      pluginPath = await resolveAgentRoomCordisPlugin();
      if (config.deepseekCompositionMode !== "managed") {
        await validateAgentRoomCordisComposition(config.deepseekCordisConfig!, pluginPath);
      }
    } catch {
      pluginPath = undefined;
      toolsError = "AgentRoom tools are unavailable. Choose AgentRoom managed composition in Mac runner settings, or repair the agentroom-tools entry in your custom composition.";
    }
  }
  const compositionPath = await prepareDeepSeekComposition(config, pluginPath);
  return {
    env: {
      ...deepseekChildEnv(config, cwd),
      DSH_CORDIS_CONFIG: compositionPath,
      ...(pluginPath ? agentRoomCordisEnv(pluginPath) : {})
    },
    pluginPath,
    toolsError
  };
}
