import { releaseCompatibility } from "./releaseInfo";
import {
  releaseManifestInputSchema,
  releaseManifestSchema,
  type ReleaseManifest
} from "./domain/releaseManifest";

export { releaseManifestSchema, type ReleaseManifest } from "./domain/releaseManifest";

/**
 * Builds the public release manifest from `/health`'s compatibility source of
 * truth and release-workflow-owned artifact facts. Every cross-source mismatch
 * fails before anything is published.
 */
export function buildReleaseManifest(input: {
  releaseTag: string;
  dmgName: string;
  architecture: "arm64";
}): ReleaseManifest {
  const parsedInput = releaseManifestInputSchema.parse(input);
  const releaseVersion = parsedInput.releaseTag.slice(1);
  const releaseMarketingVersion = releaseVersion.split("-", 1)[0];
  if (releaseMarketingVersion !== releaseCompatibility.backendVersion) {
    throw new Error(
      `release tag ${parsedInput.releaseTag} does not match backend v${releaseCompatibility.backendVersion}`
    );
  }

  const expectedDMGName = `AgentRoom-${releaseVersion}-${parsedInput.architecture}.dmg`;
  if (parsedInput.dmgName !== expectedDMGName) {
    throw new Error(`DMG ${parsedInput.dmgName} does not match expected ${expectedDMGName}`);
  }

  return releaseManifestSchema.parse({
    schemaVersion: 1,
    ...releaseCompatibility,
    macArtifact: {
      name: parsedInput.dmgName,
      architecture: parsedInput.architecture
    }
  });
}
