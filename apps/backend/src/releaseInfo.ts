import type { ReleaseCompatibility } from "./domain/models";

export const releaseCompatibility: ReleaseCompatibility = {
  // The release version, maintained by release-please. The minimumVersion
  // fields below are a different question, which client this backend still
  // talks to, so they are deliberately not annotated and do not move with it.
  backendVersion: "0.3.1", // x-release-please-version
  apiVersion: "2026-05-12",
  minimumSupportedClientApiVersion: "2026-05-12",
  compatibleClients: {
    macos: {
      minimumVersion: "0.1.0"
    },
    visionos: {
      minimumVersion: "0.1.0"
    }
  }
};
