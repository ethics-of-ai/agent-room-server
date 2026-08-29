import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBoundedFile, copyBoundedSubtree } from "../src/workspace/explorer/subtree";

describe("workspace subtree copy", () => {
  it("refuses a selected directory replaced by a symlink after inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-subtree-copy-"));
    const source = join(root, "source");
    const movedSource = join(root, "moved-source");
    const outside = join(root, "outside");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(outside);
    await writeFile(join(outside, "outside.txt"), "outside\n");
    const inventoriedSource = await stat(source);

    await rename(source, movedSource);
    await symlink(outside, source);

    await expect(copyBoundedSubtree(source, destination, inventoriedSource)).rejects.toMatchObject({
      statusCode: 409
    });
  });

  it("refuses a selected file replaced by a symlink after inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-file-copy-"));
    const source = join(root, "source.txt");
    const movedSource = join(root, "moved-source.txt");
    const outside = join(root, "outside.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "source\n");
    await writeFile(outside, "outside\n");
    const inventoriedSource = await stat(source);

    await rename(source, movedSource);
    await symlink(outside, source);

    await expect(copyBoundedFile(source, destination, inventoriedSource)).rejects.toMatchObject({
      statusCode: 409
    });
  });
});
