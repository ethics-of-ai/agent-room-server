import { z } from "zod";

export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const branchRefSchema = z.string().min(1).max(1024).refine(
  (value) => value === "HEAD" || /^refs\/(heads|remotes)\//.test(value)
);
export const gitHistoryQuerySchema = z.object({
  branch: branchRefSchema.optional(),
  compare: branchRefSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
}).strict();
export const gitCommitQuerySchema = z.object({ commit: gitObjectIdSchema }).strict();
export const gitCommitFileQuerySchema = gitCommitQuerySchema.extend({ path: z.string().min(1).max(4096) }).strict();

export interface WorkspaceGitRef {
  id: string;
  name: string;
  commit: string;
  current: boolean;
  kind: "local" | "remote" | "head";
}
export interface WorkspaceGitCommit {
  id: string;
  parents: string[];
  subject: string;
  author: string;
  committedAt: string;
}
export interface WorkspaceGitComparison {
  mergeBases: string[];
  leftOnly: string[];
  rightOnly: string[];
  truncated: boolean;
}
export interface WorkspaceGitHistory {
  workspaceId: string;
  isRepository: boolean;
  head?: string;
  selectedRef?: string;
  comparisonRef?: string;
  upstreamRef?: string;
  refs: WorkspaceGitRef[];
  refsTruncated: boolean;
  commits: WorkspaceGitCommit[];
  truncated: boolean;
  shallow: boolean;
  comparison?: WorkspaceGitComparison;
  refreshedAt: string;
}
export interface WorkspaceGitCommitFile {
  path: string;
  status: string;
  previewable: boolean;
}
export interface WorkspaceGitCommitDetail {
  workspaceId: string;
  commit: WorkspaceGitCommit;
  parent?: string;
  files: WorkspaceGitCommitFile[];
  truncated: boolean;
  filtered: boolean;
}
export interface WorkspaceGitCommitDiff {
  workspaceId: string;
  commit: string;
  parent?: string;
  path: string;
  before: string;
  after: string;
}
