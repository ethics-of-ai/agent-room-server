import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceMedia } from "../src/workspace/explorer/workspaceMedia";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, open: vi.fn(original.open) };
});

const roots: string[] = [];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

afterEach(async () => {
  vi.mocked(fs.open).mockReset();
  const original = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(original.open);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "agentroom-media-races-"));
  roots.push(root);
  const workspaceRoot = await fs.realpath(root);
  const path = join(workspaceRoot, "image.png");
  await fs.writeFile(path, png);
  return { path, target: { workspaceId: "test", workspacePath: workspaceRoot, workspaceRoot } };
}

describe("workspace media filesystem boundaries", () => {
  it("filters contained directory symlinks that resolve into protected paths", async () => {
    const { target } = await fixture();
    for (const protectedName of [".env.private", ".git", "node_modules"]) {
      const hidden = join(target.workspaceRoot, protectedName);
      await fs.mkdir(hidden);
      await fs.writeFile(join(hidden, "image.png"), png);
      const alias = `alias-${protectedName}`;
      await fs.symlink(hidden, join(target.workspaceRoot, alias));
      await expect(readWorkspaceMedia(target, { path: `${alias}/image.png` }))
        .rejects.toMatchObject({ statusCode: 403, code: "forbidden_path" });
    }
  });

  it("still permits a directory alias within an ordinary workspace directory", async () => {
    const { target } = await fixture();
    await fs.mkdir(join(target.workspaceRoot, "art"));
    await fs.writeFile(join(target.workspaceRoot, "art/image.png"), png);
    await fs.symlink(join(target.workspaceRoot, "art"), join(target.workspaceRoot, "alias"));
    const media = await readWorkspaceMedia(target, { path: "alias/image.png" });
    const chunks: Buffer[] = [];
    for await (const chunk of media.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(png);
  });

  it("refuses escaping intermediate symlinks", async () => {
    const { target } = await fixture();
    const outside = await fs.mkdtemp(join(tmpdir(), "agentroom-media-outside-"));
    roots.push(outside);
    await fs.writeFile(join(outside, "image.png"), png);
    await fs.symlink(outside, join(target.workspaceRoot, "outside"));
    await expect(readWorkspaceMedia(target, { path: "outside/image.png" }))
      .rejects.toMatchObject({ statusCode: 403, code: "forbidden_path" });
  });

  it("streams the validated snapshot even if the workspace file changes afterward", async () => {
    const { target, path } = await fixture();
    const media = await readWorkspaceMedia(target, { path: "image.png" });
    await fs.writeFile(path, Buffer.from("replaced"));
    const chunks: Buffer[] = [];
    for await (const chunk of media.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(png);
    expect(media.byteLength).toBe(BigInt(png.length));
  });

  it("closes the anonymous snapshot when a response is cancelled", async () => {
    const { target } = await fixture();
    const original = await vi.importActual<typeof fs>("node:fs/promises");
    let snapshot: Awaited<ReturnType<typeof fs.open>> | undefined;
    let snapshotPath: string | undefined;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await original.open(...args);
      if (args[1] === "wx+") {
        snapshot = handle;
        snapshotPath = String(args[0]);
      }
      return handle;
    });
    const controller = new AbortController();
    const media = await readWorkspaceMedia(target, { path: "image.png", signal: controller.signal });
    expect(snapshot).toBeDefined();
    await expect(fs.stat(snapshotPath!)).rejects.toMatchObject({ code: "ENOENT" });
    const completion = finished(media.stream);
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    await expect(snapshot!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("detects growth while copying and closes the failed snapshot", async () => {
    const { target, path } = await fixture();
    const original = await vi.importActual<typeof fs>("node:fs/promises");
    let snapshot: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await original.open(...args);
      if (args[1] === "wx+") {
        snapshot = handle;
      } else {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs: unknown[]) => {
          await fs.appendFile(path, Buffer.alloc(1024));
          return await (read as (...values: unknown[]) => ReturnType<typeof handle.read>)(...readArgs);
        });
      }
      return handle;
    });
    await expect(readWorkspaceMedia(target, { path: "image.png" }))
      .rejects.toMatchObject({ code: "file_changed" });
    expect(snapshot).toBeDefined();
    await expect(snapshot!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("rejects a same-inode size change between validation and opening and closes its handle", async () => {
    const { target, path } = await fixture();
    const original = await vi.importActual<typeof fs>("node:fs/promises");
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await fs.appendFile(path, Buffer.from([1]));
      const handle = await original.open(...args);
      close = vi.spyOn(handle, "close");
      return handle;
    });
    await expect(readWorkspaceMedia(target, { path: "image.png" }))
      .rejects.toMatchObject({ statusCode: 409, code: "file_changed" });
    expect(close).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.open).mock.calls[0]?.[1]).toBe(
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  });

  it("rejects a same-size modification observed during the read", async () => {
    const { target, path } = await fixture();
    const original = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs: unknown[]) => {
        const result = await (read as (...values: unknown[]) => Promise<unknown>)(...readArgs);
        await fs.utimes(path, new Date(0), new Date(0));
        return result as Awaited<ReturnType<typeof handle.read>>;
      });
      return handle;
    });
    await expect(readWorkspaceMedia(target, { path: "image.png" }))
      .rejects.toMatchObject({ statusCode: 409, code: "file_changed" });
  });

  it("rejects a protected parent swap even when the same file inode remains reachable", async () => {
    const { target } = await fixture();
    const art = join(target.workspaceRoot, "art");
    await fs.mkdir(art);
    await fs.writeFile(join(art, "image.png"), png);
    const original = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      await fs.rename(art, join(target.workspaceRoot, ".git"));
      await fs.symlink(join(target.workspaceRoot, ".git"), art);
      return handle;
    });
    await expect(readWorkspaceMedia(target, { path: "art/image.png" }))
      .rejects.toMatchObject({ statusCode: 403, code: "forbidden_path" });
  });

  it("does not return bytes when cancelled after the final read", async () => {
    const { target } = await fixture();
    const controller = new AbortController();
    const original = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      const stat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
        const result = await stat(...statArgs);
        if (++calls === 2) controller.abort();
        return result;
      });
      return handle;
    });
    await expect(readWorkspaceMedia(target, { path: "image.png", signal: controller.signal }))
      .rejects.toMatchObject({ code: "media_cancelled" });
  });
});
