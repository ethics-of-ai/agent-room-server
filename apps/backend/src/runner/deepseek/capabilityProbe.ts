import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";
import type { CodingAgentCapabilities, ServiceConfig } from "../../domain/models";
import { withTimeout } from "../shared/asyncUtils";
import { JsonRpcLineClient } from "../shared/JsonRpcLineClient";
import { prepareDeepSeekBootstrap } from "./bootstrap";
import { deepseekCapabilities } from "./capabilities";
import { DeepSeekToolRelay, TOOLS_READY_TIMEOUT_MS } from "./cordis/DeepSeekToolRelay";
import { AGENTROOM_DEEPSEEK_TOOLS_FD } from "./cordis/runtime";
import { DEEPSEEK_SDK_SERVER_NAME, initializeResultSchema } from "./protocol";
import { appendStderrTail, collectStderrTail, DEEPSEEK_CLIENT_LABEL, type TerminableRuntime, wrongServerMessage } from "./runtimeLifecycle";
import { deepseekInitializeParams, effectiveDeepSeekSettings } from "./settings";

/**
 * Prove the runtime starts and answers without prompting it: spawn it,
 * complete the handshake, check the server identity, and wait for the
 * AgentRoom tool plugin when one is mounted. The child is handed to
 * `trackTermination` however the probe ends.
 */
export async function probeDeepSeekCapabilities(
config: ServiceConfig,
deps: {
  initializeTimeoutMs: number;
  withTools: boolean;
  trackTermination(runtime: TerminableRuntime): void;
}
): Promise<CodingAgentCapabilities> {
  const settings = effectiveDeepSeekSettings(config, undefined);
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: JsonRpcLineClient | undefined;
  let stderrTail: () => string | undefined = () => undefined;
  let toolRelay: DeepSeekToolRelay | undefined;
  try {
    // The probe names the backend's own cwd as its agent directory, never a
    // registered workspace: it exists to prove the runtime starts and
    // answers, and it must not load a workspace's configuration to do that.
    const bootstrap = await prepareDeepSeekBootstrap(config, process.cwd(), deps.withTools);
    const { pluginPath } = bootstrap;
    child = spawn(config.deepseekExecutable as string, bootstrap.args, {
      cwd: bootstrap.cwd,
      stdio: pluginPath ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: bootstrap.env
    });
    if (pluginPath) {
      toolRelay = new DeepSeekToolRelay(child.stdio[AGENTROOM_DEEPSEEK_TOOLS_FD] as Duplex, []);
    }
    stderrTail = collectStderrTail(child);
    client = new JsonRpcLineClient(child, DEEPSEEK_CLIENT_LABEL);
    const response = await withTimeout(
      client.request("initialize", deepseekInitializeParams(process.cwd(), settings)),
      deps.initializeTimeoutMs,
      "Timed out initializing the DeepSeek Harness runtime"
    );
    const parsed = initializeResultSchema.safeParse(response);
    if (!parsed.success) {
      return deepseekCapabilities(
        config,
        appendStderrTail("The DeepSeek Harness runtime returned an unrecognized initialize result", stderrTail())
      );
    }
    if (parsed.data.serverInfo.name !== DEEPSEEK_SDK_SERVER_NAME) {
      // A different program answered. Saying so beats a turn that fails later
      // with a shape error, and naming the likely cause beats both: the usual
      // one is a custom composition that mounts no SDK JSON-RPC server.
      return deepseekCapabilities(config, wrongServerMessage(parsed.data.serverInfo.name));
    }
    let toolsError = bootstrap.toolsError;
    try { await toolRelay?.waitUntilReady(TOOLS_READY_TIMEOUT_MS); } catch {
      toolsError = "AgentRoom tools did not become ready. Repair the composition and create a new session to use tools.";
    }
    return {
      ...deepseekCapabilities(config),
      connectionTestAvailable: config.deepseekCompositionMode === "managed",
      checks: [
        { id: "runtime", status: "ready", message: "The runtime completed its handshake." },
        { id: "provider", status: "not_checked", message: "Provider access is checked when you send a turn; this check sends no model prompt." },
        { id: "agent_tools", status: toolsError ? "unavailable" : pluginPath ? "ready" : "not_checked",
          message: toolsError ?? (pluginPath ? "AgentRoom tools are ready." : "AgentRoom tools are disabled.") }
      ]
    };
  } catch (error) {
    return deepseekCapabilities(
      config,
      appendStderrTail(error instanceof Error ? error.message : String(error), stderrTail())
    );
  } finally {
    // The probe proved what it came to prove; it never prompted, so there is
    // nothing to flush and the ladder starts at EOF.
    if (client && child) {
      toolRelay?.close();
      deps.trackTermination({ key: "capability-probe", client, child, terminateImmediately: true });
    } else {
      client?.dispose();
    }
  }
}
