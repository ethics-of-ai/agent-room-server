import { z } from "zod";

export const semanticVersionSchema = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  "must be a semantic version"
);

const apiRevisionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an API revision date");

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  backendVersion: semanticVersionSchema,
  apiVersion: apiRevisionSchema,
  minimumSupportedClientApiVersion: apiRevisionSchema,
  compatibleClients: z.object({
    macos: z.object({ minimumVersion: semanticVersionSchema }).strict(),
    visionos: z.object({ minimumVersion: semanticVersionSchema }).strict()
  }).strict(),
  macArtifact: z.object({
    name: z.string().min(1),
    architecture: z.literal("arm64")
  }).strict()
}).strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const releaseManifestInputSchema = z.object({
  releaseTag: z.string().regex(
    /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    "must be a v-prefixed semantic version"
  ),
  dmgName: z.string().min(1),
  architecture: z.literal("arm64")
}).strict();
