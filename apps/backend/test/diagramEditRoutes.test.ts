import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";
import { diagramDocumentSchema } from "../src/scene/diagram/schemas";
import { maxWriteBytes } from "../src/workspace/WorkspaceExplorer";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-diagram-edit-routes-"));
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
};

const baseContent = JSON.stringify({
  schemaVersion: 2,
  kind: "solution",
  name: "Checkout",
  nodes: [
    { id: "api", label: "API", role: "gateway" },
    { id: "orders", label: "Orders", role: "service" }
  ],
  edges: [{ id: "e1", from: "api", to: "orders", kind: "sync" }],
  groups: []
});

describe("diagram edit route", () => {
  it("creates a document from nothing with canonical content, slug, and created ids", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: {
        name: "Order flow",
        ops: [
          { op: "addNode", label: "API", role: "gateway" },
          { op: "addNode", label: "Orders DB", role: "datastore" },
          { op: "addEdge", fromId: "api", toId: "orders-db", kind: "read_write" }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      content: string;
      name: string;
      slug: string;
      warnings: unknown[];
      created: Array<{ opIndex: number; type: string; id: string }>;
    };
    expect(body.name).toBe("Order flow");
    expect(body.slug).toBe("order-flow");
    expect(body.warnings).toEqual([]);
    expect(body.created).toEqual([
      { opIndex: 0, type: "node", id: "api" },
      { opIndex: 1, type: "node", id: "orders-db" },
      { opIndex: 2, type: "edge", id: "e1" }
    ]);
    // The content is the exact text a client writes: parseable, schema-valid,
    // newline-terminated, and canonically serialized (re-stringifying the
    // parsed document reproduces the served bytes).
    expect(body.content.endsWith("\n")).toBe(true);
    const document = diagramDocumentSchema.parse(JSON.parse(body.content));
    expect(document.schemaVersion).toBe(3);
    expect(`${JSON.stringify(JSON.parse(body.content), null, 2)}\n`).toBe(body.content);
    await app.close();
  });

  it("applies ops to an existing base document", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: {
        baseContent,
        ops: [{ op: "setNodeLabel", nodeId: "api", label: "Public API" }]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { content: string; name: string };
    expect(body.name).toBe("Checkout");
    const document = diagramDocumentSchema.parse(JSON.parse(body.content));
    expect(document.nodes.find((node) => node.id === "api")?.label).toBe("Public API");
    await app.close();
  });

  it("applies the v3 description ops and serializes the field after the text it annotates", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: {
        baseContent,
        ops: [
          { op: "setNodeDescription", nodeId: "orders", description: "Owns order state." },
          { op: "setEdgeDescription", edgeId: "e1", description: "REST ingress." },
          { op: "setDescription", description: "Order lifecycle end to end." }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { content: string };
    const document = diagramDocumentSchema.parse(JSON.parse(body.content));
    expect(document.schemaVersion).toBe(3);
    expect(document.description).toBe("Order lifecycle end to end.");
    expect(document.nodes.find((node) => node.id === "orders")?.description).toBe("Owns order state.");
    // Canonical order: description directly after the human-text field it
    // annotates — the document's name, a node's label — pinned at the byte
    // level because clients write this text verbatim.
    expect(body.content).toContain(
      '  "name": "Checkout",\n  "description": "Order lifecycle end to end.",\n  "nodes": ['
    );
    expect(body.content).toContain(
      '"label": "Orders",\n      "description": "Owns order state.",\n      "role": "service"'
    );
    expect(body.content).toContain(
      '"description": "REST ingress.",\n      "kind": "sync"'
    );
    await app.close();
  });

  it("rejects malformed payloads with 400", async () => {
    const { app } = await buildServer({ config: await config() });
    const payloads: unknown[] = [
      {},
      { ops: [] },
      { ops: [{ op: "unknownOp" }] },
      { ops: [{ op: "setName", name: "X", extra: true }] },
      { ops: [{ op: "setName", name: "X" }], extra: true },
      // name is only for creation; renames go through setName.
      { baseContent, name: "Renamed", ops: [{ op: "setName", name: "X" }] },
      { ops: Array.from({ length: 33 }, () => ({ op: "setName", name: "X" })) }
    ];
    for (const payload of payloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/spatial-scene/diagram-edit",
        payload: payload as Record<string, unknown>
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error).toBe("Invalid diagram edit payload");
    }
    await app.close();
  });

  it("rejects an oversized base document with 413 before validation", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: {
        baseContent: "x".repeat(maxWriteBytes + 1),
        ops: [{ op: "setName", name: "X" }]
      }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Base document is too large");
    await app.close();
  });

  it("returns 422 with op-indexed detail for an inapplicable op", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: {
        baseContent,
        ops: [{ op: "deleteNode", nodeId: "ghost" }]
      }
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: string;
      errors: Array<{ opIndex?: number; path?: string; message: string }>;
    };
    // The display string folds the first issue in (1-based for people); the
    // array stays structured (0-based for clients).
    expect(body.error).toContain("Diagram edit could not be applied");
    expect(body.error).toContain('op 1: Unknown node id "ghost"');
    expect(body.errors).toEqual([{ opIndex: 0, message: 'Unknown node id "ghost"' }]);
    await app.close();
  });

  it("returns 422 with path detail for an invalid base document", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: {
        baseContent: "{ not json",
        ops: [{ op: "setName", name: "X" }]
      }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("not valid JSON");
    await app.close();
  });

  it("requires the bearer token when AUTH_TOKEN is configured", async () => {
    const { app } = await buildServer({
      config: await config({ requireAuth: true, authToken: "secret-token" })
    });
    const payload = { ops: [{ op: "addNode", label: "API", role: "service" }] };
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload,
      headers: { authorization: "Bearer secret-token" }
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it("is not registered when the scene engine is disabled", async () => {
    const { app } = await buildServer({ config: await config({ sceneEngineEnabled: false }) });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/diagram-edit",
      payload: { ops: [{ op: "setName", name: "X" }] }
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
