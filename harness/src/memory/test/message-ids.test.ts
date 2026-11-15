import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import type { Pool } from "pg";

import { sleep } from "../../lib/async-utils.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { backfillMessageIds } from "../message-ids.js";
import { storedMessagesToChat } from "../conversation-display-replay.js";
import type { ConversationUIMessage } from "../conversation-display-storage.js";
import { createThreadHistory, type ThreadHistory } from "../thread-history.js";

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";

let pool: Pool;
let drop: () => Promise<void>;
let history: ThreadHistory;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("message-ids"));
    history = createThreadHistory(pool);
});

afterEach(async () => {
    await drop();
});

function userText(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): ModelMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
}

function displayed(id: string, role: "user" | "assistant", text: string): ConversationUIMessage {
    return { id, role, parts: [{ type: "text", text, state: "done" }] };
}

/** One turn of two display messages: `user-n` at the opening row and `assistant-n` at the next row. */
async function writeTurn(threadId: string, n: number): Promise<void> {
    (
        await history.appendTurn(threadId, {
            modelMessages: [userText(`ask ${n}`), assistantText(`answer ${n}`)],
            displayMessages: [displayed(`user-${n}`, "user", `ask ${n}`), displayed(`assistant-${n}`, "assistant", `answer ${n}`)],
        })
    )._unsafeUnwrap();
}

type Record = { thread_id: string; message_id: string; seq: string };

async function records(threadId?: string): Promise<Record[]> {
    const { rows } = await pool.query<Record>(
        `SELECT thread_id, message_id, seq::text AS seq FROM cortex_message_ids
          WHERE $1::text IS NULL OR thread_id = $1 ORDER BY thread_id, seq::bigint, message_id`,
        [threadId ?? null],
    );
    return rows;
}

async function backfillState(): Promise<{ after_thread_id: string | null; after_seq: string | null; completed: boolean }> {
    const { rows } = await pool.query<{ after_thread_id: string | null; after_seq: string | null; completed: boolean }>(
        "SELECT after_thread_id, after_seq::text AS after_seq, (completed_at IS NOT NULL) AS completed FROM cortex_message_id_backfill",
    );
    const [state] = rows;
    if (state === undefined) throw new Error("the backfill state row is absent");
    return state;
}

async function countOf(table: "messages" | "cortex_message_ids"): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
}

/** Two threads of older rows: the rows exist, and no record of any id exists. */
async function seedOlderRows(): Promise<Record[]> {
    for (let n = 1; n <= 3; n++) await writeTurn(THREAD_A, n);
    for (let n = 1; n <= 2; n++) await writeTurn(THREAD_B, n);
    const recorded = await records();
    await pool.query("DELETE FROM cortex_message_ids");
    return recorded;
}

describe("backfillMessageIds", () => {
    it("records each older id of two threads with the seq of its first row, and stores the completion", async () => {
        const expected = await seedOlderRows();
        expect(expected).toHaveLength(10);

        const outcome = (await backfillMessageIds(pool, { batchSize: 3 }))._unsafeUnwrap();

        expect(await records()).toEqual(expected);
        expect(outcome).toEqual({ rows: await countOf("messages"), ids: 10 });
        const state = await backfillState();
        expect(state.completed).toBe(true);
        expect(state).toMatchObject({ after_thread_id: THREAD_B, after_seq: "3" });
    });

    it("reads a count of rows that fills a last batch exactly, and then completes on the next empty batch", async () => {
        const expected = await seedOlderRows();
        const total = await countOf("messages");

        const outcome = (await backfillMessageIds(pool, { batchSize: total }))._unsafeUnwrap();

        expect(outcome).toEqual({ rows: total, ids: expected.length });
        expect((await backfillState()).completed).toBe(true);
    });

    it("continues after the stored cursor and reads no row before it", async () => {
        const expected = await seedOlderRows();
        await pool.query("UPDATE cortex_message_id_backfill SET after_thread_id = $1, after_seq = 5", [THREAD_A]);

        const outcome = (await backfillMessageIds(pool, { batchSize: 2 }))._unsafeUnwrap();

        expect(await records()).toEqual(expected.filter((record) => record.thread_id === THREAD_B));
        expect(outcome.rows).toBe(4);
        expect(outcome.ids).toBe(4);
    });

    it("records nothing after the completion", async () => {
        await seedOlderRows();
        (await backfillMessageIds(pool))._unsafeUnwrap();
        await pool.query("DELETE FROM cortex_message_ids");

        const outcome = (await backfillMessageIds(pool))._unsafeUnwrap();

        expect(outcome).toEqual({ rows: 0, ids: 0 });
        expect(await records()).toEqual([]);
    });

    it("completes at once for a database with no message", async () => {
        const outcome = (await backfillMessageIds(pool))._unsafeUnwrap();

        expect(outcome).toEqual({ rows: 0, ids: 0 });
        expect((await backfillState()).completed).toBe(true);
    });

    it("keeps the record of a later round, and gives the same message as the transcript", async () => {
        (
            await history.writeTurn(THREAD_A, {
                opening: { modelMessages: [userText("ask")], displayMessages: [displayed("user-1", "user", "ask")] },
                rounds: [
                    { modelMessages: [assistantText("first")], displayMessages: [displayed("assistant-1", "assistant", "first")] },
                    { modelMessages: [assistantText("second")], displayMessages: [displayed("assistant-1", "assistant", "second")] },
                ],
            })
        )._unsafeUnwrap();
        // The turn was open across an upgrade: the first round has no record, and the later round recorded the id.
        await pool.query("DELETE FROM cortex_message_ids");
        await pool.query("INSERT INTO cortex_message_ids (thread_id, message_id, seq) VALUES ($1, 'assistant-1', 2)", [THREAD_A]);

        (await backfillMessageIds(pool))._unsafeUnwrap();

        expect(await records(THREAD_A)).toEqual([
            { thread_id: THREAD_A, message_id: "user-1", seq: "0" },
            { thread_id: THREAD_A, message_id: "assistant-1", seq: "2" },
        ]);
        const transcript = storedMessagesToChat((await history.loadAll(THREAD_A))._unsafeUnwrap().flat());
        const message = (await history.loadMessage(THREAD_A, "assistant-1"))._unsafeUnwrap();
        expect(message).toEqual(transcript.find((candidate) => candidate.id === "assistant-1") ?? null);
        expect(message?.parts.length).toBeGreaterThan(1);
    });

    it("records nothing for an envelope whose messages are not an array, and completes", async () => {
        const envelopes = ['{"messages": "not an array"}', '{"messages": {"id": "an-object"}}', '{"messages": [null, 7, "text"]}', '{"version": 1}', "null"];
        for (const [seq, envelope] of envelopes.entries()) {
            await pool.query(`INSERT INTO messages (thread_id, seq, message_envelope, display_envelope, tokens) VALUES ($1, $2, '{}'::json, $3::jsonb, 1)`, [
                THREAD_A,
                seq,
                envelope,
            ]);
        }
        await pool.query(`INSERT INTO messages (thread_id, seq, message_envelope, tokens) VALUES ($1, 9, '{}'::json, 1)`, [THREAD_A]);

        const outcome = (await backfillMessageIds(pool, { batchSize: 2 }))._unsafeUnwrap();

        expect(outcome).toEqual({ rows: 6, ids: 0 });
        expect(await records()).toEqual([]);
        expect((await backfillState()).completed).toBe(true);
    });

    it("reads a batch size that is not a positive integer as the default", async () => {
        const expected = await seedOlderRows();

        for (const batchSize of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await pool.query("UPDATE cortex_message_id_backfill SET after_thread_id = NULL, after_seq = NULL, completed_at = NULL");
            await pool.query("DELETE FROM cortex_message_ids");

            expect((await backfillMessageIds(pool, { batchSize }))._unsafeUnwrap()).toEqual({ rows: await countOf("messages"), ids: expected.length });
            expect(await records()).toEqual(expected);
        }
    });

    it("stops at a failed batch with the cursor at the last committed batch, and a later call finishes", async () => {
        const expected = await seedOlderRows();
        await pool.query(
            `CREATE FUNCTION refuse_assistant_2() RETURNS trigger AS $$ BEGIN
               IF NEW.message_id = 'assistant-2' THEN RAISE EXCEPTION 'simulated record failure'; END IF;
               RETURN NEW;
             END; $$ LANGUAGE plpgsql`,
        );
        await pool.query("CREATE TRIGGER refuse_assistant_2_trg BEFORE INSERT ON cortex_message_ids FOR EACH ROW EXECUTE FUNCTION refuse_assistant_2()");

        const failure = (await backfillMessageIds(pool, { batchSize: 1 }))._unsafeUnwrapErr();

        expect(failure).toMatchObject({ type: "mutation_failed", op: "message-ids.backfill.readBatch" });
        // Each turn is two rows, and the envelope rides the first. Batches 1 and 2 commit rows 0 and 1, and batch 3 holds `assistant-2`.
        expect(await backfillState()).toEqual({ after_thread_id: THREAD_A, after_seq: "1", completed: false });
        expect((await records()).map((record) => record.message_id)).toEqual(["assistant-1", "user-1"]);

        await pool.query("DROP TRIGGER refuse_assistant_2_trg ON cortex_message_ids");
        const outcome = (await backfillMessageIds(pool, { batchSize: 1 }))._unsafeUnwrap();

        expect(await records()).toEqual(expected);
        expect(outcome.rows).toBe((await countOf("messages")) - 2);
        expect((await backfillState()).completed).toBe(true);
    });

    it("records each id one time when two calls run at the same time, and reads each row one time", async () => {
        const expected = await seedOlderRows();

        const run = async () => (await backfillMessageIds(pool, { batchSize: 2 }))._unsafeUnwrap();
        const outcomes = await Promise.all([run(), run()]);

        expect(await records()).toEqual(expected);
        expect(outcomes.reduce((sum, outcome) => sum + outcome.rows, 0)).toBe(await countOf("messages"));
        expect(outcomes.reduce((sum, outcome) => sum + outcome.ids, 0)).toBe(expected.length);
        expect((await backfillState()).completed).toBe(true);
    });

    it("stores the numeric last key as the cursor when the seqs of a batch have different digit counts", async () => {
        const total = 2500;
        await pool.query(
            `INSERT INTO messages (thread_id, seq, message_envelope, display_envelope, tokens)
             SELECT $1, n, '{}'::json, jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('id', 'm-' || n))), 1
               FROM generate_series(1, $2::int) AS n`,
            [THREAD_A, total],
        );

        const outcome = (await backfillMessageIds(pool, { batchSize: 1000 }))._unsafeUnwrap();

        expect(outcome).toEqual({ rows: await countOf("messages"), ids: total });
        expect(await countOf("cortex_message_ids")).toBe(total);
        expect(await backfillState()).toEqual({ after_thread_id: THREAD_A, after_seq: String(total), completed: true });
    });

    it("makes a delete wait for a batch that runs, and no record of the retracted turn remains", async () => {
        await writeTurn(THREAD_A, 1);
        await writeTurn(THREAD_A, 2);
        const headRecords = (await records(THREAD_A)).filter((record) => record.message_id.endsWith("-1"));
        // The rows of the tail turn have no record yet, as an older row has none.
        await pool.query("DELETE FROM cortex_message_ids WHERE message_id LIKE '%-2'");

        // This connection holds the state row in place of a batch that read a row of the tail turn.
        const batch = await pool.connect();
        let retractFinished = false;
        try {
            await batch.query("BEGIN");
            await batch.query("SELECT 1 FROM cortex_message_id_backfill FOR UPDATE");

            const retract = history.retractLastTurn(THREAD_A);
            void retract.then(() => {
                retractFinished = true;
            });
            await waitForBlockedBackend();
            expect(retractFinished).toBe(false);

            await batch.query("INSERT INTO cortex_message_ids (thread_id, message_id, seq) VALUES ($1, 'user-2', 2), ($1, 'assistant-2', 3)", [THREAD_A]);
            expect(retractFinished).toBe(false);
            await batch.query("COMMIT");

            expect((await retract)._unsafeUnwrap()).toEqual({ kind: "retracted", messages: 2 });
        } finally {
            await batch.query("ROLLBACK");
            batch.release();
        }

        expect(await records(THREAD_A)).toEqual(headRecords);
    });
});

/** Wait until a backend waits for a lock on the state row of the backfill, so a test proves that the delete is blocked. */
async function waitForBlockedBackend(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await pool.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%FROM cortex_message_id_backfill WHERE completed_at IS NULL FOR SHARE%'`,
        );
        if (rows.length > 0) return;
        await sleep(50);
    }
    throw new Error("no backend waits for the state row of the backfill");
}
