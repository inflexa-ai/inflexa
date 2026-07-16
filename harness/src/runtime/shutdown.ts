/**
 * Graceful-shutdown sequence.
 *
 * The order is load-bearing for durability:
 *
 *   1. Flip readiness to NOT_READY (so the LB stops sending new traffic).
 *   2. Drain in-flight HTTP (close the listener, await pending requests).
 *   3. `DBOS.shutdown()` — marks in-flight workflows recoverable.
 *      Must run AFTER HTTP drains (so no inbound request is orphaned)
 *      and BEFORE the application pool closes (DBOS needs the system DB,
 *      though it owns its own pool, the app close happens after).
 *   4. Close the application `pg.Pool`.
 *   5. Flush log + OTel exporters.
 *   6. `process.exit(0)`.
 *
 * Each side effect is injected so the sequence can be tested in isolation
 * (no real server, no real DBOS). Errors at any step are logged and
 * swallowed — once shutdown has started, exiting takes precedence over
 * any single step's failure.
 */

import type { Logger } from "../lib/logger.js";

export interface ShutdownDeps {
    signal: string;
    logger: Logger;
    markDraining: () => void;
    closeHttpServer: () => Promise<void>;
    shutdownDbos: () => Promise<void>;
    closePool: () => Promise<void>;
    flushLogger: () => Promise<void>;
    shutdownOtel: () => Promise<void>;
    exit: (code: number) => void;
}

async function safely(logger: Logger, step: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        logger.error(`${step} failed`, { ...logger.errorFields(err), step });
    }
}

export async function runShutdownSequence(deps: ShutdownDeps): Promise<void> {
    const { signal } = deps;
    const logger = deps.logger.named("shutdown");
    logger.info("requested", { signal });
    deps.markDraining();

    await safely(logger, "http-drain", deps.closeHttpServer);
    await safely(logger, "dbos-shutdown", deps.shutdownDbos);
    await safely(logger, "pool-close", deps.closePool);
    await safely(logger, "otel-flush", deps.shutdownOtel);
    await safely(logger, "logger-flush", deps.flushLogger);

    deps.exit(0);
}
