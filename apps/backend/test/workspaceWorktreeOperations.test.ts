import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LocalWorkspaceWorktree } from "../src/domain/childThreads";
import type { ServiceConfig } from "../src/domain/models";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceGitService, WorkspaceGitServiceError } from "../src/workspace/WorkspaceGitService";

const execFileAsync = promisify(execFile);

// Every case runs against real temporary repositories: what these operations
// promise is Git's own behavior under fixed argv, so a fake executor would
// prove nothing.

describe("child worktree add", () => {
  it("adds a worktree on a new branch at the base commit", async () => {
    const { parent, registry } = await parentWorkspace();
    const { worktree, child } = await addChild(parent, registry, "add");

    expect(child.kind).toBe("managed_worktree");
    expect(child.worktree).toEqual(worktree);
    await expect(git(worktree.worktreePath, "branch", "--show-current")).resolves.toBe(`${worktree.branch}\n`);
    await expect(git(worktree.worktreePath, "rev-parse", "HEAD")).resolves.toBe(`${worktree.baseCommit}\n`);
    // The worktree lives under AgentRoom's home, not inside the selected folder.
    expect(worktree.worktreePath.startsWith(registry.managedWorktreeRoot(parent.id))).toBe(true);
  });

  it("refuses an unborn HEAD, which has no base commit to branch from", async () => {
    const { registry, service, parent } = await parentWorkspace({ unborn: true });
    expect(await registry.git.headCommit(parent.path)).toBeUndefined();

    const worktree = mintWorktree(registry, parent.id, "unborn", "a".repeat(40));
    await expect(service.addWorktree(worktree)).rejects.toMatchObject({ statusCode: 409 });
    expect(await git(parent.path, "branch", "--list", worktree.branch)).toBe("");
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("refuses a record whose branch, base or path the backend did not mint", async () => {
    const { registry, service, parent } = await parentWorkspace();
    const valid = mintWorktree(registry, parent.id, "shape", await headOf(parent.path));
    const outside = join(await mkdtemp(join(tmpdir(), "agentroom-outside-")), "shape-abcdef12");

    for (const worktree of [
      { ...valid, branch: "main" },
      { ...valid, branch: "agentroom/--force-abcdef12" },
      { ...valid, baseCommit: "HEAD" },
      { ...valid, worktreePath: outside },
      { ...valid, worktreePath: `${registry.managedWorktreeRoot(parent.id)}/../shape-abcdef12` },
      { ...valid, worktreePath: join(registry.managedWorktreeRoot(parent.id), "--orphan") }
    ]) {
      await expect(service.addWorktree(worktree)).rejects.toBeInstanceOf(WorkspaceGitServiceError);
    }
    expect(await git(parent.path, "worktree", "list", "--porcelain")).not.toContain("shape-abcdef12");
  });

  it("deletes the branch it made when the checkout fails, and refuses a branch that already exists", async () => {
    const { registry, service, parent } = await parentWorkspace();
    // A required filter that fails, as git-lfs does offline, fails the checkout after Git made the branch.
    await writeFile(join(parent.path, ".gitattributes"), "README.md filter=broken\n");
    await git(parent.path, "add", ".gitattributes");
    await git(parent.path, "commit", "-m", "Filter the readme");
    await git(parent.path, "config", "filter.broken.smudge", "false");
    await git(parent.path, "config", "filter.broken.required", "true");
    const worktree = mintWorktree(registry, parent.id, "filtered", await headOf(parent.path));

    await expect(service.addWorktree(worktree)).rejects.toBeInstanceOf(WorkspaceGitServiceError);
    expect(await git(parent.path, "branch", "--list", worktree.branch)).toBe("");
    expect(existsSync(worktree.worktreePath)).toBe(false);

    await git(parent.path, "branch", worktree.branch);
    await expect(service.addWorktree(worktree)).rejects.toMatchObject({ statusCode: 409, message: "Git branch already exists" });
    expect(await git(parent.path, "branch", "--list", worktree.branch)).toContain(worktree.branch);
  });

  it("refuses to add a worktree from a child worktree", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child } = await addChild(parent, registry, "nested");
    const grandchild = mintWorktree(registry, child.id, "deeper", await headOf(child.path));

    await expect(service.addWorktree(grandchild)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("child worktree reads", () => {
  it("counts commits ahead and the tracked diff since the base, working tree included", async () => {
    const { parent, registry } = await parentWorkspace();
    const { worktree } = await addChild(parent, registry, "reads");
    await commitFile(worktree.worktreePath, "feature.txt", "one\ntwo\n", "Add feature");
    await writeFile(join(worktree.worktreePath, "README.md"), "# Workspace\nedited\n");
    await writeFile(join(worktree.worktreePath, "scratch.txt"), "untracked\n");

    expect(await registry.git.commitsSince(worktree.worktreePath, worktree.baseCommit)).toBe(1);
    const diff = await registry.git.diffSinceCommit(worktree.worktreePath, worktree.baseCommit);
    expect(diff).toMatchObject({ fileCount: 2, insertions: 3, deletions: 0, truncated: false });
    expect(diff.files.map((file) => file.path)).toEqual(["README.md", "feature.txt"]);
  });

  it("never rewrites the worktree's index, so a commit there at the same moment cannot meet index.lock", async () => {
    const { parent, registry } = await parentWorkspace();
    const { worktree, child } = await addChild(parent, registry, "locks");
    await commitFile(worktree.worktreePath, "feature.txt", "one\n", "Add feature");
    await writeFile(join(worktree.worktreePath, "README.md"), "# Workspace\nedited\n");
    // Same content, newer stat: what makes a status or diff refresh the index.
    const later = new Date(Date.now() + 5_000);
    await utimes(join(worktree.worktreePath, "feature.txt"), later, later);
    const indexPath = (await git(worktree.worktreePath, "rev-parse", "--path-format=absolute", "--git-path", "index")).trim();
    const fingerprint = async () => { const info = await stat(indexPath); return `${info.ino}:${info.mtimeMs}`; };
    const before = await fingerprint();

    await registry.git.commitsSince(worktree.worktreePath, worktree.baseCommit);
    expect((await registry.git.diffSinceCommit(worktree.worktreePath, worktree.baseCommit)).fileCount).toBe(2);
    expect((await registry.git.changedEntries(worktree.worktreePath)).map((entry) => entry.path)).toEqual(["README.md"]);
    expect((await registry.git.status(child.id, worktree.worktreePath)).counts.total).toBe(1);
    await registry.git.snapshot(worktree.worktreePath);
    expect(await fingerprint()).toBe(before);

    // A porcelain status without the variable does rewrite it, so the check above means something.
    await git(worktree.worktreePath, "status", "--porcelain");
    expect(await fingerprint()).not.toBe(before);
  });

  it("reads the parent's absolute Git directory as the worktree's common directory", async () => {
    const { parent, registry } = await parentWorkspace();
    const { worktree } = await addChild(parent, registry, "common");

    const commonDir = await registry.git.gitCommonDir(worktree.worktreePath);
    expect(await realpath(commonDir!)).toBe(await realpath(join(parent.path, ".git")));
    expect(await registry.git.gitCommonDir(await mkdtemp(join(tmpdir(), "agentroom-not-a-repo-")))).toBeUndefined();
  });

  it("refuses a base that is not a full commit id", async () => {
    const { parent, registry } = await parentWorkspace();
    await expect(registry.git.commitsSince(parent.path, "HEAD~1")).rejects.toThrow("full commit id");
    await expect(registry.git.diffSinceCommit(parent.path, "--output=/tmp/x")).rejects.toThrow("full commit id");
  });
});

describe("Land", () => {
  it("fast-forwards a clean parent to the child's branch", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "land");
    const childHead = await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");

    const result = await service.landChild(parent.id, child.id);

    expect(result).toMatchObject({ operation: "merge_ff", workspaceId: parent.id, branch: worktree.branch, commit: childHead });
    await expect(headOf(parent.path)).resolves.toBe(childHead);
    await expect(git(parent.path, "branch", "--show-current")).resolves.toBe("main\n");
  });

  it("keeps a parent change in a file the child does not touch", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "keep");
    const childHead = await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    await writeFile(join(parent.path, "README.md"), "# Workspace\nparent edit\n");

    await service.landChild(parent.id, child.id);

    await expect(headOf(parent.path)).resolves.toBe(childHead);
    await expect(readFile(join(parent.path, "README.md"), "utf8")).resolves.toBe("# Workspace\nparent edit\n");
  });

  it("refuses when a parent change is in a file the child changed", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "overlap");
    await commitFile(worktree.worktreePath, "README.md", "# Workspace\nchild edit\n", "Edit readme");
    await writeFile(join(parent.path, "README.md"), "# Workspace\nparent edit\n");

    const refusal = await service.landChild(parent.id, child.id).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ statusCode: 409, code: "parent_changes_in_the_way" });
    expect((refusal as Error).message).toContain("would be overwritten");
    await expect(headOf(parent.path)).resolves.toBe(worktree.baseCommit);
  });

  it("refuses when the child adds a file the parent has untracked", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "untracked");
    await commitFile(worktree.worktreePath, "notes.txt", "child\n", "Add notes");
    await writeFile(join(parent.path, "notes.txt"), "parent\n");

    const refusal = await service.landChild(parent.id, child.id).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ statusCode: 409, code: "parent_changes_in_the_way" });
    expect((refusal as Error).message).toContain("untracked working tree files would be overwritten");
    await expect(readFile(join(parent.path, "notes.txt"), "utf8")).resolves.toBe("parent\n");
  });

  it("refuses when the parent branch moved past the base", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "moved");
    await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    const parentHead = await commitFile(parent.path, "other.txt", "other\n", "Parent moves on");

    const refusal = await service.landChild(parent.id, child.id).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ statusCode: 409, code: "not_fast_forward" });
    await expect(headOf(parent.path)).resolves.toBe(parentHead);
  });

  it("lands on whatever branch the parent checkout is on when it contains the base", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "elsewhere");
    const childHead = await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    await git(parent.path, "switch", "-c", "release");

    await service.landChild(parent.id, child.id);

    await expect(git(parent.path, "rev-parse", "release")).resolves.toBe(`${childHead}\n`);
    await expect(git(parent.path, "rev-parse", "main")).resolves.toBe(`${worktree.baseCommit}\n`);
  });

  it("refuses a detached parent, which a later Close would leave holding the only copy of the commits", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "detached");
    await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    await git(parent.path, "switch", "--detach");

    await expect(service.landChild(parent.id, child.id)).rejects.toMatchObject({ code: "parent_detached" });
    await expect(headOf(parent.path)).resolves.toBe(worktree.baseCommit);
    await expect(service.deleteMergedBranch(worktree)).resolves.toMatchObject({ branchKept: true });
  });

  it("refuses a child worktree switched off its own branch, instead of landing the stale branch", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "switched");
    await git(worktree.worktreePath, "switch", "-c", "elsewhere");
    await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Work on another branch");

    await expect(service.landChild(parent.id, child.id)).rejects.toMatchObject({ code: "child_not_linked" });
    await expect(headOf(parent.path)).resolves.toBe(worktree.baseCommit);
  });

  it("gives a Git failure that is not a fast-forward refusal no not_fast_forward code", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "locked");
    await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    // A commit running in the parent holds the index lock.
    await writeFile(join(parent.path, ".git", "index.lock"), "");

    const refusal = await service.landChild(parent.id, child.id).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WorkspaceGitServiceError);
    expect((refusal as WorkspaceGitServiceError).code).toBeUndefined();
    expect((refusal as Error).message).toContain("index.lock");
  });

  it("refuses a dirty child, a missing child and a workspace that is not the child's parent", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "refusals");
    const other = await parentWorkspace();
    await writeFile(join(worktree.worktreePath, "scratch.txt"), "uncommitted\n");

    await expect(service.landChild(parent.id, child.id)).rejects.toMatchObject({ code: "child_dirty" });
    await expect(service.landChild(other.parent.id, child.id)).rejects.toMatchObject({ code: "child_not_linked" });
    await expect(service.landChild(parent.id, parent.id)).rejects.toMatchObject({ code: "child_not_linked" });

    await rm(worktree.worktreePath, { recursive: true, force: true });
    await expect(service.landChild(parent.id, child.id)).rejects.toMatchObject({ code: "child_not_linked" });
  });
});

describe("Update from parent", () => {
  it("merges the moved parent branch into the child, after which Land fast-forwards", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "update");
    await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    const parentHead = await commitFile(parent.path, "other.txt", "other\n", "Parent moves on");

    const result = await service.updateChildFromParent(child.id);

    expect(result).toMatchObject({ operation: "update_from_parent", workspaceId: child.id, branch: worktree.branch });
    await expect(git(worktree.worktreePath, "rev-list", "--parents", "-n", "1", "HEAD")).resolves.toContain(parentHead);
    await expect(git(worktree.worktreePath, "status", "--porcelain")).resolves.toBe("");

    await service.landChild(parent.id, child.id);
    await expect(headOf(parent.path)).resolves.toBe(result.commit);
  });

  it("aborts a conflicting merge and leaves the child branch and tree as they were", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "conflict");
    const childHead = await commitFile(worktree.worktreePath, "README.md", "# Workspace\nchild\n", "Child edit");
    await commitFile(parent.path, "README.md", "# Workspace\nparent\n", "Parent edit");

    const refusal = await service.updateChildFromParent(child.id).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ statusCode: 409, code: "update_conflicted" });
    await expect(headOf(worktree.worktreePath)).resolves.toBe(childHead);
    await expect(git(worktree.worktreePath, "status", "--porcelain")).resolves.toBe("");
    await expect(readFile(join(worktree.worktreePath, "README.md"), "utf8")).resolves.toBe("# Workspace\nchild\n");
  });

  it("aborts a merge a hook refused, and reports Git's refusal rather than a conflict", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "hooked");
    const childHead = await commitFile(worktree.worktreePath, "feature.txt", "feature\n", "Add feature");
    await commitFile(parent.path, "other.txt", "other\n", "Parent moves on");
    const hooks = join(parent.path, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "pre-merge-commit"), "#!/bin/sh\necho refused by policy >&2\nexit 1\n", { mode: 0o755 });

    const refusal = await service.updateChildFromParent(child.id).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WorkspaceGitServiceError);
    expect((refusal as WorkspaceGitServiceError).code).toBeUndefined();
    await expect(headOf(worktree.worktreePath)).resolves.toBe(childHead);
    await expect(git(worktree.worktreePath, "status", "--porcelain")).resolves.toBe("");
  });

  it("refuses a detached parent, a dirty child and a child off its own branch", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { child, worktree } = await addChild(parent, registry, "update-refusals");

    await git(parent.path, "switch", "--detach");
    await expect(service.updateChildFromParent(child.id)).rejects.toMatchObject({ code: "parent_detached" });
    await git(parent.path, "switch", "main");

    await writeFile(join(worktree.worktreePath, "README.md"), "# Workspace\nuncommitted\n");
    await expect(service.updateChildFromParent(child.id)).rejects.toMatchObject({ code: "child_dirty" });
    await git(worktree.worktreePath, "checkout", "--", "README.md");

    await git(worktree.worktreePath, "switch", "-c", "elsewhere");
    await expect(service.updateChildFromParent(child.id)).rejects.toMatchObject({ code: "child_not_linked" });
  });
});

describe("Close: worktree remove and branch delete", () => {
  it("removes a worktree that holds only ignored files", async () => {
    const { parent, registry, service } = await parentWorkspace({ ignore: "node_modules/\n" });
    const { worktree } = await addChild(parent, registry, "ignored");
    await mkdir(join(worktree.worktreePath, "node_modules"));
    await writeFile(join(worktree.worktreePath, "node_modules", "dep.js"), "module.exports = 1;\n");

    await expect(service.removeWorktree(worktree)).resolves.toMatchObject({ operation: "worktree_remove" });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  it("refuses to remove a worktree holding untracked or modified files", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const untracked = (await addChild(parent, registry, "untracked-files")).worktree;
    const modified = (await addChild(parent, registry, "modified-files")).worktree;
    await writeFile(join(untracked.worktreePath, "scratch.txt"), "keep me\n");
    await writeFile(join(modified.worktreePath, "README.md"), "# Workspace\nkeep me\n");

    await expect(service.removeWorktree(untracked)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.removeWorktree(modified)).rejects.toMatchObject({ statusCode: 409 });
    await expect(readFile(join(untracked.worktreePath, "scratch.txt"), "utf8")).resolves.toBe("keep me\n");
    await expect(readFile(join(modified.worktreePath, "README.md"), "utf8")).resolves.toBe("# Workspace\nkeep me\n");
  });

  it("removes a worktree whose folder was deleted outside Git and clears Git's record", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { worktree } = await addChild(parent, registry, "deleted");
    await rm(worktree.worktreePath, { recursive: true, force: true });

    await service.removeWorktree(worktree);

    expect(await git(parent.path, "worktree", "list", "--porcelain")).not.toContain("deleted-abcdef12");
  });

  it("treats a worktree Git no longer records as already removed", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const { worktree } = await addChild(parent, registry, "pruned");
    await git(parent.path, "worktree", "remove", "--", worktree.worktreePath);

    await expect(service.removeWorktree(worktree)).resolves.toBeUndefined();
    await expect(service.deleteMergedBranch(worktree)).resolves.toMatchObject({ branchKept: false });
  });

  it("keeps a branch a worktree still has checked out, even one whose folder is gone", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const present = (await addChild(parent, registry, "present")).worktree;
    const missing = (await addChild(parent, registry, "missing")).worktree;
    await rm(missing.worktreePath, { recursive: true, force: true });

    await expect(service.deleteMergedBranch(present)).resolves.toMatchObject({ operation: "branch_delete", branchKept: true });
    await expect(service.deleteMergedBranch(missing)).resolves.toMatchObject({ branchKept: true });
    const branches = await git(parent.path, "branch", "--list", present.branch, missing.branch);
    expect(branches).toContain(present.branch);
    expect(branches).toContain(missing.branch);
  });

  it("deletes a merged branch after remove and keeps an unmerged one", async () => {
    const { parent, registry, service } = await parentWorkspace();
    const merged = (await addChild(parent, registry, "merged")).worktree;
    const unmerged = (await addChild(parent, registry, "unmerged")).worktree;
    await commitFile(unmerged.worktreePath, "feature.txt", "feature\n", "Unlanded work");
    await service.removeWorktree(merged);
    await service.removeWorktree(unmerged);

    await expect(service.deleteMergedBranch(merged)).resolves.toMatchObject({ branchKept: false, branch: merged.branch });
    await expect(service.deleteMergedBranch(unmerged)).resolves.toMatchObject({ branchKept: true });
    await expect(git(parent.path, "branch", "--list", merged.branch)).resolves.toBe("");
    await expect(git(parent.path, "branch", "--list", unmerged.branch)).resolves.toContain(unmerged.branch);
  });
});

async function parentWorkspace(options: { unborn?: boolean; ignore?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentroom-worktree-ops-"));
  const config: ServiceConfig = {
    runnerKind: "codex",
    host: "127.0.0.1",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: []
  };
  const selected = join(root, "selected");
  await mkdir(selected);
  await git(selected, "init", "-b", "main");
  await git(selected, "config", "user.email", "agentroom@example.invalid");
  await git(selected, "config", "user.name", "AgentRoom Tests");
  if (!options.unborn) {
    await writeFile(join(selected, "README.md"), "# Workspace\n");
    if (options.ignore) await writeFile(join(selected, ".gitignore"), options.ignore);
    await git(selected, "add", ".");
    await git(selected, "commit", "-m", "Initial commit");
  }
  const registry = new LocalWorkspaceRegistry(config);
  const { workspace: parent } = await registry.register({ path: selected });
  return { registry, service: new WorkspaceGitService(registry), parent };
}

function mintWorktree(
  registry: LocalWorkspaceRegistry,
  parentWorkspaceId: string,
  slug: string,
  baseCommit: string
): LocalWorkspaceWorktree {
  const name = `${slug}-abcdef12`;
  return {
    parentWorkspaceId,
    worktreePath: join(registry.managedWorktreeRoot(parentWorkspaceId), name),
    branch: `agentroom/${name}`,
    baseCommit
  };
}

async function addChild(
  parent: { id: string; path: string },
  registry: LocalWorkspaceRegistry,
  slug: string
) {
  const worktree = mintWorktree(registry, parent.id, slug, await headOf(parent.path));
  const result = await new WorkspaceGitService(registry).addWorktree(worktree);
  expect(result).toMatchObject({ operation: "worktree_add", branch: worktree.branch, commit: worktree.baseCommit });
  const { workspace: child } = await registry.register({ path: worktree.worktreePath, worktree });
  return { worktree, child };
}

async function commitFile(cwd: string, path: string, content: string, message: string): Promise<string> {
  await writeFile(join(cwd, path), content);
  await git(cwd, "add", "--", path);
  await git(cwd, "commit", "-m", message);
  return headOf(cwd);
}

async function headOf(cwd: string): Promise<string> {
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
