/**
 * Per-pod Postgres pool sizing and acquisition bounds — the single source of
 * truth.
 *
 * Cortex runs two pools per pod against the same cluster (see the postgres-storage-backend spec): the
 * application pool (`lib/storage.ts::createPool()`) and the DBOS system-DB
 * pool (`runtime/dbos.ts`). Both numbers live here so the value DBOS is
 * configured with and the value the boot-time guard reasons about can never
 * drift apart.
 *
 * Fleet-level capacity (how many replicas the cluster can hold) is NOT a
 * per-pod concern and is deliberately absent here — it belongs to the
 * database (`max_connections` sizing) or a connection pooler. See
 * `runtime/connection-budget.ts`.
 */

/** DBOS system-DB pool size; passed verbatim to `DBOS.setConfig`. */
export const DBOS_SYSTEM_POOL_SIZE = 10;

/** Application pool size when `DB_POOL_MAX` is unset. */
export const DEFAULT_APP_POOL_SIZE = 12;

/**
 * Connections reserved outside the two pools: psql admin sessions, a brief
 * overlap during DBOS recovery, replication / monitoring users.
 */
export const SAFETY_MARGIN = 5;

/**
 * How long a caller may wait for a connection from the app pool before the
 * acquisition fails.
 *
 * The driver waits forever by default, which leaves a caller on a saturated
 * pool with no failure mode at all — only an indefinite hang, indistinguishable
 * from work still in progress and therefore able to stall the caller's own
 * in-flight guard permanently. A bound turns that silent stall into a surfaced
 * error the caller can degrade on. 30s is long enough that a healthy pool under
 * burst never trips it, and short enough that a wedged caller surfaces well
 * inside a human's patience.
 */
export const APP_POOL_ACQUIRE_TIMEOUT_MS = 30_000;

/** Resolve the app pool size from the optional `DB_POOL_MAX` override. */
export function resolveAppPoolSize(dbPoolMax: string | undefined): number {
    if (dbPoolMax === undefined || dbPoolMax === "") return DEFAULT_APP_POOL_SIZE;
    const n = Number.parseInt(dbPoolMax, 10);
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_APP_POOL_SIZE;
}
