/**
 * The turn that runs on a thread. The open of a turn claims the thread, and the
 * end of the turn releases it. A claim whose turn no longer runs, for example
 * after a cancel, gives way to the next turn.
 */

import type { ResultAsync } from "neverthrow";
import { z } from "zod";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

const HolderRowSchema = z.object({ active_turn_id: z.string().nullable() });

/** The outcome of a claim: the thread is the turn's, another turn that still runs holds it, or no live thread exists. */
export type TurnClaim = { readonly kind: "claimed" } | { readonly kind: "held"; readonly turnId: string } | { readonly kind: "no_thread" };

/** Each attempt reads the holder one time. A holder that changes between two reads takes one more attempt. */
const CLAIM_ATTEMPTS = 3;

/**
 * Claim the thread for a turn. `stillRuns` decides if the turn that holds the thread runs. A holder that does not
 * run gives way. Each update names the holder that it replaces, thus two opens cannot both take the thread.
 */
export function claimThreadForTurn(
    pool: Querier,
    threadId: string,
    turnId: string,
    stillRuns: (turnId: string) => Promise<boolean>,
): ResultAsync<TurnClaim, DbError> {
    return tryQuery("activeTurns.claim", async (): Promise<TurnClaim> => {
        let holder: string | null = null;
        for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
            const { rows } = await pool.query("SELECT active_turn_id FROM cortex_analysis_threads WHERE thread_id = $1 AND deleted_at IS NULL", [threadId]);
            const row = rows[0];
            if (row === undefined) return { kind: "no_thread" };
            holder = HolderRowSchema.parse(row).active_turn_id;
            if (holder !== null && holder !== turnId && (await stillRuns(holder))) return { kind: "held", turnId: holder };
            const taken = await pool.query(
                `UPDATE cortex_analysis_threads SET active_turn_id = $2
                  WHERE thread_id = $1 AND active_turn_id IS NOT DISTINCT FROM $3`,
                [threadId, turnId, holder],
            );
            if ((taken.rowCount ?? 0) > 0) return { kind: "claimed" };
        }
        return { kind: "held", turnId: holder ?? "" };
    });
}

/**
 * Close each turn record of the thread that is still `open`, as `aborted`. A turn that a cancel ended runs no more
 * code, thus the harness closes its record here. A record that is closed already does not change.
 */
export function closeOpenTurnRecords(pool: Querier, threadId: string): ResultAsync<void, DbError> {
    return tryMutation("activeTurns.closeOpen", () =>
        pool.query("UPDATE cortex_thread_turns SET status = 'aborted', closed_at = NOW() WHERE thread_id = $1 AND status = 'open'", [threadId]),
    ).map(() => undefined);
}

const AskTurnRowSchema = z.object({ active_turn_id: z.string().nullable() });

/** The turn that runs on the thread of an ask, which waits for its answer. `undefined` when no turn runs there. */
export function turnOfAsk(pool: Querier, askId: string): ResultAsync<string | undefined, DbError> {
    return tryQuery("activeTurns.turnOfAsk", async () => {
        const { rows } = await pool.query(
            `SELECT threads.active_turn_id FROM cortex_asks asks
               JOIN cortex_analysis_threads threads ON threads.thread_id = asks.thread_id
              WHERE asks.id = $1`,
            [askId],
        );
        const row = rows[0];
        return row === undefined ? undefined : (AskTurnRowSchema.parse(row).active_turn_id ?? undefined);
    });
}

const TurnOfThreadRowSchema = z.object({ thread_id: z.string(), active_turn_id: z.string() });

/** The turn that holds each live thread of an analysis. A claim can outlive its turn, thus a caller checks that the turn runs. */
export function queryTurnsOfAnalysis(pool: Querier, analysisId: string): ResultAsync<{ readonly threadId: string; readonly turnId: string }[], DbError> {
    return tryQuery("activeTurns.ofAnalysis", async () => {
        const { rows } = await pool.query(
            `SELECT thread_id, active_turn_id FROM cortex_analysis_threads
              WHERE analysis_id = $1 AND active_turn_id IS NOT NULL AND deleted_at IS NULL`,
            [analysisId],
        );
        return rows.map((row) => {
            const parsed = TurnOfThreadRowSchema.parse(row);
            return { threadId: parsed.thread_id, turnId: parsed.active_turn_id };
        });
    });
}

/** Release the thread, when the turn still holds it. A second release changes nothing. */
export function releaseThreadOfTurn(pool: Querier, threadId: string, turnId: string): ResultAsync<void, DbError> {
    return tryMutation("activeTurns.release", () =>
        pool.query("UPDATE cortex_analysis_threads SET active_turn_id = NULL WHERE thread_id = $1 AND active_turn_id = $2", [threadId, turnId]),
    ).map(() => undefined);
}
