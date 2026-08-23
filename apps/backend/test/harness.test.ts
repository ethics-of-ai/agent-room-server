import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-harness-"));
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

describe("harness profile", () => {
  it("does not expose the removed event projection", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });
    const removedProjectionEndpoint = ["/api/events", ["a", "g"].join("") + "-" + ["u", "i"].join("")].join("/");

    expect(app.printRoutes()).not.toContain(removedProjectionEndpoint);

    await app.close();
  });

  it("exposes agent-first repository context without enabling execution", async () => {
    const serviceConfig = await config({ authToken: "secret", requireAuth: true });
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({ method: "GET", url: "/api/harness" });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      name: "AgentRoom Harness",
      source: {
        title: "Harness engineering: leveraging Codex in an agent-first world"
      },
      safetyPosture: {
        runnerKind: "codex",
        arbitraryShellApi: false,
        authRequiredForMutations: true
      }
    });
    expect(payload.principles).toContain("The Mac backend is the only local agent host.");
    expect(payload.knowledgeMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", purpose: expect.stringContaining("entry point") }),
        expect.objectContaining({ path: "docs/api/API.md", purpose: expect.stringContaining("REST") }),
        expect.objectContaining({
          path: "docs/reference/apple-wwdc2023-spatial-video-manifest.json",
          purpose: expect.stringContaining("collection")
        }),
        expect.objectContaining({ path: "docs/safety/TRUST_AND_SAFETY.md" })
      ])
    );
    expect(payload.feedbackLoops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status snapshot", endpoint: "/api/status" }),
        expect.objectContaining({ name: "runtime event stream", endpoint: "/api/events" })
      ])
    );
    const removedProjectionEndpoint = ["/api/events", ["a", "g"].join("") + "-" + ["u", "i"].join("")].join("/");
    expect(JSON.stringify(payload)).not.toContain(removedProjectionEndpoint);
    expect(payload.verificationCommands).toContain("pnpm typecheck");
    expect(JSON.stringify(payload)).not.toContain("secret");

    await app.close();
  });

  it("requires Apple spatial design grounding for visionOS design work", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({ method: "GET", url: "/api/harness" });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.visionOSDesignGrounding).toMatchObject({
      requiredReferences: expect.arrayContaining([
        expect.objectContaining({ path: "docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md" }),
        expect.objectContaining({ path: "docs/reference/apple-wwdc2023-spatial-video-manifest.json" }),
        expect.objectContaining({ path: "docs/engineering/SWIFTUI_STANDARDS.md" })
      ]),
      preflightChecklist: expect.arrayContaining([
        expect.stringContaining("WWDC spatial reference"),
        expect.stringContaining("timestamp"),
        expect.stringContaining("AgentRoom client boundary")
      ])
    });
    expect(payload.guardrails).toContain(
      "Ground visionOS design questions and implementation in the Apple spatial design references before proposing or editing UI."
    );

    await app.close();
  });
});
