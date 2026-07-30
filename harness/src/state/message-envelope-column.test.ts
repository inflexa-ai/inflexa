/**
 * `messages.message_envelope` must be `json`, not `jsonb`.
 *
 * JSONB re-sorts object keys on the way in, so a stored turn reads back with
 * every free-form payload rewritten and no longer matches the prefix the
 * provider's prompt cache holds. The fidelity of the round trip is asserted in
 * `memory/thread-history.test.ts`; this pins the column type that makes it hold,
 * on a fresh database and on one created before the type changed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { initCortexState } from "./init.js";

let pool: Pool;
let drop: () => Promise<void>;

async function envelopeColumnType(): Promise<string | undefined> {
    const { rows } = await pool.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'message_envelope'`,
    );
    return rows[0]?.data_type;
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("message-envelope-column"));
});

afterEach(async () => {
    await drop?.();
});

describe("messages.message_envelope column type", () => {
    it("is json on a freshly initialized schema", async () => {
        expect(await envelopeColumnType()).toBe("json");
    });

    it("converts an existing jsonb column to json, preserving its rows", async () => {
        await pool.query("ALTER TABLE messages ALTER COLUMN message_envelope TYPE jsonb USING message_envelope::text::jsonb");
        await pool.query(
            `INSERT INTO messages (thread_id, seq, message_envelope, tokens)
             VALUES ('legacy', 0, $1::jsonb, 3)`,
            [JSON.stringify({ kind: "ai-sdk-model-message", aiSdkMajor: 7, message: { role: "user", content: "kept" } })],
        );
        expect(await envelopeColumnType()).toBe("jsonb");

        await initCortexState(pool);

        expect(await envelopeColumnType()).toBe("json");
        const { rows } = await pool.query<{ envelope: { message: { content: string } } }>(
            "SELECT message_envelope AS envelope FROM messages WHERE thread_id = 'legacy'",
        );
        expect(rows[0]?.envelope.message.content).toBe("kept");
    });

    it("leaves the column alone when it is already json", async () => {
        // The conversion rewrites the whole table, and init runs at every boot —
        // so re-running it must not re-alter a column already at the target type.
        await pool.query("INSERT INTO messages (thread_id, seq, message_envelope, tokens) VALUES ('t', 0, $1::json, 1)", [
            JSON.stringify({ kind: "ai-sdk-model-message", aiSdkMajor: 7, message: { role: "user", content: "hi" } }),
        ]);
        const { rows: before } = await pool.query<{ ctid: string }>("SELECT ctid::text FROM messages WHERE thread_id = 't'");

        await initCortexState(pool);

        expect(await envelopeColumnType()).toBe("json");
        // An unchanged physical row location is the observable proof no rewrite ran.
        const { rows: after } = await pool.query<{ ctid: string }>("SELECT ctid::text FROM messages WHERE thread_id = 't'");
        expect(after[0]?.ctid).toBe(before[0]!.ctid);
    });
});
