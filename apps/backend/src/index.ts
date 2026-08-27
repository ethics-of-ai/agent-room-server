import { buildServer } from "./server";
import { getServiceConfig } from "./config/serviceConfig";
import { writeRunnerCatalogFile } from "./config/runnerCatalogFile";
import { booleanEnv } from "./config/env";
import { startParentExitWatchdog } from "./util/parentExitWatchdog";
import { installShutdownHandlers } from "./util/shutdown";
import { logger } from "./logging/logger";

async function main(): Promise<void> {
  armParentExitWatchdog();
  const config = getServiceConfig();
  const { app } = await buildServer({ config });
  // Installed once the server exists and before it listens, so the SIGINT the
  // macOS app sends on quit runs the close hooks (runner children SIGTERMed,
  // terminals killed, the session store flushed) instead of Node's default
  // immediate exit. See `util/shutdown.ts` for the ceiling.
  installShutdownHandlers({ close: () => app.close() });
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

/**
 * Configures the process rather than the service, so it is read here rather
 * than carried on `ServiceConfig`: no route, client, or runner has anything to
 * ask about it. It is env-only for the same reason every other execution-tier
 * value is — the settings file cannot decide the lifetime of the process that
 * reads it. See `util/parentExitWatchdog.ts`.
 */
function armParentExitWatchdog(): void {
  if (!booleanEnv("AGENTROOM_EXIT_WITH_PARENT", false)) {
    return;
  }
  const configuredParentPid = Number(process.env.AGENTROOM_PARENT_PID);
  const parentPid =
    Number.isSafeInteger(configuredParentPid) && configuredParentPid > 1
      ? configuredParentPid
      : process.ppid;
  const stop = startParentExitWatchdog({
    parentPid,
    onOrphaned: () => {
      // Exit 0: the supervisor asked for this by launching us with the flag, so
      // it is a clean stop rather than a crash to restart from. Abrupt on
      // purpose, matching the SIGINT the macOS app sends when it quits
      // normally — there is no longer anyone waiting on a graceful drain.
      logger.warn({ parentPid }, "Launching process exited; stopping AgentRoom backend");
      process.exit(0);
    }
  });
  if (!stop) {
    logger.info(
      { parentPid },
      "AGENTROOM_EXIT_WITH_PARENT is set but this process has no parent to watch"
    );
  }
}

main().catch((error) => {
  logger.error({ error }, "AgentRoom backend failed to start");
  process.exitCode = 1;
});
