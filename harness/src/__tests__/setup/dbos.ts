/**
 * DBOS test rig — composes the shared pgvector container from
 * `harness/src/__tests__/setup/postgres.ts` with a single, process-global
 * `DBOS.launch()`. Tests get a per-test cortex schema (search_path) and
 * unique workflow IDs from `nextWorkflowId`; the DBOS system tables
 * (workflow_status, operation_outputs, streams, notifications, etc.) live
 * in the shared `dbos` schema in the same database, and are partitioned
 * across tests via unique workflow IDs.
 *
 * Why one DBOS per process: `DBOS.launch()` is process-global state. A
 * second `launch()` without `shutdown({ deregister: true })` is rejected
 * and re-launching after a shutdown loses every `registerWorkflow` call
 * the harness made at import time. The simplest contract — and the one
 * that mirrors production — is to launch once and let unique workflow IDs
 * provide cross-test isolation.
 *
 * Lifecycle:
 *
 *  - First `withDbos(testName)` in a `bun test` process:
 *      1. starts (or attaches to) the pgvector container via `getTestPool()`
 *      2. points `DB_PG_*` env vars at it and resets the env cache so
 *         `launchDbos()` builds its `systemDatabaseUrl` from the test DB
 *      3. calls the existing `launchDbos()` exactly once
 *      4. carves out a fresh per-test cortex schema via `withSchema()`
 *      5. returns the per-test pool for explicit injection (`rig.pool`)
 *
 *  - Subsequent `withDbos` calls: reuse the same DBOS engine, return a
 *    fresh per-test schema + a unique-ID minter.
 *
 *  - A process-exit hook calls `DBOS.shutdown()` so testcontainers' ryuk
 *    sidecar doesn't tear the DB out from under a still-running engine.
 *
 * The rig deliberately does NOT call `DBOS.shutdown` between tests —
 * doing so would deregister every workflow the harness wired up at
 * import time.
 */

import { afterEach, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import pino from "pino";

import { getTestPool, withSchema } from "./postgres.js";
import { launchDbos, shutdownDbos } from "../../runtime/dbos.js";

const DBOS_TEST_APP_NAME = "cortex-test";
const DBOS_TEST_APPLICATION_VERSION = "test-1";
const DBOS_TEST_EXECUTOR_ID = "test";

interface SharedDbosState {
    launchPromise: Promise<void> | null;
    shutdownRegistered: boolean;
}

const shared: SharedDbosState = {
    launchPromise: null,
    shutdownRegistered: false,
};

const silentLogger = pino({ level: "silent" });

export interface DbosTestRig {
    /** Per-test pool scoped to a fresh cortex schema via `search_path`. */
    pool: Pool;
    /** Per-test cortex schema name. */
    schemaName: string;
    /**
     * Mint a workflow ID unique to this test. Pass a prefix to make logs
     * and DB rows greppable (e.g. `chaos-`, `402-`). The returned ID is
     * always unique across the process — safe to use as DBOS `workflowID`.
     */
    nextWorkflowId(prefix?: string): string;
    /**
     * Tear the per-test schema down and release the per-test pool. Idempotent.
     * The shared DBOS engine and pgvector container are NOT shut down — the
     * process-exit hook handles those.
     */
    drop(): Promise<void>;
}

/** Parse a libpq-style connection string into individual DB_PG_* fields. */
function parseConnectionStringToEnv(url: string): {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
} {
    const u = new URL(url);
    // pg accepts `127.0.0.1` and `localhost` interchangeably; preserve whatever
    // the caller wrote.
    return {
        host: u.hostname,
        port: u.port || "5432",
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    };
}

/** Pull connection settings off a Pool's internal options. */
function poolConnectionEnv(pool: Pool): {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
} {
    const cfg = (pool as unknown as { options?: Record<string, unknown> }).options ?? {};
    if (cfg.connectionString) {
        return parseConnectionStringToEnv(String(cfg.connectionString));
    }
    return {
        host: String(cfg.host ?? "127.0.0.1"),
        port: String(cfg.port ?? "5432"),
        user: String(cfg.user ?? "cortex"),
        password: String(cfg.password ?? "cortex"),
        database: String(cfg.database ?? "cortex"),
    };
}

/**
 * Ensure DBOS is launched against the test container exactly once per
 * process. Concurrent callers share the same promise — DBOS.launch is
 * not safe to call twice in flight.
 */
async function ensureDbosLaunched(basePool: Pool): Promise<void> {
    if (shared.launchPromise) return shared.launchPromise;
    shared.launchPromise = (async () => {
        const env = poolConnectionEnv(basePool);
        process.env.DB_PG_HOST = env.host;
        process.env.DB_PG_PORT = env.port;
        process.env.DB_PG_USER = env.user;
        process.env.DB_PG_PASSWORD = env.password;
        process.env.DB_PG_NAME = env.database;
        process.env.DB_PG_SSLMODE = "disable";
        process.env.DBOS_APP_NAME = DBOS_TEST_APP_NAME;
        process.env.DBOS_APPLICATION_VERSION = DBOS_TEST_APPLICATION_VERSION;
        // The harness picks executorID off HOSTNAME if set; pin it explicitly so
        // tests don't pick up the developer's hostname.
        process.env.HOSTNAME = DBOS_TEST_EXECUTOR_ID;
        // Picking a deterministic but uncommon admin port avoids colliding with
        // other locally-running tools and with parallel test files.
        if (!process.env.DBOS_ADMIN_PORT) {
            process.env.DBOS_ADMIN_PORT = "39001";
        }
        await launchDbos({
            config: {
                dbHost: process.env.DB_PG_HOST!,
                dbPort: process.env.DB_PG_PORT ?? "5432",
                dbName: process.env.DB_PG_NAME!,
                dbUser: process.env.DB_PG_USER!,
                dbPassword: process.env.DB_PG_PASSWORD!,
                dbSslMode: "disable",
                appName: process.env.DBOS_APP_NAME!,
                applicationVersion: process.env.DBOS_APPLICATION_VERSION,
                adminPort: process.env.DBOS_ADMIN_PORT ?? "3001",
                executorId: process.env.HOSTNAME ?? "local-dev",
            },
            logger: silentLogger,
        });

        if (!shared.shutdownRegistered) {
            shared.shutdownRegistered = true;
            const shutdown = () => {
                // Fire-and-forget — exit handlers can't await.
                void shutdownDbos({ logger: silentLogger });
            };
            process.once("beforeExit", shutdown);
            process.once("SIGINT", shutdown);
            process.once("SIGTERM", shutdown);
        }
    })();
    return shared.launchPromise;
}

/**
 * Stand up the per-test slice of the rig: a fresh cortex schema, a
 * search-path-scoped pool returned for explicit injection, and a launched DBOS.
 */
export async function setupDbosForTests(testName: string): Promise<DbosTestRig> {
    const basePool = await getTestPool();
    await ensureDbosLaunched(basePool);

    const { pool, schemaName, drop } = await withSchema(testName);

    let dropped = false;
    const safeDrop = async () => {
        if (dropped) return;
        dropped = true;
        await drop();
    };

    return {
        pool,
        schemaName,
        nextWorkflowId(prefix?: string): string {
            const p = (prefix ?? "wf-").replace(/[^a-zA-Z0-9_.-]/g, "-");
            return `${p}${randomUUID()}`;
        },
        drop: safeDrop,
    };
}

/**
 * Convenience: pair with `bun:test`'s `beforeEach`/`afterEach` idioms.
 * Returns a fresh rig per call. The caller is responsible for invoking
 * `rig.drop()` from `afterEach` (or assigning the rig in `beforeEach`
 * via a closure variable).
 */
export async function withDbos(testName: string): Promise<DbosTestRig> {
    return setupDbosForTests(testName);
}

/**
 * Helper for the common pattern: wire `beforeEach` to assign a rig and
 * `afterEach` to drop it. Pass the consumer function a getter so it can
 * access the freshly-built rig after `beforeEach` ran.
 *
 *   let rig: DbosTestRig;
 *   beforeEach(async () => { rig = await withDbos("chaos"); });
 *   afterEach(async () => { await rig.drop(); });
 */
export function registerDbosLifecycle(testName: string, onReady: (rig: DbosTestRig) => void): void {
    let rig: DbosTestRig | undefined;
    beforeAll(async () => {
        rig = await setupDbosForTests(testName);
        onReady(rig);
    });
    afterEach(async () => {
        // No-op: per-test cleanup is the caller's job. This helper exists
        // for tests that want a single rig for an entire `describe` block.
    });
}
