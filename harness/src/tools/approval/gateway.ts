/**
 * The tool-approval gateway: the ask ledger over the Postgres pool of an
 * embedder. A turn workflow raises an ask under a known id and waits for the
 * answer itself. `answer` is one guarded write, and `pending` and the boot-time
 * `sweepExpired` read and expire the ledger.
 */

import type { Pool } from "pg";

import { unwrapOrThrow } from "../../lib/result.js";
import type { AskPart } from "../../contracts/chat-parts.js";
import type { AskReply, AskRequest } from "./contract.js";
import {
    answerAsk,
    insertGrantedAsk,
    insertPendingAsk,
    markAborted,
    markExpired,
    selectGrant,
    selectPending,
    sweepExpired as sweepExpiredRows,
    type AnswerOutcome,
    type AskRow,
    type AskStatus,
    type PendingAsk,
} from "./queries.js";

export type { AnswerOutcome, PendingAsk } from "./queries.js";

/** Construction deps: the harness application pool the ledger lives in. */
export type AskGatewayDeps = {
    readonly pool: Pool;
};

/** Who an ask goes to and where it belongs. */
export type AskScope = {
    readonly analysisId: string;
    /** The opaque identity of the person the ask goes to. The harness never reads it. */
    readonly userId: string;
    readonly threadId?: string;
};

/** The gateway surface: the raise of a turn and the outward embedder-driven API. */
export type AskGateway = {
    /**
     * Raise an ask under a known id, for a turn workflow that waits for the answer itself. A standing grant settles
     * it at once as `resolved`. Else the row waits as `pending`. A second raise of the same id changes nothing.
     */
    raise(id: string, request: AskRequest, scope: AskScope): Promise<"granted" | "pending">;
    /** Mark a pending ask `expired`. */
    expire(id: string): Promise<void>;
    /** Mark a pending ask `aborted`. */
    abort(id: string): Promise<void>;
    answer(id: string, reply: AskReply): Promise<AnswerOutcome>;
    pending(): Promise<PendingAsk[]>;
    /** Expire pending asks older than `maxAgeMs` (default {@link DEFAULT_SWEEP_MAX_AGE_MS}). */
    sweepExpired(maxAgeMs?: number): Promise<number>;
};

/**
 * Pending rows older than this are treated as orphans of a dead process. Far
 * beyond any plausible live turn, so a boot sweep during a rolling deployment
 * cannot expire an ask another pod is still waiting on.
 */
export const DEFAULT_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createAskGateway(deps: AskGatewayDeps): AskGateway {
    const { pool } = deps;

    async function raise(id: string, request: AskRequest, scope: AskScope): Promise<"granted" | "pending"> {
        const now = new Date().toISOString();
        const row: AskRow = {
            id,
            analysisId: scope.analysisId,
            userId: scope.userId,
            threadId: scope.threadId ?? null,
            title: request.title,
            command: request.command,
            detail: request.detail ?? null,
            grantKey: request.grantKey ?? null,
            createdAt: now,
        };
        if (unwrapOrThrow(await selectGrant(pool, scope.analysisId, scope.userId, request.grantKey ?? request.command))) {
            unwrapOrThrow(await insertGrantedAsk(pool, row, now));
            return "granted";
        }
        unwrapOrThrow(await insertPendingAsk(pool, row));
        return "pending";
    }

    async function expire(id: string): Promise<void> {
        unwrapOrThrow(await markExpired(pool, id, new Date().toISOString()));
    }

    async function abort(id: string): Promise<void> {
        unwrapOrThrow(await markAborted(pool, id, new Date().toISOString()));
    }

    async function answer(id: string, reply: AskReply): Promise<AnswerOutcome> {
        return unwrapOrThrow(await answerAsk(pool, id, reply, new Date().toISOString()));
    }

    async function pending(): Promise<PendingAsk[]> {
        return unwrapOrThrow(await selectPending(pool));
    }

    async function sweepExpired(maxAgeMs: number = DEFAULT_SWEEP_MAX_AGE_MS): Promise<number> {
        const now = Date.now();
        return unwrapOrThrow(await sweepExpiredRows(pool, new Date(now).toISOString(), new Date(now - maxAgeMs).toISOString()));
    }

    return { raise, expire, abort, answer, pending, sweepExpired };
}

/** The `data-ask` part of an ask in one status. Each status of one ask reconciles under the same id. */
export function askPartOf(id: string, request: AskRequest, status: AskStatus, reply?: AskReply["kind"]): AskPart {
    const part: AskPart = {
        type: "data-ask",
        id,
        title: request.title,
        command: request.command,
        status,
    };
    if (request.detail !== undefined) part.detail = request.detail;
    if (reply !== undefined) part.reply = reply;
    return part;
}
