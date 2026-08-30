import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSessionService } from "../src/agent/AgentSessionService";
import { buildServer } from "../src/server";
import {
  abandonedQuestionRunner,
  config,
  fileWritingRunner,
  permissionAskingRunner,
  questionAskingRunner,
  waitForEvent,
  waitForSession,
  PERMISSION_ALLOW_OPTION_ID,
  PERMISSION_REQUEST_ID,
  QUESTION_REQUEST_ID
} from "./support/agentSessionHarness";

describe("agent sessions", () => {
  it("lets a client answer an outstanding permission request, and audits the decision", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-permission-workspace-"));
    const runner = permissionAskingRunner();
    const { app, eventBus } = await buildServer({ config: serviceConfig, runners: { codex: runner } });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "delete everything" }
    });

    const requested = await waitForEvent(eventBus, "coding_permission_requested");
    // The client is given what it needs to offer a choice: the id an answer
    // addresses and the options the agent itself supplied.
    expect(requested.payload).toMatchObject({
      requestId: PERMISSION_REQUEST_ID,
      options: [
        { optionId: PERMISSION_ALLOW_OPTION_ID, kind: "allow_once", name: "Allow" },
        { optionId: "reject-1", kind: "reject_once", name: "Reject" }
      ],
      request: { title: "Run rm -rf /tmp/everything" }
    });

    const unknownOption = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/permissions/${PERMISSION_REQUEST_ID}`,
      payload: { optionId: "allow_always" }
    });
    expect(unknownOption.statusCode).toBe(400);

    const unknownRequest = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/permissions/permission-not-mine`,
      payload: { optionId: "allow-1" }
    });
    expect(unknownRequest.statusCode).toBe(404);

    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/permissions/${PERMISSION_REQUEST_ID}`,
      // Option ids are opaque. Leading/trailing whitespace must survive the
      // route unchanged so the value still matches what the runner offered.
      payload: { optionId: PERMISSION_ALLOW_OPTION_ID }
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().session.id).toBe(sessionId);
    await waitForSession(app, sessionId, "idle");

    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    const entry = audit.json().events.find(
      (event: { type: string }) => event.type === "agent_permission_resolved"
    );
    // The decision is recorded; the request is not. A tool call an agent was
    // about to run can carry anything, and a durable log is the wrong place
    // for it.
    expect(entry).toMatchObject({
      sessionId,
      audit: {
        requestId: PERMISSION_REQUEST_ID,
        optionId: PERMISSION_ALLOW_OPTION_ID,
        decidedBy: "human",
        status: "selected"
      }
    });
    expect(JSON.stringify(entry)).not.toContain("rm -rf");

    await app.close();
  });

  it("refuses an unauthenticated permission answer when a token is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-permission-auth-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: permissionAskingRunner() } });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory },
      headers: { authorization: "Bearer secret-token" }
    });

    // Answering is a mutation like any other: the global preHandler gates it,
    // so authorizing an agent's action cannot be done by an unauthenticated
    // caller on the LAN.
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-sessions/agent-session-missing/permissions/permission-1",
      payload: { optionId: "allow-1" }
    });
    expect(response.statusCode).toBe(401);
    expect(registered.statusCode).toBe(201);

    await app.close();
  });

  it("reports no outstanding request for a runner with no approval channel", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-permission-none-"));
    const runner = fileWritingRunner("codex", async () => {});
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: runner } });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });

    // A runner that never asks has nothing outstanding, which is the same
    // answer as an id that expired — the route reads no runner identity.
    const response = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/permissions/permission-1`,
      payload: { optionId: "allow-1" }
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("lets a client answer a clarifying-question batch, records the answer in the thread, and audits the decision", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-question-workspace-"));
    const runner = questionAskingRunner();
    const { app, eventBus, agentSessions } = await buildServer({ config: serviceConfig, runners: { codex: runner } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;
    let snapshotDuringRequest: ReturnType<AgentSessionService["listOutstandingQuestions"]> = undefined;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "coding_question_requested") {
        snapshotDuringRequest = agentSessions.listOutstandingQuestions(sessionId);
      }
    });
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "build the thing" }
    });

    const requested = await waitForEvent(eventBus, "coding_question_requested");
    // The client is given what it needs to render the deck: the id an answer
    // addresses and every set with its minted option ids.
    expect(requested.payload).toMatchObject({
      requestId: QUESTION_REQUEST_ID,
      questionSets: [
        { setId: "set-1", header: "Platform", selection: "single", discussion: "optional" },
        { setId: "set-2", header: "Features", selection: "multiple", discussion: "none" }
      ]
    });
    expect(snapshotDuringRequest).toEqual([
      expect.objectContaining({ requestId: QUESTION_REQUEST_ID, questionSets: requested.payload.questionSets })
    ]);
    unsubscribe();

    // A late joiner can re-seed the same batch from the read route.
    const outstanding = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(outstanding.statusCode).toBe(200);
    expect(outstanding.json().questions).toEqual([
      expect.objectContaining({ requestId: QUESTION_REQUEST_ID, questionSets: requested.payload.questionSets })
    ]);

    const unknownOption = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: { answers: [{ setId: "set-1", selectedOptionIds: ["opt-9"] }] }
    });
    expect(unknownOption.statusCode).toBe(400);
    expect(unknownOption.json().error).toBe("Question option was not offered for this set");

    const freeTextRefused = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: { answers: [{ setId: "set-2", selectedOptionIds: ["opt-1"], discussion: "but also" }] }
    });
    expect(freeTextRefused.statusCode).toBe(400);

    const unknownRequest = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/question-not-mine`,
      payload: { answers: [{ setId: "set-1", selectedOptionIds: ["opt-1"] }] }
    });
    expect(unknownRequest.statusCode).toBe(404);

    const emptyAnswer = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: { answers: [] }
    });
    expect(emptyAnswer.statusCode).toBe(400);

    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: {
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first, please" },
          { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
        ]
      }
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().session.id).toBe(sessionId);
    await waitForSession(app, sessionId, "idle");

    const resolved = await waitForEvent(eventBus, "coding_question_resolved");
    expect(resolved.payload).toMatchObject({
      requestId: QUESTION_REQUEST_ID,
      status: "answered",
      decidedBy: "human",
      questionAnswers: [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first, please" },
        { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
      ]
    });

    // The answer is in the thread as the user message it is.
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const answerMessage = messages.json().messages.find(
      (message: { context?: { questionRequestId?: string } }) => message.context?.questionRequestId === QUESTION_REQUEST_ID
    );
    expect(answerMessage).toMatchObject({ role: "user", status: "sent" });
    expect(answerMessage.content).toContain("Platform: Which platform first?");
    expect(answerMessage.content).toContain("→ Mobile");
    expect(answerMessage.content).toContain("phones first, please");
    expect(answerMessage.content).toContain("→ Reminders, Sharing");

    // Durable audit keeps the decision — sets and option ids, on whose
    // authority — and never the person's free text.
    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    const entry = audit.json().events.find((event: { type: string }) => event.type === "agent_question_resolved");
    expect(entry).toMatchObject({
      sessionId,
      audit: {
        requestId: QUESTION_REQUEST_ID,
        status: "answered",
        decidedBy: "human",
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"] },
          { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
        ]
      }
    });
    expect(JSON.stringify(entry)).not.toContain("phones first");

    // Settled, so the read route shows nothing outstanding.
    const drained = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(drained.json().questions).toEqual([]);

    await app.close();
  });

  it("cancels a question left open by a terminal runner path before publishing the terminal event", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-question-terminal-"));
    const { app, eventBus } = await buildServer({
      config: serviceConfig,
      runners: { codex: abandonedQuestionRunner() }
    });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "ask, then fail" }
    });
    await waitForSession(app, sessionId, "failed");

    const questions = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(questions.json().questions).toEqual([]);
    const relevant = eventBus.getRecentEvents().filter((event) =>
      event.type === "coding_question_requested"
      || event.type === "coding_question_resolved"
      || event.type === "coding_turn_failed"
    );
    expect(relevant.map((event) => event.type)).toEqual([
      "coding_question_requested",
      "coding_question_resolved",
      "coding_turn_failed"
    ]);
    expect(relevant[1]?.payload).toMatchObject({ requestId: QUESTION_REQUEST_ID, status: "cancelled" });

    await app.close();
  });

  it("gates the question answer and the outstanding read behind the bearer token when one is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: questionAskingRunner() } });

    const answer = await app.inject({
      method: "POST",
      url: "/api/agent-sessions/agent-session-missing/questions/question-1",
      payload: { answers: [] }
    });
    expect(answer.statusCode).toBe(401);
    // The outstanding read returns model-authored text, so it is gated like
    // the transcript read rather than left open like the status snapshot.
    const read = await app.inject({ method: "GET", url: "/api/agent-sessions/agent-session-missing/questions" });
    expect(read.statusCode).toBe(401);

    await app.close();
  });

  it("reports no outstanding question batch for a runner with no way to ask", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-question-none-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: fileWritingRunner("codex", async () => {}) } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/question-1`,
      payload: { answers: [{ setId: "set-1", selectedOptionIds: ["opt-1"] }] }
    });
    expect(response.statusCode).toBe(404);
    const outstanding = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(outstanding.json().questions).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/agent-sessions/nope/questions" })).statusCode).toBe(404);

    await app.close();
  });
});
