import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the public mirror (docs/operations/OPEN_SOURCE_MIRROR.md): what the
 * manifest admits and refuses, that the overlay the public repository depends
 * on is complete, and that no overlay document links to a file the public
 * tree will not hold. Links from mirrored shared documents to the stripped
 * visionOS documents are expected and are not checked here.
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
  "AGENTS.md",
  "CLAUDE.md",
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
      "scripts/install-macos.mjs",
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
      "docs/clients/VISIONOS.md",
      "docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md",
      "docs/engineering/VISIONOS_PROFILE_SELECTION.md",
      "docs/reference/apple-wwdc2023-spatial-video-manifest.json",
      "docs/diagrams/phase1-check.diagram.json",
      "docs/README.md",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      ".env",
      ".agentroom/state/audit.jsonl",
      "mirror/manifest.json",
      ".github/workflows/mirror.yml",
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
    expect(matchesGlob("docs/diagrams/phase1-check.diagram.json", "docs/diagrams/*-check.diagram.json")).toBe(true);
    expect(matchesGlob("docs/diagrams/agentroom.diagram.json", "docs/diagrams/*-check.diagram.json")).toBe(false);
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
    expect(readFileSync(resolve(overlayRoot, "LICENSE"), "utf8").startsWith("MIT License")).toBe(true);
  });

  it("keeps every relative link in the overlay resolvable inside the public tree", async () => {
    const { readManifest, publicPathAdmitted } = await loadScript();
    const manifest = readManifest();
    const overlayFiles = new Set(walk(overlayRoot));
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

    for (const file of overlayFiles) {
      if (!file.endsWith(".md")) continue;
      const source = readFileSync(resolve(overlayRoot, file), "utf8");
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

  it("keeps the docs index and the agent guidance pointing at the mirror", () => {
    expect(readFileSync(resolve(repoRoot, "docs/README.md"), "utf8")).toContain("operations/OPEN_SOURCE_MIRROR.md");
    expect(readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8")).toContain("mirror/manifest.json");
    expect(readFileSync(resolve(repoRoot, "CLAUDE.md"), "utf8")).toContain("mirror/manifest.json");
  });
});
