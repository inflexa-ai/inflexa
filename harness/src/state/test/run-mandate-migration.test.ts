/**
 * The migration that keeps a reference to the run mandate in place of a token id and its expiry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { forgetMigrations, withSchema } from "../../__tests__/setup/postgres.js";
import { initCortexState } from "../init.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("run-mandate-migration"));
});

afterEach(async () => {
    await drop();
});

async function mandateColumns(): Promise<string[]> {
    const { rows } = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'cortex_runs' AND column_name LIKE 'mandate%' ORDER BY column_name",
    );
    return rows.map((row) => row.column_name);
}

describe("the migration that references the run mandate", () => {
    it("renames the column of a database from before it, keeps its values, and drops the expiry", async () => {
        await pool.query("ALTER TABLE cortex_runs RENAME COLUMN mandate_id TO mandate_jti");
        await pool.query("ALTER TABLE cortex_runs ADD COLUMN mandate_expires_at TEXT");
        await pool.query(
            `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, mandate_jti, mandate_expires_at)
             VALUES ('r1', 'a1', 'executeAnalysis', 'running', NOW(), 'mandate-1', '2026-10-29T10:00:00.000Z')`,
        );
        await forgetMigrations(pool);

        await initCortexState(pool);

        expect(await mandateColumns()).toEqual(["mandate_id"]);
        const { rows } = await pool.query<{ mandate_id: string }>("SELECT mandate_id FROM cortex_runs WHERE run_id = 'r1'");
        expect(rows).toEqual([{ mandate_id: "mandate-1" }]);
    });

    it("drops the column that the baseline adds again beside the renamed one", async () => {
        await pool.query(
            `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, mandate_id)
             VALUES ('r2', 'a1', 'executeAnalysis', 'running', NOW(), 'mandate-2')`,
        );
        await forgetMigrations(pool);

        await initCortexState(pool);

        expect(await mandateColumns()).toEqual(["mandate_id"]);
        const { rows } = await pool.query<{ mandate_id: string }>("SELECT mandate_id FROM cortex_runs WHERE run_id = 'r2'");
        expect(rows).toEqual([{ mandate_id: "mandate-2" }]);
    });
});
