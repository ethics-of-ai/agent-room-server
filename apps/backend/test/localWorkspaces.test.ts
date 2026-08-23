import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const execFileAsync = promisify(execFile);

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-local-workspaces-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

describe("local workspace registry", () => {
  it("lists the configured default workspace root before user workspaces are registered", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({ method: "GET", url: "/api/workspaces" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      defaultWorkspaceRoot: serviceConfig.workspaceRoot,
      workspaces: []
    });

    await app.close();
  });

  it("registers a selected directory without writing AgentRoom metadata inside it", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-selected-workspace-"));
    const expectedPath = await realpath(selectedDirectory);
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const payload = response.json();

    expect(response.statusCode).toBe(201);
    expect(payload.workspace).toMatchObject({
      name: basename(expectedPath),
      path: expectedPath,
      kind: "user_selected",
      git: { isRepository: false }
    });
    expect(payload.workspace.id).toMatch(/^workspace-[a-f0-9]{12}$/);
    expect(payload.workspace.trustedAt).toEqual(expect.any(String));
    expect(payload.workspace.lastOpenedAt).toEqual(expect.any(String));
    await expect(readdir(selectedDirectory)).resolves.toEqual([]);

    const stored = JSON.parse(await readFile(join(serviceConfig.stateDir, "workspaces.json"), "utf8"));
    expect(stored.workspaces).toHaveLength(1);
    expect(stored.workspaces[0]).toMatchObject({ id: payload.workspace.id, path: expectedPath });

    const listResponse = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(listResponse.json().workspaces).toEqual([payload.workspace]);

    await app.close();
  });

  it("updates an existing registered directory instead of creating duplicates", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-selected-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });

    const first = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory, name: "Original name" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory, name: "Renamed workspace" }
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().workspace).toMatchObject({
      id: first.json().workspace.id,
      name: "Renamed workspace",
      trustedAt: first.json().workspace.trustedAt
    });

    const listResponse = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(listResponse.json().workspaces).toHaveLength(1);
    expect(listResponse.json().workspaces[0]).toMatchObject({
      id: first.json().workspace.id,
      name: "Renamed workspace"
    });

    await app.close();
  });

  it("unregisters a selected directory without deleting it", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-selected-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });

    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${registered.json().workspace.id}`
    });
    const listResponse = await app.inject({ method: "GET", url: "/api/workspaces" });

    expect(removed.statusCode).toBe(204);
    expect(listResponse.json().workspaces).toEqual([]);
    await expect(readdir(selectedDirectory)).resolves.toEqual([]);

    await app.close();
  });

  it("rejects non-absolute or missing workspace directories", async () => {
    const serviceConfig = await config();
    const missingDirectory = join(await mkdtemp(join(tmpdir(), "agentroom-missing-parent-")), "missing");
    const { app } = await buildServer({ config: serviceConfig });

    const relative = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: "relative/project" }
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: missingDirectory }
    });
    await mkdir(missingDirectory, { recursive: true });
    const badKind = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: missingDirectory, kind: "unsupported_kind" }
    });

    expect(relative.statusCode).toBe(400);
    expect(relative.json()).toEqual({ error: "Workspace path must be absolute" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: "Workspace path must be an existing directory" });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toEqual({ error: "Invalid workspace payload" });

    await app.close();
  });

  it("requires bearer auth for workspace registration when auth is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-selected-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: selectedDirectory }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(201);
    expect(JSON.stringify(authorized.json())).not.toContain("agentroom-secret");

    await app.close();
  });

  it("lists local Git branches for a registered workspace", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await git(selectedDirectory, "switch", "-c", "feature/branch-switching");
    const { app } = await buildServer({ config: serviceConfig });

    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const response = await app.inject({ method: "GET", url: "/api/workspaces" });

    expect(registered.statusCode).toBe(201);
    expect(response.statusCode).toBe(200);
    expect(response.json().workspaces[0].git).toMatchObject({
      isRepository: true,
      branch: "feature/branch-switching",
      hasUncommittedChanges: false,
      branches: [
        { name: "feature/branch-switching", current: true },
        { name: "main", current: false }
      ]
    });

    await app.close();
  });

  it("returns clean Git status for a registered repository with no dirty files", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/status`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceId,
      isRepository: true,
      branch: "main",
      clean: true,
      counts: {
        total: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0
      },
      files: [],
      truncated: false
    });
    expect(response.json().refreshedAt).toEqual(expect.any(String));

    await app.close();
  });

  it("returns file-level Git status for dirty registered workspaces", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await writeFile(join(selectedDirectory, "modified.txt"), "before\n");
    await writeFile(join(selectedDirectory, "staged.txt"), "before\n");
    await writeFile(join(selectedDirectory, "delete-me.txt"), "delete me\n");
    await writeFile(join(selectedDirectory, "rename-me.txt"), "rename me\n");
    await git(selectedDirectory, "add", ".");
    await git(selectedDirectory, "commit", "-m", "Add status fixtures");
    await writeFile(join(selectedDirectory, "modified.txt"), "before\nafter\n");
    await writeFile(join(selectedDirectory, "staged.txt"), "before\nstaged\n");
    await git(selectedDirectory, "add", "staged.txt");
    await writeFile(join(selectedDirectory, "untracked.txt"), "new\n");
    await rm(join(selectedDirectory, "delete-me.txt"));
    await git(selectedDirectory, "mv", "rename-me.txt", "renamed.txt");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/status`
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      workspaceId,
      isRepository: true,
      clean: false,
      counts: {
        total: 5,
        staged: 2,
        unstaged: 2,
        untracked: 1,
        conflicts: 0
      },
      truncated: false
    });
    expect(payload.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "modified.txt",
        status: "modified",
        staged: false,
        unstaged: true,
        additions: 1,
        deletions: 0
      }),
      expect.objectContaining({
        path: "staged.txt",
        status: "modified",
        staged: true,
        unstaged: false,
        additions: 1,
        deletions: 0
      }),
      expect.objectContaining({
        path: "untracked.txt",
        status: "untracked",
        staged: false,
        unstaged: true
      }),
      expect.objectContaining({
        path: "delete-me.txt",
        status: "deleted",
        staged: false,
        unstaged: true
      }),
      expect.objectContaining({
        path: "renamed.txt",
        oldPath: "rename-me.txt",
        status: "renamed",
        staged: true,
        unstaged: false
      })
    ]));

    await app.close();
  });

  it("returns a safe empty Git status for non-Git workspaces", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-selected-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/status`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceId,
      isRepository: false,
      clean: true,
      counts: {
        total: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0
      },
      files: [],
      truncated: false
    });

    await app.close();
  });

  it("requires bearer auth for Git status when auth is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const selectedDirectory = await createGitWorkspace();
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/status`
    });
    const authorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/status`,
      headers: { authorization: "Bearer agentroom-secret" }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(JSON.stringify(authorized.json())).not.toContain("agentroom-secret");

    await app.close();
  });

  it("returns 404 for Git status on an unknown workspace", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces/workspace-missing/git/status"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Workspace is not registered" });

    await app.close();
  });

  it("switches a registered workspace to an existing clean local branch", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await git(selectedDirectory, "switch", "-c", "feature/branch-switching");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const switched = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/branch`,
      payload: { branch: "main" }
    });

    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({
      workspace: expect.objectContaining({
        id: workspaceId,
        git: expect.objectContaining({
          branch: "main",
          hasUncommittedChanges: false,
          branches: expect.arrayContaining([
            { name: "feature/branch-switching", current: false },
            { name: "main", current: true }
          ])
        })
      }),
      previousBranch: "feature/branch-switching",
      branch: "main",
      changed: true
    });
    await expect(git(selectedDirectory, "branch", "--show-current")).resolves.toBe("main\n");

    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    expect(logs.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "workspace_branch_changed",
        payload: expect.objectContaining({
          workspaceId,
          previousBranch: "feature/branch-switching",
          branch: "main"
        })
      })
    ]));

    await app.close();
  });

  it("rejects branch switching when the workspace has uncommitted changes", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await git(selectedDirectory, "switch", "-c", "feature/branch-switching");
    await writeFile(join(selectedDirectory, "dirty.txt"), "uncommitted\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });

    const switched = await app.inject({
      method: "POST",
      url: `/api/workspaces/${registered.json().workspace.id}/git/branch`,
      payload: { branch: "main" }
    });

    expect(switched.statusCode).toBe(409);
    expect(switched.json()).toEqual({
      error: "Workspace has uncommitted changes; commit or stash them before switching branches"
    });
    await expect(git(selectedDirectory, "branch", "--show-current")).resolves.toBe("feature/branch-switching\n");

    await app.close();
  });

  it("returns the HEAD baseline for a modified tracked file", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await mkdir(join(selectedDirectory, "src"));
    await writeFile(join(selectedDirectory, "src", "app.ts"), "const before = 1;\n");
    await git(selectedDirectory, "add", ".");
    await git(selectedDirectory, "commit", "-m", "Add baseline fixture");
    await writeFile(join(selectedDirectory, "src", "app.ts"), "const after = 2;\nconst added = 3;\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=src/app.ts`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspaceId,
      path: "src/app.ts",
      ref: "HEAD",
      isRepository: true,
      existsInHead: true,
      sizeBytes: Buffer.byteLength("const before = 1;\n"),
      encoding: "utf8",
      content: "const before = 1;\n",
      truncated: false
    });

    await app.close();
  });

  it("serves the pre-rename baseline for a renamed file via its old path", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await writeFile(join(selectedDirectory, "rename-me.txt"), "rename me\n");
    await git(selectedDirectory, "add", ".");
    await git(selectedDirectory, "commit", "-m", "Add rename fixture");
    await git(selectedDirectory, "mv", "rename-me.txt", "renamed.txt");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const oldPath = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=rename-me.txt`
    });
    const newPath = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=renamed.txt`
    });

    expect(oldPath.statusCode).toBe(200);
    expect(oldPath.json()).toMatchObject({ existsInHead: true, content: "rename me\n" });
    expect(newPath.statusCode).toBe(200);
    expect(newPath.json()).toMatchObject({ isRepository: true, existsInHead: false });

    await app.close();
  });

  it("reports missing baselines for new files and non-Git workspaces", async () => {
    const serviceConfig = await config();
    const gitDirectory = await createGitWorkspace();
    await writeFile(join(gitDirectory, "untracked.txt"), "new\n");
    const plainDirectory = await mkdtemp(join(tmpdir(), "agentroom-selected-workspace-"));
    await writeFile(join(plainDirectory, "file.txt"), "content\n");
    const { app } = await buildServer({ config: serviceConfig });
    const gitWorkspaceId = (await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: gitDirectory }
    })).json().workspace.id;
    const plainWorkspaceId = (await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: plainDirectory }
    })).json().workspace.id;

    const untracked = await app.inject({
      method: "GET",
      url: `/api/workspaces/${gitWorkspaceId}/git/file-base?path=untracked.txt`
    });
    const nonRepository = await app.inject({
      method: "GET",
      url: `/api/workspaces/${plainWorkspaceId}/git/file-base?path=file.txt`
    });

    expect(untracked.statusCode).toBe(200);
    expect(untracked.json()).toEqual({
      workspaceId: gitWorkspaceId,
      path: "untracked.txt",
      ref: "HEAD",
      isRepository: true,
      existsInHead: false
    });
    expect(nonRepository.statusCode).toBe(200);
    expect(nonRepository.json()).toEqual({
      workspaceId: plainWorkspaceId,
      path: "file.txt",
      ref: "HEAD",
      isRepository: false,
      existsInHead: false
    });

    await app.close();
  });

  it("bounds Git file baseline paths and refuses secrets, directories, and binary blobs", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await mkdir(join(selectedDirectory, "src"));
    await writeFile(join(selectedDirectory, "src", "app.ts"), "const value = 1;\n");
    await writeFile(join(selectedDirectory, "binary.bin"), Buffer.from([0x62, 0x00, 0x69, 0x6e]));
    await git(selectedDirectory, "add", ".");
    await git(selectedDirectory, "commit", "-m", "Add bounding fixtures");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const traversal = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=${encodeURIComponent("../escape.txt")}`
    });
    const secret = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=.env`
    });
    const directory = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=src`
    });
    const binary = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=binary.bin`
    });

    expect(traversal.statusCode).toBe(400);
    expect(traversal.json()).toEqual({ error: "Workspace path must stay inside the registered workspace" });
    expect(secret.statusCode).toBe(415);
    expect(secret.json()).toEqual({ error: "Workspace file is not previewable" });
    expect(directory.statusCode).toBe(415);
    expect(directory.json()).toEqual({ error: "Workspace path must be a file" });
    expect(binary.statusCode).toBe(415);
    expect(binary.json()).toEqual({ error: "Workspace file is not previewable" });

    await app.close();
  });

  it("returns baseline metadata without content when the HEAD blob exceeds maxBytes", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    const committed = "0123456789".repeat(10);
    await writeFile(join(selectedDirectory, "large.txt"), committed);
    await git(selectedDirectory, "add", ".");
    await git(selectedDirectory, "commit", "-m", "Add large fixture");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=large.txt&maxBytes=16`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspaceId,
      path: "large.txt",
      ref: "HEAD",
      isRepository: true,
      existsInHead: true,
      sizeBytes: committed.length,
      truncated: true
    });

    await app.close();
  });

  it("requires bearer auth for Git file baselines when auth is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const selectedDirectory = await createGitWorkspace();
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: selectedDirectory }
    });
    const workspaceId = registered.json().workspace.id;

    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=README.md`
    });
    const authorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/git/file-base?path=README.md`,
      headers: { authorization: "Bearer agentroom-secret" }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ existsInHead: true, content: "# Workspace\n" });
    expect(JSON.stringify(authorized.json())).not.toContain("agentroom-secret");

    await app.close();
  });
});

async function createGitWorkspace(): Promise<string> {
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-git-workspace-"));
  await git(selectedDirectory, "init", "-b", "main");
  await git(selectedDirectory, "config", "user.email", "agentroom@example.invalid");
  await git(selectedDirectory, "config", "user.name", "AgentRoom Tests");
  await writeFile(join(selectedDirectory, "README.md"), "# Workspace\n");
  await git(selectedDirectory, "add", "README.md");
  await git(selectedDirectory, "commit", "-m", "Initial commit");
  return selectedDirectory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
