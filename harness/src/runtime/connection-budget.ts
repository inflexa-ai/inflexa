/**
 * Boot-time Postgres connection-budget guard.
 *
 * Cortex runs two pools per pod against the same Postgres cluster (see the postgres-storage-backend spec):
 * the application pool (`lib/storage.ts::createPool()`, sized via the optional
 * `DB_POOL_MAX`) and the DBOS system-DB pool (`runtime/dbos.ts`, sized via
 * `DBOS_SYSTEM_POOL_SIZE`). This guard asserts a single pod's footprint fits
 * inside `max_connections` — it catches gross misconfiguration (a pool larger
 * than the cluster can serve) without the pod needing to know the fleet size.
 *
 * Fleet-level capacity is intentionally NOT asserted here. A pod cannot learn
 * the live replica count at boot (the Deployment's `spec.replicas` is not
 * exposed via the downward API, and under an HPA it varies), so a fleet-wide
 * assertion would either give false confidence or fail spuriously. The fleet
 * budget is enforced where it belongs: size `max_connections` for the replica
 * ceiling, or front Postgres with a pooler (RDS Proxy / PgBouncer) so N
 * replicas multiplex onto a bounded set of backend connections. This guard
 * logs the supported-replica headroom as guidance for that sizing.
 *
 * Runs after `launchDbos` and before the HTTP listener accepts traffic so a
 * misconfigured pod fails boot loudly instead of degrading under load.
 */

import type { Pool } from "pg";

import type { Logger } from "../lib/logger.js";
import { DBOS_SYSTEM_POOL_SIZE, resolveAppPoolSize, SAFETY_MARGIN } from "./pools.js";

/**
 * Narrow config slice the budget guard reads — only the optional app-pool
 * size override. Composition roots map `Env.DB_POOL_MAX` onto this.
 */
export interface ConnectionBudgetConfig {
    readonly poolMax?: string;
}

export interface AssertConnectionBudgetOptions {
    pool: Pool;
    logger: Logger;
    config: ConnectionBudgetConfig;
}

/**
 * Verify a single pod's pool footprint fits inside pg `max_connections`.
 * Throws on shortfall — the caller must abort boot. Returns the per-pod
 * footprint and the replica headroom it implies so callers can log it.
 */
export async function assertConnectionBudget({ pool, logger, config }: AssertConnectionBudgetOptions): Promise<{
    maxConnections: number;
    appPoolSize: number;
    dbosPoolSize: number;
    podFootprint: number;
    supportedReplicas: number;
}> {
    const appPoolSize = resolveAppPoolSize(config.poolMax);
    const dbosPoolSize = DBOS_SYSTEM_POOL_SIZE;
    const podFootprint = appPoolSize + dbosPoolSize;

    const { rows } = await pool.query<{ max: string }>("SELECT current_setting('max_connections') AS max");
    const maxConnections = parseInt(rows[0].max, 10);

    if (podFootprint + SAFETY_MARGIN > maxConnections) {
        throw new Error(
            `FATAL: pg max_connections (${maxConnections}) cannot hold one pod's pool footprint ` +
                `(${podFootprint}) = app=${appPoolSize} + dbos=${dbosPoolSize}, plus margin=${SAFETY_MARGIN}. ` +
                `Lower DB_POOL_MAX or raise max_connections.`,
        );
    }

    const supportedReplicas = Math.floor((maxConnections - SAFETY_MARGIN) / podFootprint);

    logger
        .named("boot")
        .info(
            `postgres connection budget OK — this cluster's max_connections ` +
                `supports ~${supportedReplicas} cortex replicas; size replicas/pooler accordingly`,
            {
                maxConnections,
                appPoolSize,
                dbosPoolSize,
                podFootprint,
                safetyMargin: SAFETY_MARGIN,
                supportedReplicas,
            },
        );

    return {
        maxConnections,
        appPoolSize,
        dbosPoolSize,
        podFootprint,
        supportedReplicas,
    };
}
