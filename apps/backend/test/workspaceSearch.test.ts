import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildServer } from "../src/server";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";
import type { GitCommandExecutor } from "../src/workspace/LocalWorkspaceGit";
import type { ServiceConfig } from "../src/domain/models";

const execFileAsync = promisify(execFile);

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-workspace-search-"));
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function createGitWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-search-workspace-"));
  await git(workspaceDir, "init", "-b", "main");
  await git(workspaceDir, "config", "user.email", "agentroom@example.invalid");
  await git(workspaceDir, "config", "user.name", "AgentRoom Tests");
  return workspaceDir;
}

async function writeWorkspaceFile(root: string, relativePath: string, content: string | Buffer): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

async function registeredWorkspace(app: Awaited<ReturnType<typeof buildServer>>["app"], path: string): Promise<string> {
  const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path } });
  return registered.json().workspace.id as string;
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Direct explorer wiring with a stubbed git executor, so `git ls-files` output
// itself can be made hostile (traversal, absolute, NUL, secret, generated dirs).
async function explorerWithGitPaths(
  workspaceDir: string,
  paths: string[]
): Promise<{ explorer: WorkspaceExplorer; workspaceId: string }> {
  const runGit: GitCommandExecutor = async (_cwd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
    if (args[0] === "ls-files") return { stdout: paths.join("\0"), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const registry = new LocalWorkspaceRegistry(await config(), { runGit });
  const registered = await registry.register({ path: workspaceDir });
  return { explorer: new WorkspaceExplorer(registry), workspaceId: registered.workspace.id };
}

describe("workspace file index", () => {
  it("indexes git-tracked and untracked files, ranks them, and reports previewability", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "README.md", "# Workspace\n");
    await writeWorkspaceFile(workspaceDir, "src/app.ts", "export const app = 1;\n");
    await writeWorkspaceFile(workspaceDir, "src/nested/appliance.ts", "export const appliance = 2;\n");
    await writeWorkspaceFile(workspaceDir, "docs/app-notes.md", "notes about app\n");
    await git(workspaceDir, "add", ".");
    await git(workspaceDir, "commit", "-m", "Add index fixtures");
    // Untracked-but-not-ignored files are part of the index too.
    await writeWorkspaceFile(workspaceDir, "untracked.txt", "fresh\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const all = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files` });
    const ranked = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?query=app` });

    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ workspaceId, query: "", truncated: false });
    expect(all.json().files.map((file: { path: string }) => file.path)).toEqual([
      "README.md",
      "src/app.ts",
      "untracked.txt",
      "docs/app-notes.md",
      "src/nested/appliance.ts"
    ]);
    expect(all.json().files[0]).toEqual({ path: "README.md", name: "README.md", previewable: true });

    expect(ranked.statusCode).toBe(200);
    // All three are basename-prefix matches, so the shorter path wins the tie;
    // `untracked.txt` and `README.md` do not match at all and drop out.
    expect(ranked.json().files.map((file: { path: string }) => file.path)).toEqual([
      "src/app.ts",
      "docs/app-notes.md",
      "src/nested/appliance.ts"
    ]);

    await app.close();
  });

  it("never indexes secret files, generated directories, or escaping symlinks", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    const outsideDir = await mkdtemp(join(tmpdir(), "agentroom-search-outside-"));
    await writeFile(join(outsideDir, "outside.txt"), "leaked needle\n");
    await writeWorkspaceFile(workspaceDir, "keep.txt", "kept needle\n");
    await writeWorkspaceFile(workspaceDir, ".env", "SECRET=needle\n");
    await writeWorkspaceFile(workspaceDir, "config/.env.local", "SECRET=needle\n");
    await writeWorkspaceFile(workspaceDir, "keys/id_rsa", "needle private key\n");
    await writeWorkspaceFile(workspaceDir, "certs/server.pem", "needle pem\n");
    await writeWorkspaceFile(workspaceDir, "node_modules/pkg/index.js", "needle in node_modules\n");
    await writeWorkspaceFile(workspaceDir, "dist/bundle.js", "needle in dist\n");
    await symlink(join(outsideDir, "outside.txt"), join(workspaceDir, "escaping-link.txt"));
    await symlink(outsideDir, join(workspaceDir, "escaping-dir"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const index = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=200` });
    const search = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });

    expect(index.statusCode).toBe(200);
    expect(index.json().files.map((file: { path: string }) => file.path)).toEqual(["keep.txt"]);
    expect(search.statusCode).toBe(200);
    expect(search.json().files.map((file: { path: string }) => file.path)).toEqual(["keep.txt"]);
    // Neither the linked-through content nor the `.git` internals leak.
    expect(JSON.stringify(index.json())).not.toContain("outside.txt");
    expect(JSON.stringify(index.json())).not.toContain(".git/");
    expect(JSON.stringify(search.json())).not.toContain("leaked needle");

    await app.close();
  });

  it("rejects traversal, absolute, NUL, secret, and generated paths coming back from git", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-search-hostile-"));
    await writeWorkspaceFile(workspaceDir, "safe.txt", "safe\n");
    const { explorer, workspaceId } = await explorerWithGitPaths(workspaceDir, [
      "../outside.txt",
      "nested/../../outside.txt",
      "/etc/passwd",
      "with\0nul.txt",
      ".env",
      "sub/.env.production",
      "keys/id_ed25519",
      ".git/config",
      "node_modules/pkg/index.js",
      "build/output.txt",
      "safe.txt"
    ]);

    const listed = await explorer.listFiles(workspaceId, {});

    expect(listed.files.map((file) => file.path)).toEqual(["safe.txt"]);
  });

  it("falls back to a bounded filesystem walk for non-git workspaces", async () => {
    const serviceConfig = await config();
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-search-plain-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "agentroom-search-plain-outside-"));
    await writeFile(join(outsideDir, "outside.txt"), "leaked needle\n");
    await writeWorkspaceFile(workspaceDir, "notes.md", "walk needle\n");
    await writeWorkspaceFile(workspaceDir, "src/deep/module.ts", "walk needle\n");
    await writeWorkspaceFile(workspaceDir, ".env", "SECRET=needle\n");
    await writeWorkspaceFile(workspaceDir, "node_modules/pkg/index.js", "needle\n");
    await symlink(join(outsideDir, "outside.txt"), join(workspaceDir, "escaping-link.txt"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const index = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files` });
    const search = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });

    expect(index.statusCode).toBe(200);
    expect(index.json().files.map((file: { path: string }) => file.path)).toEqual(["notes.md", "src/deep/module.ts"]);
    expect(search.json().files.map((file: { path: string }) => file.path)).toEqual(["notes.md", "src/deep/module.ts"]);

    await app.close();
  });

  it("reports index truncation for the enumeration cap and for capped results", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    for (const name of ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]) {
      await writeWorkspaceFile(workspaceDir, name, "content\n");
    }
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const capped = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=2` });

    expect(capped.statusCode).toBe(200);
    expect(capped.json().files).toHaveLength(2);
    expect(capped.json().truncated).toBe(true);

    // The 20k enumeration cap, exercised through a stubbed `git ls-files`.
    const oversizedPaths = Array.from({ length: 20_001 }, (_, index) => `generated/file-${index}.txt`);
    const { explorer, workspaceId: hugeWorkspaceId } = await explorerWithGitPaths(workspaceDir, oversizedPaths);
    const huge = await explorer.listFiles(hugeWorkspaceId, {});

    expect(huge.truncated).toBe(true);

    await app.close();
  });

  it("starts a fresh enumeration for a request that arrives after an invalidation, even mid-build", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-search-inflight-"));
    await writeWorkspaceFile(workspaceDir, "before.txt", "before\n");
    await writeWorkspaceFile(workspaceDir, "created.txt", "created\n");
    let releaseFirstBuild: () => void = () => {};
    const firstBuildGate = new Promise<void>((resolve) => {
      releaseFirstBuild = resolve;
    });
    let reachedFirstBuild: () => void = () => {};
    const firstBuildReached = new Promise<void>((resolve) => {
      reachedFirstBuild = resolve;
    });
    let listFilesCalls = 0;
    const runGit: GitCommandExecutor = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
      if (args[0] === "ls-files") {
        listFilesCalls += 1;
        if (listFilesCalls === 1) {
          // The pre-invalidation enumeration: park it so the invalidation lands
          // while this build is still in flight.
          reachedFirstBuild();
          await firstBuildGate;
          return { stdout: "before.txt", stderr: "" };
        }
        return { stdout: "before.txt\0created.txt", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const registry = new LocalWorkspaceRegistry(await config(), { runGit });
    const registered = await registry.register({ path: workspaceDir });
    const explorer = new WorkspaceExplorer(registry);
    const workspaceId = registered.workspace.id;

    const staleRead = explorer.listFiles(workspaceId, {});
    await firstBuildReached;
    // The write/checkout happened: the parked enumeration no longer describes
    // the workspace. A request arriving after this point must not join it.
    explorer.invalidateFileIndex(workspaceId);
    const freshRead = explorer.listFiles(workspaceId, {});
    releaseFirstBuild();

    expect((await staleRead).files.map((file) => file.path)).toEqual(["before.txt"]);
    expect((await freshRead).files.map((file) => file.path)).toEqual(["before.txt", "created.txt"]);
    expect(listFilesCalls).toBe(2);

    // The fresh build's result is the cached one: a follow-up read reuses it
    // without re-enumerating, and the superseded build never entered the cache.
    expect((await explorer.listFiles(workspaceId, {})).files.map((file) => file.path)).toEqual([
      "before.txt",
      "created.txt"
    ]);
    expect(listFilesCalls).toBe(2);
  });

  it("invalidates the cached index when the bounded write creates a file", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "existing.txt", "existing\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const before = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files` });
    const created = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "created.txt", content: "needle\n" }
    });
    const after = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files` });
    const search = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });

    expect(before.json().files.map((file: { path: string }) => file.path)).toEqual(["existing.txt"]);
    expect(created.statusCode).toBe(201);
    // Without invalidation the 15s TTL would still be serving the pre-write index.
    expect(after.json().files.map((file: { path: string }) => file.path)).toEqual(["created.txt", "existing.txt"]);
    expect(search.json().files.map((file: { path: string }) => file.path)).toEqual(["created.txt"]);

    await app.close();
  });

  it("requires the bearer token for both reads when AUTH_TOKEN is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "keep.txt", "needle\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: workspaceDir },
      headers: { authorization: "Bearer secret-token" }
    });
    const workspaceId = registered.json().workspace.id as string;
    const authorization = { authorization: "Bearer secret-token" };

    const unauthorizedIndex = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files` });
    const unauthorizedSearch = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/search?query=needle`
    });
    const authorizedIndex = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/files`,
      headers: authorization
    });
    const authorizedSearch = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/search?query=needle`,
      headers: authorization
    });

    expect(unauthorizedIndex.statusCode).toBe(401);
    expect(unauthorizedSearch.statusCode).toBe(401);
    expect(authorizedIndex.statusCode).toBe(200);
    expect(authorizedSearch.statusCode).toBe(200);

    await app.close();
  });

  it("rejects invalid queries and unknown workspaces", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const missingQuery = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search` });
    const blankQuery = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=%20` });
    const overLongQuery = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/search?query=${"a".repeat(201)}`
    });
    const badLimit = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=0` });
    const unknownIndex = await app.inject({ method: "GET", url: "/api/workspaces/workspace-unknown/files" });
    const unknownSearch = await app.inject({ method: "GET", url: "/api/workspaces/workspace-unknown/search?query=a" });

    expect(missingQuery.statusCode).toBe(400);
    expect(blankQuery.statusCode).toBe(400);
    expect(overLongQuery.statusCode).toBe(400);
    expect(badLimit.statusCode).toBe(400);
    expect(unknownIndex.statusCode).toBe(404);
    expect(unknownSearch.statusCode).toBe(404);

    await app.close();
  });
});

describe("workspace content search", () => {
  it("reports 1-indexed line/column for every literal match on a line", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "src/app.ts", "first line\nconst needle = needleValue;\nlast line\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceId,
      query: "needle",
      totalMatches: 2,
      filesScanned: 1,
      truncated: false,
      files: [
        {
          path: "src/app.ts",
          truncated: false,
          matches: [
            {
              line: 2,
              column: 7,
              length: 6,
              preview: "const needle = needleValue;",
              previewColumn: 7
            },
            {
              line: 2,
              column: 16,
              length: 6,
              preview: "const needle = needleValue;",
              previewColumn: 16
            }
          ]
        }
      ]
    });

    await app.close();
  });

  it("honours matchCase and wholeWord", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "src/app.ts", "const needle = needleValue;\nconst NEEDLE = 1;\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);
    const search = (query: string) =>
      app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?${query}` });

    const insensitive = await search("query=needle");
    const sensitive = await search("query=needle&matchCase=true");
    const sensitiveUpper = await search("query=NEEDLE&matchCase=true");
    const wholeWord = await search("query=needle&wholeWord=true");
    const wholeWordSensitive = await search("query=needle&wholeWord=true&matchCase=true");

    expect(insensitive.json().totalMatches).toBe(3);
    expect(sensitive.json().totalMatches).toBe(2);
    expect(sensitiveUpper.json().totalMatches).toBe(1);
    // `needleValue` is not a whole word; `NEEDLE` still matches case-insensitively.
    expect(wholeWord.json().totalMatches).toBe(2);
    expect(wholeWordSensitive.json().totalMatches).toBe(1);
    expect(wholeWordSensitive.json().files[0].matches[0]).toMatchObject({ line: 1, column: 7 });

    await app.close();
  });

  it("skips binary files, counts them as scanned, and bounds long-line previews", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "assets/blob.bin", Buffer.from("needle needle", "utf8"));
    await writeWorkspaceFile(
      workspaceDir,
      "minified.js",
      `${"x".repeat(5000)}needle${"y".repeat(5000)}\n`
    );
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });
    const payload = response.json();

    expect(payload.filesScanned).toBe(2);
    expect(payload.files.map((file: { path: string }) => file.path)).toEqual(["minified.js"]);
    const match = payload.files[0].matches[0];
    expect(match).toMatchObject({ line: 1, column: 5001, length: 6 });
    expect(match.preview).toHaveLength(200);
    expect(match.preview.slice(match.previewColumn - 1, match.previewColumn - 1 + 6)).toBe("needle");

    await app.close();
  });

  it("never splits a surrogate pair at the edges of a bounded preview", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    // 💚 is one astral code point = two UTF-16 units. With the match centred in
    // a long emoji run, both edges of the 200-unit preview window land inside a
    // pair, so an unaware slice would emit a lone surrogate at each end.
    await writeWorkspaceFile(workspaceDir, "emoji.txt", `${"💚".repeat(200)}x needle ${"💚".repeat(200)}\n`);
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });
    const match = response.json().files[0].matches[0];

    expect(hasLoneSurrogate(match.preview)).toBe(false);
    expect(match.preview.length).toBeLessThanOrEqual(200);
    expect(match.preview.slice(match.previewColumn - 1, match.previewColumn - 1 + 6)).toBe("needle");

    await app.close();
  });

  it("caps matches per file and total matches, flagging truncation", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "many.txt", "needle\n".repeat(30));
    await writeWorkspaceFile(workspaceDir, "also.txt", "needle\n".repeat(5));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);

    const capped = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/search?query=needle` });
    const limited = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/search?query=needle&limit=3`
    });

    // Per-file cap is 20; the second file still gets scanned.
    const cappedFiles = capped.json().files as Array<{ path: string; matches: unknown[]; truncated: boolean }>;
    expect(cappedFiles.find((file) => file.path === "many.txt")).toMatchObject({ truncated: true });
    expect(cappedFiles.find((file) => file.path === "many.txt")?.matches).toHaveLength(20);
    expect(cappedFiles.find((file) => file.path === "also.txt")).toMatchObject({ truncated: false });
    expect(capped.json().totalMatches).toBe(25);
    expect(capped.json().truncated).toBe(false);

    expect(limited.json().totalMatches).toBe(3);
    expect(limited.json().truncated).toBe(true);

    await app.close();
  });

  it("filters candidates with the include pattern", async () => {
    const serviceConfig = await config();
    const workspaceDir = await createGitWorkspace();
    await writeWorkspaceFile(workspaceDir, "src/app.ts", "needle\n");
    await writeWorkspaceFile(workspaceDir, "src/app.test.ts", "needle\n");
    await writeWorkspaceFile(workspaceDir, "docs/guide.md", "needle\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = await registeredWorkspace(app, workspaceDir);
    const search = (include: string) =>
      app.inject({
        method: "GET",
        url: `/api/workspaces/${workspaceId}/search?query=needle&include=${encodeURIComponent(include)}`
      });

    const byExtension = await search("*.md");
    const byDirectory = await search("src");
    const byGlob = await search("src/*.test.ts");
    const escaping = await search("../*");

    expect(byExtension.json().files.map((file: { path: string }) => file.path)).toEqual(["docs/guide.md"]);
    expect(byDirectory.json().files.map((file: { path: string }) => file.path)).toEqual([
      "src/app.test.ts",
      "src/app.ts"
    ]);
    expect(byGlob.json().files.map((file: { path: string }) => file.path)).toEqual(["src/app.test.ts"]);
    expect(escaping.json().files).toEqual([]);

    await app.close();
  });
});
