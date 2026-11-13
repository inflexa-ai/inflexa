/**
 * The install of pgvector in the test setup. The shared test database holds pgvector in `public`, and concurrent test
 * files depend on it, so each test makes a scratch database on the same server. `TEMPLATE template0` keeps an
 * extension that an administrator added to `template1` out of the scratch database.
 */

import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Pool, type PoolConfig } from "pg";

import { errorMessageOf } from "../../../lib/thrown.js";
import { ensureVectorInPublic, getTestPool } from "../postgres.js";
import { databaseLabel } from "../require-dedicated-database.js";

let counter = 0;
let databaseName: string;
let roleSchema: string;
let scratchPool: Pool;
const openedPools: Pool[] = [];

const POSTGRES_SETUP_PATH = fileURLToPath(new URL("../postgres.ts", import.meta.url));
const CHILD_WAIT_MS = 60_000;

function urlOn(base: PoolConfig, database: string): string {
    const { connectionString } = base;
    if (connectionString) {
        const url = new URL(connectionString);
        url.pathname = `/${encodeURIComponent(database)}`;
        return url.toString();
    }
    const { host, port, user, password } = base;
    const hostName = host ?? "localhost";
    const portNumber = String(port ?? 5432);
    return `postgres://${encodeURIComponent(user ?? "")}:${encodeURIComponent(password ? String(password) : "")}@${hostName}:${portNumber}/${encodeURIComponent(database)}`;
}

function poolOn(base: PoolConfig, database: string, options?: string): Pool {
    // A connection string wins over the fields of the config, so the database has to change in the URL.
    const pool = new Pool({ connectionString: urlOn(base, database), options });
    openedPools.push(pool);
    return pool;
}

beforeEach(async () => {
    const base = await getTestPool();
    const { rows } = await base.query<{ role: string }>("SELECT current_user AS role");
    const role = rows[0]?.role;
    if (role === undefined) throw new Error("current_user returned no row");
    roleSchema = role;
    databaseName = `t_vector_${Date.now().toString(36)}_${counter++}`;
    await base.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    scratchPool = poolOn(base.options, databaseName);
    await scratchPool.query(`CREATE SCHEMA "${roleSchema}"`);
});

afterEach(async () => {
    const base = await getTestPool();
    for (let pool = openedPools.pop(); pool !== undefined; pool = openedPools.pop()) {
        await pool.end();
    }
    await base.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
});

async function extensionSchema(pool: Pool): Promise<string | undefined> {
    const { rows } = await pool.query<{ schema: string }>(
        "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
    );
    return rows[0]?.schema;
}

async function refusalOf(pool: Pool): Promise<string> {
    try {
        await ensureVectorInPublic(pool);
    } catch (err) {
        const message = errorMessageOf(err);
        if (message === undefined) throw err;
        return message;
    }
    throw new Error("ensureVectorInPublic did not refuse");
}

describe("ensureVectorInPublic", () => {
    it("installs pgvector in public when a schema of the connecting role exists", async () => {
        const { rows } = await scratchPool.query<{ schema: string }>("SELECT current_schema() AS schema");
        expect(rows[0]?.schema).toBe(roleSchema);

        await ensureVectorInPublic(scratchPool);

        expect(await extensionSchema(scratchPool)).toBe("public");

        await scratchPool.query('CREATE SCHEMA "t_vector_search"');
        const testPool = poolOn(scratchPool.options, databaseName, "-c search_path=t_vector_search,public");
        const result = await testPool.query<{ v: string }>("SELECT '[1,2,3]'::vector AS v");
        expect(result.rows[0]?.v).toBe("[1,2,3]");
    });

    it("refuses an extension in another schema, names the schema and the remedy, and leaves it there", async () => {
        await scratchPool.query(`CREATE EXTENSION vector SCHEMA "${roleSchema}"`);

        const message = await refusalOf(scratchPool);

        expect(message).toContain(`the schema "${roleSchema}"`);
        expect(message).toContain(databaseLabel(scratchPool.options));
        expect(message).toContain("ALTER EXTENSION vector SET SCHEMA public");
        expect(message).toContain("unset CORTEX_TEST_PG_URL; bun run test:full");
        expect(message).toContain("new dedicated Postgres with no pgvector");
        expect(await extensionSchema(scratchPool)).toBe(roleSchema);
    });

    it("continues when the extension is already in public", async () => {
        await scratchPool.query("CREATE EXTENSION vector SCHEMA public");

        await expect(ensureVectorInPublic(scratchPool)).resolves.toBeUndefined();
        expect(await extensionSchema(scratchPool)).toBe("public");

        await scratchPool.query('CREATE SCHEMA "t_vector_search"');
        const testPool = poolOn(scratchPool.options, databaseName, "-c search_path=t_vector_search,public");
        const result = await testPool.query<{ v: string }>("SELECT '[1,2,3]'::vector AS v");
        expect(result.rows[0]?.v).toBe("[1,2,3]");
    });
});

describe("withSchema", () => {
    it(
        "refuses a misplaced extension before it makes a test schema",
        async () => {
            await scratchPool.query(`CREATE EXTENSION vector SCHEMA "${roleSchema}"`);
            const base = await getTestPool();

            // A module registry memoizes getTestPool, so only a new process runs the setup in the real order.
            const child = Bun.spawn(
                [process.execPath, "-e", `const { withSchema } = await import(${JSON.stringify(POSTGRES_SETUP_PATH)}); await withSchema("child");`],
                {
                    env: { ...process.env, CORTEX_TEST_PG_URL: urlOn(base.options, databaseName) },
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: CHILD_WAIT_MS,
                    killSignal: "SIGKILL",
                },
            );
            const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            const output = `${stdout}\n${stderr}`;

            expect(exitCode).not.toBe(0);
            expect(output).toContain(`the schema "${roleSchema}"`);
            expect(output).toContain("ALTER EXTENSION vector SET SCHEMA public");

            const { rows } = await scratchPool.query<{ name: string }>(
                "SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 't\\_%' AND nspname <> $1",
                [roleSchema],
            );
            expect(rows).toEqual([]);
        },
        CHILD_WAIT_MS + 30_000,
    );
});
