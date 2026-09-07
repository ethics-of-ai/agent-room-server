import { get } from "node:http";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import { buildServer } from "../src/server";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";
import {
  maxDocumentMediaBytes,
  maxImageMediaBytes,
  WorkspaceMediaError,
  WorkspaceMediaReader,
  type WorkspaceMediaRead
} from "../src/workspace/explorer/workspaceMedia";
import type { WorkspaceTarget } from "../src/workspace/explorer/paths";

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff]);
const pdfHeader = Buffer.from("%PDF-", "ascii");
const usdzHeader = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(26)]);
const webpHeader = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("workspace media route", () => {
  it("cancels the read when a client disconnects after sending its GET request", async () => {
    const fixture = await setupWorkspace();
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const read = vi.spyOn(WorkspaceExplorer.prototype, "fileMedia").mockImplementation(async (_id, input) => {
      receivedSignal = input.signal;
      started();
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new WorkspaceMediaError("Media read was cancelled", 499, "media_cancelled");
    });
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const request = get(`${address}/api/workspaces/${fixture.workspaceId}/file-media?path=image.png`);
    request.on("error", () => {});
    try {
      await reading;
      request.destroy();
      await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    } finally {
      request.destroy();
      read.mockRestore();
      await fixture.app.close();
    }
  });

  it("serves each supported format with verified response headers", async () => {
    const fixture = await setupWorkspace();
    const files = [
      ["image.PNG", pngHeader, "image/png", "image"],
      ["photo.JpEg", jpegHeader, "image/jpeg", "image"],
      ["frame.WEBP", webpHeader, "image/webp", "image"],
      ["document.PDF", pdfHeader, "application/pdf", "pdf"],
      ["model.USDZ", usdzHeader, "model/vnd.usdz+zip", "usdz"]
    ] as const;
    for (const [name, bytes] of files) await writeFile(join(fixture.directory, name), bytes);

    for (const [name, bytes, mime] of files) {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/workspaces/${fixture.workspaceId}/file-media?path=${encodeURIComponent(name)}`
      });
      expect(response.statusCode, name).toBe(200);
      expect(response.rawPayload, name).toEqual(bytes);
      expect(response.headers["content-type"], name).toBe(mime);
      expect(response.headers["content-length"], name).toBe(String(bytes.length));
      expect(response.headers["cache-control"], name).toBe("no-store");
      expect(response.headers["x-content-type-options"], name).toBe("nosniff");
      expect(response.headers["last-modified"], name).toEqual(expect.any(String));
    }

    const classifiedFiles = files;
    const tree = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/tree?depth=1`
    });
    expect(tree.json().entries).toEqual(expect.arrayContaining(classifiedFiles.map(([name, , , mediaKind]) =>
      expect.objectContaining({ name, mediaKind })
    )));

    const index = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/files?limit=20`
    });
    expect(index.json().files).toEqual(expect.arrayContaining(classifiedFiles.map(([name, , , mediaKind]) =>
      expect.objectContaining({ name, mediaKind })
    )));
    await fixture.app.close();
  });

  it("rejects empty, truncated, mismatched, corrupt, and unsupported media", async () => {
    const fixture = await setupWorkspace();
    const cases = [
      ["empty.png", Buffer.alloc(0)],
      ["short.png", pngHeader.subarray(0, 7)],
      ["wrong.jpg", pngHeader],
      ["wrong.webp", Buffer.from("RIFF\u0000\u0000\u0000\u0000NOPE", "binary")],
      ["wrong.pdf", Buffer.from("not a pdf")],
      ["high-bit.pdf", Buffer.from(pdfHeader.map((byte) => byte | 0x80))],
      ["high-bit.webp", Buffer.from(webpHeader.map((byte, index) => index < 4 || index >= 8 ? byte | 0x80 : byte))],
      ["wrong.usdz", Buffer.from("PK\u0003\u0004")],
      ["mismatched.usdz", Buffer.alloc(30)],
      ["plain.txt", Buffer.from("hello")]
    ] as const;
    for (const [name, bytes] of cases) {
      await writeFile(join(fixture.directory, name), bytes);
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/workspaces/${fixture.workspaceId}/file-media?path=${encodeURIComponent(name)}`
      });
      expect(response.statusCode, name).toBe(415);
      expect(response.json(), name).toMatchObject({ code: "unsupported_media" });
    }
    await fixture.app.close();
  });

  it("enforces the exact image and document size caps", async () => {
    const fixture = await setupWorkspace();
    const exactImage = Buffer.alloc(maxImageMediaBytes);
    pngHeader.copy(exactImage);
    const oversizedImage = Buffer.alloc(maxImageMediaBytes + 1);
    pngHeader.copy(oversizedImage);
    const exactPDF = Buffer.alloc(maxDocumentMediaBytes);
    pdfHeader.copy(exactPDF);
    const oversizedPDF = Buffer.alloc(maxDocumentMediaBytes + 1);
    pdfHeader.copy(oversizedPDF);
    await writeFile(join(fixture.directory, "exact.png"), exactImage);
    await writeFile(join(fixture.directory, "large.png"), oversizedImage);
    await writeFile(join(fixture.directory, "exact.pdf"), exactPDF);
    await writeFile(join(fixture.directory, "large.pdf"), oversizedPDF);

    const exactImageResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/file-media?path=exact.png`
    });
    const largeImageResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/file-media?path=large.png`
    });
    const exactPDFResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/file-media?path=exact.pdf`
    });
    const largePDFResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/file-media?path=large.pdf`
    });

    expect(exactImageResponse.statusCode).toBe(200);
    expect(largeImageResponse.statusCode).toBe(413);
    expect(largeImageResponse.json()).toMatchObject({ code: "media_too_large" });
    expect(exactPDFResponse.statusCode).toBe(200);
    expect(largePDFResponse.statusCode).toBe(413);
    expect(largePDFResponse.json()).toMatchObject({ code: "media_too_large" });
    await fixture.app.close();
  });

  it("bounds USDZ bytes and authenticates model reads without extracting the package", async () => {
    const fixture = await setupWorkspace({ requireAuth: true, authToken: "media-secret" });
    const bytes = Buffer.alloc(maxDocumentMediaBytes);
    usdzHeader.copy(bytes);
    await writeFile(join(fixture.directory, "model.usdz"), bytes);
    await writeFile(join(fixture.directory, "large.usdz"), Buffer.alloc(maxDocumentMediaBytes + 1));
    await symlink(join(fixture.directory, "model.usdz"), join(fixture.directory, "link.usdz"));
    const request = (path: string, authorized = true) => fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/file-media?path=${path}`,
      headers: authorized ? { authorization: "Bearer media-secret" } : undefined
    });
    expect((await request("model.usdz", false)).statusCode).toBe(401);
    const modelResponse = await request("model.usdz");
    expect(modelResponse.statusCode).toBe(200);
    expect(modelResponse.rawPayload.length).toBe(maxDocumentMediaBytes);
    expect(modelResponse.rawPayload.subarray(0, usdzHeader.length)).toEqual(usdzHeader);
    expect((await request("large.usdz")).statusCode).toBe(413);
    expect((await request("link.usdz")).statusCode).toBe(403);
    await fixture.app.close();
  });

  it("maps auth, path, workspace, protected-name, missing, directory, and symlink refusals", async () => {
    const fixture = await setupWorkspace({ requireAuth: true, authToken: "media-secret" });
    await writeFile(join(fixture.directory, "ok.png"), pngHeader);
    await mkdir(join(fixture.directory, "folder.png"));
    await symlink(join(fixture.directory, "ok.png"), join(fixture.directory, "link.png"));
    await writeFile(join(fixture.directory, ".env.png"), pngHeader);

    const unauthorized = await fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${fixture.workspaceId}/file-media?path=ok.png`
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: "Unauthorized", code: "unauthorized" });

    const get = (path: string, workspaceId = fixture.workspaceId) => fixture.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/file-media?path=${encodeURIComponent(path)}`,
      headers: { authorization: "Bearer media-secret" }
    });
    const invalid = await get("../ok.png");
    const protectedFile = await get(".env.png");
    const missing = await get("missing.png");
    const directory = await get("folder.png");
    const link = await get("link.png");
    const unknown = await get("ok.png", "workspace-missing");

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_path" });
    expect(protectedFile.statusCode).toBe(403);
    expect(protectedFile.json()).toMatchObject({ code: "forbidden_path" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "file_not_found" });
    expect(directory.statusCode).toBe(415);
    expect(directory.json()).toMatchObject({ code: "unsupported_media" });
    expect(link.statusCode).toBe(403);
    expect(link.json()).toMatchObject({ code: "forbidden_path" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "workspace_not_found" });
    await fixture.app.close();
  });
});

describe("workspace media read admission", () => {
  it("refuses a third read and releases slots after success and failure", async () => {
    const gates: Array<() => void> = [];
    const reader = new WorkspaceMediaReader(async () => new Promise<WorkspaceMediaRead>((resolve) => {
      gates.push(() => resolve(fakeMedia()));
    }));
    const target: WorkspaceTarget = { workspaceId: "workspace-test", workspacePath: "/tmp", workspaceRoot: "/tmp" };
    const first = reader.read(target, { path: "first.png" });
    const second = reader.read(target, { path: "second.png" });
    await expect(reader.read(target, { path: "third.png" })).rejects.toMatchObject({
      statusCode: 503,
      code: "media_busy"
    });
    gates.shift()?.();
    await first;
    const fourth = reader.read(target, { path: "fourth.png" });
    gates.shift()?.();
    await second;
    gates.shift()?.();
    await fourth;

    const failing = new WorkspaceMediaReader(async () => {
      throw new Error("failure");
    });
    await expect(failing.read(target, { path: "bad.png" })).rejects.toThrow("failure");
    await expect(failing.read(target, { path: "bad-again.png" })).rejects.toThrow("failure");
  });
});

async function setupWorkspace(overrides: Partial<ServiceConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentroom-workspace-media-"));
  const directory = join(root, "workspace");
  await mkdir(directory);
  const config: ServiceConfig = {
    runnerKind: "codex",
    host: "127.0.0.1",
    port: 8787,
    workspaceRoot: join(root, "managed"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
  const { app } = await buildServer({ config });
  const registered = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: config.requireAuth ? { authorization: `Bearer ${config.authToken}` } : undefined,
    payload: { path: directory }
  });
  return { app, directory, workspaceId: registered.json().workspace.id as string };
}

function fakeMedia(): WorkspaceMediaRead {
  return {
    path: "image.png",
    name: "image.png",
    kind: "image",
    contentType: "image/png",
    bytes: pngHeader,
    modifiedAt: new Date(0)
  };
}
