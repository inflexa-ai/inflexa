/**
 * The guard that refuses a test database that a host uses. A test never writes a relation into `public`, because a
 * concurrent test file would then refuse the shared test database. Each test makes a scratch schema and gives the
 * guard a pool whose `search_path` names it, thus `current_schema()` is the scratch schema.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Pool, type PoolConfig } from "pg";

import { errorMessageOf } from "../../../lib/thrown.js";
import { getTestPool } from "../postgres.js";
import { assertDatabaseIsDedicated, databaseLabel, refusalMessage } from "../require-dedicated-database.js";

let counter = 0;
let schemaName: string;
let scratchPool: Pool;

beforeEach(async () => {
    const base = await getTestPool();
    schemaName = `t_dedicated_${Date.now().toString(36)}_${counter++}`;
    await base.query(`CREATE SCHEMA "${schemaName}"`);
    const cfg: PoolConfig = base.options;
    scratchPool = new Pool({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectionString: cfg.connectionString,
        options: `-c search_path=${schemaName}`,
    });
});

afterEach(async () => {
    await scratchPool.end();
    const base = await getTestPool();
    await base.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
});

async function refusalOf(pool: Pool): Promise<string> {
    try {
        await assertDatabaseIsDedicated(pool);
    } catch (err) {
        const message = errorMessageOf(err);
        if (message === undefined) throw err;
        return message;
    }
    throw new Error("the guard did not refuse");
}

describe("assertDatabaseIsDedicated", () => {
    it("permits a database whose schemas hold no relation of a host", async () => {
        await expect(assertDatabaseIsDedicated(scratchPool)).resolves.toBeUndefined();
    });

    it("refuses a table and a view in the default schema, and names both", async () => {
        await scratchPool.query("CREATE TABLE host_runs (run_id TEXT)");
        await scratchPool.query("CREATE VIEW host_runs_view AS SELECT run_id FROM host_runs");

        const message = await refusalOf(scratchPool);

        expect(message).toContain(`${schemaName}.host_runs (table)`);
        expect(message).toContain(`${schemaName}.host_runs_view (view)`);
    });

    it("names the safe routes and the database, and not a host database as a route", async () => {
        await scratchPool.query("CREATE TABLE host_runs (run_id TEXT)");

        const message = await refusalOf(scratchPool);

        expect(message).toContain("unset CORTEX_TEST_PG_URL; bun run test:full");
        expect(message).toContain("CORTEX_TEST_PG_URL unset");
        expect(message).toContain("dedicated Postgres whose public schema is empty");
        expect(message).toContain(databaseLabel(scratchPool.options));
        expect(message).not.toContain("localhost:5433");
    });

    it("lists at most the limit of relations and says that it omits the rest", async () => {
        for (let index = 0; index < 21; index++) {
            await scratchPool.query(`CREATE TABLE host_table_${String(index).padStart(2, "0")} (id TEXT)`);
        }

        const message = await refusalOf(scratchPool);

        expect(message).toContain("host_table_19");
        expect(message).not.toContain("host_table_20");
        expect(message).toContain("this list omits the rest");
    });

    // The role that connects must be able to make the extension: CI and `test:full` use the superuser of the image.
    it("permits a relation that an extension owns", async () => {
        await scratchPool.query("CREATE EXTENSION pg_buffercache");
        const { rows } = await scratchPool.query<{ relname: string }>(
            "SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'v'",
        );
        expect(rows.map((row) => row.relname)).toContain("pg_buffercache");

        await expect(assertDatabaseIsDedicated(scratchPool)).resolves.toBeUndefined();
    });
});

describe("databaseLabel", () => {
    it("names host, port, and database, and never the password", () => {
        const label = databaseLabel({ connectionString: "postgres://cortex:s3cret-pw@db.example:6543/shared" });

        expect(label).toBe("host db.example, port 6543, database shared");
        expect(label).not.toContain("s3cret-pw");
    });

    it("does not echo a connection string that it cannot read", () => {
        const label = databaseLabel({ connectionString: "host=db.example password=s3cret-pw dbname=shared" });

        expect(label).not.toContain("s3cret-pw");
    });

    it("reads the fields of a pool with no connection string", () => {
        expect(databaseLabel({ host: "127.0.0.1", port: 5555, database: "cortex" })).toBe("host 127.0.0.1, port 5555, database cortex");
    });
});

describe("refusalMessage", () => {
    it("names the relations that it found with their kinds", () => {
        const message = refusalMessage("host h, port 1, database d", [
            { schema: "public", name: "cortex_runs", kind: "r" },
            { schema: "public", name: "recent", kind: "m" },
        ]);

        expect(message).toContain("host h, port 1, database d");
        expect(message).toContain("public.cortex_runs (table)");
        expect(message).toContain("public.recent (materialized view)");
    });
});
