/**
 * The person columns, the step usage column, and their indexes must exist, and adding them to an older database
 * must be purely additive. A row that predates a column reads null, because no backfill runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { forgetMigrations, withSchema } from "../../__tests__/setup/postgres.js";
import { initCortexState } from "../init.js";

let pool: Pool;
let drop: () => Promise<void>;

type ColumnSpec = {
    table: string;
    column: string;
    dataType: string;
};

const COLUMNS: ColumnSpec[] = [
    { table: "cortex_runs", column: "user_id", dataType: "text" },
    { table: "cortex_analysis_threads", column: "user_id", dataType: "text" },
    { table: "cortex_analysis_threads", column: "active_turn_user_id", dataType: "text" },
    { table: "cortex_analysis_state", column: "data_profile_user_id", dataType: "text" },
    { table: "cortex_paused_work", column: "user_id", dataType: "text" },
    { table: "cortex_step_executions", column: "usage", dataType: "jsonb" },
];

async function columnOf(spec: ColumnSpec): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | undefined> {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [spec.table, spec.column],
    );
    return rows[0];
}

async function indexDefinition(name: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1", [name]);
    return rows[0]?.indexdef;
}

async function primaryKeyColumns(table: string): Promise<string[]> {
    const { rows } = await pool.query<{ attname: string }>(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indisprimary AND i.indrelid = (quote_ident(current_schema()) || '.' || quote_ident($1))::regclass
          ORDER BY array_position(i.indkey::int2[], a.attnum)`,
        [table],
    );
    return rows.map((row) => row.attname);
}

const STORED_DISPLAY_ENVELOPE = JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [] }] });

async function storeMessageWithDisplayEnvelope(): Promise<void> {
    await pool.query(
        `INSERT INTO messages (thread_id, seq, message_envelope, display_envelope, tokens)
         VALUES ('t1', 0, '{"role":"user","content":"hi"}'::json, $1::jsonb, 1)`,
        [STORED_DISPLAY_ENVELOPE],
    );
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("person-columns"));
});

afterEach(async () => {
    await drop();
});

describe("the person columns", () => {
    it("are nullable with no default on a freshly initialized schema", async () => {
        // A NOT NULL or a DEFAULT would put a person on each row, including the rows that no person made.
        for (const spec of COLUMNS) {
            expect(await columnOf(spec)).toEqual({ data_type: spec.dataType, is_nullable: "YES", column_default: null });
        }
    });

    it("make the index of the threads of one person", async () => {
        expect(await indexDefinition("idx_cortex_analysis_threads_user")).toContain("(user_id, updated_at DESC, thread_id) WHERE (deleted_at IS NULL)");
    });

    it("make the message-id tables, their key and their index, and no index on messages for the ids", async () => {
        expect(await primaryKeyColumns("cortex_message_ids")).toEqual(["thread_id", "message_id"]);
        expect(await indexDefinition("idx_cortex_message_ids_seq")).toContain("(thread_id, seq)");
        expect(await primaryKeyColumns("cortex_message_id_backfill")).toEqual(["id"]);

        const state = await pool.query("SELECT id, after_thread_id, after_seq, completed_at FROM cortex_message_id_backfill");
        expect(state.rows).toEqual([{ id: true, after_thread_id: null, after_seq: null, completed_at: null }]);

        const indexes = await pool.query<{ indexdef: string }>(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'messages'",
        );
        for (const row of indexes.rows) expect(row.indexdef).not.toContain("display_envelope");
    });

    it("are added to a database that predates them, and an existing row reads null", async () => {
        await pool.query(
            `INSERT INTO cortex_analysis_state (analysis_id, status, created_at, updated_at)
             VALUES ('a1', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        );
        await pool.query(
            `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at)
             VALUES ('r1', 'a1', 'executeAnalysis', 'running', '2026-01-01T00:00:00.000Z')`,
        );
        await pool.query("INSERT INTO cortex_analysis_threads (thread_id, analysis_id) VALUES ('t1', 'a1')");
        await pool.query(
            `INSERT INTO cortex_paused_work (workflow_id, work_id, work_kind, analysis_id, state, cause, attempt, topic, paused_at)
             VALUES ('w1', 'r1', 'run', 'a1', 'paused', '{}'::jsonb, 0, 'resume', '2026-01-01T00:00:00.000Z')`,
        );
        await pool.query(
            `INSERT INTO cortex_step_executions (analysis_id, run_id, step_id, wave, agent_id, status)
             VALUES ('a1', 'r1', 's1', 0, 'agent', 'completed')`,
        );

        await pool.query("DROP INDEX idx_cortex_analysis_threads_user");
        await pool.query("DROP TABLE cortex_message_ids, cortex_message_id_backfill");
        await storeMessageWithDisplayEnvelope();
        for (const spec of COLUMNS) await pool.query(`ALTER TABLE ${spec.table} DROP COLUMN ${spec.column}`);
        for (const spec of COLUMNS) expect(await columnOf(spec)).toBeUndefined();

        await forgetMigrations(pool);
        await initCortexState(pool);

        for (const spec of COLUMNS) expect((await columnOf(spec))?.data_type).toBe(spec.dataType);
        expect(await indexDefinition("idx_cortex_analysis_threads_user")).toBeDefined();
        expect(await indexDefinition("idx_cortex_message_ids_seq")).toBeDefined();
        const recorded = await pool.query("SELECT 1 FROM cortex_message_ids");
        expect(recorded.rowCount).toBe(0);
        const stored = await pool.query("SELECT 1 FROM messages WHERE thread_id = 't1'");
        expect(stored.rowCount).toBe(1);
        const backfill = await pool.query("SELECT after_thread_id, completed_at FROM cortex_message_id_backfill");
        expect(backfill.rows).toEqual([{ after_thread_id: null, completed_at: null }]);

        const run = await pool.query<{ user_id: string | null }>("SELECT user_id FROM cortex_runs WHERE run_id = 'r1'");
        expect(run.rows[0]?.user_id).toBeNull();
        const thread = await pool.query<{ user_id: string | null; active_turn_user_id: string | null }>(
            "SELECT user_id, active_turn_user_id FROM cortex_analysis_threads WHERE thread_id = 't1'",
        );
        expect(thread.rows[0]).toEqual({ user_id: null, active_turn_user_id: null });
        const state = await pool.query<{ data_profile_user_id: string | null }>(
            "SELECT data_profile_user_id FROM cortex_analysis_state WHERE analysis_id = 'a1'",
        );
        expect(state.rows[0]?.data_profile_user_id).toBeNull();
        const pause = await pool.query<{ user_id: string | null }>("SELECT user_id FROM cortex_paused_work WHERE workflow_id = 'w1'");
        expect(pause.rows[0]?.user_id).toBeNull();
        const step = await pool.query<{ usage: unknown }>("SELECT usage FROM cortex_step_executions WHERE step_id = 's1'");
        expect(step.rows[0]?.usage).toBeNull();
    });
});
