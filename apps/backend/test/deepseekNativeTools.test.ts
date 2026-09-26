import { describe, expect, it, vi } from "vitest";
import { prepareDeepSeekNativeTools } from "../src/runner/deepseek/nativeTools";
import { PendingQuestionRequests } from "../src/runner/shared/PendingQuestionRequests";
import type { AgentRunnerActivity } from "../src/runner/AgentRunner";

function fixture(timeoutMs = 600_000) {
  const questions = new PendingQuestionRequests({ timeoutMs });
  const events: Array<Omit<AgentRunnerActivity, "runner">> = [];
  const prepared = prepareDeepSeekNativeTools({
    turn: { runId: "turn", sessionId: "session", workspacePath: "/workspace", prompt: "ask" },
    questions, isLive: () => true, emit: (event) => events.push(event)
  });
  const abort = new AbortController();
  const invoke = () => prepared.tools.binding.invoke({
    name: "ask_user_question", callId: "call", signal: abort.signal,
    arguments: { questions: [{ question: "Which target?", selection: "single", discussion: "optional",
      sensitive: true, options: [{ label: "Mac" }, { label: "Headset" }] }] }
  });
  return { questions, events, prepared, abort, invoke };
}

describe("DeepSeek native questions", () => {
  it("keeps the human wait open, rejects other sessions, and returns sensitive discussion only to the model", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const result = f.invoke();
      const request = f.events[0].canonical;
      if (request?.kind !== "question_requested") throw new Error("Missing request");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.questions.pendingCount("session")).toBe(1);
      const answer = [{ setId: "set-1", selectedOptionIds: ["opt-1"], discussion: "private detail" }];
      expect(f.questions.answer("other-session", request.requestId!, answer)).toBe("unknown_request");
      expect(f.questions.answer("session", request.requestId!, answer)).toBe("answered");
      expect(await result).toContain("private detail");
      expect(JSON.stringify(f.events)).not.toContain("private detail");
      expect(f.questions.answer("session", request.requestId!, answer)).toBe("unknown_request");
      expect(f.prepared.tools.required).toBe(false);
    } finally { f.prepared.dispose(); vi.useRealTimers(); }
  });

  it("reports timeout without inventing a selection", async () => {
    vi.useFakeTimers();
    const f = fixture(10);
    try {
      const result = f.invoke();
      await vi.advanceTimersByTimeAsync(11);
      expect(await result).toContain("No answer arrived in time");
      expect(f.events.at(-1)?.canonical).toMatchObject({ kind: "question_resolved", status: "timeout" });
    } finally { f.prepared.dispose(); vi.useRealTimers(); }
  });

  it.each(["abort", "dispose", "delete"])("releases a pending request on %s and refuses a late answer", async (action) => {
    const f = fixture();
    const result = f.invoke();
    const request = f.events[0].canonical;
    if (request?.kind !== "question_requested") throw new Error("Missing request");
    if (action === "abort") f.abort.abort();
    else if (action === "dispose") f.prepared.dispose();
    else f.questions.releaseSession("session");
    await result;
    expect(f.questions.pendingCount("session")).toBe(0);
    expect(f.questions.answer("session", request.requestId!, [])).toBe("unknown_request");
    f.prepared.dispose();
  });
});
