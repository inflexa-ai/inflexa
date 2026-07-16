/**
 * Notification-cleanup sweep — clears unconsumed `dbos.notifications`
 * rows whose owning workflow has reached a terminal status (SUCCESS,
 * ERROR, CANCELLED).
 *
 * Background: a `DBOS.send` to an already-completed workflow accumulates
 * forever as `consumed=f`. The watchdog's
 * synthetic-failure send guarantees this happens at the protocol level —
 * a real `complete` may arrive microseconds before the watchdog and the
 * loser becomes a stuck notification.
 *
 * Cadence is separate from the liveness watchdog (~5 minutes vs ~1
 * minute). Bounded delete batch keeps the lock window short.
 *
 * Production reads the DBOS system DB via the app pool (DBOS by default
 * shares the database, only the pool is separate). The query function is
 * injectable so tests can drive the sweep against a stub.
 */

import type { Pool } from "pg";
import { DBOS } from "@dbos-inc/dbos-sdk";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";

const SWEEP_CRON = "0 */5 * * * *";
const DELETE_BATCH_LIMIT = 10_000;

export interface SweepDeps {
    /**
     * Execute the bounded DELETE. Returns the row count cleared. Injected
     * for tests; production wires the app pool.
     */
    deleteStale: (limit: number) => Promise<number>;
    logger?: Logger;
}

export async function sweepStaleNotifications(deps: SweepDeps): Promise<number> {
    const logger = (deps.logger ?? createNoopLogger()).named("notification-sweep");
    try {
        const cleared = await deps.deleteStale(DELETE_BATCH_LIMIT);
        logger.info("cleared stale notifications", { rowsCleared: cleared });
        return cleared;
    } catch (err) {
        logger.error("sweep failed", logger.errorFields(err));
        throw err;
    }
}

/**
 * Default `deleteStale` for production — issues the bounded DELETE
 * against the shared application pool, which DBOS by default connects
 * to. The CTE form keeps the join + the LIMIT in one statement.
 */
export function makeDefaultDeleteStale(pool: Pool) {
    return async (limit: number): Promise<number> => {
        const result = await pool.query<{ rowcount: number }>({
            text: `WITH stale AS (
              SELECT destination_uuid, topic, message
              FROM dbos.notifications n
              WHERE n.consumed = false
                AND EXISTS (
                  SELECT 1 FROM dbos.workflow_status w
                  WHERE w.workflow_uuid = n.destination_uuid
                    AND w.status IN ('SUCCESS','ERROR','CANCELLED')
                )
              LIMIT $1
            )
            DELETE FROM dbos.notifications n
            USING stale s
            WHERE n.destination_uuid = s.destination_uuid
              AND n.topic = s.topic
              AND n.message = s.message`,
            values: [limit],
        });
        return result.rowCount ?? 0;
    };
}

export interface RegisterNotificationSweepDeps {
    pool: Pool;
    logger?: Logger;
    /** Override the DELETE driver — production defaults to the app pool. */
    deleteStale?: (limit: number) => Promise<number>;
}

export function registerNotificationSweep(deps: RegisterNotificationSweepDeps): void {
    const deleteStale = deps.deleteStale ?? makeDefaultDeleteStale(deps.pool);
    // The scheduled target must itself be a registered workflow — DBOS's
    // scheduler loop skips (and errors on) any `@scheduled` function that lacks
    // a workflow registration. Register, then schedule the same callable.
    const sweep = DBOS.registerWorkflow(
        async () => {
            await sweepStaleNotifications({ deleteStale, logger: deps.logger });
        },
        { name: "dbos-notifications-sweep" },
    );
    DBOS.registerScheduled(sweep, {
        name: "dbos-notifications-sweep",
        crontab: SWEEP_CRON,
    });
}
