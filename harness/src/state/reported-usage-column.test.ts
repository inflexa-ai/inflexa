/**
 * `messages.reported_usage` must exist as a nullable `jsonb` column, and adding
 * it to an older database must be purely additive.
 *
 * The rollup's whole contract is that absent means "nothing was reported" — so a
 * database created before the column existed has to read back with every row's
 * rollup absent rather than backfilled, defaulted, or zeroed. That is a property
 * of the DDL, not of the write path, which is why it is pinned here rather than
 * in `memory/thread-history.test.ts` (where the round trip through `appendTurn`
 * is asserted).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { initCortexState } from "./init.js";

let pool: Pool;
let drop: () => Promise<void>;

async function reportedUsageColumn(): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | undefined> {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'reported_usage'`,
    );
    return rows[0];
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("reported-usage-column"));
});

afterEach(async () => {
    await drop?.();
});

describe("messages.reported_usage column", () => {
    it("is a nullable jsonb column with no default on a freshly initialized schema", async () => {
        // A NOT NULL or a DEFAULT here would be the defect the column exists to
        // avoid: it would turn "was told nothing" into "spent nothing" on every row.
        expect(await reportedUsageColumn()).toEqual({ data_type: "jsonb", is_nullable: "YES", column_default: null });
    });

    it("adds the column to a database that predates it, leaving existing rows readable and rollup-free", async () => {
        await pool.query("ALTER TABLE messages DROP COLUMN reported_usage");
        await pool.query(
            `INSERT INTO messages (thread_id, seq, message_envelope, tokens)
             VALUES ('legacy', 0, $1::json, 3)`,
            [JSON.stringify({ kind: "ai-sdk-model-message", aiSdkMajor: 7, message: { role: "user", content: "kept" } })],
        );
        expect(await reportedUsageColumn()).toBeUndefined();

        await initCortexState(pool);

        expect((await reportedUsageColumn())?.data_type).toBe("jsonb");
        const { rows } = await pool.query<{ envelope: { message: { content: string } }; reported_usage: unknown }>(
            "SELECT message_envelope AS envelope, reported_usage FROM messages WHERE thread_id = 'legacy'",
        );
        expect(rows[0]?.envelope.message.content).toBe("kept");
        expect(rows[0]?.reported_usage).toBeNull();
    });
});
