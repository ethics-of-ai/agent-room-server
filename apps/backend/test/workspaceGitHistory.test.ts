import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";
import type { WorkspaceGitHistory } from "../src/domain/gitHistory";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function fixture(options: { auth?: boolean; subdirectory?: boolean; empty?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentroom-history-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, "inside"), { recursive: true });
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "History Tests");
  if (!options.empty) {
    await writeFile(join(cwd, "inside", "file.txt"), "before\n");
    await writeFile(join(cwd, "outside.txt"), "outside\n");
    await git(cwd, "add", "inside/file.txt", "outside.txt");
    await git(cwd, "commit", "-m", "Initial");
  }
  const config: ServiceConfig = {
    runnerKind: "codex", host: "127.0.0.1", port: 8799, workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"), editorCatalogDir: join(root, "catalog"), codexArgs: [],
    requireAuth: Boolean(options.auth), authToken: options.auth ? "test-bearer" : undefined, gitCommandTimeoutMs: 30_000
  };
  const { app } = await buildServer({ config });
  cleanups.push(() => app.close());
  const headers = options.auth ? { authorization: "Bearer test-bearer" } : {};
  const registered = await app.inject({ method: "POST", url: "/api/workspaces", headers,
    payload: { path: options.subdirectory ? join(cwd, "inside") : cwd } });
  expect(registered.statusCode).toBe(201);
  const workspaceId = registered.json().workspace.id;
  const get = (route: string, query: Record<string, string> = {}) => app.inject({ method: "GET", headers,
    url: `/api/workspaces/${workspaceId}/git/${route}?${new URLSearchParams(query)}` });
  return { app, cwd, workspaceId, get };
}

describe("workspace Git history", { timeout: 30_000 }, () => {
  it("keeps one copy of shared ancestry and compares diverged tips", async () => {
    const { cwd, get } = await fixture();
    const base = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "switch", "-c", "feature");
    await writeFile(join(cwd, "feature.txt"), "feature");
    await git(cwd, "add", "feature.txt");
    await git(cwd, "commit", "-m", "Feature");
    const feature = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "switch", "main");
    await writeFile(join(cwd, "main.txt"), "main");
    await git(cwd, "add", "main.txt");
    await git(cwd, "commit", "-m", "Main");
    const main = await git(cwd, "rev-parse", "HEAD");
    const response = await get("history", { branch: "refs/heads/feature", compare: "refs/heads/main" });
    expect(response.statusCode, response.body).toBe(200);
    const history = response.json<WorkspaceGitHistory>();
    expect(history.commits.map((c) => c.id).sort()).toEqual([base, feature, main].sort());
    expect(history.comparison).toEqual({ mergeBases: [base], leftOnly: [feature], rightOnly: [main], truncated: false });
    expect(history.head).toBe(main);
    expect(history.commits.find((c) => c.id === feature)?.parents).toEqual([base]);
    await git(cwd, "merge", "--no-ff", "feature", "-m", "Merge feature");
    const merged = (await get("history")).json<WorkspaceGitHistory>();
    expect(merged.commits[0].parents).toEqual([main, feature]);
    const detail = (await get("commit", { commit: merged.commits[0].id })).json();
    expect(detail.parent).toBe(main);
    expect(detail.files).toContainEqual({ path: "feature.txt", status: "A", previewable: true });
  });

  it("labels bounded history and preserves parent ids outside the loaded slice", async () => {
    const { cwd, get } = await fixture();
    const parent = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "commit", "--allow-empty", "-m", "Second");
    const response = await get("history", { limit: "1" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ truncated: true, commits: [{ parents: [parent], subject: "Second" }] });
  });

  it("includes the locally fetched upstream and handles detached and unborn HEAD", async () => {
    const { cwd, get } = await fixture();
    const id = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "remote", "add", "origin", "/nonexistent-local-remote");
    await git(cwd, "update-ref", "refs/remotes/origin/main", id);
    await git(cwd, "branch", "--set-upstream-to=origin/main", "main");
    const response = await get("history");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().upstreamRef).toBe("refs/remotes/origin/main");
    await git(cwd, "checkout", "--detach");
    expect((await get("history")).json().selectedRef).toBe("HEAD");
    const empty = await fixture({ empty: true });
    expect((await empty.get("history")).json()).toMatchObject({ isRepository: true, commits: [], truncated: false });
  });

  it("pins historical file content and scopes deleted and added files to a registered subtree", async () => {
    const { cwd, get } = await fixture({ subdirectory: true });
    const root = await git(cwd, "rev-parse", "HEAD");
    const added = await get("commit-file", { commit: root, path: "file.txt" });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ before: "", after: "before\n" });
    await git(cwd, "rm", "inside/file.txt");
    await mkdir(join(cwd, "inside"), { recursive: true });
    await writeFile(join(cwd, "outside.txt"), "outside secret change\n");
    await git(cwd, "add", "outside.txt");
    await git(cwd, "commit", "-m", "Delete");
    const deletion = await git(cwd, "rev-parse", "HEAD");
    expect((await get("commit", { commit: deletion })).json().files).toEqual([{ path: "file.txt", status: "D", previewable: true }]);
    expect((await get("commit-file", { commit: deletion, path: "file.txt" })).json()).toMatchObject({ before: "before\n", after: "" });
    expect((await get("commit-file", { commit: deletion, path: "../outside.txt" })).statusCode).toBe(415);
    expect((await get("commit-file", { commit: deletion, path: "outside.txt" })).statusCode).toBe(404);
  });

  it("filters protected files and refuses symlinks, binary blobs, and partial text", async () => {
    const { cwd, get } = await fixture();
    await writeFile(join(cwd, ".env"), "TOKEN=secret\n");
    await writeFile(join(cwd, "binary"), Buffer.from([0, 255]));
    await writeFile(join(cwd, "large"), "x".repeat(256 * 1024 + 1));
    await symlink(".env", join(cwd, "link"));
    await git(cwd, "add", ".env", "binary", "large", "link");
    await git(cwd, "commit", "-m", "Various files");
    const commit = await git(cwd, "rev-parse", "HEAD");
    const detail = (await get("commit", { commit })).json();
    expect(detail.filtered).toBe(true);
    expect(detail.files.some((f: { path: string }) => f.path === ".env")).toBe(false);
    expect(detail.files.find((f: { path: string }) => f.path === "link").previewable).toBe(false);
    for (const path of [".env", "link", "binary"]) expect((await get("commit-file", { commit, path })).statusCode).toBe(415);
    expect((await get("commit-file", { commit, path: "large" })).statusCode).toBe(413);
  });

  it("treats special filenames literally and represents renames as deletion and addition", async () => {
    const { cwd, get } = await fixture();
    const path = "inside/[odd]\nfile.txt";
    await git(cwd, "mv", "inside/file.txt", path);
    await git(cwd, "commit", "-m", "Rename");
    const commit = await git(cwd, "rev-parse", "HEAD");
    const detail = (await get("commit", { commit })).json();
    expect(detail.files.map((f: { status: string }) => f.status).sort()).toEqual(["A", "D"]);
    expect((await get("commit-file", { commit, path })).json()).toMatchObject({ before: "", after: "before\n" });
  });

  it("rejects revision expressions, unadvertised refs, unreachable objects, and unknown query options", async () => {
    const { cwd, get } = await fixture();
    expect((await get("history", { branch: "refs/heads/missing" })).statusCode).toBe(400);
    expect((await get("history", { branch: "HEAD~1" })).statusCode).toBe(400);
    expect((await get("history", { limit: "201" })).statusCode).toBe(400);
    expect((await get("history", { flags: "--all" })).statusCode).toBe(400);
    expect((await get("commit", { commit: "HEAD" })).statusCode).toBe(400);
    const blob = await git(cwd, "rev-parse", "HEAD:outside.txt");
    expect((await get("commit", { commit: blob })).statusCode).toBe(404);
    await git(cwd, "switch", "--orphan", "unreachable");
    await git(cwd, "commit", "--allow-empty", "-m", "Unreachable");
    const unreachable = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "switch", "main");
    await git(cwd, "branch", "-D", "unreachable");
    expect((await get("commit", { commit: unreachable })).statusCode).toBe(404);
  });

  it("authenticates all history reads and emits no history event or audit record", async () => {
    const { app, cwd, workspaceId, get } = await fixture({ auth: true });
    const commit = await git(cwd, "rev-parse", "HEAD");
    const before = (await app.inject({ url: "/api/audit", headers: { authorization: "Bearer test-bearer" } })).json();
    for (const route of ["history", "commit", "commit-file"]) {
      expect((await app.inject({ url: `/api/workspaces/${workspaceId}/git/${route}` })).statusCode).toBe(401);
    }
    expect((await get("history")).statusCode).toBe(200);
    expect((await get("commit", { commit })).statusCode).toBe(200);
    expect((await get("commit-file", { commit, path: "inside/file.txt" })).statusCode).toBe(200);
    const after = (await app.inject({ url: "/api/audit", headers: { authorization: "Bearer test-bearer" } })).json();
    expect(after).toEqual(before);
  });
});
