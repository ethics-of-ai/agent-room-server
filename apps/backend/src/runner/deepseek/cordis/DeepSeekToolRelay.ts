import type { Duplex } from "node:stream";
import { unboundAgentToolResult, type AgentToolAdvertisement } from "../../../agentTools/dispatch";
import type { AgentRunnerToolBinding } from "../../AgentRunner";
import {
  AGENTROOM_TOOLS_MAX_FRAME_BYTES,
  AGENTROOM_TOOLS_PROTOCOL_VERSION,
  childToolMessageSchema,
  encodeToolMessage,
  type ChildToolMessage,
  type ParentToolMessage
} from "./protocol";

const READY_TIMEOUT_MESSAGE = "Timed out waiting for the AgentRoom Cordis tools plugin";

export class DeepSeekToolRelay {
  private buffer = "";
  private greeted = false;
  private ready = false;
  private closed = false;
  private binding?: AgentRunnerToolBinding;
  private readonly calls = new Map<string, AbortController>();
  private readonly seenCallIds = new Set<string>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(
    private readonly stream: Duplex,
    private readonly catalog: readonly AgentToolAdvertisement[]
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => this.receive(chunk));
    stream.on("error", () => this.close(new Error("AgentRoom tools pipe failed")));
    stream.on("close", () => this.close(new Error("AgentRoom tools pipe closed")));
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(READY_TIMEOUT_MESSAGE)), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([this.readyPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  bind(binding: AgentRunnerToolBinding): void {
    if (!this.ready || this.closed) throw new Error("AgentRoom Cordis tools plugin is unavailable");
    if (this.binding) throw new Error("AgentRoom Cordis tools already have a live turn binding");
    this.seenCallIds.clear();
    this.binding = binding;
    this.send({
      version: AGENTROOM_TOOLS_PROTOCOL_VERSION,
      type: "bind",
      runId: binding.runId,
      allowedNames: binding.allowedNames
    });
  }

  unbind(runId: string): void {
    if (this.binding?.runId !== runId) return;
    for (const controller of this.calls.values()) controller.abort();
    this.calls.clear();
    this.seenCallIds.clear();
    this.binding = undefined;
    if (!this.closed) this.send({ version: AGENTROOM_TOOLS_PROTOCOL_VERSION, type: "unbind", runId });
  }

  close(error = new Error("AgentRoom tools relay closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.calls.values()) controller.abort();
    this.calls.clear();
    this.binding = undefined;
    if (!this.ready) this.rejectReady(error);
    this.stream.destroy();
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, "utf8") > AGENTROOM_TOOLS_MAX_FRAME_BYTES) {
          this.close(new Error("AgentRoom tools pipe exceeded its frame bound"));
        }
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > AGENTROOM_TOOLS_MAX_FRAME_BYTES) {
        this.close(new Error("AgentRoom tools pipe exceeded its frame bound"));
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        this.close(new Error("AgentRoom tools pipe sent malformed JSON"));
        return;
      }
      const parsed = childToolMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        this.close(new Error("AgentRoom tools pipe sent an invalid envelope"));
        return;
      }
      this.handle(parsed.data);
      if (this.closed) return;
    }
  }

  private handle(message: ChildToolMessage): void {
    if (message.type === "hello") {
      if (this.greeted) return this.close(new Error("AgentRoom tools catalog replay refused"));
      this.greeted = true;
      this.send({ version: AGENTROOM_TOOLS_PROTOCOL_VERSION, type: "catalog", catalog: this.catalog });
      return;
    }
    if (message.type === "ready") {
      const expected = this.catalog.map((tool) => tool.name);
      if (!this.greeted || this.ready || JSON.stringify(message.names) !== JSON.stringify(expected)) {
        return this.close(new Error("AgentRoom Cordis tools plugin registered an unexpected catalog"));
      }
      this.ready = true;
      this.resolveReady();
      return;
    }
    if (!this.ready) return this.close(new Error("AgentRoom tools pipe invoked before readiness"));
    if (message.type === "cancel") {
      if (message.runId === this.binding?.runId) this.calls.get(message.callId)?.abort();
      return;
    }
    void this.invoke(message);
  }

  private async invoke(message: Extract<ChildToolMessage, { type: "invoke" }>): Promise<void> {
    const binding = this.binding;
    if (
      !binding
      || binding.runId !== message.runId
      || !binding.allowedNames.includes(message.name)
      || this.seenCallIds.has(message.callId)
    ) {
      this.sendResult(message, unboundAgentToolResult(message.name));
      return;
    }
    this.seenCallIds.add(message.callId);
    const controller = new AbortController();
    this.calls.set(message.callId, controller);
    try {
      let result: string;
      try {
        result = await binding.invoke({
          callId: message.callId,
          name: message.name,
          arguments: message.arguments,
          signal: controller.signal
        });
      } catch {
        result = unboundAgentToolResult(message.name);
      }
      if (!this.closed) this.sendResult(message, result);
    } finally {
      this.calls.delete(message.callId);
    }
  }

  private sendResult(message: { runId: string; callId: string }, result: string): void {
    if (this.closed) return;
    this.send({
      version: AGENTROOM_TOOLS_PROTOCOL_VERSION,
      type: "result",
      runId: message.runId,
      callId: message.callId,
      result
    });
  }

  private send(message: ParentToolMessage): void {
    if (!this.closed) this.stream.write(encodeToolMessage(message));
  }
}
