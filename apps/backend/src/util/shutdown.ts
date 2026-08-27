import { logger } from "../logging/logger";

/**
 * Close the server when the process is asked to stop.
 *
 * Node's default disposition for SIGINT and SIGTERM ends the process at once,
 * so without this the `onClose` hooks the server registers — runner
 * `dispose()` (which SIGTERMs every resident child), terminal `disposeAll`,
 * the diagram trackers, and the durable session store's flush — never run on
 * the SIGINT the macOS app sends when it quits. Persistence does not depend on
 * this (the session store is write-through), but orphaned children do.
 *
 * The close runs under a ceiling. The macOS supervisor sends SIGINT, waits
 * three seconds, then SIGTERM; two seconds sits inside that window so the
 * escalation stays the backstop it was meant to be rather than the normal
 * path. A second signal during the close exits at once. Exit is `0` in every
 * case: the stop was asked for, so it is a clean stop rather than a crash to
 * restart from, even when the ceiling had to end it.
 *
 * The parent-exit watchdog keeps its own abrupt `process.exit(0)`: nobody is
 * waiting on a drain there, and write-through is what makes that safe.
 */
export interface ShutdownHandlerOptions {
  /** `app.close()`, or whatever runs the server's close hooks. */
  readonly close: () => Promise<void>;
  /** How long the close may take before the process exits anyway. */
  readonly ceilingMs?: number;
  readonly signals?: readonly NodeJS.Signals[];
  /** Injected for tests; defaults to `process`. */
  readonly target?: ShutdownSignalTarget;
  /** Injected for tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

export interface ShutdownSignalTarget {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export const DEFAULT_SHUTDOWN_CEILING_MS = 2_000;
export const DEFAULT_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** Installs the handlers and returns a function that removes them. */
export function installShutdownHandlers(options: ShutdownHandlerOptions): () => void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const ceilingMs = options.ceilingMs ?? DEFAULT_SHUTDOWN_CEILING_MS;
  const signals = options.signals ?? DEFAULT_SHUTDOWN_SIGNALS;
  let closing = false;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (closing) {
      logger.warn({ signal }, "Second stop signal received while closing; exiting now");
      exitOnce(0);
      return;
    }
    closing = true;
    logger.info({ signal, ceilingMs }, "Stop signal received; closing AgentRoom backend");
    const startedAtMs = Date.now();
    const ceiling = setTimeout(() => {
      logger.warn({ signal, ceilingMs }, "Close did not finish inside the ceiling; exiting now");
      exitOnce(0);
    }, ceilingMs);
    ceiling.unref?.();
    void options.close().then(
      () => {
        logger.info({ signal, durationMs: Date.now() - startedAtMs }, "AgentRoom backend closed");
      },
      (error: unknown) => {
        logger.warn(
          { signal, error: error instanceof Error ? error.message : String(error) },
          "Close failed; exiting anyway"
        );
      }
    ).finally(() => {
      clearTimeout(ceiling);
      exitOnce(0);
    });
  };

  for (const signal of signals) target.on(signal, onSignal);
  return () => {
    for (const signal of signals) target.off(signal, onSignal);
  };
}
