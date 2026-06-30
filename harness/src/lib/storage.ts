/**
 * Application `pg.Pool` construction.
 *
 * One `pg.Pool` backs every Cortex query — Cortex tables, the per-analysis
 * pgvector indexes, route handlers, and durable-workflow steps all share the
 * same pool so connection budgets stay predictable. The pool is built once at
 * the composition root and threaded as a constructor dep (see the harness-durable-runtime spec).
 */

import pg, { type Pool } from "pg";
import { resolveAppPoolSize } from "../runtime/pools.js";

/**
 * Narrow config slice the app pool reads — the six `DB_PG_*` connection
 * fields plus the optional pool-size override. Composition roots map their
 * validated `Env` onto this; the harness never reaches for an env loader.
 */
export interface PoolConfig {
    readonly host: string;
    readonly port: string;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly sslMode: "disable" | "require" | "verify-ca" | "verify-full";
    readonly poolMax?: string;
}

function poolOptions(config: PoolConfig) {
    return {
        host: config.host,
        port: parseInt(config.port, 10),
        database: config.database,
        user: config.user,
        password: config.password,
        // Per-pod app pool; DBOS owns its system-DB connections separately
        // (see the postgres-storage-backend spec). The boot guard checks this fits `max_connections`.
        max: resolveAppPoolSize(config.poolMax),
        // `pg` accepts `ssl: false` to disable entirely, or an object with
        // `rejectUnauthorized` to tune TLS. We map sslmode to those forms.
        ssl:
            config.sslMode === "disable"
                ? false
                : config.sslMode === "verify-full" || config.sslMode === "verify-ca"
                  ? { rejectUnauthorized: true }
                  : { rejectUnauthorized: false },
    };
}

/**
 * Construct the application `pg.Pool`. Called exactly once, at the process
 * composition root (`server.ts:main()`), and threaded as a constructor dep
 * from there. No module reaches for the pool ambiently (see the harness-durable-runtime spec).
 */
export function createPool(config: PoolConfig): Pool {
    return new pg.Pool(poolOptions(config));
}
