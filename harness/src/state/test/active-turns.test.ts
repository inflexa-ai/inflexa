/** The turns that hold the live threads, read for one analysis or for each analysis. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { queryTurns } from "../active-turns.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
    ({ pool, drop } = await withSchema("active-turns"));
});

afterAll(async () => {
    await drop();
});

async function thread(threadId: string, analysisId: string, turnId: string | null, deleted = false): Promise<void> {
    await pool.query(
        `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, active_turn_id, deleted_at) VALUES ($1, $2, $3, ${deleted ? "NOW()" : "NULL"})`,
        [threadId, analysisId, turnId],
    );
}

describe("the turns that hold a thread", () => {
    it("gives no turn when no thread is claimed", async () => {
        await thread("t-idle", "a1", null);

        expect((await queryTurns(pool))._unsafeUnwrap()).toEqual([]);
    });

    it("gives the turn of each analysis with its analysis id when no analysis is named", async () => {
        await thread("t-1", "a1", "turn-1");
        await thread("t-2", "a2", "turn-2");
        await thread("t-gone", "a2", "turn-gone", true);

        const all = (await queryTurns(pool))._unsafeUnwrap();

        expect(all).toEqual([
            { analysisId: "a1", threadId: "t-1", turnId: "turn-1" },
            { analysisId: "a2", threadId: "t-2", turnId: "turn-2" },
        ]);
    });

    it("gives only the turns of the named analysis", async () => {
        expect((await queryTurns(pool, "a2"))._unsafeUnwrap()).toEqual([{ analysisId: "a2", threadId: "t-2", turnId: "turn-2" }]);
        expect((await queryTurns(pool, "a-none"))._unsafeUnwrap()).toEqual([]);
    });
});
