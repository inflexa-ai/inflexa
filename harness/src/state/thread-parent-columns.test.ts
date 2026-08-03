/**
 * `cortex_analysis_threads` must acquire `thread_type`, `parent_thread_id` and
 * `parent_seq` on a database that predates them, and the partial index over the
 * parent column must be creatable at the same moment.
 *
 * The ordering is the whole point, and it is invisible on a fresh schema. The
 * DDL text runs before the additive `ALTER TABLE` block, and
 * `CREATE TABLE IF NOT EXISTS` adds no column to a table that already exists —
 * so on every database but a brand new one these columns arrive from an ALTER.
 * An index declared over one of them earlier in the text fails with 42703 on
 * exactly the databases a migration exists to serve, while every fresh-schema
 * test stays green. That is why this file drops the columns first: without the
 * drop it asserts nothing the `CREATE TABLE` did not already satisfy.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { initCortexState } from "./init.js";

let pool: Pool;
let drop: () => Promise<void>;

async function threadColumns(): Promise<Record<string, { data_type: string; column_default: string | null }>> {
    const { rows } = await pool.query<{ column_name: string; data_type: string; column_default: string | null }>(
        `SELECT column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'cortex_analysis_threads'`,
    );
    const byName: Record<string, { data_type: string; column_default: string | null }> = {};
    for (const row of rows) byName[row.column_name] = { data_type: row.data_type, column_default: row.column_default };
    return byName;
}

async function indexNames(): Promise<string[]> {
    const { rows } = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'cortex_analysis_threads'
          ORDER BY indexname`,
    );
    return rows.map((row) => row.indexname);
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("thread-parent-columns"));
});

afterEach(async () => {
    await drop?.();
});

describe("cortex_analysis_threads parent and type columns", () => {
    it("adds them to a database that predates them, over rows it leaves standing", async () => {
        await pool.query("INSERT INTO cortex_analysis_threads (thread_id, analysis_id, title) VALUES ('legacy', 'a1', 'Kept')");
        await pool.query("DROP INDEX idx_cortex_analysis_threads_parent");
        await pool.query("ALTER TABLE cortex_analysis_threads DROP COLUMN parent_seq, DROP COLUMN parent_thread_id, DROP COLUMN thread_type");
        expect(Object.keys(await threadColumns())).not.toContain("thread_type");

        await initCortexState(pool);

        const columns = await threadColumns();
        expect(columns.thread_type).toEqual({ data_type: "text", column_default: "'conversation'::text" });
        expect(columns.parent_thread_id?.data_type).toBe("text");
        expect(columns.parent_seq?.data_type).toBe("bigint");
        expect(await indexNames()).toContain("idx_cortex_analysis_threads_parent");

        // The row predates all three, so it has to read as what it is: a root
        // conversation with no anchor. A backfill inventing an edge here would
        // hand a later reader a parent nothing ever spawned it from.
        const { rows } = await pool.query<{ title: string; thread_type: string; parent_thread_id: string | null; parent_seq: string | null }>(
            "SELECT title, thread_type, parent_thread_id, parent_seq::text AS parent_seq FROM cortex_analysis_threads WHERE thread_id = 'legacy'",
        );
        expect(rows[0]).toEqual({ title: "Kept", thread_type: "conversation", parent_thread_id: null, parent_seq: null });
    });

    it("changes nothing on a second run", async () => {
        await initCortexState(pool);
        const columns = await threadColumns();
        const indexes = await indexNames();

        await initCortexState(pool);

        expect(await threadColumns()).toEqual(columns);
        expect(await indexNames()).toEqual(indexes);
    });
});
