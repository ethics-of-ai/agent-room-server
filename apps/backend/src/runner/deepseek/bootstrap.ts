import { access, constants, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { ServiceConfig } from "../../domain/models";
import { prepareDeepSeekComposition } from "./cordis/composition";
import { DEEPSEEK_PROFILE_NAME, prepareDeepSeekProfile } from "./cordis/profile";
import { agentRoomCordisEnv, resolveAgentRoomCordisPlugin, validateAgentRoomCordisComposition } from "./cordis/runtime";
import { deepseekChildEnv } from "./settings";

export interface DeepSeekLaunch {
  args: string[];
  /** The backend-owned Harness home. The launcher reads a `.env` from its cwd, so it never runs in a workspace. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginPath?: string;
  toolsError?: string;
}

export async function prepareDeepSeekBootstrap(
  config: ServiceConfig,
  agentCwd: string,
  withTools: boolean,
  purpose: "session" | "connection_test" = "session"
): Promise<DeepSeekLaunch> {
  if (config.deepseekExecutable && /^node(?:\.exe)?$/.test(basename(config.deepseekExecutable))) {
    const entrypoint = config.deepseekArgs[0];
    if (!entrypoint || !isAbsolute(entrypoint)) {
      throw new Error("DeepSeek needs an absolute dsh CLI entrypoint as its first argument. Choose a built source checkout in Mac runner settings.");
    }
    try {
      await access(entrypoint, constants.R_OK);
      if (!(await stat(entrypoint)).isFile()) throw new Error("Not a file");
    } catch {
      throw new Error("The DeepSeek dsh CLI entrypoint is missing or unreadable. Build the selected checkout or correct Arguments in Mac runner settings.");
    }
  }
  let pluginPath: string | undefined;
  let toolsError: string | undefined;
  // Every session carries the plugin when its graph has one: it is also how
  // AgentRoom stops the session's background jobs and subagents. A custom
  // graph without it is reported only when the session needs tools.
  if (withTools || purpose === "session") {
    try {
      pluginPath = await resolveAgentRoomCordisPlugin();
      if (config.deepseekCompositionMode !== "managed") {
        await validateAgentRoomCordisComposition(config.deepseekCordisConfig!, pluginPath);
      }
    } catch {
      pluginPath = undefined;
      if (withTools || config.deepseekCompositionMode === "managed") {
        toolsError = "AgentRoom tools are unavailable. Choose AgentRoom managed composition in Mac runner settings, or repair the agentroom-tools entry in your custom composition.";
      }
    }
  }
  const compositionPath = await prepareDeepSeekComposition(config, pluginPath, purpose);
  const home = await prepareDeepSeekProfile(config);
  return {
    // Launcher flags end at the first token it does not recognize, so the
    // profile and overlay follow any operator-supplied launcher arguments.
    args: [...config.deepseekArgs, "--profile", DEEPSEEK_PROFILE_NAME, "--patch", compositionPath],
    cwd: home,
    env: {
      ...deepseekChildEnv(config, agentCwd),
      DSH_HOME: home,
      ...(pluginPath ? agentRoomCordisEnv(pluginPath) : {})
    },
    pluginPath,
    toolsError
  };
}
