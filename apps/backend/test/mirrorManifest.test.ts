import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the public mirror (docs/operations/OPEN_SOURCE_MIRROR.md): what the
 * manifest admits and refuses, that the overlay the public repository depends
 * on is complete, and that published documentation links only to files the
 * public tree holds. Private references can remain plain text when needed.
 */

const repoRoot = resolve(__dirname, "../../..");
const overlayRoot = resolve(repoRoot, "mirror/overlay");
// The manifest and overlay live only in the private repository; the public
// tree this suite describes does not publish anything, so there it skips.
const mirrorPresent = existsSync(resolve(repoRoot, "mirror/manifest.json"));

const requiredOverlayFiles = [
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/README.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml"
];

async function loadScript() {
  return import(pathToFileURL(resolve(repoRoot, "scripts/mirror-public.mjs")).href);
}

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else found.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return found.sort();
}

function markdownLinkTargets(source: string): string[] {
  return [...source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
}

describe.skipIf(!mirrorPresent)("public mirror manifest", () => {
  it("names the public repository and keeps the visionOS tree and secrets out", async () => {
    const { readManifest } = await loadScript();
    const manifest = readManifest();

    expect(manifest.repository).toBe("ethics-of-ai/agent-room-server");
    expect(manifest.branch).toBe("main");
    expect(manifest.overlay).toBe("mirror/overlay");
    for (const path of manifest.include as string[]) {
      expect(path.startsWith("apps/visionos"), `${path} must not be included`).toBe(false);
      expect(existsSync(resolve(repoRoot, path)), `${path} does not exist`).toBe(true);
    }
    expect(manifest.exclude).toEqual(
      expect.arrayContaining([
        "docs/README.md",
        "docs/reference/**",
        "docs/clients/VISIONOS.md",
        "docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md",
        "docs/engineering/VISIONOS_LANGUAGE_INTELLIGENCE.md",
        "docs/engineering/VISIONOS_LANGUAGE_DEPENDENCY_UPDATES.md",
        "docs/engineering/VISIONOS_PROFILE_SELECTION.md"
      ])
    );
    expect(manifest.deny).toEqual(
      expect.arrayContaining([".env", ".env.*", "!.env.example", "*.p12", "*.pem", "*.mobileprovision", ".agentroom/**", "apps/visionos/**"])
    );
    expect(manifest.commit.authorEmail).toContain("users.noreply.github.com");
  });

  it("admits the paths the public tree needs and refuses the ones it must not", async () => {
    const { readManifest, publicPathAdmitted, isDenied } = await loadScript();
    const manifest = readManifest();

    for (const path of [
      "apps/backend/src/server.ts",
      "apps/backend/test/mirrorManifest.test.ts",
      "apps/macos/project.yml",
      "apps/shared/AgentRoomClient/Package.swift",
      "scripts/package-macos.mjs",
      "scripts/macos-sparkle.mjs",
      "scripts/macos-distribution-security.mjs",
      "scripts/verify-sparkle-key-pair.mjs",
      "scripts/install-macos.mjs",
      "scripts/generate-release-manifest.mjs",
      "scripts/codesign/node-runtime.entitlements",
      "docs/operations/OPEN_SOURCE_MIRROR.md",
      "docs/operations/LOCAL_MAC_SERVER.md",
      "docs/safety/TRUST_AND_SAFETY.md",
      "docs/engineering/SWIFTUI_STANDARDS.md",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".env.example",
      ".gitignore"
    ]) {
      expect(publicPathAdmitted(path, manifest), `${path} should be public`).toBe(true);
    }
    for (const path of [
      "apps/visionos/project.yml",
      "apps/visionos/AgentRoom/Resources/Monaco/vs/editor.api.js",
      // The release-credential wizard drives this operator's own Apple team
      // and GitHub org. It is operator tooling, not part of the product a
      // reader of the public repository builds.
      "scripts/setup-release-credentials.sh",
      "docs/clients/VISIONOS.md",
      "docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md",
      "docs/engineering/VISIONOS_LANGUAGE_INTELLIGENCE.md",
      "docs/engineering/VISIONOS_LANGUAGE_DEPENDENCY_UPDATES.md",
      "docs/engineering/VISIONOS_PROFILE_SELECTION.md",
      // The grammar importer writes into the visionOS tree the mirror denies,
      // and its test scaffolds that tree; both stay with the private checkout.
      "apps/backend/scripts/import-editor-grammars.mjs",
      "apps/backend/scripts/editor-grammar-sources.json",
      "apps/backend/test/importEditorGrammars.test.ts",
      "docs/reference/apple-wwdc2023-spatial-video-manifest.json",
      "docs/README.md",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      ".env",
      ".agentroom/state/audit.jsonl",
      "mirror/manifest.json",
      ".github/workflows/mirror.yml",
      ".github/workflows/release-candidate.yml",
      ".github/workflows/release-please.yml",
      // Versioning automation runs against the private repository alone. The
      // changelog stays with it too: its entries link to private pull
      // requests, which would be dead links for a public reader.
      "release-please-config.json",
      ".release-please-manifest.json",
      "CHANGELOG.md",
      ".agents/skills/unslop/SKILL.md",
      "skills-lock.json"
    ]) {
      expect(publicPathAdmitted(path, manifest), `${path} must not be public`).toBe(false);
    }

    expect(isDenied(".env", manifest)).toBe(true);
    expect(isDenied(".env.example", manifest)).toBe(false);
    expect(isDenied("apps/backend/.env.local", manifest)).toBe(true);
    expect(isDenied("certs/developer-id.p12", manifest)).toBe(true);
    expect(isDenied("apps/backend/src/index.ts", manifest)).toBe(false);
  });

  it("matches globs the way the manifest uses them", async () => {
    const { globToRegExp, matchesGlob } = await loadScript();

    expect(globToRegExp("docs/reference/**").test("docs/reference/a.json")).toBe(true);
    expect(globToRegExp("docs/reference/**").test("docs/reference/x/y.json")).toBe(true);
    expect(globToRegExp("docs/reference/**").test("docs/referenced.md")).toBe(false);
    expect(matchesGlob("deep/inside/secret.p12", "*.p12")).toBe(true);
    expect(matchesGlob(".env.local", ".env.*")).toBe(true);
    expect(matchesGlob("apps/visionos/project.yml", "apps/visionos/**")).toBe(true);
    expect(matchesGlob("apps/visionos-notes.md", "apps/visionos/**")).toBe(false);
  });

  it("ships every overlay file the public repository depends on", () => {
    const files = walk(overlayRoot);
    for (const required of requiredOverlayFiles) {
      expect(files, `${required} is missing from mirror/overlay`).toContain(required);
    }
    // The public tree carries no agent guidance file. Its docs are the rules,
    // while the private AGENTS.md and CLAUDE.md stay in the source repository.
    expect(files).not.toContain("AGENTS.md");
    expect(files).not.toContain("CLAUDE.md");
    expect(readFileSync(resolve(overlayRoot, "LICENSE"), "utf8").startsWith("MIT License")).toBe(true);
  });

  it("keeps relative links in overlay and shared documentation inside the public tree", async () => {
    const { readManifest, publicPathAdmitted } = await loadScript();
    const manifest = readManifest();
    const overlayFiles = new Set(walk(overlayRoot));
    const documents = new Map(
      [...overlayFiles].filter((file) => file.endsWith(".md"))
        .map((file) => [file, resolve(overlayRoot, file)])
    );
    for (const file of walk(resolve(repoRoot, "docs"))) {
      const path = `docs/${file}`;
      if (file.endsWith(".md") && !overlayFiles.has(path) && publicPathAdmitted(path, manifest)) {
        documents.set(path, resolve(repoRoot, path));
      }
    }
    const dangling: string[] = [];

    const resolvesInPublicTree = (target: string, fromFile: string): boolean => {
      const clean = target.replace(/[#?].*$/, "");
      if (clean === "") return true;
      const base = clean.startsWith("/") ? clean.slice(1) : posix.join(posix.dirname(fromFile), clean);
      const normalized = posix.normalize(base).replace(/\/$/, "");
      if (normalized.startsWith("../") || normalized === "..") return false;
      if (overlayFiles.has(normalized)) return true;
      if ([...overlayFiles].some((file) => file.startsWith(`${normalized}/`))) return true;
      return existsSync(resolve(repoRoot, normalized)) && publicPathAdmitted(normalized, manifest);
    };

    for (const [file, sourcePath] of documents) {
      const source = readFileSync(sourcePath, "utf8");
      for (const target of markdownLinkTargets(source)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (!resolvesInPublicTree(target, file)) dangling.push(`${file} -> ${target}`);
      }
    }

    expect(dangling).toEqual([]);
  });

  it("builds a sync commit message with the source trailer", async () => {
    const { buildCommitMessage } = await loadScript();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const message: string = buildCommitMessage({
      subjectPrefix: "Sync agent-room@",
      sourceSha: sha,
      sourceSubjects: ["abc1234 feat: one", "def5678 fix: two"]
    });

    expect(message.split("\n")[0]).toBe("Sync agent-room@0123456789ab");
    expect(message).toContain("- abc1234 feat: one");
    expect(message.trimEnd().endsWith(`Source-Commit: ${sha}`)).toBe(true);
  });

  it("keeps the docs index and shared agent guidance pointing at the mirror", () => {
    expect(readFileSync(resolve(repoRoot, "docs/README.md"), "utf8")).toContain("operations/OPEN_SOURCE_MIRROR.md");
    const sharedGuidance = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
    const claudeGuidance = readFileSync(resolve(repoRoot, "CLAUDE.md"), "utf8");
    expect(sharedGuidance).toContain("mirror/manifest.json");
    expect(claudeGuidance).toContain("AGENTS.md");
  });
});
