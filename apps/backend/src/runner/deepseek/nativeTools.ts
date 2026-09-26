import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prepareAgentRunnerToolSet } from "../../agentTools/runnerToolSet";
import { unboundAgentToolResult } from "../../agentTools/dispatch";
import { QUESTIONS_ASK_LOGICAL_ID } from "../../agentTools/questionAsk";
import type { AgentRunnerActivity, AgentRunnerInput, AgentRunnerToolSet } from "../AgentRunner";
import type { PendingQuestionRequests } from "../shared/PendingQuestionRequests";
import { nativeQuestionBatch, nativeQuestionToolResult } from "../shared/nativeQuestions";

/** Adds the adapter-owned question handler to the shared turn tool catalog. */
export function prepareDeepSeekNativeTools(input: {
  turn: AgentRunnerInput;
  questions: PendingQuestionRequests;
  isLive(): boolean;
  emit(activity: Omit<AgentRunnerActivity, "runner">): void;
}): { tools: AgentRunnerToolSet; dispose(): void } {
  const sessionKey = input.turn.sessionId ?? input.turn.runId;
  const prepared = prepareAgentRunnerToolSet({
    runId: input.turn.runId,
    sessionKey,
    catalog: [QUESTIONS_ASK_LOGICAL_ID],
    allowed: [QUESTIONS_ASK_LOGICAL_ID],
    isLive: input.isLive,
    handlers: {
      [QUESTIONS_ASK_LOGICAL_ID]: async (value, invocation) => {
        const parsed = z.record(z.unknown()).safeParse(value);
        if (!parsed.success) return "Expected a question object.";
        const batch = nativeQuestionBatch(parsed.data);
        if ("error" in batch) return batch.error;
        if (!input.isLive() || invocation.signal.aborted) return nativeQuestionToolResult(batch, { status: "cancelled" });
        const requestId = `question-${randomUUID()}`;
        const wait = input.questions.wait({ sessionKey, requestId, sets: batch.sets });
        if (!wait) return nativeQuestionToolResult(batch, { status: "unavailable" });
        const cancel = () => input.questions.cancel(sessionKey, requestId);
        invocation.signal.addEventListener("abort", cancel, { once: true });
        input.emit({
          kind: "deepseek_question_requested", title: "Questions for you", content: { questionCount: batch.sets.length },
          canonical: { kind: "question_requested", requestId, questionSets: batch.sets }
        });
        try {
          const outcome = await wait;
          if (input.isLive()) input.emit({
            kind: "deepseek_question_resolved", title: "Question resolved", content: { status: outcome.status },
            canonical: {
              kind: "question_resolved", requestId, status: outcome.status,
              ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
              ...(outcome.status === "answered" ? {
                questionAnswers: outcome.answers.map((answer) => batch.sets.find((set) => set.setId === answer.setId)?.sensitive
                  ? { setId: answer.setId, selectedOptionIds: answer.selectedOptionIds } : answer)
              } : {})
            }
          });
          return nativeQuestionToolResult(batch, outcome);
        } finally {
          invocation.signal.removeEventListener("abort", cancel);
        }
      }
    }
  });
  const existing = input.turn.tools;
  const questionNames = new Set(prepared.tools.catalog.map((entry) => entry.name));
  return {
    tools: {
      required: existing?.required ?? Boolean(existing?.binding.allowedNames.length),
      catalog: [...(existing?.catalog ?? []).filter((entry) => !questionNames.has(entry.name)), ...prepared.tools.catalog],
      binding: {
        runId: input.turn.runId,
        allowedNames: [...(existing?.binding.allowedNames ?? []).filter((name) => !questionNames.has(name)), ...prepared.tools.binding.allowedNames],
        invoke: (call) => questionNames.has(call.name) ? prepared.tools.binding.invoke(call)
          : existing ? existing.binding.invoke(call) : Promise.resolve(unboundAgentToolResult(call.name))
      }
    },
    dispose: prepared.dispose
  };
}
