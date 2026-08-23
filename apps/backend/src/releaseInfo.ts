import type { ReleaseCompatibility } from "./domain/models";

export const releaseCompatibility: ReleaseCompatibility = {
  backendVersion: "0.1.0",
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
