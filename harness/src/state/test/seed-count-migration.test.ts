/**
 * The migration that keeps the count of the seeded input set in place of one id for each file.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { forgetMigrations, withSchema } from "../../__tests__/setup/postgres.js";
import { initCortexState } from "../init.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("seed-count-migration"));
});

afterEach(async () => {
    await drop();
});

describe("the migration that counts the seed inputs", () => {
    it("keeps the count of each stored seed and drops the column of file ids", async () => {
        await pool.query("ALTER TABLE cortex_analysis_state DROP COLUMN seed_input_count");
        await pool.query("ALTER TABLE cortex_analysis_state ADD COLUMN seed_input_file_ids JSONB");
        await pool.query(
            `INSERT INTO cortex_analysis_state (analysis_id, status, seed_input_file_ids, created_at, updated_at) VALUES
             ('three', 'active', '["a", "b", "c"]'::jsonb, NOW(), NOW()),
             ('empty', 'active', '[]'::jsonb, NOW(), NOW()),
             ('none', 'active', NULL, NOW(), NOW())`,
        );
        await forgetMigrations(pool);

        await initCortexState(pool);

        const { rows } = await pool.query<{ analysis_id: string; seed_input_count: number | null }>(
            "SELECT analysis_id, seed_input_count FROM cortex_analysis_state ORDER BY analysis_id",
        );
        expect(rows).toEqual([
            { analysis_id: "empty", seed_input_count: 0 },
            { analysis_id: "none", seed_input_count: null },
            { analysis_id: "three", seed_input_count: 3 },
        ]);
        const columns = await pool.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'cortex_analysis_state' AND column_name LIKE 'seed%'",
        );
        expect(columns.rows).toEqual([{ column_name: "seed_input_count" }]);
    });
});
