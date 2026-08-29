import { describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, rename, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-workspace-context-"));
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
    codexArgs: ["-e", "process.stdin.on('data', chunk => process.stdout.write(`codex heard: ${chunk}`))"],
    codexRunnerProtocol: "exec",
    ...overrides
  };
};

describe("workspace context", () => {
  it("returns a bounded tree for a registered workspace and hides generated directories", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    await writeFile(join(selectedDirectory, "README.md"), "# Workspace\n");
    await mkdir(join(selectedDirectory, "apps", "backend", "src"), { recursive: true });
    await writeFile(join(selectedDirectory, "apps", "backend", "src", "server.ts"), "export const server = true;\n");
    await mkdir(join(selectedDirectory, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(selectedDirectory, "node_modules", "ignored", "package.json"), "{}");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });

    const tree = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/tree?depth=3`
    });

    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toEqual({
      workspaceId: registered.json().workspace.id,
      path: "",
      entries: [
        expect.objectContaining({ type: "directory", name: "apps", path: "apps" }),
        expect.objectContaining({ type: "file", name: "README.md", path: "README.md", previewable: true })
      ]
    });
    expect(JSON.stringify(tree.json())).toContain("server.ts");
    expect(JSON.stringify(tree.json())).not.toContain("node_modules");

    await app.close();
  });

  it("marks tree files previewable up to the write cap so larger files stay editable", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    // medium > 24 KB browse default but within the 256 KB write cap; huge exceeds it.
    await writeFile(join(selectedDirectory, "medium.txt"), "a".repeat(40 * 1024));
    await writeFile(join(selectedDirectory, "huge.txt"), "a".repeat(300 * 1024));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });

    const tree = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/tree?depth=1`
    });

    const entries = tree.json().entries as Array<{ name: string; previewable?: boolean }>;
    expect(entries.find((entry) => entry.name === "medium.txt")?.previewable).toBe(true);
    expect(entries.find((entry) => entry.name === "huge.txt")?.previewable).toBe(false);

    await app.close();
  });

  it("previews a text file and rejects symlink escapes", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-outside-"));
    await writeFile(join(selectedDirectory, "notes.md"), "Use registered workspaces.\n");
    await writeFile(join(outsideDirectory, "secret.txt"), "do not expose\n");
    await symlink(join(outsideDirectory, "secret.txt"), join(selectedDirectory, "leak.txt"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });

    const preview = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/file-preview?path=notes.md`
    });
    const escaped = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/file-preview?path=leak.txt`
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      workspaceId: registered.json().workspace.id,
      path: "notes.md",
      name: "notes.md",
      encoding: "utf8",
      content: "Use registered workspaces.\n",
      truncated: false,
      previewable: true
    });
    expect(escaped.statusCode).toBe(400);
    expect(escaped.json()).toEqual({ error: "Workspace path must stay inside the registered workspace" });

    await app.close();
  });

  it("lifts the preview truncation cap when maxBytes is requested for editing", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    // Larger than the 24 KB browse-preview default, smaller than the 256 KB write cap.
    const big = "a".repeat(40 * 1024);
    await writeFile(join(selectedDirectory, "big.txt"), big);
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;

    const browse = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/file-preview?path=big.txt`
    });
    const forEditing = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/file-preview?path=big.txt&maxBytes=${256 * 1024}`
    });
    const overCap = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/file-preview?path=big.txt&maxBytes=${256 * 1024 + 1}`
    });

    // The default browse preview still truncates the large file, so it stays read-only
    // in the client (WorkspaceFileEditorModel.isEditable requires !truncated).
    expect(browse.statusCode).toBe(200);
    expect(browse.json().truncated).toBe(true);
    expect(browse.json().content.length).toBeLessThan(big.length);

    // Requesting up to the write cap returns the whole file untruncated, so the editor
    // can load and save it through the existing optimistic-lock write path.
    expect(forEditing.statusCode).toBe(200);
    expect(forEditing.json().truncated).toBe(false);
    expect(forEditing.json().content).toBe(big);

    // maxBytes above the write cap is rejected by the bounded schema, so a load can
    // never request more than the write route can persist.
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json()).toEqual({ error: "Invalid workspace file preview query" });

    await app.close();
  });

  it("requires bearer auth for workspace tree and file preview when auth is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    await writeFile(join(selectedDirectory, "README.md"), "# Workspace\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: selectedDirectory }
    });

    const unauthorizedTree = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/tree`
    });
    const authorizedTree = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/tree`,
      headers: { authorization: "Bearer agentroom-secret" }
    });
    const unauthorizedPreview = await app.inject({
      method: "GET",
      url: `/api/workspaces/${registered.json().workspace.id}/file-preview?path=README.md`
    });

    expect(unauthorizedTree.statusCode).toBe(401);
    expect(unauthorizedTree.json()).toEqual({ error: "Unauthorized" });
    expect(authorizedTree.statusCode).toBe(200);
    expect(unauthorizedPreview.statusCode).toBe(401);

    await app.close();
  });

  it("injects selected workspace context into a turn without changing the stored user message", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    await writeFile(join(selectedDirectory, "README.md"), "# AgentRoom\n");
    await mkdir(join(selectedDirectory, "apps", "backend", "src"), { recursive: true });
    await writeFile(join(selectedDirectory, "apps", "backend", "src", "server.ts"), "export const port = 8787;\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: {
        message: "Use the selected files.",
        context: { paths: ["README.md", "apps/backend/src/server.ts"] }
      }
    });

    expect(turn.statusCode).toBe(202);
    const completed = await waitForSession(app, session.json().session.id, "idle");
    expect(completed.lastMessage).toContain("User selected workspace context");
    expect(completed.lastMessage).toContain("README.md");
    expect(completed.lastMessage).toContain("# AgentRoom");
    expect(completed.lastMessage).toContain("apps/backend/src/server.ts");
    expect(completed.lastMessage).toContain("export const port = 8787;");
    expect(completed.lastMessage).toContain("Use the selected files.");

    const messages = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${session.json().session.id}/messages`
    });
    expect(messages.json().messages[0]).toMatchObject({
      role: "user",
      content: "Use the selected files."
    });

    await app.close();
  });

  it("uses a safe markdown fence when selected file context contains code fences", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-context-workspace-"));
    await writeFile(join(selectedDirectory, "README.md"), "Example:\n```ts\nconst port = 8787;\n```\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: {
        message: "Use the readme.",
        context: { paths: ["README.md"] }
      }
    });

    expect(turn.statusCode).toBe(202);
    const completed = await waitForSession(app, session.json().session.id, "idle");
    expect(completed.lastMessage).toContain("File: README.md\n````\nExample:\n```ts");
    expect(completed.lastMessage).toContain("\n```\n\n````");

    await app.close();
  });
});

describe("workspace file write", () => {
  it("creates a new file (201) and overwrites it with an optimistic-lock token (200)", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const created = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", content: "first\n" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ path: "notes.md", content: "first\n", previewable: true });
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("first\n");

    const overwrite = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", content: "second\n", baseModifiedAt: created.json().modifiedAt }
    });
    expect(overwrite.statusCode).toBe(200);
    expect(overwrite.json().content).toBe("second\n");
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("second\n");

    await app.close();
  });

  it("rejects a blind or stale overwrite of an existing file with 409", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "original\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const blind = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", content: "clobber\n" }
    });
    const stale = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", content: "clobber\n", baseModifiedAt: "2000-01-01T00:00:00.000Z" }
    });

    expect(blind.statusCode).toBe(409);
    expect(stale.statusCode).toBe(409);
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("original\n");

    await app.close();
  });

  it("does not recreate a renamed path when a save carries its old optimistic-lock token", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const oldPath = join(selectedDirectory, "notes.md");
    const newPath = join(selectedDirectory, "ideas.md");
    await writeFile(oldPath, "original\n");
    const baseModifiedAt = (await stat(oldPath)).mtime.toISOString();
    await rename(oldPath, newPath);
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const staleSave = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", content: "stale draft\n", baseModifiedAt }
    });

    expect(staleSave.statusCode).toBe(409);
    await expect(stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(newPath, "utf8")).toBe("original\n");

    await app.close();
  });

  it("refuses secret names, generated dirs, traversal, and symlink leaves", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-outside-"));
    await writeFile(join(outsideDirectory, "secret.txt"), "do not touch\n");
    await symlink(join(outsideDirectory, "secret.txt"), join(selectedDirectory, "leak.txt"));
    await mkdir(join(selectedDirectory, ".git"));
    await writeFile(join(selectedDirectory, ".git", "config"), "protected\n");
    await symlink(join(selectedDirectory, ".git"), join(selectedDirectory, "visible"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const put = (path: string) =>
      app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/file`, payload: { path, content: "x\n" } });

    expect((await put(".env")).statusCode).toBe(415);
    expect((await put(".git/config")).statusCode).toBe(415);
    expect((await put("keys/server.pem")).statusCode).toBe(415);
    expect((await put("hidden.agentroom-tmp")).statusCode).toBe(415);
    expect((await put("../escape.txt")).statusCode).toBe(400);
    expect((await put("leak.txt")).statusCode).toBe(415);
    expect((await put("visible/config")).statusCode).toBe(415);
    expect(await readFile(join(outsideDirectory, "secret.txt"), "utf8")).toBe("do not touch\n");
    expect(await readFile(join(selectedDirectory, ".git", "config"), "utf8")).toBe("protected\n");

    await app.close();
  });

  it("404s when the parent directory does not exist (no recursive mkdir)", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const missingParent = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "does/not/exist.md", content: "x\n" }
    });

    expect(missingParent.statusCode).toBe(404);
    await app.close();
  });

  it("requires bearer auth for writes when auth is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { authorization: "Bearer agentroom-secret" },
        payload: { path: selectedDirectory }
      })
    ).json().workspace.id;

    const unauthorized = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", content: "x\n" }
    });
    const authorized = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: "notes.md", content: "x\n" }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(201);

    await app.close();
  });

  it("echoes the full written content even when it exceeds the browse-preview cap", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    // Larger than the 24 KB browse-preview cap but well under the 256 KB write cap.
    const content = "a".repeat(40 * 1024);
    const created = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "big.md", content }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().truncated).toBe(false);
    expect(created.json().content).toBe(content);
    expect(created.json().sizeBytes).toBe(40 * 1024);
    expect(await readFile(join(selectedDirectory, "big.md"), "utf8")).toBe(content);

    await app.close();
  });

  it("caps content by UTF-8 byte length, not UTF-16 code units", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    // 200K of a 3-byte char = 600 KB UTF-8 but only 200K UTF-16 units; must be rejected.
    const oversize = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "wide.md", content: "中".repeat(200 * 1024) }
    });

    expect(oversize.statusCode).toBe(400);

    await app.close();
  });

  it("rejects ill-formed UTF-16 content rather than persisting mangled bytes", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const loneSurrogate = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "bad.md", content: "ok\uD800tail" }
    });

    expect(loneSurrogate.statusCode).toBe(415);

    await app.close();
  });
});

describe("workspace file delete", () => {
  it("deletes the rendered file version, invalidates the index, and emits a sanitized event", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "remove me\n");
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;

    const preview = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/file-preview?path=notes.md`
    });
    const before = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(before.json().files.map((file: { path: string }) => file.path)).toContain("notes.md");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", baseModifiedAt: preview.json().modifiedAt }
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      workspaceId,
      path: "notes.md",
      sizeBytes: Buffer.byteLength("remove me\n"),
      deleted: true
    });
    await expect(readFile(join(selectedDirectory, "notes.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const after = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(after.json().files.map((file: { path: string }) => file.path)).not.toContain("notes.md");
    expect(eventBus.getRecentEvents().at(-1)).toMatchObject({
      type: "workspace_file_deleted",
      payload: {
        workspaceId,
        workspacePath: registered.json().workspace.path,
        path: "notes.md",
        sizeBytes: Buffer.byteLength("remove me\n")
      }
    });

    await app.close();
  });

  it("requires a current optimistic-lock token and leaves stale files untouched", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "keep me\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const missingToken = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md" }
    });
    const stale = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", baseModifiedAt: "2000-01-01T00:00:00.000Z" }
    });

    expect(missingToken.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("keep me\n");
    await app.close();
  });

  it("refuses directories, secret and generated paths, traversal, and symlinks", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-outside-"));
    await mkdir(join(selectedDirectory, "folder"));
    await writeFile(join(selectedDirectory, ".env"), "secret\n");
    await mkdir(join(selectedDirectory, ".git"));
    await writeFile(join(selectedDirectory, ".git", "config"), "protected\n");
    await writeFile(join(outsideDirectory, "outside.txt"), "outside\n");
    await symlink(join(outsideDirectory, "outside.txt"), join(selectedDirectory, "leak.txt"));
    await symlink(join(selectedDirectory, ".git"), join(selectedDirectory, "visible"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const remove = (path: string) => app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path, baseModifiedAt: "2000-01-01T00:00:00.000Z" }
    });

    expect((await remove("folder")).statusCode).toBe(415);
    expect((await remove(".env")).statusCode).toBe(415);
    expect((await remove(".git/config")).statusCode).toBe(415);
    expect((await remove("../outside.txt")).statusCode).toBe(400);
    expect((await remove("leak.txt")).statusCode).toBe(415);
    expect((await remove("visible/config")).statusCode).toBe(415);
    expect(await readFile(join(outsideDirectory, "outside.txt"), "utf8")).toBe("outside\n");
    expect(await readFile(join(selectedDirectory, ".git", "config"), "utf8")).toBe("protected\n");
    await app.close();
  });

  it("requires bearer auth when auth is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "agentroom-secret" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { authorization: "Bearer agentroom-secret" },
        payload: { path: selectedDirectory }
      })
    ).json().workspace.id;
    const created = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: "notes.md", content: "x\n" }
    });

    const unauthorized = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "notes.md", baseModifiedAt: created.json().modifiedAt }
    });
    const authorized = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/file`,
      headers: { authorization: "Bearer agentroom-secret" },
      payload: { path: "notes.md", baseModifiedAt: created.json().modifiedAt }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });
});

describe("workspace directory create", () => {
  it("creates one directory under an existing parent and emits a sanitized event", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-create-directory-workspace-"));
    await mkdir(join(selectedDirectory, "docs"));
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;

    const created = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/directory`,
      payload: { path: "docs/diagrams" }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      workspaceId,
      path: "docs/diagrams",
      // The new folder is immediately a rename/move/paste/delete target, so the
      // response carries the token those routes require.
      modifiedAt: (await stat(join(selectedDirectory, "docs", "diagrams"))).mtime.toISOString(),
      created: true
    });
    expect((await stat(join(selectedDirectory, "docs", "diagrams"))).isDirectory()).toBe(true);
    expect(eventBus.getRecentEvents().at(-1)).toMatchObject({
      type: "workspace_directory_created",
      payload: {
        workspaceId,
        workspacePath: registered.json().workspace.path,
        path: "docs/diagrams"
      }
    });

    // The new folder shows in the tree and can take a file straight away.
    const tree = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/tree?path=docs&depth=1` });
    expect(tree.json().entries).toEqual([expect.objectContaining({ name: "diagrams", type: "directory" })]);
    const wrote = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "docs/diagrams/notes.md", content: "notes\n" }
    });
    expect(wrote.statusCode).toBe(201);

    await app.close();
  });

  it("refuses an occupied name, a missing parent, the root, and protected or escaping paths", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-create-directory-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-create-directory-outside-"));
    await mkdir(join(selectedDirectory, "docs"));
    await mkdir(join(selectedDirectory, ".git"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await symlink(outsideDirectory, join(selectedDirectory, "linked"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const create = (path: string) => app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/directory`,
      payload: { path }
    });

    // Create-only, so an existing folder or file is the same 409 no-overwrite
    // answer rename, move, and copy give rather than a silent adoption.
    expect((await create("docs")).statusCode).toBe(409);
    expect((await create("notes.md")).statusCode).toBe(409);
    // Not recursive: the parent must already exist, exactly as for the file PUT.
    expect((await create("missing/child")).statusCode).toBe(404);
    // "" is the workspace root, which is never an entry target.
    expect((await create("")).statusCode).toBe(400);
    expect((await create("../escape")).statusCode).toBe(400);
    expect((await create(".git/objects")).statusCode).toBe(415);
    expect((await create("node_modules")).statusCode).toBe(415);
    expect((await create(".env.d")).statusCode).toBe(415);
    expect((await create("docs/hidden.agentroom-tmp")).statusCode).toBe(415);
    // A contained symlink whose target leaves the workspace cannot be used as a
    // parent to write through.
    expect((await create("linked/child")).statusCode).toBe(400);
    expect((await create(`docs/${"n".repeat(256)}`)).statusCode).toBe(400);

    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("notes\n");
    expect((await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/tree?path=docs&depth=1` })).json().entries).toEqual([]);

    await app.close();
  });
});

describe("workspace directory delete", () => {
  it("recursively deletes a bounded directory, invalidates the index, and emits counts", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-directory-workspace-"));
    await mkdir(join(selectedDirectory, "docs", "nested"), { recursive: true });
    await writeFile(join(selectedDirectory, "docs", "readme.md"), "read me\n");
    await writeFile(join(selectedDirectory, "docs", "nested", "notes.txt"), "notes\n");
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;
    const before = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(before.json().files).toHaveLength(2);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/directory`,
      payload: { path: "docs", baseModifiedAt: (await stat(join(selectedDirectory, "docs"))).mtime.toISOString() }
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      workspaceId,
      path: "docs",
      fileCount: 2,
      directoryCount: 2,
      sizeBytes: Buffer.byteLength("read me\nnotes\n"),
      deleted: true
    });
    await expect(stat(join(selectedDirectory, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
    const after = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(after.json().files).toEqual([]);
    expect(eventBus.getRecentEvents().at(-1)).toMatchObject({
      type: "workspace_directory_deleted",
      payload: {
        workspaceId,
        workspacePath: registered.json().workspace.path,
        path: "docs",
        fileCount: 2,
        directoryCount: 2,
        sizeBytes: Buffer.byteLength("read me\nnotes\n")
      }
    });

    await app.close();
  });

  it("requires a current directory token and refuses file or root targets", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-directory-workspace-"));
    await mkdir(join(selectedDirectory, "docs"));
    await writeFile(join(selectedDirectory, "notes.md"), "keep\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const remove = (path: string, baseModifiedAt: string) => app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/directory`,
      payload: { path, baseModifiedAt }
    });

    expect((await remove("docs", "2000-01-01T00:00:00.000Z")).statusCode).toBe(409);
    expect((await remove("notes.md", (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString())).statusCode).toBe(415);
    expect((await remove("../escape", "2000-01-01T00:00:00.000Z")).statusCode).toBe(400);
    expect((await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/directory`,
      payload: { path: "", baseModifiedAt: "2000-01-01T00:00:00.000Z" }
    })).statusCode).toBe(400);
    expect((await stat(join(selectedDirectory, "docs"))).isDirectory()).toBe(true);
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("keep\n");

    await app.close();
  });

  it("refuses a subtree containing protected names, symlinks, or too many bytes", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-directory-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-delete-directory-outside-"));
    await writeFile(join(outsideDirectory, "outside.txt"), "outside\n");
    await mkdir(join(selectedDirectory, "protected"));
    await writeFile(join(selectedDirectory, "protected", ".env"), "secret\n");
    await mkdir(join(selectedDirectory, "linked"));
    await symlink(join(outsideDirectory, "outside.txt"), join(selectedDirectory, "linked", "outside.txt"));
    await mkdir(join(selectedDirectory, "oversize"));
    await writeFile(join(selectedDirectory, "oversize", "large.bin"), "x");
    await truncate(join(selectedDirectory, "oversize", "large.bin"), 1024 * 1024 * 1024 + 1);
    await mkdir(join(selectedDirectory, "generated"));
    await writeFile(join(selectedDirectory, "generated", "stale.agentroom-tmp"), "partial\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const remove = async (path: string) => app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}/directory`,
      payload: { path, baseModifiedAt: (await stat(join(selectedDirectory, path))).mtime.toISOString() }
    });

    expect((await remove("protected")).statusCode).toBe(415);
    expect((await remove("linked")).statusCode).toBe(415);
    expect((await remove("oversize")).statusCode).toBe(413);
    expect((await remove("generated")).statusCode).toBe(415);
    expect(await readFile(join(selectedDirectory, "protected", ".env"), "utf8")).toBe("secret\n");
    expect(await readFile(join(outsideDirectory, "outside.txt"), "utf8")).toBe("outside\n");
    expect((await stat(join(selectedDirectory, "oversize", "large.bin"))).size).toBe(1024 * 1024 * 1024 + 1);

    await app.close();
  });
});

describe("workspace entry rename", () => {
  it("renames files and directories in place, refreshes the index, and emits sanitized events", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-rename-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await mkdir(join(selectedDirectory, "docs"));
    await writeFile(join(selectedDirectory, "docs", "guide.md"), "guide\n");
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;
    await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });

    const fileRename = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/rename`,
      payload: {
        path: "notes.md",
        newName: "ideas.md",
        baseModifiedAt: (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString()
      }
    });
    expect(fileRename.statusCode).toBe(200);
    expect(fileRename.json()).toEqual({
      workspaceId,
      oldPath: "notes.md",
      path: "ideas.md",
      entryType: "file",
      sizeBytes: Buffer.byteLength("notes\n"),
      renamed: true
    });
    expect(await readFile(join(selectedDirectory, "ideas.md"), "utf8")).toBe("notes\n");

    const caseOnlyRename = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/rename`,
      payload: {
        path: "ideas.md",
        newName: "IDEAS.md",
        baseModifiedAt: (await stat(join(selectedDirectory, "ideas.md"))).mtime.toISOString()
      }
    });
    expect(caseOnlyRename.statusCode).toBe(200);
    expect(caseOnlyRename.json()).toMatchObject({
      oldPath: "ideas.md",
      path: "IDEAS.md",
      renamed: true
    });
    expect(await readFile(join(selectedDirectory, "IDEAS.md"), "utf8")).toBe("notes\n");

    const directoryRename = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/rename`,
      payload: {
        path: "docs",
        newName: "reference",
        baseModifiedAt: (await stat(join(selectedDirectory, "docs"))).mtime.toISOString()
      }
    });
    expect(directoryRename.statusCode).toBe(200);
    expect(directoryRename.json()).toEqual({
      workspaceId,
      oldPath: "docs",
      path: "reference",
      entryType: "directory",
      renamed: true
    });
    expect(await readFile(join(selectedDirectory, "reference", "guide.md"), "utf8")).toBe("guide\n");

    const after = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(after.json().files.map((file: { path: string }) => file.path)).toEqual(["IDEAS.md", "reference/guide.md"]);
    expect(eventBus.getRecentEvents().filter((event) => event.type === "workspace_entry_renamed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ oldPath: "notes.md", path: "ideas.md", entryType: "file" })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ oldPath: "ideas.md", path: "IDEAS.md", entryType: "file" })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ oldPath: "docs", path: "reference", entryType: "directory" })
      })
    ]);

    await app.close();
  });

  it("refuses stale, protected, moving, symlink, and existing-destination renames", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-rename-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-rename-outside-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await writeFile(join(selectedDirectory, "existing.md"), "existing\n");
    await link(join(selectedDirectory, "notes.md"), join(selectedDirectory, "same-inode.md"));
    await writeFile(join(outsideDirectory, "outside.md"), "outside\n");
    await symlink(join(outsideDirectory, "outside.md"), join(selectedDirectory, "linked.md"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const currentToken = (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString();
    const move = (path: string, newName: string, baseModifiedAt = currentToken) => app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/rename`,
      payload: { path, newName, baseModifiedAt }
    });

    expect((await move("notes.md", "stale.md", "2000-01-01T00:00:00.000Z")).statusCode).toBe(409);
    expect((await move("notes.md", "existing.md")).statusCode).toBe(409);
    // Distinct hard links share a device/inode, but they are still two occupied
    // names. Treating this as the case-only rename exception reports success
    // even though POSIX rename leaves both names in place.
    expect((await move("notes.md", "same-inode.md")).statusCode).toBe(409);
    expect((await move("notes.md", "../moved.md")).statusCode).toBe(400);
    expect((await move("notes.md", ".env")).statusCode).toBe(415);
    expect((await move("notes.md", "hidden.agentroom-tmp")).statusCode).toBe(415);
    expect((await move("linked.md", "renamed.md", (await stat(join(selectedDirectory, "linked.md"))).mtime.toISOString())).statusCode).toBe(415);
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("notes\n");
    expect(await readFile(join(selectedDirectory, "existing.md"), "utf8")).toBe("existing\n");
    expect(await readFile(join(outsideDirectory, "outside.md"), "utf8")).toBe("outside\n");

    await app.close();
  });
});

describe("workspace entry move", () => {
  it("relocates files and folders, keeps or replaces the leaf name, and emits sanitized events", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-move-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await mkdir(join(selectedDirectory, "docs", "nested"), { recursive: true });
    await writeFile(join(selectedDirectory, "docs", "nested", "guide.md"), "guide\n");
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;
    await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });

    // An omitted `newName` keeps the entry's own name, which is what a plain
    // paste into another folder does.
    const fileMove = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/move`,
      payload: {
        path: "notes.md",
        destinationParent: "docs",
        baseModifiedAt: (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString()
      }
    });
    expect(fileMove.statusCode).toBe(200);
    expect(fileMove.json()).toEqual({
      workspaceId,
      oldPath: "notes.md",
      path: "docs/notes.md",
      entryType: "file",
      sizeBytes: Buffer.byteLength("notes\n"),
      moved: true
    });
    expect(await readFile(join(selectedDirectory, "docs", "notes.md"), "utf8")).toBe("notes\n");

    // A move that also renames is one request, and a folder carries its subtree.
    const folderMove = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/move`,
      payload: {
        path: "docs/nested",
        destinationParent: "",
        newName: "reference",
        baseModifiedAt: (await stat(join(selectedDirectory, "docs", "nested"))).mtime.toISOString()
      }
    });
    expect(folderMove.statusCode).toBe(200);
    expect(folderMove.json()).toEqual({
      workspaceId,
      oldPath: "docs/nested",
      path: "reference",
      entryType: "directory",
      moved: true
    });
    expect(await readFile(join(selectedDirectory, "reference", "guide.md"), "utf8")).toBe("guide\n");

    const after = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(after.json().files.map((file: { path: string }) => file.path).sort()).toEqual([
      "docs/notes.md",
      "reference/guide.md"
    ]);
    expect(eventBus.getRecentEvents().filter((event) => event.type === "workspace_entry_moved")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ oldPath: "notes.md", path: "docs/notes.md", entryType: "file" })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ oldPath: "docs/nested", path: "reference", entryType: "directory" })
      })
    ]);

    await app.close();
  });

  it("refuses stale, occupied, protected, escaping, and self-nesting destinations", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-move-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await mkdir(join(selectedDirectory, "docs", "nested"), { recursive: true });
    await mkdir(join(selectedDirectory, ".git"));
    await writeFile(join(selectedDirectory, "docs", "notes.md"), "other notes\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const fileToken = (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString();
    const docsToken = (await stat(join(selectedDirectory, "docs"))).mtime.toISOString();
    const move = (payload: Record<string, unknown>) => app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/move`,
      payload
    });

    expect((await move({ path: "notes.md", destinationParent: "docs", baseModifiedAt: "2000-01-01T00:00:00.000Z" })).statusCode).toBe(409);
    // `docs/notes.md` is taken: a move never overwrites, exactly like rename.
    expect((await move({ path: "notes.md", destinationParent: "docs", baseModifiedAt: fileToken })).statusCode).toBe(409);
    expect((await move({ path: "notes.md", destinationParent: ".git", baseModifiedAt: fileToken })).statusCode).toBe(415);
    expect((await move({ path: "notes.md", destinationParent: "..", baseModifiedAt: fileToken })).statusCode).toBe(400);
    expect((await move({ path: "notes.md", destinationParent: "missing", baseModifiedAt: fileToken })).statusCode).toBe(404);
    // A folder cannot become its own descendant.
    expect((await move({ path: "docs", destinationParent: "docs/nested", baseModifiedAt: docsToken })).statusCode).toBe(400);
    expect((await move({ path: "docs", destinationParent: "docs", baseModifiedAt: docsToken })).statusCode).toBe(400);

    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("notes\n");
    expect(await readFile(join(selectedDirectory, "docs", "notes.md"), "utf8")).toBe("other notes\n");
    await app.close();
  });

  it("reports a no-op when a symlinked destination parent resolves to the source parent", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-move-workspace-"));
    await mkdir(join(selectedDirectory, "real"));
    await writeFile(join(selectedDirectory, "real", "notes.md"), "notes\n");
    await symlink(join(selectedDirectory, "real"), join(selectedDirectory, "alias"));
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const moved = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/move`,
      payload: {
        path: "real/notes.md",
        destinationParent: "alias",
        baseModifiedAt: (await stat(join(selectedDirectory, "real", "notes.md"))).mtime.toISOString()
      }
    });

    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      oldPath: "real/notes.md",
      path: "real/notes.md",
      moved: false
    });
    expect(await readFile(join(selectedDirectory, "real", "notes.md"), "utf8")).toBe("notes\n");
    expect(eventBus.getRecentEvents().filter((event) => event.type === "workspace_entry_moved")).toEqual([]);

    await app.close();
  });
});

describe("workspace entry copy", () => {
  it("duplicates files and folders with counts, leaves the source, and emits sanitized events", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-copy-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await mkdir(join(selectedDirectory, "docs", "nested"), { recursive: true });
    await writeFile(join(selectedDirectory, "docs", "readme.md"), "read me\n");
    await writeFile(join(selectedDirectory, "docs", "nested", "guide.md"), "guide\n");
    const { app, eventBus } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const workspaceId = registered.json().workspace.id;
    await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });

    const fileCopy = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/copy`,
      payload: {
        path: "notes.md",
        destinationParent: "docs",
        baseModifiedAt: (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString()
      }
    });
    expect(fileCopy.statusCode).toBe(201);
    expect(fileCopy.json()).toEqual({
      workspaceId,
      sourcePath: "notes.md",
      path: "docs/notes.md",
      entryType: "file",
      fileCount: 1,
      directoryCount: 0,
      sizeBytes: Buffer.byteLength("notes\n"),
      copied: true
    });
    // The source is untouched: copy is the one entry operation that adds only.
    expect(await readFile(join(selectedDirectory, "notes.md"), "utf8")).toBe("notes\n");
    expect(await readFile(join(selectedDirectory, "docs", "notes.md"), "utf8")).toBe("notes\n");

    const folderCopy = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/copy`,
      payload: {
        path: "docs",
        destinationParent: "",
        newName: "docs-backup",
        baseModifiedAt: (await stat(join(selectedDirectory, "docs"))).mtime.toISOString()
      }
    });
    expect(folderCopy.statusCode).toBe(201);
    expect(folderCopy.json()).toEqual({
      workspaceId,
      sourcePath: "docs",
      path: "docs-backup",
      entryType: "directory",
      fileCount: 3,
      directoryCount: 2,
      sizeBytes: Buffer.byteLength("read me\nguide\nnotes\n"),
      copied: true
    });
    expect(await readFile(join(selectedDirectory, "docs-backup", "nested", "guide.md"), "utf8")).toBe("guide\n");

    const after = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/files?limit=20` });
    expect(after.json().files.map((file: { path: string }) => file.path).sort()).toEqual([
      "docs-backup/nested/guide.md",
      "docs-backup/notes.md",
      "docs-backup/readme.md",
      "docs/nested/guide.md",
      "docs/notes.md",
      "docs/readme.md",
      "notes.md"
    ]);
    expect(eventBus.getRecentEvents().filter((event) => event.type === "workspace_entry_copied")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ sourcePath: "notes.md", path: "docs/notes.md", fileCount: 1 })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ sourcePath: "docs", path: "docs-backup", fileCount: 3, directoryCount: 2 })
      })
    ]);

    await app.close();
  });

  it("refuses an occupied name by default and walks a bounded ladder only when asked", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-copy-workspace-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const token = (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString();
    const copy = (onCollision?: string) => app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/copy`,
      payload: { path: "notes.md", destinationParent: "", baseModifiedAt: token, ...(onCollision ? { onCollision } : {}) }
    });

    // Copying next to itself with no strategy is the same refusal rename gives.
    expect((await copy()).statusCode).toBe(409);

    // The ladder suffixes the stem, never the extension, and reports the name it
    // actually took so the client never has to guess.
    expect((await copy("keep_both")).json().path).toBe("notes-2.md");
    expect((await copy("keep_both")).json().path).toBe("notes-3.md");
    expect((await copy("keep_both")).json().path).toBe("notes-4.md");
    expect((await copy("keep_both")).json().path).toBe("notes-5.md");
    // `-5` is the end of the ladder: past it a bounded refusal beats a lottery.
    expect((await copy("keep_both")).statusCode).toBe(409);

    await app.close();
  });

  it("refuses stale, protected, symlinked, escaping, and self-nesting copies", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-copy-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-copy-outside-"));
    await writeFile(join(selectedDirectory, "notes.md"), "notes\n");
    await writeFile(join(selectedDirectory, ".env"), "SECRET=1\n");
    await mkdir(join(selectedDirectory, "docs", "nested"), { recursive: true });
    await mkdir(join(selectedDirectory, "generated"));
    await writeFile(join(selectedDirectory, "generated", "stale.agentroom-tmp"), "partial\n");
    await mkdir(join(selectedDirectory, ".git"));
    await writeFile(join(outsideDirectory, "outside.md"), "outside\n");
    await symlink(join(outsideDirectory, "outside.md"), join(selectedDirectory, "linked.md"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;
    const fileToken = (await stat(join(selectedDirectory, "notes.md"))).mtime.toISOString();
    const docsToken = (await stat(join(selectedDirectory, "docs"))).mtime.toISOString();
    const generatedToken = (await stat(join(selectedDirectory, "generated"))).mtime.toISOString();
    const copy = (payload: Record<string, unknown>) => app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/entry/copy`,
      payload
    });

    expect((await copy({ path: "notes.md", destinationParent: "docs", baseModifiedAt: "2000-01-01T00:00:00.000Z" })).statusCode).toBe(409);
    expect((await copy({ path: ".env", destinationParent: "docs", baseModifiedAt: (await stat(join(selectedDirectory, ".env"))).mtime.toISOString() })).statusCode).toBe(415);
    expect((await copy({ path: "linked.md", destinationParent: "docs", baseModifiedAt: (await stat(join(selectedDirectory, "linked.md"))).mtime.toISOString() })).statusCode).toBe(415);
    expect((await copy({ path: "notes.md", destinationParent: ".git", baseModifiedAt: fileToken })).statusCode).toBe(415);
    expect((await copy({
      path: "notes.md",
      destinationParent: "docs",
      newName: "hidden.agentroom-tmp",
      baseModifiedAt: fileToken
    })).statusCode).toBe(415);
    expect((await copy({ path: "notes.md", destinationParent: "..", baseModifiedAt: fileToken })).statusCode).toBe(400);
    expect((await copy({ path: "notes.md", destinationParent: "missing", baseModifiedAt: fileToken })).statusCode).toBe(404);
    // Copying a folder into its own subtree would recurse forever.
    expect((await copy({ path: "docs", destinationParent: "docs/nested", baseModifiedAt: docsToken })).statusCode).toBe(400);
    expect((await copy({
      path: "generated",
      destinationParent: "docs",
      baseModifiedAt: generatedToken
    })).statusCode).toBe(415);
    // A refused copy writes nothing, including no staging leftovers.
    expect((await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/tree?path=docs&depth=1` })).json().entries).toEqual([
      expect.objectContaining({ name: "nested", type: "directory" })
    ]);

    await app.close();
  });
});

async function waitForSession(app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> }, id: string, status: string): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/agent-sessions/${id}` });
    const session = response.json().session;
    if (session?.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session ${id} to become ${status}`);
}
