import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const execFileAsync = promisify(execFile);

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-git-operations-"));
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

describe("workspace git operations", () => {
  it("stages a named path and reports it in the refreshed status", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "README.md"), "# Workspace\nchanged\n");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/stage`,
      payload: { paths: ["README.md"] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      operation: "stage",
      paths: ["README.md"],
      status: {
        clean: false,
        counts: { staged: 1 },
        files: [{ path: "README.md", staged: true }]
      }
    });

    await app.close();
  });

  it("stages every changed path but refuses secret-named ones, reporting what it skipped", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "src.ts"), "export const value = 1;\n");
    await writeFile(join(workspacePath, ".env"), "TOKEN=super-secret\n");
    await writeFile(join(workspacePath, "id_rsa"), "PRIVATE KEY\n");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/stage`,
      payload: { all: true }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.paths).toEqual(["src.ts"]);
    expect(payload.skippedPaths.sort()).toEqual([".env", "id_rsa"]);
    // The refused files stay untracked: a secret-named path cannot be staged
    // here, so it cannot be swept into a commit this API then pushes.
    expect(payload.status.files.find((file: { path: string }) => file.path === ".env")).toMatchObject({
      staged: false,
      status: "untracked"
    });

    await app.close();
  });

  it("refuses an explicitly named secret path instead of silently dropping it", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, ".env"), "TOKEN=super-secret\n");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/stage`,
      payload: { paths: [".env"] }
    });

    expect(response.statusCode).toBe(415);

    const traversal = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/stage`,
      payload: { paths: ["../escape.txt"] }
    });

    expect(traversal.statusCode).toBe(415);

    await app.close();
  });

  it("refuses a directory pathspec so a safe parent cannot recursively stage a secret child", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "src", "safe.txt"), "initial\n");
    await writeFile(join(workspacePath, "src", ".env"), "TOKEN=initial\n");
    await git(workspacePath, "add", "src");
    await git(workspacePath, "commit", "-m", "Add source files");
    await writeFile(join(workspacePath, "src", "safe.txt"), "changed\n");
    await writeFile(join(workspacePath, "src", ".env"), "TOKEN=changed\n");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/stage`,
      payload: { paths: ["src"] }
    });

    expect(response.statusCode).toBe(409);
    await expect(git(workspacePath, "diff", "--cached", "--name-only")).resolves.toBe("");

    await app.close();
  });

  it("unstages a staged path", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "README.md"), "# Workspace\nchanged\n");
    await git(workspacePath, "add", "README.md");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/unstage`,
      payload: { paths: ["README.md"] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.files).toMatchObject([{ path: "README.md", staged: false, unstaged: true }]);

    await app.close();
  });

  it("commits the staged tree and reports the new commit", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "src.ts"), "export const value = 1;\n");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/commit`,
      payload: { message: "Add a value", stageAll: true }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload).toMatchObject({ operation: "commit", commitSubject: "Add a value" });
    expect(payload.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.status.clean).toBe(true);
    await expect(git(workspacePath, "log", "-1", "--format=%s")).resolves.toBe("Add a value\n");

    await app.close();
  });

  it("refuses to commit a secret path that was staged outside AgentRoom", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, ".env"), "TOKEN=super-secret\n");
    await git(workspacePath, "add", ".env");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/commit`,
      payload: { message: "Should not include secrets" }
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error).toContain("Git index contains a path");
    await expect(git(workspacePath, "log", "-1", "--format=%s")).resolves.toBe("Initial commit\n");
    await expect(git(workspacePath, "diff", "--cached", "--name-only")).resolves.toBe(".env\n");

    await app.close();
  });

  it("refuses to commit an index entry outside a registered repository subdirectory", async () => {
    const serviceConfig = await config();
    const repositoryPath = await createGitWorkspace();
    const workspacePath = join(repositoryPath, "registered-child");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "inside.txt"), "inside\n");
    await writeFile(join(repositoryPath, "outside.txt"), "outside\n");
    await git(repositoryPath, "add", "registered-child/inside.txt", "outside.txt");
    await git(repositoryPath, "commit", "-m", "Add nested files");
    await writeFile(join(repositoryPath, "outside.txt"), "externally staged\n");
    await git(repositoryPath, "add", "outside.txt");
    await writeFile(join(workspacePath, "inside.txt"), "changed inside\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: workspacePath }
    });

    const status = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/git/status`
    });
    expect(status.json().files).toEqual([
      expect.objectContaining({ path: "inside.txt", staged: false, unstaged: true })
    ]);

    const staged = await app.inject({
      method: "POST",
      url: `/api/workspaces/${registered.json().workspace.id}/git/stage`,
      payload: { paths: ["inside.txt"] }
    });
    expect(staged.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${registered.json().workspace.id}/git/commit`,
      payload: { message: "Should stay inside the registered workspace" }
    });

    expect(response.statusCode).toBe(415);
    await expect(git(repositoryPath, "log", "-1", "--format=%s")).resolves.toBe("Add nested files\n");

    await app.close();
  });

  it("rejects a commit with no staged changes and surfaces git's own message", async () => {
    const { app, workspaceId } = await registeredGitWorkspace();

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/commit`,
      payload: { message: "Nothing to do" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("nothing to commit");

    await app.close();
  });

  it("discards a modification back to HEAD and deletes a file HEAD does not have", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "README.md"), "# Workspace\nunwanted\n");
    await writeFile(join(workspacePath, "untracked.txt"), "throwaway\n");
    await writeFile(join(workspacePath, "added.txt"), "staged new file\n");
    await git(workspacePath, "add", "added.txt");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/discard`,
      payload: { paths: ["README.md", "untracked.txt", "added.txt"] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.clean).toBe(true);
    const remaining = await readdir(workspacePath);
    expect(remaining).toContain("README.md");
    expect(remaining).not.toContain("untracked.txt");
    expect(remaining).not.toContain("added.txt");

    await app.close();
  });

  it("discards a staged rename by restoring the original path", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await git(workspacePath, "mv", "README.md", "GUIDE.md");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/discard`,
      payload: { paths: ["GUIDE.md"] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.clean).toBe(true);
    const remaining = await readdir(workspacePath);
    expect(remaining).toContain("README.md");
    expect(remaining).not.toContain("GUIDE.md");

    await app.close();
  });

  it("creates a branch, carrying uncommitted work onto it", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "wip.txt"), "in progress\n");

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/branch/create`,
      payload: { branch: "feature/new-work" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      operation: "create_branch",
      branch: "feature/new-work",
      previousBranch: "main",
      workspace: { git: { branch: "feature/new-work" } }
    });
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("feature/new-work\n");
    expect(await readdir(workspacePath)).toContain("wip.txt");

    await app.close();
  });

  it("rejects creating a branch that already exists and an invalid branch name", async () => {
    const { app, workspaceId } = await registeredGitWorkspace();

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/branch/create`,
      payload: { branch: "main" }
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/branch/create`,
      payload: { branch: "not a valid branch~name" }
    });

    expect(duplicate.statusCode).toBe(409);
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });

  it("publishes a branch with an upstream, then fetches and fast-forward pulls a remote commit", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    const remotePath = await mkdtemp(join(tmpdir(), "agentroom-git-remote-"));
    await git(remotePath, "init", "--bare", "-b", "main");
    await git(workspacePath, "remote", "add", "origin", remotePath);

    const published = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/push`,
      payload: {}
    });

    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ operation: "push", branch: "main", remote: "origin" });
    expect(published.json().workspace.git).toMatchObject({ upstream: "origin/main", ahead: 0, behind: 0 });

    // A second clone lands a commit on the remote, so the workspace has something to pull.
    const collaborator = await mkdtemp(join(tmpdir(), "agentroom-git-collaborator-"));
    await git(collaborator, "clone", remotePath, ".");
    await git(collaborator, "config", "user.email", "agentroom@example.invalid");
    await git(collaborator, "config", "user.name", "AgentRoom Tests");
    await writeFile(join(collaborator, "remote.txt"), "from the remote\n");
    await git(collaborator, "add", "remote.txt");
    await git(collaborator, "commit", "-m", "Remote commit");
    await git(collaborator, "push", "origin", "main");

    const fetched = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/git/fetch` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().workspace.git).toMatchObject({ behind: 1, ahead: 0 });

    const pulled = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/git/pull` });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().workspace.git).toMatchObject({ behind: 0, ahead: 0 });
    expect(await readdir(workspacePath)).toContain("remote.txt");

    await app.close();
  });

  it("reports ahead of upstream after a local commit and pushes it", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    const remotePath = await mkdtemp(join(tmpdir(), "agentroom-git-remote-"));
    await git(remotePath, "init", "--bare", "-b", "main");
    await git(workspacePath, "remote", "add", "origin", remotePath);
    await git(workspacePath, "push", "--set-upstream", "origin", "main");

    await writeFile(join(workspacePath, "local.txt"), "local work\n");
    const committed = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/commit`,
      payload: { message: "Local commit", stageAll: true }
    });
    expect(committed.json().workspace.git).toMatchObject({ ahead: 1, behind: 0 });

    const pushed = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/push`,
      payload: {}
    });

    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().workspace.git).toMatchObject({ ahead: 0, behind: 0 });
    await expect(git(remotePath, "log", "-1", "--format=%s")).resolves.toBe("Local commit\n");

    await app.close();
  });

  it("fails a diverged pull instead of creating a merge or a conflicted worktree", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    const remotePath = await mkdtemp(join(tmpdir(), "agentroom-git-remote-"));
    await git(remotePath, "init", "--bare", "-b", "main");
    await git(workspacePath, "remote", "add", "origin", remotePath);
    await git(workspacePath, "push", "--set-upstream", "origin", "main");

    const collaborator = await mkdtemp(join(tmpdir(), "agentroom-git-collaborator-"));
    await git(collaborator, "clone", remotePath, ".");
    await git(collaborator, "config", "user.email", "agentroom@example.invalid");
    await git(collaborator, "config", "user.name", "AgentRoom Tests");
    await writeFile(join(collaborator, "remote.txt"), "from the remote\n");
    await git(collaborator, "add", "remote.txt");
    await git(collaborator, "commit", "-m", "Remote commit");
    await git(collaborator, "push", "origin", "main");

    await writeFile(join(workspacePath, "local.txt"), "local work\n");
    await git(workspacePath, "add", "local.txt");
    await git(workspacePath, "commit", "-m", "Diverging local commit");

    const response = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/git/pull` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/fast-forward/i);
    // The worktree is untouched: no merge commit, no conflict markers.
    await expect(git(workspacePath, "log", "-1", "--format=%s")).resolves.toBe("Diverging local commit\n");

    await app.close();
  });

  it("rejects remote operations for a workspace with no remote configured", async () => {
    const { app, workspaceId } = await registeredGitWorkspace();

    for (const operation of ["fetch", "pull", "push"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/git/${operation}`,
        payload: {}
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("no Git remote");
    }

    await app.close();
  });

  it("reports remote capability when the only remote is not named origin", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const remotePath = await mkdtemp(join(tmpdir(), "agentroom-git-upstream-"));
    await git(remotePath, "init", "--bare", "-b", "main");
    await git(workspacePath, "remote", "add", "upstream", remotePath);
    const { app } = await buildServer({ config: serviceConfig });

    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: workspacePath }
    });

    expect(registered.statusCode).toBe(201);
    expect(registered.json().workspace.git).toMatchObject({
      isRepository: true,
      hasRemote: true
    });
    expect(registered.json().workspace.git.remote).toBeUndefined();

    await app.close();
  });

  it("rejects git operations on a workspace that is not a repository", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });
    const plainDirectory = await mkdtemp(join(tmpdir(), "agentroom-plain-workspace-"));
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: plainDirectory } });

    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${registered.json().workspace.id}/git/stage`,
      payload: { all: true }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("not a Git repository");

    await app.close();
  });

  it("returns 404 for an unregistered workspace", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace-missing/git/fetch",
      payload: {}
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("requires the bearer token for every mutating git operation when AUTH_TOKEN is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const { app } = await buildServer({ config: serviceConfig });
    const workspacePath = await createGitWorkspace();
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: workspacePath }
    });
    const workspaceId = registered.json().workspace.id;

    const operations = ["stage", "unstage", "discard", "commit", "fetch", "pull", "push", "branch/create"];
    for (const operation of operations) {
      const response = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/git/${operation}`,
        payload: {}
      });
      expect(response.statusCode, `${operation} must require auth`).toBe(401);
    }

    await app.close();
  });

  it("publishes a sanitized event carrying counts rather than paths or content", async () => {
    const { app, workspaceId, workspacePath } = await registeredGitWorkspace();
    await writeFile(join(workspacePath, "src.ts"), "const apiKey = \"super-secret-value\";\n");

    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/git/stage`,
      payload: { paths: ["src.ts"] }
    });
    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    const event = logs
      .json()
      .events.find((candidate: { type: string }) => candidate.type === "workspace_git_operation");

    expect(event.payload).toMatchObject({
      workspaceId,
      operation: "stage",
      fileCount: 1,
      changedFileCount: 1
    });
    expect(event.payload.paths).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("super-secret-value");

    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    expect(audit.json().events).toContainEqual(
      expect.objectContaining({ type: "workspace_git_operation", workspaceId })
    );

    await app.close();
  });
});

async function registeredGitWorkspace() {
  const serviceConfig = await config();
  const { app } = await buildServer({ config: serviceConfig });
  const workspacePath = await createGitWorkspace();
  const registered = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { path: workspacePath }
  });
  return { app, workspaceId: registered.json().workspace.id as string, workspacePath };
}

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
