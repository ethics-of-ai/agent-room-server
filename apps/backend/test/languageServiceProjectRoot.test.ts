import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalWorkspace } from "../src/domain/models";
import { LanguageServiceError } from "../src/editor/languageServices/errors";
import { resolveLanguageServiceProject } from "../src/editor/languageServices/projectRoot";
import type { LanguageServiceDescriptor } from "../src/editor/languageServices/types";

const roots: string[] = [];

function descriptor(overrides: Partial<LanguageServiceDescriptor> = {}): LanguageServiceDescriptor {
  return {
    id: "fake_lsp",
    displayName: "Fake LSP",
    testedVersion: "fixture",
    positionEncoding: "utf-16",
    languageIds: ["swift"],
    featureKinds: ["hover"],
    projectMarkers: [{ kind: "exact", value: "Package.swift", priority: 100 }],
    standaloneWorkspaceRoot: false,
    projectLoading: { mayInvokeBuildTools: false, mayLoadPlugins: false },
    environmentKeys: [],
    configured: () => true,
    resolveExecutable: async () => ({ command: process.execPath, args: [] }),
    ...overrides
  };
}

async function workspace(): Promise<LocalWorkspace> {
  const path = await mkdtemp(join(tmpdir(), "agentroom-language-root-"));
  roots.push(path);
  return {
    id: "workspace-1",
    name: "Fixture",
    path,
    kind: "user_selected",
    trustedAt: new Date(0).toISOString(),
    lastOpenedAt: new Date(0).toISOString(),
    git: { isRepository: false }
  };
}

async function source(root: string, relativePath = "Sources/App/main.swift"): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "let value = 1\n");
  return relativePath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("language-service project root resolution", () => {
  it("chooses the nearest marker without walking above the registered workspace", async () => {
    const item = await workspace();
    await writeFile(join(item.path, "Package.swift"), "root");
    await mkdir(join(item.path, "Nested", "Sources"), { recursive: true });
    await writeFile(join(item.path, "Nested", "Package.swift"), "nested");
    await writeFile(join(item.path, "Nested", "Sources", "main.swift"), "let x = 1\n");

    const resolved = await resolveLanguageServiceProject(
      item,
      "Nested/Sources/main.swift",
      "swift",
      [descriptor()]
    );

    expect(resolved.relativeProjectRoot).toBe("Nested");
    expect(resolved.marker).toBe("Package.swift");
  });

  it("uses same-directory marker priority and refuses unresolved ties", async () => {
    const item = await workspace();
    await source(item.path, "main.swift");
    await mkdir(join(item.path, "App.xcodeproj"));
    await writeFile(join(item.path, "Package.swift"), "package");
    const prioritized = descriptor({
      projectMarkers: [
        { kind: "suffix", value: ".xcodeproj", priority: 110 },
        { kind: "exact", value: "Package.swift", priority: 100 }
      ]
    });
    await expect(resolveLanguageServiceProject(item, "main.swift", "swift", [prioritized]))
      .resolves.toMatchObject({ marker: "App.xcodeproj" });

    await mkdir(join(item.path, "Other.xcodeproj"));
    await expect(resolveLanguageServiceProject(item, "main.swift", "swift", [prioritized]))
      .rejects.toMatchObject({ code: "ambiguous_project" } satisfies Partial<LanguageServiceError>);
  });

  it("refuses path traversal, secret-named paths, and symlink aliases", async () => {
    const item = await workspace();
    await writeFile(join(item.path, "Package.swift"), "package");
    const relativePath = await source(item.path);
    await symlink(join(item.path, relativePath), join(item.path, "alias.swift"));
    await writeFile(join(item.path, ".env"), "secret");

    for (const path of ["../outside.swift", ".env", "alias.swift"]) {
      await expect(resolveLanguageServiceProject(item, path, "swift", [descriptor()]))
        .rejects.toMatchObject({ code: "invalid_path" } satisfies Partial<LanguageServiceError>);
    }
  });

  it("returns project_not_found unless the descriptor explicitly allows standalone roots", async () => {
    const item = await workspace();
    await source(item.path, "main.swift");
    await expect(resolveLanguageServiceProject(item, "main.swift", "swift", [descriptor()]))
      .rejects.toMatchObject({ code: "project_not_found" } satisfies Partial<LanguageServiceError>);
    const standalone = await resolveLanguageServiceProject(
      item,
      "main.swift",
      "swift",
      [descriptor({ standaloneWorkspaceRoot: true })]
    );
    expect(standalone.relativeProjectRoot).toBe("");
    expect(standalone).not.toHaveProperty("marker");
  });

  it("refuses equal-ranked descriptors instead of choosing by registry order", async () => {
    const item = await workspace();
    await writeFile(join(item.path, "Package.swift"), "package");
    await source(item.path, "main.swift");
    await expect(resolveLanguageServiceProject(item, "main.swift", "swift", [
      descriptor({ id: "one" }),
      descriptor({ id: "two" })
    ])).rejects.toMatchObject({ code: "ambiguous_project" } satisfies Partial<LanguageServiceError>);
  });
});
