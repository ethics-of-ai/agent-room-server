import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServiceConfig } from "../../domain/models";
import { JsonRpcLineClient } from "../shared/JsonRpcLineClient";
import { withTimeout } from "../shared/asyncUtils";
import { prepareDeepSeekComposition } from "./cordis/composition";
import { prepareDeepSeekBootstrap } from "./bootstrap";
import { deepseekInitializeParams, effectiveDeepSeekSettings } from "./settings";
import { initializeResultSchema, sessionEventNotificationSchema, sessionStatusNotificationSchema, DEEPSEEK_SDK_SERVER_NAME } from "./protocol";
import { createDeepSeekTurnState, mapDeepSeekSessionEvent } from "./sessionEventMapper";
import { settled, waitForExit } from "./runtimeLifecycle";

/** An explicit, bounded provider call. The generated test graph has no tools. */
export async function testDeepSeekConnection(config: ServiceConfig): Promise<{ ok: boolean; message: string }> {
  if (config.deepseekCompositionMode !== "managed") {
    return { ok: false, message: "Use AgentRoom managed setup for a connection test. Custom compositions can be checked with a normal turn." };
  }
  const root = resolve(config.stateDir, "deepseek", "connection-tests");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(root, "test-"));
  let child: ReturnType<typeof spawn> | undefined;
  let client: JsonRpcLineClient | undefined;
  try {
    const testConfig = { ...config, stateDir: scratch, deepseekMaxTokens: 32, clarifyingQuestionsEnabled: false };
    const bootstrap = await prepareDeepSeekBootstrap(testConfig, scratch, false);
    const composition = await prepareDeepSeekComposition(testConfig, undefined, "connection_test");
    await mkdir(join(scratch, "deepseek", "sessions"), { recursive: true, mode: 0o700 });
    const runtime = spawn(config.deepseekExecutable!, config.deepseekArgs, {
      cwd: scratch, stdio: ["pipe", "pipe", "pipe"], env: { ...bootstrap.env, DSH_CORDIS_CONFIG: composition }
    });
    child = runtime;
    runtime.stderr.resume();
    client = new JsonRpcLineClient(runtime, "DeepSeek connection test");
    const rpc = client;
    await withTimeout((async () => {
      const initialized = initializeResultSchema.parse(await rpc.request("initialize", deepseekInitializeParams(scratch, effectiveDeepSeekSettings(testConfig, undefined))));
      if (initialized.serverInfo.name !== DEEPSEEK_SDK_SERVER_NAME) throw new Error("Unexpected runtime");
      const state = createDeepSeekTurnState();
      const completed = new Promise<void>((resolveDone, reject) => {
        let sawOutput = false;
        let running = false;
        runtime.once("close", () => reject(new Error("Runtime exited")));
        runtime.once("error", reject);
        rpc.onNotification((notification) => {
          if (notification.method === "session.event") {
            const event = sessionEventNotificationSchema.safeParse(notification.params);
            if (!event.success || event.data.sessionId !== "connection-test") return;
            const mapped = mapDeepSeekSessionEvent(event.data.event, { state, runner: {} });
            sawOutput ||= mapped.events.some((item) => item.type === "agent_update" && item.message.trim().length > 0);
            if (mapped.completion?.event.type === "run_failed") reject(new Error("Provider rejected test"));
          }
          if (notification.method === "session.status") {
            const status = sessionStatusNotificationSchema.safeParse(notification.params);
            if (!status.success || status.data.sessionId !== "connection-test") return;
            if (status.data.status === "running") running = true;
            else if (running) sawOutput ? resolveDone() : reject(new Error("No model response"));
          }
        });
      });
      void completed.catch(() => undefined);
      await rpc.request("session/prompt", { sessionId: "connection-test", contentBlocks: [{ type: "text", text: "Reply with OK." }] });
      await completed;
    })(), 30_000, "Connection test timed out");
    return { ok: true, message: "The configured provider and model returned a response." };
  } catch {
    return { ok: false, message: "The connection test failed. Check runtime readiness, the API key, provider/model settings, and network access, then retry." };
  } finally {
    if (child) {
      const exited = waitForExit(child as Parameters<typeof waitForExit>[0]);
      child.kill("SIGTERM");
      if (!await settled(exited, 1_000)) { child.kill("SIGKILL"); await exited; }
    }
    client?.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
}
