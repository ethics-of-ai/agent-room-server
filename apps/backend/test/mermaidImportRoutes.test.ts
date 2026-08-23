import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";
import { MAX_MERMAID_SOURCE_BYTES } from "../src/scene/diagram/mermaidImport";
import { diagramDocumentSchema } from "../src/scene/diagram/schemas";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-mermaid-import-routes-"));
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

const validSource = "flowchart TD\n  api[API] --> db[(Orders DB)]";

describe("mermaid import route", () => {
  it("converts a flowchart into canonical diagram file content with a slug", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source: validSource, name: "Order flow" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      content: string;
      name: string;
      slug: string;
      warnings: unknown[];
    };
    expect(body.name).toBe("Order flow");
    expect(body.slug).toBe("order-flow");
    expect(body.warnings).toEqual([]);
    // The content is the exact text a client writes: parseable, schema-valid,
    // and newline-terminated.
    expect(body.content.endsWith("\n")).toBe(true);
    const document = diagramDocumentSchema.parse(JSON.parse(body.content));
    expect(document.name).toBe("Order flow");
    expect(document.nodes.map((node) => node.id)).toEqual(["api", "db"]);
    // Canonical serialization: re-stringifying the parsed document reproduces
    // the served bytes, so a re-import writes an identical file.
    expect(`${JSON.stringify(JSON.parse(body.content), null, 2)}\n`).toBe(body.content);
    await app.close();
  });

  it("rejects malformed payloads with 400", async () => {
    const { app } = await buildServer({ config: await config() });
    const payloads: unknown[] = [
      {},
      { source: "   " },
      { source: validSource, extra: true },
      { source: validSource, name: "x".repeat(121) }
    ];
    for (const payload of payloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/spatial-scene/mermaid-import",
        payload: payload as Record<string, unknown>
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error).toBe("Invalid mermaid import payload");
    }
    await app.close();
  });

  it("rejects an oversized source with 413 before validation", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source: `flowchart TD\n%% ${"x".repeat(MAX_MERMAID_SOURCE_BYTES)}` }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Mermaid source is too large");
    await app.close();
  });

  it("returns 422 with line-level detail for unconvertible source", async () => {
    const { app } = await buildServer({ config: await config() });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source: "sequenceDiagram\n  A->>B: hi" }
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      error: string;
      errors: Array<{ line?: number; message: string }>;
    };
    // The display string folds the first issue in; the array stays structured.
    expect(body.error).toContain("Mermaid source could not be converted");
    expect(body.error).toContain("line 1: Unsupported Mermaid diagram type");
    expect(body.errors[0]!.line).toBe(1);
    expect(body.errors[0]!.message).toContain("Unsupported Mermaid diagram type");
    await app.close();
  });

  it("requires the bearer token when AUTH_TOKEN is configured", async () => {
    const { app } = await buildServer({
      config: await config({ requireAuth: true, authToken: "secret-token" })
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source: validSource }
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source: validSource },
      headers: { authorization: "Bearer secret-token" }
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it("is not registered when the scene engine is disabled", async () => {
    const { app } = await buildServer({ config: await config({ sceneEngineEnabled: false }) });
    const response = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source: validSource }
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("prefers the requested name over a frontmatter title", async () => {
    const { app } = await buildServer({ config: await config() });
    const source = ["---", "title: From frontmatter", "---", validSource].join("\n");

    const withName = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source, name: "Requested" }
    });
    expect(withName.statusCode).toBe(200);
    expect(withName.json().name).toBe("Requested");

    const withoutName = await app.inject({
      method: "POST",
      url: "/api/spatial-scene/mermaid-import",
      payload: { source }
    });
    expect(withoutName.statusCode).toBe(200);
    expect(withoutName.json().name).toBe("From frontmatter");
    expect(withoutName.json().slug).toBe("from-frontmatter");
    await app.close();
  });
});
