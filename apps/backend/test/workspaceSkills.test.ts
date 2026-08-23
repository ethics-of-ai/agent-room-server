import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-workspace-skills-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [],
    codexRunnerProtocol: "exec",
    ...overrides
  };
};

async function writeSkill(root: string, skillsDir: string, folder: string, frontmatter: string): Promise<void> {
  const dir = join(root, skillsDir, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `${frontmatter}\n# ${folder}\n\nBody that must never be returned.\n`);
}

async function registeredWorkspace(app: Awaited<ReturnType<typeof buildServer>>["app"], path: string): Promise<string> {
  const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path } });
  return registered.json().workspace.id as string;
}

describe("workspace skills", () => {
  it("lists codex skills from both repo skill directories with $ invocations and frontmatter metadata", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    await writeSkill(workspaceDir, ".codex/skills", "prime-context", "---\nname: prime-context\ndescription: Prime the repo context.\n---");
    await writeSkill(workspaceDir, ".agents/skills", "swiftui-pro", "---\nname: swiftui-pro\ndescription: SwiftUI review.\n---");
    // Duplicate name in the lower-precedence directory: `.codex/skills` wins.
    await writeSkill(workspaceDir, ".agents/skills", "prime-context", "---\nname: prime-context\ndescription: Shadowed duplicate.\n---");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/skills?runnerKind=codex` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspaceId,
      runnerKind: "codex",
      available: true,
      skills: [
        {
          name: "prime-context",
          description: "Prime the repo context.",
          invocation: "$prime-context",
          source: ".codex/skills"
        },
        {
          name: "swiftui-pro",
          description: "SwiftUI review.",
          invocation: "$swiftui-pro",
          source: ".agents/skills"
        }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain("Body that must never be returned");

    await app.close();
  });

  it("lists claude_code skills with / invocations under the default workspace-settings gate", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    await writeSkill(workspaceDir, ".claude/skills", "regenerate-dmg", "---\nname: regenerate-dmg\ndescription: Rebuild the DMG.\n---");
    // Frontmatter name wins over the folder name when composer-safe.
    await writeSkill(workspaceDir, ".claude/skills", "folder-name", "---\nname: actual-name\ndescription: Uses frontmatter name.\n---");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/skills?runnerKind=claude_code`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runnerKind: "claude_code",
      available: true,
      skills: [
        { name: "actual-name", invocation: "/actual-name", source: ".claude/skills" },
        { name: "regenerate-dmg", invocation: "/regenerate-dmg", source: ".claude/skills" }
      ]
    });

    await app.close();
  });

  it("reports claude_code skills unavailable when workspace-settings loading is gated off", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    await writeSkill(workspaceDir, ".claude/skills", "prime-context", "---\nname: prime-context\n---");

    for (const overrides of [
      { claudeCodeLoadWorkspaceSkills: false },
      { claudeCodePermissionMode: "acceptEdits" as const }
    ]) {
      const { app } = await buildServer({ config: await config(overrides) });
      const workspaceId = await registeredWorkspace(app, workspaceDir);
      const response = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspaceId}/skills?runnerKind=claude_code`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ available: false, skills: [] });

      await app.close();
    }
  });

  it("defaults the runner kind to the configured backend default", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    await writeSkill(workspaceDir, ".codex/skills", "prime-context", "---\nname: prime-context\n---");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/skills` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runnerKind: "codex",
      skills: [expect.objectContaining({ invocation: "$prime-context" })]
    });

    await app.close();
  });

  it("skips symlink escapes, unsafe names, and tolerates malformed frontmatter", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "agentroom-skills-outside-"));
    await mkdir(join(outsideDir, "leaked-skill"), { recursive: true });
    await writeFile(join(outsideDir, "leaked-skill", "SKILL.md"), "---\nname: leaked-skill\n---\n");
    await mkdir(join(workspaceDir, ".codex", "skills"), { recursive: true });
    await symlink(join(outsideDir, "leaked-skill"), join(workspaceDir, ".codex", "skills", "leaked-skill"));
    // Malformed frontmatter degrades to the folder name with no description.
    await writeSkill(workspaceDir, ".codex/skills", "broken-frontmatter", "---\nname: [unclosed\n---");
    // No safe name at all (folder name with spaces, no frontmatter): skipped.
    await writeSkill(workspaceDir, ".codex/skills", "bad name", "no frontmatter here");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/skills?runnerKind=codex` });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([
      { name: "broken-frontmatter", invocation: "$broken-frontmatter", source: ".codex/skills" }
    ]);

    await app.close();
  });

  it("returns an empty list for a workspace with no skill directories", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/skills?runnerKind=codex` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, skills: [] });

    await app.close();
  });

  it("rejects an invalid runner kind and an unknown workspace", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const invalidKind = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/skills?runnerKind=other` });
    const unknownWorkspace = await app.inject({ method: "GET", url: "/api/workspaces/workspace-unknown/skills" });

    expect(invalidKind.statusCode).toBe(400);
    expect(unknownWorkspace.statusCode).toBe(404);

    await app.close();
  });

  it("requires the bearer token when AUTH_TOKEN is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-skills-workspace-"));
    await writeSkill(workspaceDir, ".codex/skills", "prime-context", "---\nname: prime-context\n---");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: workspaceDir },
      headers: { authorization: "Bearer secret-token" }
    });
    const workspaceId = registered.json().workspace.id as string;

    const unauthorized = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/skills` });
    const authorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/skills`,
      headers: { authorization: "Bearer secret-token" }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);

    await app.close();
  });
});
