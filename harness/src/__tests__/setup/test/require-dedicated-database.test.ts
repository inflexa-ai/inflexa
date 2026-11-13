/**
 * The guard that refuses a test database that a host uses. A test never writes a relation into `public`, because a
 * concurrent test file would then refuse the shared test database. Each test makes a scratch schema and gives the
 * guard a pool whose `search_path` names it, thus `current_schema()` is the scratch schema.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Pool, type PoolConfig } from "pg";

import { errorMessageOf } from "../../../lib/thrown.js";
import { getTestPool } from "../postgres.js";
import { assertDatabaseIsDedicated, databaseLabel } from "../require-dedicated-database.js";

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
});
