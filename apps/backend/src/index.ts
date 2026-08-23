import { buildServer } from "./server";
import { getServiceConfig } from "./config/serviceConfig";
import { writeRunnerCatalogFile } from "./config/runnerCatalogFile";
import { logger } from "./logging/logger";

async function main(): Promise<void> {
  const config = getServiceConfig();
  const { app } = await buildServer({ config });
  await app.listen({ host: config.host, port: config.port });
  // Leave the macOS app a catalog of the runners this process registers, so its
  // settings panes can offer them while the backend is stopped — which is
  // exactly when they cannot ask. Published after a successful listen, because a
  // backend that could not start has nothing to advertise. Best effort.
  await writeRunnerCatalogFile(config);
  logger.info(
    { host: config.host, port: config.port, runnerKind: config.runnerKind, mode: "agent-bridge" },
    "AgentRoom backend listening"
  );
}

main().catch((error) => {
  logger.error({ error }, "AgentRoom backend failed to start");
  process.exitCode = 1;
});
