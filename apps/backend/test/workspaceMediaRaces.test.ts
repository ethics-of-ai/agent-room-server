import { constants } from "node:fs";
import * as fs from "node:fs/promises";
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
    expect((await readWorkspaceMedia(target, { path: "alias/image.png" })).bytes).toEqual(png);
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
