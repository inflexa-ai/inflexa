/**
 * Postgres test helper — hands out per-test schemas scoped via `search_path`
 * against one `pgvector/pgvector:pg18` database.
 *
 * Two ways to point tests at a Postgres:
 *
 *  1. Override: `CORTEX_TEST_PG_URL` is a libpq-style connection string and
 *     no container is started — the helper just connects. This is how the
 *     full suite runs: the `just test` recipe starts ONE container, exports
 *     `CORTEX_TEST_PG_URL`, and removes it on exit. It is also how you point
 *     tests at a `just up` dev Postgres for tight iteration.
 *
 *  2. Fallback: with no `CORTEX_TEST_PG_URL`, a testcontainers-managed
 *     container is launched on the first `getTestPool()` call. Cold start
 *     is ~3s; the `ryuk` sidecar reaps it on process exit.
 *
 * Why the recipe owns the container for the full suite: Bun isolates module
 * state per test file, so a module-level singleton here is NOT shared across
 * the ~130 test files — each would spin its own container. A real OS-process
 * env var (`CORTEX_TEST_PG_URL`, exported by the recipe before `bun test`)
 * IS inherited by every file, so all of them connect to the one container.
 *
 * Each test should call `withSchema(testName)` to get a `{ pool, drop }`
 * pair and `afterEach(drop)` to tear it down.
 */

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Pool, type PoolConfig } from "pg";
import { initCortexState } from "../../state/init.js";

const PG_IMAGE = "pgvector/pgvector:pg18";
const PG_USER = "cortex";
const PG_PASSWORD = "cortex";
const PG_DB = "cortex";

let _startPromise: Promise<{ pool: Pool; container?: StartedTestContainer }> | undefined;
let _extensionPromise: Promise<void> | undefined;

async function startContainer(): Promise<{ pool: Pool; container?: StartedTestContainer }> {
    const override = process.env.CORTEX_TEST_PG_URL;
    if (override) {
        return { pool: new Pool({ connectionString: override }) };
    }

    // The default port-probe wait strategy hangs under Bun when run against
    // the postgres image (the port opens during the initdb bootstrap before
    // the final server is up). Use the log-message strategy with count=2 —
    // the official postgres images print "ready to accept connections" once
    // for the bootstrap server and once for the final server.
    const container = await new GenericContainer(PG_IMAGE)
        .withEnvironment({
            POSTGRES_USER: PG_USER,
            POSTGRES_PASSWORD: PG_PASSWORD,
            POSTGRES_DB: PG_DB,
        })
        .withExposedPorts(5432)
        .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off"])
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withStartupTimeout(60_000)
        .start();

    const pool = new Pool({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
    });

    // Crude readiness loop — the container's postgres process accepts
    // connections before it's actually ready for queries, and testcontainers'
    // default log wait can be flaky across pg versions.
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            await pool.query("SELECT 1");
            break;
        } catch (err) {
            if (Date.now() > deadline) throw err;
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    return { pool, container };
}

/**
 * Get the shared base `pg.Pool` for the default database. Lazily starts
 * the container (if no override is set) on first call. The caller SHALL
 * NOT close this pool — it lives for the duration of the test run.
 */
export async function getTestPool(): Promise<Pool> {
    // Memoize the *promise*, assigned synchronously before the first await —
    // concurrent callers racing the cold start share one container instead
    // of each starting its own.
    _startPromise ??= startContainer();
    const { pool } = await _startPromise;
    // Install pgvector once per test run against the default database.
    _extensionPromise ??= pool.query("CREATE EXTENSION IF NOT EXISTS vector").then(() => {});
    await _extensionPromise;
    return pool;
}

let _schemaCounter = 0;

/**
 * Create a uniquely-named Postgres schema, initialize Cortex state DDL
 * inside it, and return a pool whose default `search_path` points at the
 * new schema. The caller wires the returned `drop` into `afterEach` to
 * tear the schema down.
 */
export async function withSchema(testName: string): Promise<{
    pool: Pool;
    schemaName: string;
    drop: () => Promise<void>;
}> {
    const base = await getTestPool();
    const safeName = testName
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 40);
    const schemaName = `t_${safeName}_${Date.now().toString(36)}_${_schemaCounter++}`;

    await base.query(`CREATE SCHEMA "${schemaName}"`);

    // Each test gets its own scoped pool so search_path sticks on every
    // connection pulled from it.
    const cfg: PoolConfig = (base as unknown as { options?: PoolConfig }).options ?? {};
    const pool = new Pool({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectionString: cfg.connectionString,
    });

    // Ensure every connection handed out resolves tables in the test schema
    // before falling back to public (where pgvector lives).
    pool.on("connect", (client) => {
        client.query(`SET search_path TO "${schemaName}", public`).catch(() => {
            /* ignore */
        });
    });

    // The very first query from the pool races the `connect` listener above.
    // Force a query that waits for search_path to apply.
    const firstClient = await pool.connect();
    try {
        await firstClient.query(`SET search_path TO "${schemaName}", public`);
    } finally {
        firstClient.release();
    }

    await initCortexState(pool);

    const drop = async () => {
        await pool.end().catch(() => {
            /* already closed */
        });
        await base.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    };

    return { pool, schemaName, drop };
}

/**
 * Best-effort global teardown for the shared container. Only matters when
 * the Bun test runner is configured to invoke this (it isn't by default —
 * containers are reaped by testcontainers' ryuk sidecar).
 */
export async function stopTestContainer(): Promise<void> {
    const started = _startPromise;
    _startPromise = undefined;
    _extensionPromise = undefined;
    if (!started) return;
    try {
        const { pool, container } = await started;
        await pool.end().catch(() => {
            /* ignore */
        });
        await container?.stop().catch(() => {
            /* ignore */
        });
    } catch {
        /* container never started cleanly */
    }
}
