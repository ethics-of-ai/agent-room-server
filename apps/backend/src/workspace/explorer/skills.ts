import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkspaceSkill } from "../../domain/models";
import type { RunnerDescriptor } from "../../runner/registry";
import { readFileHead } from "./filePreview";
import { safeRealpath } from "./paths";

// The fixed committed skill directories a runner kind natively loads, and the
// token a composer inserts to invoke one, are registry descriptor fields
// (`runner/registry.ts`) rather than per-kind records here — this listing is
// discovery metadata for composer autocompletion, never a loading mechanism of
// its own, so it must describe whatever the runner itself would load.
const maxSkills = 50;
// Only frontmatter is needed; a SKILL.md whose frontmatter has not closed
// within this head is treated as having none rather than read further.
const maxSkillFileHeadBytes = 16 * 1024;
const maxSkillDescriptionChars = 200;
// Composer-safe skill names only: a name outside this set could not round-trip
// through the slash/mention token the clients insert.
const skillNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The descriptor fields this scan reads — never which runner supplied them. */
export type SkillSourceDescriptor = Pick<RunnerDescriptor, "skillSourceDirs" | "skillInvocationPrefix">;

/**
 * Bounded, read-only discovery of the skills a runner kind would natively load
 * from a registered workspace, for the clients' composer slash picker. Scans
 * only the fixed committed skill directories, follows the tree read's symlink
 * containment (an escaping link is skipped, not an error), and reads only each
 * SKILL.md's frontmatter head — name and description, never body content.
 * Purely informational: it loads nothing and emits no events or audit entries.
 */
export async function listWorkspaceSkills(
  workspaceRoot: string,
  descriptor: SkillSourceDescriptor
): Promise<WorkspaceSkill[]> {
  const skills: WorkspaceSkill[] = [];
  const seenNames = new Set<string>();
  for (const sourceDir of descriptor.skillSourceDirs) {
    if (skills.length >= maxSkills) break;
    const sourcePath = await safeRealpath(workspaceRoot, resolve(workspaceRoot, sourceDir));
    if (!sourcePath) continue;
    let dirents;
    try {
      dirents = await readdir(sourcePath, { withFileTypes: true });
    } catch {
      continue; // absent or unreadable skills dir is an ordinary "no skills" state
    }
    for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
      if (skills.length >= maxSkills) break;
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      const skillDirPath = await safeRealpath(workspaceRoot, join(sourcePath, dirent.name));
      if (!skillDirPath) continue;
      const skillFilePath = await safeRealpath(workspaceRoot, join(skillDirPath, "SKILL.md"));
      if (!skillFilePath) continue;
      const head = await readSkillFileHead(skillFilePath);
      if (head === undefined) continue;
      const frontmatter = parseSkillFrontmatter(head);
      const name = resolveSkillName(frontmatter.name, dirent.name);
      if (!name || seenNames.has(name.toLowerCase())) continue;
      seenNames.add(name.toLowerCase());
      skills.push({
        name,
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
        invocation: `${descriptor.skillInvocationPrefix}${name}`,
        source: sourceDir
      });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

// Bounded head read of a SKILL.md: only enough bytes for frontmatter, UTF-8
// text only (a NUL byte means "not a skill file", mirroring the preview
// contract). Returns undefined for a missing, non-file, or binary target.
async function readSkillFileHead(targetPath: string): Promise<string | undefined> {
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch {
    return undefined;
  }
  if (!fileStat.isFile()) return undefined;
  const head = await readFileHead(targetPath, Math.min(fileStat.size, maxSkillFileHeadBytes));
  if (head.includes(0)) return undefined;
  return head.toString("utf8");
}

// Extracts only `name` and `description` strings from a leading YAML
// frontmatter block. Anything malformed degrades to "no frontmatter" (the
// directory name still identifies the skill) rather than an error, since the
// file is workspace-authored content.
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const description =
    typeof record.description === "string"
      ? record.description.replace(/\s+/g, " ").trim().slice(0, maxSkillDescriptionChars)
      : undefined;
  return {
    ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    ...(description ? { description } : {})
  };
}

// Frontmatter name wins when composer-safe; otherwise the directory name; a
// skill with no safe name is skipped because its invocation token could not be
// typed or parsed back out of the composer.
function resolveSkillName(frontmatterName: string | undefined, directoryName: string): string | undefined {
  for (const candidate of [frontmatterName, directoryName]) {
    if (candidate && skillNamePattern.test(candidate)) return candidate;
  }
  return undefined;
}
