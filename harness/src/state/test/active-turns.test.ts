/** The turns that hold the live threads, read for one analysis or for each analysis. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { claimThreadForTurn, queryTurns, releaseThreadOfTurn } from "../active-turns.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
    ({ pool, drop } = await withSchema("active-turns"));
});

afterAll(async () => {
    await drop();
});

async function thread(threadId: string, analysisId: string, turnId: string | null, deleted = false, turnUserId: string | null = null): Promise<void> {
    await pool.query(
        `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, active_turn_id, active_turn_user_id, deleted_at)
         VALUES ($1, $2, $3, $4, ${deleted ? "NOW()" : "NULL"})`,
        [threadId, analysisId, turnId, turnUserId],
    );
}

async function holderOf(threadId: string): Promise<{ active_turn_id: string | null; active_turn_user_id: string | null }> {
    const { rows } = await pool.query<{ active_turn_id: string | null; active_turn_user_id: string | null }>(
        "SELECT active_turn_id, active_turn_user_id FROM cortex_analysis_threads WHERE thread_id = $1",
        [threadId],
    );
    return rows[0] ?? { active_turn_id: null, active_turn_user_id: null };
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
            { analysisId: "a1", threadId: "t-1", turnId: "turn-1", userId: null },
            { analysisId: "a2", threadId: "t-2", turnId: "turn-2", userId: null },
        ]);
    });

    it("gives only the turns of the named analysis", async () => {
        expect((await queryTurns(pool, "a2"))._unsafeUnwrap()).toEqual([{ analysisId: "a2", threadId: "t-2", turnId: "turn-2", userId: null }]);
        expect((await queryTurns(pool, "a-none"))._unsafeUnwrap()).toEqual([]);
    });
});

describe("the person of the turn that holds a thread", () => {
    const never = (): Promise<boolean> => Promise.resolve(false);
    const always = (): Promise<boolean> => Promise.resolve(true);

    it("writes the user of the turn with the claim, and queryTurns gives it", async () => {
        await thread("t-claim", "a-claim", null);

        const claim = (await claimThreadForTurn(pool, "t-claim", "turn-claim", "u1", never))._unsafeUnwrap();

        expect(claim).toEqual({ kind: "claimed" });
        expect(await holderOf("t-claim")).toEqual({ active_turn_id: "turn-claim", active_turn_user_id: "u1" });
        expect((await queryTurns(pool, "a-claim"))._unsafeUnwrap()).toEqual([
            { analysisId: "a-claim", threadId: "t-claim", turnId: "turn-claim", userId: "u1" },
        ]);
    });

    it("replaces the user of a holder that no longer runs", async () => {
        await thread("t-stale", "a-stale", "turn-old", false, "u1");

        const claim = (await claimThreadForTurn(pool, "t-stale", "turn-new", "u2", never))._unsafeUnwrap();

        expect(claim).toEqual({ kind: "claimed" });
        expect(await holderOf("t-stale")).toEqual({ active_turn_id: "turn-new", active_turn_user_id: "u2" });
    });

    it("keeps the holder and its user when the holder still runs", async () => {
        await thread("t-held", "a-held", "turn-live", false, "u1");

        const claim = (await claimThreadForTurn(pool, "t-held", "turn-other", "u2", always))._unsafeUnwrap();

        expect(claim).toEqual({ kind: "held", turnId: "turn-live" });
        expect(await holderOf("t-held")).toEqual({ active_turn_id: "turn-live", active_turn_user_id: "u1" });
    });

    it("writes a null user for a claim with no person", async () => {
        await thread("t-nobody", "a-nobody", "turn-old", false, "u1");

        (await claimThreadForTurn(pool, "t-nobody", "turn-new", null, never))._unsafeUnwrap();

        expect(await holderOf("t-nobody")).toEqual({ active_turn_id: "turn-new", active_turn_user_id: null });
    });

    it("clears the turn and its user together at the release", async () => {
        await thread("t-release", "a-release", null);
        (await claimThreadForTurn(pool, "t-release", "turn-release", "u1", never))._unsafeUnwrap();

        (await releaseThreadOfTurn(pool, "t-release", "turn-release"))._unsafeUnwrap();

        expect(await holderOf("t-release")).toEqual({ active_turn_id: null, active_turn_user_id: null });
    });

    it("leaves the claim of another turn as it is at a release", async () => {
        await thread("t-other", "a-other", null);
        (await claimThreadForTurn(pool, "t-other", "turn-b", "u2", never))._unsafeUnwrap();

        (await releaseThreadOfTurn(pool, "t-other", "turn-a"))._unsafeUnwrap();

        expect(await holderOf("t-other")).toEqual({ active_turn_id: "turn-b", active_turn_user_id: "u2" });
    });
});
