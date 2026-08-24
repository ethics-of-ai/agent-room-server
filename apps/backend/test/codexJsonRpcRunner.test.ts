import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRunner } from "../src/runner/codex/CodexAppServerRunner";
import { jsonRpcArgs } from "../src/runner/codex/settings";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-codex-jsonrpc-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [],
    ...overrides
  };
};

/**
 * Phase 6 of docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md moves the app-server
 * bootstrap decision behind the adapter that owns the protocol. The macOS app
 * used to make it in generic launch assembly, by force-writing
 * `CODEX_RUNNER_PROTOCOL` and `CODEX_ARGS` whenever the Codex network toggle was
 * on — which also overrode an operator who had pinned `exec` on purpose.
 */
describe("Codex app-server arguments", () => {
  it("starts the app-server itself when the operator supplied no arguments", () => {
    expect(jsonRpcArgs([])).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("passes the operator's own app-server launch through verbatim", () => {
    // A wrapper script, a `--cd`, a `-c key=value`: the adapter refuses one
    // known-incompatible shape, it does not allowlist the arguments it happens
    // to recognize.
    expect(jsonRpcArgs(["/opt/tools/codex-wrapper.js"])).toEqual(["/opt/tools/codex-wrapper.js"]);
    expect(jsonRpcArgs(["app-server", "--listen", "stdio://", "-c", "model=gpt-example"]))
      .toEqual(["app-server", "--listen", "stdio://", "-c", "model=gpt-example"]);
    expect(jsonRpcArgs(["--cd", "exec", "app-server", "--listen", "stdio://"]))
      .toEqual(["--cd", "exec", "app-server", "--listen", "stdio://"]);
  });

  it("drops exec-style arguments a JSON-RPC child could never honor", () => {
    // Left over from an install configured before jsonrpc became the default.
    // Spawning `codex exec --json` and then speaking JSON-RPC at it fails as an
    // initialize timeout, which reads as a broken runner rather than as the
    // stale configuration it is.
    expect(jsonRpcArgs(["exec", "--json"])).toEqual(["app-server", "--listen", "stdio://"]);
  });
});

describe("CodexAppServerRunner JSON-RPC protocol mode", () => {
  it("starts a Codex app-server turn and maps structured notifications into runner events", async () => {
    const fakeServer = await writeFakeCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello structured Codex",
      title: "JSON-RPC turn"
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "agent_activity",
      activity: expect.objectContaining({
        kind: "codex_thread_started",
        canonical: { kind: "session_started" },
        runner: expect.objectContaining({
          nativeSessionId: "codex-thread-1",
          native: { method: "thread/started" }
        })
      })
    });
    expect(events).toContainEqual({
      type: "agent_activity",
      activity: expect.objectContaining({
        kind: "codex_plan_updated",
        content: expect.objectContaining({
          explanation: "Plan from fake server"
        })
      })
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_update",
      message: "hello ",
      runner: expect.objectContaining({
        nativeSessionId: "codex-thread-1",
        nativeTurnId: "codex-turn-1",
        nativeItemId: "assistant-message-1",
        native: { method: "item/agentMessage/delta" }
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_update",
      message: "world"
    }));
    expect(events).toContainEqual({
      type: "token_usage_updated",
      runner: expect.objectContaining({
        nativeSessionId: "codex-thread-1",
        nativeTurnId: "codex-turn-1",
        native: { method: "thread/tokenUsage/updated" }
      }),
      inputTokens: 14,
      cachedInputTokens: 4,
      outputTokens: 6,
      reasoningOutputTokens: 2,
      totalTokens: 20,
      contextWindowUsedTokens: 12,
      modelContextWindowTokens: 258400
    });
    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });
    await runner.dispose();
  });

  it("streams JSON-RPC notifications before a delayed turn/start response resolves", async () => {
    const fakeServer = await writeDelayedTurnStartResponseCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: Array<{ event: AgentRunnerEvent; elapsedMs: number }> = [];
    const startedAt = performance.now();

    const run = (async () => {
      for await (const event of runner.run({
        runId: "agentroom-turn-delayed-start-response",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "Stream without waiting for turn/start response",
        title: "Delayed turn/start response"
      })) {
        events.push({ event, elapsedMs: performance.now() - startedAt });
      }
    })();

    await waitForTimedEvent(events, ({ event }) => event.type === "agent_update");

    const firstUpdate = events.find(({ event }) => event.type === "agent_update");
    expect(firstUpdate?.elapsedMs).toBeLessThan(300);

    await run;
    expect(events.map(({ event }) => event.type)).toContain("run_succeeded");
    expect(events.find(({ event }) => event.type === "runner_audit" && event.audit.phase === "completed")?.event).toEqual(
      expect.objectContaining({
        audit: expect.objectContaining({
          timeToFirstOutputMs: expect.any(Number),
          streamDurationMs: expect.any(Number),
          eventCount: expect.any(Number),
          outputBytes: expect.any(Number)
        })
      })
    );
    await runner.dispose();
  });

  it("sends local image input parts to Codex turn/start after the text prompt", async () => {
    const fakeServer = await writeInputLoggingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const imagePath = join(serviceConfig.stateDir, "attachments", "workspace-1", "session-1", "attachment-1", "source");
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-with-image",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Describe the screenshot",
      inputParts: [{ type: "localImage", path: imagePath }],
      title: "Image turn"
    } as any)) {
      events.push(event);
    }

    const turnStartParams = JSON.parse(await readFile(fakeServer.logPath, "utf8")) as { input: unknown[] };
    expect(turnStartParams.input).toEqual([
      { type: "text", text: "Describe the screenshot", text_elements: [] },
      { type: "localImage", path: imagePath }
    ]);
    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });
    await runner.dispose();
  });

  it("passes configured approval, sandbox, and workspace network access to Codex thread/start", async () => {
    const fakeServer = await writeThreadStartLoggingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc",
      codexApprovalPolicy: "on-request",
      codexSandboxMode: "workspace-write",
      codexWorkspaceNetworkAccess: true
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-network-git",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Fetch from origin",
      title: "Git network turn"
    })) {
      events.push(event);
    }

    const threadStartParams = JSON.parse(await readFile(fakeServer.logPath, "utf8")) as Record<string, unknown>;
    expect(threadStartParams).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: {
        sandbox_workspace_write: {
          network_access: true
        }
      }
    });
    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });
    await runner.dispose();
  });

  it("pins workspace network access to false in thread/start when the operator has not enabled it", async () => {
    // A registered workspace's committed .codex/config.toml merges into the
    // thread's effective config as a Codex project layer; only an explicit
    // per-key override shadows it. An omitted network_access key would let a
    // workspace silently re-enable network inside the workspace-write sandbox.
    const fakeServer = await writeThreadStartLoggingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-network-default",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Inspect the workspace",
      title: "Default network turn"
    })) {
      events.push(event);
    }

    const threadStartParams = JSON.parse(await readFile(fakeServer.logPath, "utf8")) as Record<string, unknown>;
    expect(threadStartParams).toMatchObject({
      sandbox: "workspace-write",
      config: {
        sandbox_workspace_write: {
          network_access: false
        }
      }
    });
    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });
    await runner.dispose();
  });

  it("sends no sandbox_workspace_write config outside the workspace-write sandbox mode", async () => {
    const fakeServer = await writeThreadStartLoggingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc",
      codexSandboxMode: "danger-full-access"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-full-access",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Push the branch",
      title: "Full access turn"
    })) {
      events.push(event);
    }

    const threadStartParams = JSON.parse(await readFile(fakeServer.logPath, "utf8")) as Record<string, unknown>;
    expect(threadStartParams.sandbox).toBe("danger-full-access");
    // The network pin belongs to the workspace-write sandbox alone; the thread
    // config still carries the clarifying-question flags.
    expect(threadStartParams.config.sandbox_workspace_write).toBeUndefined();
    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });
    await runner.dispose();
  });

  it("waits for a slow JSON-RPC interrupt and keeps the session alive when it lands", async () => {
    // The fake acknowledges turn/interrupt after 700ms — inside the default
    // 1s window — so cancel must settle as an interrupt, not a child kill.
    const fakeServer = await writeInterruptStallingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    const run = (async () => {
      for await (const event of runner.run({
        runId: "agentroom-turn-slow-interrupt",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "Cancel me slowly",
        title: "Slow interrupt cancellation"
      })) {
        events.push(event);
      }
    })();

    await waitForEvent(events, (event) =>
      event.type === "agent_activity" && event.activity.kind === "codex_turn_started"
    );

    const startedAt = performance.now();
    await runner.cancel("agentroom-turn-slow-interrupt");
    const durationMs = performance.now() - startedAt;
    await run;

    expect(durationMs).toBeGreaterThan(500);
    expect(durationMs).toBeLessThan(1_500);
    expect(events).toContainEqual({
      type: "run_failed",
      error: "Codex app-server turn interrupted"
    });
    expect(events).not.toContainEqual({
      type: "run_failed",
      error: "Codex app-server terminated by signal SIGTERM"
    });
    await runner.dispose();
  });

  it("does not wait for a stalled JSON-RPC interrupt response before terminating a turn", async () => {
    const fakeServer = await writeInterruptStallingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    // The fake stalls interrupt for 700ms; with a 150ms window the kill
    // fallback must fire instead of waiting on the stalled acknowledgement.
    const runner = new CodexAppServerRunner(serviceConfig, { interruptTimeoutMs: 150 });
    const events: AgentRunnerEvent[] = [];
    const run = (async () => {
      for await (const event of runner.run({
        runId: "agentroom-turn-cancel",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "Cancel me",
        title: "JSON-RPC cancellation"
      })) {
        events.push(event);
      }
    })();

    await waitForEvent(events, (event) =>
      event.type === "agent_activity" && event.activity.kind === "codex_turn_started"
    );

    const startedAt = performance.now();
    await runner.cancel("agentroom-turn-cancel");
    const durationMs = performance.now() - startedAt;
    await run;

    expect(durationMs).toBeLessThan(250);
    expect(events).toContainEqual({
      type: "run_failed",
      error: "Codex app-server terminated by signal SIGTERM"
    });
    await runner.dispose();
  });

  it("terminates a JSON-RPC session when cancellation happens before a Codex turn id is available", async () => {
    const fakeServer = await writeThreadStartStallingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    const run = (async () => {
      for await (const event of runner.run({
        runId: "agentroom-turn-before-turn-id",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "Cancel before turn id",
        title: "Early JSON-RPC cancellation"
      })) {
        events.push(event);
      }
    })();

    try {
      await waitForLoggedMethod(fakeServer.logPath, "thread/start");

      const startedAt = performance.now();
      await runner.cancel("agentroom-turn-before-turn-id");
      const durationMs = performance.now() - startedAt;

      await Promise.race([
        run,
        delay(300).then(() => {
          throw new Error("Runner did not finish after early JSON-RPC cancellation");
        })
      ]);

      expect(durationMs).toBeLessThan(250);
      expect(events).toContainEqual(expect.objectContaining({
        type: "run_failed"
      }));
    } finally {
      await runner.dispose();
      await Promise.race([run.catch(() => undefined), delay(100)]);
    }
  });

  it("keeps streaming while the Codex app-server floods stderr", async () => {
    const fakeServer = await writeStderrFloodingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    // The fake only sends turn/completed after its oversized stderr write has
    // drained, so an unconsumed stderr pipe hangs this turn forever.
    for await (const event of runner.run({
      runId: "agentroom-turn-stderr-flood",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Survive the stderr flood",
      title: "Stderr flood turn"
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });
    await runner.dispose();
  });

  it("includes a bounded stderr tail when the Codex app-server crashes during startup", async () => {
    const fakeServer = await writeStartupCrashingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-startup-crash",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Crash on thread start",
      title: "Startup crash turn"
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "run_failed",
      error: "Codex app-server exited with code 3 (stderr: codex exploded: bad config)"
    });
    await runner.dispose();
  });

  it("redacts credentials the Codex app-server echoes on stderr", async () => {
    // The tail is the child's own text: a config-parse failure can quote an
    // `mcp_servers.*.env` line straight out of the workspace's `.codex/config.toml`.
    // The error string it lands in reaches unauthenticated reads (`/api/logs`,
    // `/api/status` recent events, capability errors), so the value must not survive.
    const fakeServer = await writeCredentialLeakingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-stderr-credentials",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Leak a credential on stderr",
      title: "Stderr credential turn"
    })) {
      events.push(event);
    }

    const final = events.at(-1);
    expect(final?.type).toBe("run_failed");
    const error = final?.type === "run_failed" ? final.error : "";
    expect(error).not.toContain("sk-live-not-a-real-key");
    expect(error).not.toContain("agentroom-not-a-real-bearer");
    expect(error).toContain("api_key=[REDACTED]");
    expect(error).toContain("Authorization=[REDACTED]");
    // Redaction must not swallow the diagnostic that makes the tail worth keeping.
    expect(error).toContain("failed to parse config");
    await runner.dispose();
  });

  it("does not pass AgentRoom's bearer token to the Codex app-server child", async () => {
    // AUTH_TOKEN is AgentRoom's transport secret, not something codex or the MCP
    // servers its project config layer starts have any use for. Mirrors the
    // terminal PTY scrub.
    const fakeServer = await writeEnvReportingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    const previousAuthToken = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "agentroom-not-a-real-bearer";

    try {
      for await (const event of runner.run({
        runId: "agentroom-turn-child-env",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "Report the inherited environment",
        title: "Child env turn"
      })) {
        events.push(event);
      }
    } finally {
      if (previousAuthToken === undefined) delete process.env.AUTH_TOKEN;
      else process.env.AUTH_TOKEN = previousAuthToken;
    }

    const final = events.at(-1);
    expect(final?.type).toBe("run_failed");
    const error = final?.type === "run_failed" ? final.error : "";
    expect(error).toContain("agentroom-bearer-inherited no");
    // The rest of the operator environment still reaches codex, which needs it
    // to find its own credentials and tooling.
    expect(error).toContain("path-inherited yes");
    await runner.dispose();
  });

  it("fails a turn when the Codex app-server thread/start never responds", async () => {
    const fakeServer = await writeThreadStartStallingCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig, {
      startupTimeouts: { initializeMs: 500, threadStartMs: 500 }
    });
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-thread-start-timeout",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Never get a thread",
      title: "Thread start timeout turn"
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "run_failed",
      error: "Timed out starting Codex app-server thread"
    });
    await runner.dispose();
  });

  it("resumes the recorded Codex thread when the app-server child died between turns", async () => {
    const fakeServer = await writeResumableCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath, "exit-after-turn"],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);

    const collect = async (runId: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-resume",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "resume turn",
        title: "Resume turn"
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("agentroom-turn-resume-1");
    expect(first.at(-1)).toEqual({ type: "run_succeeded", message: "Codex app-server turn completed" });

    // The fake exits shortly after completing the turn; give the child close
    // time to land so the next turn sees a dead session.
    await delay(250);

    const second = await collect("agentroom-turn-resume-2");
    expect(second.at(-1)).toEqual({ type: "run_succeeded", message: "Codex app-server turn completed" });

    const methods = (await readFile(fakeServer.logPath, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "thread/resume:codex-thread-resumable")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
    await runner.dispose();
  });

  it("falls back to a fresh thread when Codex rejects the resume", async () => {
    const fakeServer = await writeResumableCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath, "exit-after-turn,reject-resume"],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);

    const collect = async (runId: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-resume-reject",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "resume turn",
        title: "Resume fallback turn"
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("agentroom-turn-resume-reject-1");
    expect(first.at(-1)).toEqual({ type: "run_succeeded", message: "Codex app-server turn completed" });
    await delay(250);
    // A thread with no rollout (or a pruned one) cannot resume; the turn must
    // still run on a fresh thread instead of failing.
    const second = await collect("agentroom-turn-resume-reject-2");
    expect(second.at(-1)).toEqual({ type: "run_succeeded", message: "Codex app-server turn completed" });

    const methods = (await readFile(fakeServer.logPath, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method === "thread/resume:codex-thread-resumable")).toHaveLength(1);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(2);
    await runner.dispose();
  });

  it("forgets the resumable thread when the AgentRoom session is closed", async () => {
    const fakeServer = await writeResumableCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);

    const collect = async (runId: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-forget",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "resume turn",
        title: "Forget turn"
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("agentroom-turn-forget-1");
    expect(first.at(-1)?.type).toBe("run_succeeded");

    // An explicitly deleted session must never be silently resumed.
    await runner.closeSession("agentroom-session-forget");

    const second = await collect("agentroom-turn-forget-2");
    expect(second.at(-1)?.type).toBe("run_succeeded");

    const methods = (await readFile(fakeServer.logPath, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method.startsWith("thread/resume"))).toHaveLength(0);
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(2);
    await runner.dispose();
  });

  it("idle-reaps a quiet Codex session and resumes its thread on the next turn", async () => {
    const fakeServer = await writeResumableCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path, fakeServer.logPath],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig, { idleSessionTimeoutMs: 120 });

    const collect = async (runId: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-idle",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "idle turn",
        title: "Idle reap turn"
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("agentroom-turn-idle-1");
    expect(first.at(-1)?.type).toBe("run_succeeded");

    // Past the idle window the child must be reaped, so the next turn spawns
    // a fresh app-server and resumes the recorded thread.
    await delay(500);

    const second = await collect("agentroom-turn-idle-2");
    expect(second.at(-1)?.type).toBe("run_succeeded");

    const methods = (await readFile(fakeServer.logPath, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(methods.filter((method) => method === "thread/resume:codex-thread-resumable")).toHaveLength(1);
    await runner.dispose();
  });

  it("reuses one Codex thread for multiple turns in the same AgentRoom session", async () => {
    const fakeServer = await writePersistentThreadCodexAppServer();
    const serviceConfig = await config({
      codexArgs: [fakeServer.path],
      codexRunnerProtocol: "jsonrpc"
    } as Partial<ServiceConfig>);
    const runner = new CodexAppServerRunner(serviceConfig);

    const firstEvents: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "agentroom-turn-persistent-1",
      sessionId: "agentroom-session-persistent",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "First turn",
      title: "Persistent JSON-RPC turn"
    })) {
      firstEvents.push(event);
    }

    const secondEvents: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "agentroom-turn-persistent-2",
      sessionId: "agentroom-session-persistent",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Second turn",
      title: "Persistent JSON-RPC turn"
    })) {
      secondEvents.push(event);
    }

    const methods = (await readFile(fakeServer.logPath, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: "agent_activity",
      activity: expect.objectContaining({
        kind: "codex_thread_started",
        runner: expect.objectContaining({ nativeSessionId: "codex-thread-persistent" })
      })
    }));
    expect(secondEvents).not.toContainEqual(expect.objectContaining({
      type: "agent_activity",
      activity: expect.objectContaining({ kind: "codex_thread_started" })
    }));
    await runner.dispose();
  });
});

async function writeFakeCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-app-server-"));
  const path = join(root, "fake-codex-app-server.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-1",
    sessionId: "codex-session-1",
    forkedFromId: null,
    preview: "",
    ephemeral: true,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    path: null,
    cwd: "/tmp/workspace",
    cliVersion: "fake",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-1",
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 100 : null
  };
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(2);
  }

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }

  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", modelProvider: "openai", serviceTier: null, cwd: "/tmp/workspace", instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: { type: "readOnly", networkAccess: false }, permissionProfile: null, activePermissionProfile: null, reasoningEffort: null } });
    send({ method: "thread/started", params: { thread: thread() } });
    return;
  }

  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId: "codex-thread-1", turn: turn("inProgress") } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-1", turnId: "codex-turn-1", tokenUsage: { total: { inputTokens: 14, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 20 }, last: { inputTokens: 8, cachedInputTokens: 4, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 12 }, modelContextWindow: 258400 } } });
    send({ method: "turn/plan/updated", params: { threadId: "codex-thread-1", turnId: "codex-turn-1", explanation: "Plan from fake server", plan: [{ step: "Write tests", status: "completed" }] } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-1", turnId: "codex-turn-1", itemId: "assistant-message-1", delta: "hello " } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-1", turnId: "codex-turn-1", itemId: "assistant-message-1", delta: "world" } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-1", turn: turn("completed") } });
    return;
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function writeDelayedTurnStartResponseCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-delayed-turn-start-"));
  const path = join(root, "fake-codex-delayed-turn-start.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-delayed-start",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-delayed-start",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    return;
  }
  if (message.method === "turn/start") {
    const currentTurn = turn("inProgress");
    send({ method: "turn/started", params: { threadId: "codex-thread-delayed-start", turn: currentTurn } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-delayed-start", turnId: currentTurn.id, itemId: "assistant-message-delayed-start", delta: "fast delta" } });
    setTimeout(() => {
      send({ method: "turn/completed", params: { threadId: "codex-thread-delayed-start", turn: { ...currentTurn, status: "completed" } } });
    }, 60);
    setTimeout(() => {
      send({ id: message.id, result: { turn: currentTurn } });
    }, 600);
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function writeInterruptStallingCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-interrupt-stall-"));
  const path = join(root, "fake-codex-interrupt-stall.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-cancel",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn() {
  return {
    id: "codex-turn-cancel",
    status: "inProgress",
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread() } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn() } });
    send({ method: "turn/started", params: { threadId: "codex-thread-cancel", turn: turn() } });
    return;
  }
  if (message.method === "turn/interrupt") {
    setTimeout(() => send({ id: message.id, result: {} }), 700);
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

// Fake app-server for session-resilience tests. Logs each method (resume with
// its thread id) to argv[2]; argv[3] carries comma-separated behavior flags:
// "exit-after-turn" dies shortly after completing a turn, "reject-resume"
// answers thread/resume with a no-rollout error.
async function writeResumableCodexAppServer(): Promise<{ path: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-resumable-"));
  const path = join(root, "fake-codex-resumable.cjs");
  const logPath = join(root, "methods.log");
  await writeFile(path, `
const fs = require("node:fs");
const readline = require("node:readline");

const logPath = process.argv[2];
const flags = (process.argv[3] || "").split(",");
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(entry) {
  fs.appendFileSync(logPath, entry + "\\n");
}

function thread(id) {
  return { id, status: "running", cwd: "/tmp/workspace", turns: [] };
}

function turn(status) {
  return { id: "codex-turn-resumable", status, items: [], error: null };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    log("initialize");
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    log("thread/start");
    send({ id: message.id, result: { thread: thread("codex-thread-resumable"), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread("codex-thread-resumable") } });
    return;
  }
  if (message.method === "thread/resume") {
    log("thread/resume:" + message.params.threadId);
    if (flags.includes("reject-resume")) {
      send({ id: message.id, error: { code: -32600, message: "no rollout found for thread id " + message.params.threadId } });
      return;
    }
    send({ id: message.id, result: { thread: thread(message.params.threadId), model: "gpt-test", cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy, sandbox: message.params.sandbox } });
    return;
  }
  if (message.method === "turn/start") {
    log("turn/start");
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-resumable", turn: currentTurn } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-resumable", turnId: currentTurn.id, itemId: "assistant-resumable", delta: "ok" } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-resumable", turn: { ...currentTurn, status: "completed" } } });
    if (flags.includes("exit-after-turn")) {
      // Die shortly after the completion has flushed, emulating a crashed
      // app-server between turns.
      setTimeout(() => process.exit(0), 30);
    }
  }
});
`);
  await chmod(path, 0o755);
  return { path, logPath };
}

async function writeStderrFloodingCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-stderr-flood-"));
  const path = join(root, "fake-codex-stderr-flood.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-stderr-flood",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-stderr-flood",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread() } });
    return;
  }
  if (message.method === "turn/start") {
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-stderr-flood", turn: currentTurn } });
    // 256 KB is far past the OS pipe buffer; the write callback only fires
    // once the parent has drained stderr, so an unconsumed pipe means
    // turn/completed is never sent and the runner hangs.
    process.stderr.write("x".repeat(256 * 1024), () => {
      send({ method: "turn/completed", params: { threadId: "codex-thread-stderr-flood", turn: { ...currentTurn, status: "completed" } } });
    });
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function writeStartupCrashingCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-startup-crash-"));
  const path = join(root, "fake-codex-startup-crash.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    // Exit only after the stderr write has flushed so the parent's bounded
    // tail deterministically sees the diagnostic line.
    process.stderr.write("codex exploded: bad config\\n", () => process.exit(3));
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function writeCredentialLeakingCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-credential-leak-"));
  const path = join(root, "fake-codex-credential-leak.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    // Shaped like a real config-parse diagnostic quoting the offending lines.
    const diagnostic = [
      "failed to parse config at .codex/config.toml",
      'api_key = "sk-live-not-a-real-key"',
      "Authorization: Bearer agentroom-not-a-real-bearer"
    ].join("\\n");
    process.stderr.write(diagnostic + "\\n", () => process.exit(3));
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function writeEnvReportingCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-env-report-"));
  const path = join(root, "fake-codex-env-report.cjs");
  // Markers are deliberately shaped so the credential redactor leaves them
  // alone; a "TOKEN=" spelling would be rewritten and the assertion would pass
  // for the wrong reason.
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    const report = [
      "agentroom-bearer-inherited " + (process.env.AUTH_TOKEN ? "yes" : "no"),
      "path-inherited " + (process.env.PATH ? "yes" : "no")
    ].join(" ");
    process.stderr.write(report + "\\n", () => process.exit(3));
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function writeThreadStartStallingCodexAppServer(): Promise<{ path: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-thread-start-stall-"));
  const path = join(root, "fake-codex-thread-start-stall.cjs");
  const logPath = join(root, "methods.log");
  await writeFile(path, `
const fs = require("node:fs");
const readline = require("node:readline");

const logPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(method) {
  fs.appendFileSync(logPath, method + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message.method);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    return;
  }
});
`);
  await chmod(path, 0o755);
  return { path, logPath };
}

async function writePersistentThreadCodexAppServer(): Promise<{ path: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-persistent-"));
  const path = join(root, "fake-codex-persistent.cjs");
  const logPath = join(root, "methods.log");
  await writeFile(path, `
const fs = require("node:fs");
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
let turnCount = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(method) {
  fs.appendFileSync(${JSON.stringify(logPath)}, method + "\\n");
}

function thread() {
  return {
    id: "codex-thread-persistent",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  turnCount += status === "inProgress" ? 1 : 0;
  return {
    id: "codex-turn-persistent-" + turnCount,
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message.method);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    return;
  }
  if (message.method === "turn/start") {
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-persistent", turn: currentTurn } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-persistent", turnId: currentTurn.id, itemId: "assistant-message-" + turnCount, delta: "turn " + turnCount } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-persistent", turn: { ...currentTurn, status: "completed" } } });
  }
});
`);
  await chmod(path, 0o755);
  return { path, logPath };
}

async function writeInputLoggingCodexAppServer(): Promise<{ path: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-input-log-"));
  const path = join(root, "fake-codex-input-log.cjs");
  const logPath = join(root, "turn-start-params.json");
  await writeFile(path, `
const fs = require("node:fs");
const readline = require("node:readline");

const logPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-input-log",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-input-log",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread() } });
    return;
  }
  if (message.method === "turn/start") {
    fs.writeFileSync(logPath, JSON.stringify(message.params));
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-input-log", turn: currentTurn } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-input-log", turn: { ...currentTurn, status: "completed" } } });
  }
});
`);
  await chmod(path, 0o755);
  return { path, logPath };
}

async function writeThreadStartLoggingCodexAppServer(): Promise<{ path: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-thread-start-log-"));
  const path = join(root, "fake-codex-thread-start-log.cjs");
  const logPath = join(root, "thread-start-params.json");
  await writeFile(path, `
const fs = require("node:fs");
const readline = require("node:readline");

const logPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-network-git",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-network-git",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    fs.writeFileSync(logPath, JSON.stringify(message.params));
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: message.params.approvalPolicy, sandbox: message.params.sandbox } });
    send({ method: "thread/started", params: { thread: thread(), approvalPolicy: message.params.approvalPolicy, sandbox: message.params.sandbox } });
    return;
  }
  if (message.method === "turn/start") {
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-network-git", turn: currentTurn } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-network-git", turn: { ...currentTurn, status: "completed" } } });
  }
});
`);
  await chmod(path, 0o755);
  return { path, logPath };
}

async function waitForEvent(
  events: AgentRunnerEvent[],
  predicate: (event: AgentRunnerEvent) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for runner event");
}

async function waitForTimedEvent<T>(
  events: T[],
  predicate: (event: T) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for runner event");
}

async function waitForLoggedMethod(logPath: string, method: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const contents = await readFile(logPath, "utf8").catch(() => "");
    if (contents.split("\n").includes(method)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for logged JSON-RPC method ${method}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
