import { z } from "zod";
import { maxFileIndexResults, maxSearchMatches, maxWriteBytes } from "../workspace/WorkspaceExplorer";
import { maxCommitMessageChars } from "../workspace/LocalWorkspaceGit";
import { agentRunnerKindSchema } from "./schemas";

// Every workspace request is validated here before it reaches the explorer or
// the git service, so the bounds a route advertises and the bounds the backend
// enforces are stated once. The explorer applies its own path bounding on top:
// these schemas bound shape and size, never containment.

export const registerWorkspacePayloadSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  kind: z.enum(["managed_throwaway", "user_selected"]).optional()
});

export const workspaceParamsSchema = z.object({
  workspaceId: z.string().trim().min(1)
});

export const treeQuerySchema = z.object({
  path: z.string().optional(),
  depth: z.coerce.number().int().min(0).max(4).optional()
});

export const filePreviewQuerySchema = z.object({
  path: z.string().trim().min(1),
  // Optional override that lets an editor load a file up to the write cap. The read
  // path otherwise truncates at the 24 KB browse-preview default, which forces any
  // larger file read-only in the client. Bounded to the same `maxWriteBytes` the
  // write route enforces, so a load can never request more than a save can persist.
  maxBytes: z.coerce.number().int().min(1).max(maxWriteBytes).optional()
});

export const gitFileBaselineQuerySchema = z.object({
  path: z.string().trim().min(1),
  // Same cap contract as `filePreviewQuerySchema`; the default is the full write
  // cap because a baseline is only useful whole for diffing editable files.
  maxBytes: z.coerce.number().int().min(1).max(maxWriteBytes).optional()
});

const maxSearchQueryChars = 200;

// Query-string booleans arrive as text; `z.coerce.boolean()` would read "false"
// as true (any non-empty string is truthy), so accept only explicit tokens.
const booleanFlagSchema = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

export const fileIndexQuerySchema = z.object({
  query: z.string().trim().max(maxSearchQueryChars).optional(),
  limit: z.coerce.number().int().min(1).max(maxFileIndexResults).optional()
});

export const searchQuerySchema = z.object({
  // Literal substring only — no regex in v1 (a caller-supplied pattern would be
  // an in-process ReDoS vector). See docs/safety/TRUST_AND_SAFETY.md.
  query: z.string().trim().min(1).max(maxSearchQueryChars),
  matchCase: booleanFlagSchema.optional(),
  wholeWord: booleanFlagSchema.optional(),
  include: z.string().trim().max(maxSearchQueryChars).optional(),
  // `limit` bounds total matches returned, not files scanned.
  limit: z.coerce.number().int().min(1).max(maxSearchMatches).optional()
});

export const skillsQuerySchema = z.object({
  // Registry-derived, so a registered runner is accepted here without editing
  // this route (docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md, Phase 3).
  runnerKind: agentRunnerKindSchema.optional()
});

const branchNameSchema = z.string().trim().min(1).max(240);

export const switchBranchPayloadSchema = z.object({
  branch: branchNameSchema
});

export const createBranchPayloadSchema = z.object({
  branch: branchNameSchema
});

// Path lists are bounded so one request cannot ask the backend to fork git over
// an unbounded argv; `all` is the supported way to act on a whole dirty tree.
export const gitPathsPayloadSchema = z.object({
  paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(500).optional(),
  all: z.boolean().optional()
});

export const gitDiscardPayloadSchema = z.object({
  // Discard is irreversible, so it has no `all`: a client names every path it
  // means to destroy.
  paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(500)
});

export const gitCommitPayloadSchema = z.object({
  message: z.string().trim().min(1).max(maxCommitMessageChars),
  stageAll: z.boolean().optional()
});

export const gitPushPayloadSchema = z
  .object({
    setUpstream: z.boolean().optional()
  })
  .optional();

export const writeFilePayloadSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  // Cap the UTF-8 byte length, not the JS string length: `.max()` would count
  // UTF-16 code units, letting multibyte content land ~3x over the documented cap.
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maxWriteBytes, {
    message: "Workspace file content exceeds the maximum size"
  }),
  baseModifiedAt: z.string().trim().min(1).optional()
});

export const deleteEntryPayloadSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  baseModifiedAt: z.string().trim().min(1)
});

// Creating a directory is the one mutation with no `baseModifiedAt`: nothing is
// being replaced, so there is no prior version to prove the caller had seen.
// The explorer refuses an occupied name rather than adopting someone else's
// folder, which is what makes a token unnecessary rather than merely omitted.
export const createDirectoryPayloadSchema = z.object({
  path: z.string().trim().min(1).max(1024)
});

// One leaf name: the shared shape behind rename's required `newName` and the
// optional one move and copy take when a paste is also a rename.
const entryLeafNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 255, {
    message: "Workspace entry name exceeds the maximum size"
  });

export const renameEntryPayloadSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  newName: entryLeafNameSchema,
  baseModifiedAt: z.string().trim().min(1)
});

// `destinationParent` is required but may be empty: "" is the workspace root,
// which is a real paste target and the one destination that always exists.
// Omitting `newName` means "keep the entry's own name", which is what a plain
// paste into another folder does.
export const moveEntryPayloadSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  destinationParent: z.string().trim().max(1024),
  newName: entryLeafNameSchema.optional(),
  baseModifiedAt: z.string().trim().min(1)
});

export const copyEntryPayloadSchema = moveEntryPayloadSchema.extend({
  onCollision: z.enum(["fail", "keep_both"]).optional()
});
