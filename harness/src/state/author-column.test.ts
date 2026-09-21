/**
 * `messages.author` must exist as a nullable `text` column, and adding it to an
 * older database must be purely additive.
 *
 * The author's whole contract is that absent means "no sender was recorded" — so
 * a database created before the column existed has to read back with every row's
 * author absent rather than backfilled or defaulted. That is a property of the
 * DDL, not of the write path, which is why it is pinned here rather than in
 * `memory/thread-history.test.ts` (where the round trip through `appendTurn` is
 * asserted).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { initCortexState } from "./init.js";

let pool: Pool;
let drop: () => Promise<void>;

async function authorColumn(): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | undefined> {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'author'`,
    );
    return rows[0];
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("author-column"));
});

afterEach(async () => {
    await drop?.();
});

describe("messages.author column", () => {
    it("is a nullable text column with no default on a freshly initialized schema", async () => {
        // A NOT NULL or a DEFAULT here would be the defect the column exists to
        // avoid: it would put a sender on every row, including the rows nobody sent.
        expect(await authorColumn()).toEqual({ data_type: "text", is_nullable: "YES", column_default: null });
    });

    it("adds the column to a database that predates it, leaving existing rows readable and author-free", async () => {
        await pool.query("ALTER TABLE messages DROP COLUMN author");
        await pool.query(
            `INSERT INTO messages (thread_id, seq, message_envelope, tokens)
             VALUES ('legacy', 0, $1::json, 3)`,
            [JSON.stringify({ kind: "ai-sdk-model-message", aiSdkMajor: 7, message: { role: "user", content: "kept" } })],
        );
        expect(await authorColumn()).toBeUndefined();

        await initCortexState(pool);

        expect((await authorColumn())?.data_type).toBe("text");
        const { rows } = await pool.query<{ envelope: { message: { content: string } }; author: string | null }>(
            "SELECT message_envelope AS envelope, author FROM messages WHERE thread_id = 'legacy'",
        );
        expect(rows[0]?.envelope.message.content).toBe("kept");
        expect(rows[0]?.author).toBeNull();
    });
});
