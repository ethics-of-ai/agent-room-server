import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultGitBlobExecutor, defaultGitExecutor, LocalWorkspaceGit } from "../src/workspace/LocalWorkspaceGit";
import { createGitWorkspace, git } from "./support/agentSessionHarness";

// The committed-range read behind the settle-time turn diff, against real Git.

const workspaceGit = new LocalWorkspaceGit(defaultGitExecutor(30_000), defaultGitBlobExecutor(30_000));

describe("committed changes since a turn-start commit", () => {
  it("reports added, modified, and deleted files with line counts", async () => {
    const workspacePath = await createGitWorkspace();
    await writeFile(join(workspacePath, "old.txt"), "one\ntwo\n");
    await git(workspacePath, "add", "old.txt");
    await git(workspacePath, "commit", "-m", "Add old file");
    const start = await workspaceGit.headCommit(workspacePath);

    await git(workspacePath, "switch", "-c", "feature/agent");
    await writeFile(join(workspacePath, "README.md"), "# Workspace\nMore\n");
    await writeFile(join(workspacePath, "new.txt"), "fresh\n");
    await rm(join(workspacePath, "old.txt"));
    await git(workspacePath, "add", "-A");
    await git(workspacePath, "commit", "-m", "Agent change");

    expect(start).toMatch(/^[0-9a-f]{40}$/);
    const changes = await workspaceGit.committedChanges(workspacePath, start!, (await workspaceGit.headCommit(workspacePath))!);
    expect(changes.truncated).toBe(false);
    expect(changes.files).toHaveLength(3);
    expect(changes.files).toEqual(expect.arrayContaining([
      { path: "README.md", status: "modified", staged: true, unstaged: false, additions: 1, deletions: 0 },
      { path: "new.txt", status: "added", staged: true, unstaged: false, additions: 1, deletions: 0 },
      { path: "old.txt", status: "deleted", staged: true, unstaged: false, additions: 0, deletions: 2 }
    ]));
  });

  it("stays inside a workspace registered as a repository subdirectory", async () => {
    const repositoryPath = await createGitWorkspace();
    const workspacePath = join(repositoryPath, "app");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "inside.txt"), "a\n");
    await git(repositoryPath, "add", "app/inside.txt");
    await git(repositoryPath, "commit", "-m", "Add app");
    const start = await workspaceGit.headCommit(workspacePath);

    await writeFile(join(workspacePath, "inside.txt"), "a\nb\n");
    await writeFile(join(repositoryPath, "outside.txt"), "not ours\n");
    await git(repositoryPath, "add", "-A");
    await git(repositoryPath, "commit", "-m", "Both sides");

    const changes = await workspaceGit.committedChanges(workspacePath, start!, (await workspaceGit.headCommit(workspacePath))!);
    expect(changes.files.map((file) => file.path)).toEqual(["inside.txt"]);
  });

  it("reads only up to the end commit it is given, even after HEAD moves on", async () => {
    const workspacePath = await createGitWorkspace();
    const start = await workspaceGit.headCommit(workspacePath);
    await writeFile(join(workspacePath, "first.txt"), "one\n");
    await git(workspacePath, "add", "first.txt");
    await git(workspacePath, "commit", "-m", "First");
    const end = await workspaceGit.headCommit(workspacePath);
    await writeFile(join(workspacePath, "later.txt"), "two\n");
    await git(workspacePath, "add", "later.txt");
    await git(workspacePath, "commit", "-m", "Later");

    const changes = await workspaceGit.committedChanges(workspacePath, start!, end!);
    expect(changes.files.map((file) => file.path)).toEqual(["first.txt"]);
  });

  it("reads the range when a tracked file shares a revision's name", async () => {
    const workspacePath = await createGitWorkspace();
    await writeFile(join(workspacePath, "HEAD"), "a file, not a revision\n");
    await git(workspacePath, "add", "HEAD");
    await git(workspacePath, "commit", "-m", "Add a file named HEAD");
    const start = await workspaceGit.headCommit(workspacePath);
    await writeFile(join(workspacePath, "README.md"), "# Workspace\nMore\n");
    await git(workspacePath, "commit", "-am", "Agent change");
    const end = await workspaceGit.headCommit(workspacePath);

    const changes = await workspaceGit.committedChanges(workspacePath, start!, end!);
    expect(changes.files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("refuses anything but a full commit id at either end", async () => {
    const workspacePath = await createGitWorkspace();
    const head = (await workspaceGit.headCommit(workspacePath))!;

    await expect(workspaceGit.committedChanges(workspacePath, "--output=/tmp/x", head)).rejects.toThrow("full commit id");
    await expect(workspaceGit.committedChanges(workspacePath, "main", head)).rejects.toThrow("full commit id");
    await expect(workspaceGit.committedChanges(workspacePath, head, "HEAD")).rejects.toThrow("full commit id");
    await expect(workspaceGit.committedChanges(workspacePath, head, "--output=/tmp/x")).rejects.toThrow("full commit id");
  });

  it.each(["sha1", "sha256"] as const)("reads a repository's first commits against the empty tree (%s)", async (objectFormat) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agentroom-first-commit-"));
    await git(workspacePath, "init", "-b", "main", `--object-format=${objectFormat}`);
    await git(workspacePath, "config", "user.email", "agentroom@example.invalid");
    await git(workspacePath, "config", "user.name", "AgentRoom Tests");
    await writeFile(join(workspacePath, "first.txt"), "one\ntwo\n");
    await git(workspacePath, "add", "first.txt");
    await git(workspacePath, "commit", "-m", "First");
    await writeFile(join(workspacePath, "second.txt"), "three\n");
    await git(workspacePath, "add", "second.txt");
    await git(workspacePath, "commit", "-m", "Second");

    const changes = await workspaceGit.committedChanges(workspacePath, undefined, (await workspaceGit.headCommit(workspacePath))!);
    expect(changes).toEqual({
      files: [
        { path: "first.txt", status: "added", staged: true, unstaged: false, additions: 2, deletions: 0 },
        { path: "second.txt", status: "added", staged: true, unstaged: false, additions: 1, deletions: 0 }
      ],
      truncated: false
    });
  });

  it("has no HEAD commit on an unborn branch", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agentroom-unborn-"));
    await git(workspacePath, "init", "-b", "main");

    await expect(workspaceGit.headCommit(workspacePath)).resolves.toBeUndefined();
  });
});
