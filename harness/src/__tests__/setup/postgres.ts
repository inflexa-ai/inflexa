// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the testcontainers wait matches the Postgres readiness line of the server log
const POSTGRES_READY_LOG = /database system is ready to accept connections/;

/**
 * Postgres test helper — hands out per-test schemas scoped via `search_path`
 * against one `pgvector/pgvector:pg18` database.
 *
 * Two ways to point tests at a Postgres:
 *
 *  1. Override: `CORTEX_TEST_PG_URL` is a libpq-style connection string and
 *     no container is started — the helper just connects. This is how the
 *     full suite runs: `bun run test:full` (scripts/test-full.sh) starts ONE
 *     container, exports `CORTEX_TEST_PG_URL`, and removes it on exit; CI does
 *     the same with a `services:` container. It is also how you point tests at
 *     an already-running dedicated Postgres for tight iteration. That database
 *     must be one that no host uses: the first `getTestPool()` refuses a database
 *     that holds a relation in `public`, or in the default schema of the role,
 *     that no extension owns (see `require-dedicated-database.ts`).
 *
 *  2. Fallback: with no `CORTEX_TEST_PG_URL`, a testcontainers-managed
 *     container is launched on the first `getTestPool()` call. Cold start
 *     is ~3s; the `ryuk` sidecar reaps it on process exit. The container
 *     lives in this module's state, so the fallback starts one container for
 *     each Bun module registry that runs a database test file: one for a
 *     default `bun test`; one for each database test file under `--isolate`
 *     or `--parallel`; one for each worker that runs a database test file
 *     under `--parallel --no-isolate`. The fallback refuses to start anything
 *     unless a reaper is actually up to remove it again — see
 *     `require-reaper.ts`.
 *
 * Why the runner owns the container in `test:full`: its exit trap removes the
 * container, so it needs no ryuk. A real OS-process env var
 * (`CORTEX_TEST_PG_URL`, exported before `bun test`) is inherited by every
 * module registry, so it keeps one container under `--isolate` and
 * `--parallel`. It also matches CI, which sets `CORTEX_TEST_PG_URL` to one
 * service container.
 *
 * Each test should call `withSchema(testName)` to get a `{ pool, drop }`
 * pair and `afterEach(drop)` to tear it down.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Pool, type PoolConfig } from "pg";
import { initCortexState } from "../../state/init.js";
import { assertDatabaseIsDedicated, databaseLabel } from "./require-dedicated-database.js";
import { assertContainerWillBeReaped } from "./require-reaper.js";

const PG_IMAGE = "pgvector/pgvector:pg18";
const PG_USER = "cortex";
const PG_PASSWORD = "cortex";
const PG_DB = "cortex";

let _startPromise: Promise<{ pool: Pool; container?: StartedTestContainer }> | undefined;
let _extensionPromise: Promise<void> | undefined;

async function startContainer(): Promise<{ pool: Pool; container?: StartedTestContainer }> {
    const override = process.env.CORTEX_TEST_PG_URL;
    if (override) {
        const pool = new Pool({ connectionString: override });
        try {
            await assertDatabaseIsDedicated(pool);
        } catch (err) {
            await pool.end().catch(() => {
                /* the refusal is the error to report */
            });
            throw err;
        }
        return { pool };
    }

    // Only the fallback creates a container, so only the fallback has to prove
    // one will be removed again. Throws with both safe routes named otherwise.
    await assertContainerWillBeReaped();

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
        .withWaitStrategy(Wait.forLogMessage(POSTGRES_READY_LOG, 2))
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
            await sleep(200);
        }
    }

    return { pool, container };
}

/**
 * Install pgvector in `public`, the schema that each test pool searches after its test schema. A statement with no
 * `SCHEMA` clause installs in the first schema of `"$user", public` that exists, which is the schema of the role on a
 * database that has one. `IF NOT EXISTS` skips an extension that exists in any schema and does not move it, so the
 * schema is read back and a misplaced extension is refused. The setup never moves an extension that it did not install.
 */
export async function ensureVectorInPublic(pool: Pool): Promise<void> {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    const { rows } = await pool.query<{ schema: string }>(
        "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
    );
    const schema = rows[0]?.schema;
    if (schema === "public") return;
    if (schema === undefined) {
        throw new Error(`The pgvector extension is absent from ${databaseLabel(pool.options)} right after its install; a different session dropped it.`);
    }
    throw new Error(misplacedExtensionMessage(databaseLabel(pool.options), schema));
}

function misplacedExtensionMessage(label: string, schema: string): string {
    return `Refusing to run the tests against ${label}: the pgvector extension is in the schema "${schema}", but each test pool searches only its test schema and public.

Use one of these remedies:

  ALTER EXTENSION vector SET SCHEMA public
                                   run it in that database, then run the tests again
  unset CORTEX_TEST_PG_URL; bun run test:full [paths...]
                                   starts one container with pgvector in public, and removes it on exit
  CORTEX_TEST_PG_URL=<url of a new dedicated Postgres with no pgvector> bun test [paths...]
                                   the setup installs pgvector in public there`;
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
    // Install pgvector in `public` once per test run, and refuse a database that holds it in another schema. This
    // runs before any test schema exists, because `withSchema` awaits this function before `CREATE SCHEMA`.
    _extensionPromise ??= ensureVectorInPublic(pool);
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
        .split("")
        .map((char) => ((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_" ? char : "_"))
        .join("")
        .slice(0, 40);
    const schemaName = `t_${safeName}_${Date.now().toString(36)}_${_schemaCounter++}`;

    await base.query(`CREATE SCHEMA "${schemaName}"`);

    // The search_path is a startup parameter, so every connection handed out
    // resolves tables in the test schema before falling back to public (where
    // pgvector lives), with no query to race.
    const cfg: PoolConfig = base.options;
    const pool = new Pool({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectionString: cfg.connectionString,
        options: `-c search_path=${schemaName},public`,
    });

    await initCortexState(pool);

    const drop = async (): Promise<void> => {
        await pool.end().catch(() => {
            /* already closed */
        });
        await base.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    };

    return { pool, schemaName, drop };
}

/**
 * Make a test schema look like a database from before the versioned migrations:
 * drop the record of the migrator, thus the next `initCortexState` applies the
 * baseline again over the tables as they stand.
 */
export async function forgetMigrations(pool: Pool): Promise<void> {
    await pool.query("DROP TABLE cortex_migration, cortex_migration_lock");
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
