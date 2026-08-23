import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

  it("refuses secret names, generated dirs, traversal, and symlink leaves", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-workspace-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "agentroom-write-outside-"));
    await writeFile(join(outsideDirectory, "secret.txt"), "do not touch\n");
    await symlink(join(outsideDirectory, "secret.txt"), join(selectedDirectory, "leak.txt"));
    const { app } = await buildServer({ config: serviceConfig });
    const workspaceId = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } })).json().workspace.id;

    const put = (path: string) =>
      app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/file`, payload: { path, content: "x\n" } });

    expect((await put(".env")).statusCode).toBe(415);
    expect((await put(".git/config")).statusCode).toBe(415);
    expect((await put("keys/server.pem")).statusCode).toBe(415);
    expect((await put("../escape.txt")).statusCode).toBe(400);
    expect((await put("leak.txt")).statusCode).toBe(415);
    expect(await readFile(join(outsideDirectory, "secret.txt"), "utf8")).toBe("do not touch\n");

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

async function waitForSession(app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> }, id: string, status: string): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/agent-sessions/${id}` });
    const session = response.json().session;
    if (session?.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session ${id} to become ${status}`);
}
