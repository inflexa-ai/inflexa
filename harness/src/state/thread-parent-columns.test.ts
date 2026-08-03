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

async function threadIndexes(): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'cortex_analysis_threads'
          ORDER BY indexname`,
    );
    const byName: Record<string, string> = {};
    for (const row of rows) byName[row.indexname] = row.indexdef;
    return byName;
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
        await pool.query("DROP INDEX idx_cortex_analysis_threads_parent_fk");
        await pool.query("ALTER TABLE cortex_analysis_threads DROP COLUMN parent_seq, DROP COLUMN parent_thread_id, DROP COLUMN thread_type");
        expect(Object.keys(await threadColumns())).not.toContain("thread_type");

        await initCortexState(pool);

        const columns = await threadColumns();
        expect(columns.thread_type).toEqual({ data_type: "text", column_default: "'conversation'::text" });
        expect(columns.parent_thread_id?.data_type).toBe("text");
        expect(columns.parent_seq?.data_type).toBe("bigint");
        expect(await threadIndexes()).toHaveProperty("idx_cortex_analysis_threads_parent_fk");

        // The row predates all three, so it has to read as what it is: a root
        // conversation with no anchor. A backfill inventing an edge here would
        // hand a later reader a parent nothing ever spawned it from.
        const { rows } = await pool.query<{ title: string; thread_type: string; parent_thread_id: string | null; parent_seq: string | null }>(
            "SELECT title, thread_type, parent_thread_id, parent_seq::text AS parent_seq FROM cortex_analysis_threads WHERE thread_id = 'legacy'",
        );
        expect(rows[0]).toEqual({ title: "Kept", thread_type: "conversation", parent_thread_id: null, parent_seq: null });
    });

    // The subtree walk joins on parent_thread_id with no deleted_at predicate,
    // and neither can the referential trigger behind ON DELETE CASCADE. Postgres
    // uses a partial index only where it can prove the predicate holds, so a
    // predicate on this index takes both paths to a sequential scan.
    it("indexes the parent column over every row, live or archived", async () => {
        const definition = (await threadIndexes()).idx_cortex_analysis_threads_parent_fk;
        expect(definition).toContain("(parent_thread_id)");
        expect(definition).not.toContain("WHERE");
    });

    // CREATE INDEX IF NOT EXISTS keeps whatever definition already holds the
    // name, so a database that built the partial form needs the drop to reach it.
    it("replaces a partial index on the parent column that an earlier build left", async () => {
        await pool.query("DROP INDEX idx_cortex_analysis_threads_parent_fk");
        await pool.query("CREATE INDEX idx_cortex_analysis_threads_parent ON cortex_analysis_threads(parent_thread_id) WHERE deleted_at IS NULL");

        await initCortexState(pool);

        const indexes = await threadIndexes();
        expect(indexes).not.toHaveProperty("idx_cortex_analysis_threads_parent");
        expect(indexes.idx_cortex_analysis_threads_parent_fk).not.toContain("WHERE");
    });

    it("changes nothing on a second run", async () => {
        await initCortexState(pool);
        const columns = await threadColumns();
        const indexes = await threadIndexes();

        await initCortexState(pool);

        expect(await threadColumns()).toEqual(columns);
        expect(await threadIndexes()).toEqual(indexes);
    });
});
