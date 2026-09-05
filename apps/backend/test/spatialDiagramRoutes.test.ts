import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import type { AgentSession, ServiceConfig } from "../src/domain/models";
import type { AgentRunner, AgentRunnerInput } from "../src/runner/AgentRunner";
import { DIAGRAM_PROMPT_INSTRUCTION } from "../src/scene/diagram/prompt";

const diagramJson = JSON.stringify({
  schemaVersion: 1,
  kind: "solution",
  name: "Checkout flow",
  nodes: [
    { id: "api", label: "API", role: "service", group: "core" },
    { id: "db", label: "Database", role: "datastore", group: "core" }
  ],
  edges: [{ id: "writes", from: "api", to: "db", kind: "read_write" }],
  groups: [{ id: "core", label: "Core" }]
});

// A three-node chain so a flow has more than one hop to order, authored at the
// version that admits `flows`.
const flowDiagramJson = JSON.stringify({
  schemaVersion: 2,
  kind: "solution",
  name: "Checkout flow",
  nodes: [
    { id: "web", label: "Web", role: "actor" },
    { id: "api", label: "API", role: "service", group: "core" },
    { id: "db", label: "Database", role: "datastore", group: "core" }
  ],
  edges: [
    { id: "accepts", from: "web", to: "api", kind: "sync" },
    { id: "writes", from: "api", to: "db", kind: "read_write" }
  ],
  groups: [{ id: "core", label: "Core" }],
  flows: [{ id: "place-order", label: "Place an order", edges: ["accepts", "writes"] }]
});

async function config(overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-diagram-routes-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    editorCatalogDir: join(root, ".catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
}

describe("spatial diagram walking skeleton", () => {
  it("teaches a Codex turn the contract and serves the diagram file that turn writes", async () => {
    const inputs: AgentRunnerInput[] = [];
    const runner = writingRunner(inputs);
    const built = await buildServer({ config: await config(), runners: { codex: runner } });
    const workspace = await registerWorkspace(built.app);

    const sessionResponse = await built.app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: workspace.id, runnerKind: "codex" }
    });
    expect(sessionResponse.statusCode).toBe(201);
    const sessionId = sessionResponse.json().session.id as string;

    const turn = await built.app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "Design the checkout flow as a spatial diagram." }
    });
    expect(turn.statusCode).toBe(202);
    await waitForSession(built.agentSessions, sessionId, "idle");

    expect(inputs[0]!.prompt).toContain(DIAGRAM_PROMPT_INSTRUCTION);
    expect(inputs[0]!.prompt).toContain("Design the checkout flow as a spatial diagram.");

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=docs/diagrams/checkout.diagram.json`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: "docs/diagrams/checkout.diagram.json",
      document: {
        // The composed contract is at 3 (it gained `flows` at 2 and
        // descriptions at 3) while this source document still declares 1 — a
        // committed diagram authored against an older engine keeps rendering,
        // it just carries no flows and no descriptions.
        schemaVersion: 3,
        kind: "solution",
        name: "Checkout flow",
        flows: [],
        warnings: []
      },
      base: { path: "docs/diagrams/checkout.diagram.json" },
      human: null,
      humanDocument: null
    });
    expect(response.json().document.entities).toHaveLength(3);
    expect(response.json().document.connectors).toHaveLength(1);
    await built.app.close();
  });

  it("serves a schemaVersion 2 flow as an ordered list of composed connector ids", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "checkout.diagram.json"), flowDiagramJson);

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=checkout.diagram.json`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().document.flows).toEqual([
      {
        id: "flow:place-order",
        label: "Place an order",
        provenance: { flowId: "place-order" },
        connectorIds: ["edge:accepts", "edge:writes"]
      }
    ]);
    await built.app.close();
  });

  it("keeps a flow renderable when a human hides a node on its path", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "checkout.diagram.json"), flowDiagramJson);
    await writeFile(
      join(workspace.path, "checkout.diagram.human.json"),
      JSON.stringify({ schemaVersion: 1, overrides: [{ id: "db", visible: false }] })
    );

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=checkout.diagram.json`
    });

    expect(response.statusCode).toBe(200);
    // The `writes` edge has no connector while its target is hidden, so that
    // step is dropped rather than pointing the renderer at nothing. The hop
    // that survives still lights.
    expect(response.json().document.flows).toEqual([
      {
        id: "flow:place-order",
        label: "Place an order",
        provenance: { flowId: "place-order" },
        connectorIds: ["edge:accepts"]
      }
    ]);
    await built.app.close();
  });

  it("returns bounded structured validation errors as a renderable data state", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "broken.diagram.json"), "{not json");

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=broken.diagram.json`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().document).toEqual({
      errors: [{ path: "base", message: "File is not valid JSON" }]
    });
    expect(response.json().version).toMatch(/^[a-f0-9]{64}$/);
    await built.app.close();
  });

  it("reports an invalid human layer instead of silently dropping it", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "checkout.diagram.json"), diagramJson);
    await writeFile(join(workspace.path, "checkout.diagram.human.json"), "{not json");

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=checkout.diagram.json`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().document).toEqual({
      errors: [{ path: "human", message: "File is not valid JSON" }]
    });
    expect(response.json().human).toMatchObject({ path: "checkout.diagram.human.json" });
    expect(response.json().humanDocument).toBeNull();
    await built.app.close();
  });

  // The standing contract tells the agent to read the sibling
  // override layer, but it cannot tell it that the layer *changed*. The bounded
  // PUT the client drags through already publishes `workspace_file_written`, so
  // the next turn in that session carries a summary — no watcher, no new event.
  it("tells the next turn what the human moved, once", async () => {
    const inputs: AgentRunnerInput[] = [];
    const built = await buildServer({ config: await config(), runners: { codex: writingRunner(inputs) } });
    const workspace = await registerWorkspace(built.app);
    const sessionResponse = await built.app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: workspace.id, runnerKind: "codex" }
    });
    const sessionId = sessionResponse.json().session.id as string;
    const turn = async (message: string): Promise<void> => {
      await built.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message } });
      await waitForSession(built.agentSessions, sessionId, "idle");
    };

    // Turn 1 writes the diagram; nothing has been adjusted yet.
    await turn("Design the checkout flow as a spatial diagram.");
    expect(inputs[0]!.prompt).not.toContain("Human diagram edits");

    const written = await built.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.id}/file`,
      payload: {
        path: "docs/diagrams/checkout.diagram.human.json",
        content: JSON.stringify({
          schemaVersion: 1,
          overrides: [{ id: "api", transform: { position: [0.4, 0.2, -0.1] } }, { id: "db", visible: false }]
        })
      }
    });
    expect(written.statusCode).toBe(201);

    await turn("Add a payments service.");
    expect(inputs[1]!.prompt).toContain("Human diagram edits");
    expect(inputs[1]!.prompt).toContain("docs/diagrams/checkout.diagram.json — placement: moved: api; hidden: db");

    // Salience, not nagging: an unchanged layer is not re-announced every turn.
    await turn("Now add a queue.");
    expect(inputs[2]!.prompt).not.toContain("Human diagram edits");
    await built.app.close();
  });

  it("uses the scene-engine flag as the single prompt and route gate", async () => {
    const inputs: AgentRunnerInput[] = [];
    const built = await buildServer({
      config: await config({ sceneEngineEnabled: false }),
      runners: { codex: writingRunner(inputs) }
    });
    const workspace = await registerWorkspace(built.app);
    const sessionResponse = await built.app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: workspace.id, runnerKind: "codex" }
    });
    const sessionId = sessionResponse.json().session.id as string;
    const turn = async (message: string): Promise<void> => {
      await built.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message } });
      await waitForSession(built.agentSessions, sessionId, "idle");
    };
    await turn("Design the checkout flow.");

    expect(inputs[0]!.prompt).not.toContain(DIAGRAM_PROMPT_INSTRUCTION);
    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=docs/diagrams/checkout.diagram.json`
    });
    expect(response.statusCode).toBe(404);

    // One flag gates both halves of the prompt seam: the standing contract and
    // the per-turn human-edit summary.
    await built.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.id}/file`,
      payload: {
        path: "docs/diagrams/checkout.diagram.human.json",
        content: JSON.stringify({ schemaVersion: 1, overrides: [{ id: "api", locked: true }] })
      }
    });
    await turn("Add a payments service.");
    expect(inputs[1]!.prompt).not.toContain("Human diagram edits");
    await built.app.close();
  });

  it("composes human node overrides on the next read without tracking state", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "checkout.diagram.json"), diagramJson);

    const humanJson = JSON.stringify({
      schemaVersion: 1,
      overrides: [{ id: "api", transform: { position: [0.4, 0.2, -0.1] }, locked: true }]
    });
    const written = await built.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.id}/file`,
      payload: { path: "checkout.diagram.human.json", content: humanJson }
    });
    expect(written.statusCode).toBe(201);

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=checkout.diagram.json`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().document.entities[0]).toMatchObject({
      id: "node:api",
      transform: { position: [0.4, 0.2, -0.1] },
      locked: true,
      humanEdited: true
    });
    expect(response.json().document.connectors[0].from).toEqual([0.4, 0.2, -0.1]);
    expect(response.json().human).toMatchObject({ path: "checkout.diagram.human.json" });
    await built.app.close();
  });

  // End to end: the human places a node, the agent's next
  // revision renames it away, and the composed read is where they find out.
  // Adopting the new layout is the client rewriting the same override layer
  // through the same bounded PUT — there is no discard route.
  it("reports an adjustment the agent's revision orphaned, and clears it on rewrite", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "checkout.diagram.json"), diagramJson);

    const written = await built.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.id}/file`,
      payload: {
        path: "checkout.diagram.human.json",
        content: JSON.stringify({
          schemaVersion: 1,
          overrides: [
            { id: "api", transform: { position: [0.4, 0.2, -0.1] } },
            { id: "db", locked: true }
          ]
        })
      }
    });
    expect(written.statusCode).toBe(201);

    const read = async () => {
      const response = await built.app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.id}/spatial-scene?path=checkout.diagram.json`
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };

    expect((await read()).document.staleOverrides).toEqual([]);

    // The agent rewrites the diagram, renaming `api` to `gateway`.
    await writeFile(join(workspace.path, "checkout.diagram.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "solution",
      name: "Checkout flow",
      nodes: [
        { id: "gateway", label: "API", role: "service", group: "core" },
        { id: "db", label: "Database", role: "datastore", group: "core" }
      ],
      edges: [{ id: "writes", from: "gateway", to: "db", kind: "read_write" }],
      groups: [{ id: "core", label: "Core" }]
    }));

    const orphaned = await read();
    expect(orphaned.document.staleOverrides).toEqual([{ id: "api", moved: true }]);
    // The live adjustment beside it is untouched, and the orphan still composes
    // to nothing rather than to an entity of its own.
    expect(orphaned.document.entities.find((entity: { id: string }) => entity.id === "node:db"))
      .toMatchObject({ locked: true });
    expect(orphaned.document.entities.map((entity: { id: string }) => entity.id))
      .not.toContain("node:api");

    const discarded = await built.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.id}/file`,
      payload: {
        path: "checkout.diagram.human.json",
        baseModifiedAt: orphaned.human.modifiedAt,
        content: JSON.stringify({ schemaVersion: 1, overrides: [{ id: "db", locked: true }] })
      }
    });
    expect(discarded.statusCode).toBe(200);
    expect((await read()).document.staleOverrides).toEqual([]);
    await built.app.close();
  });

  // The override layer keys on bare semantic ids; composed entity ids are
  // namespaced (`node:api`) so a node and its group platter can never be
  // confused. A client that writes the composed id back does not merely miss
  // its target — the id fails the schema's id pattern, so the whole diagram
  // becomes an error document and the human's first drag replaces their
  // diagram with a validation card. This is the backend half of that contract;
  // the client resolves the id through entity provenance before writing
  // (`SpatialSceneStore.overrideId(forEntityId:in:)`).
  it("rejects composed entity ids in the override layer", async () => {
    const built = await buildServer({ config: await config() });
    const workspace = await registerWorkspace(built.app);
    await writeFile(join(workspace.path, "checkout.diagram.json"), diagramJson);

    const written = await built.app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.id}/file`,
      payload: {
        path: "checkout.diagram.human.json",
        content: JSON.stringify({
          schemaVersion: 1,
          overrides: [{ id: "node:api", transform: { position: [0.4, 0.2, -0.1] } }]
        })
      }
    });
    expect(written.statusCode).toBe(201);

    const response = await built.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/spatial-scene?path=checkout.diagram.json`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().document.entities).toBeUndefined();
    expect(response.json().document.errors).toEqual([
      { path: "human.overrides.0.id", message: "Ids must match ^[a-z0-9][a-z0-9_-]{0,63}$" }
    ]);
    await built.app.close();
  });
});

function writingRunner(inputs: AgentRunnerInput[]): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      inputs.push(input);
      const directory = join(input.workspacePath, "docs", "diagrams");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "checkout.diagram.json"), diagramJson);
      yield { type: "run_succeeded", message: "diagram written" };
    },
    async cancel() {}
  };
}

async function registerWorkspace(app: Awaited<ReturnType<typeof buildServer>>["app"]): Promise<{
  id: string;
  path: string;
}> {
  const path = await mkdtemp(join(tmpdir(), "agentroom-diagram-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { path }
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json().workspace.id as string, path };
}

async function waitForSession(
  service: Awaited<ReturnType<typeof buildServer>>["agentSessions"],
  sessionId: string,
  status: AgentSession["status"]
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.getSession(sessionId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become ${status}`);
}
