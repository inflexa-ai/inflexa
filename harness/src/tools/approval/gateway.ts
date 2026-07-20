/**
 * The poll-based tool-approval gateway — the constructed `Ask` seam realization
 * an embedder wires over its Postgres pool, plus the outward `answer` / `pending`
 * API it drives and the boot-time `sweepExpired`.
 *
 * `ask` is the per-turn seam an embedder binds: a conversation tool's `ctx.ask`
 * pauses on it. The database is the single source of truth for ask state — `ask`
 * inserts a `pending` ledger row, emits the `data-ask` part, and polls that row to
 * a terminal status; there is no in-memory resolver map. `answer` is one guarded
 * write. See the poll site below for why.
 */

import type { Pool } from "pg";

import { unwrapOrThrow } from "../../lib/result.js";
import type { EmitFn } from "../../loop/types.js";
import { AskRejectedError, type AskApproval, type AskReply, type AskRequest } from "./contract.js";
import {
    answerAsk,
    insertGrantedAsk,
    insertPendingAsk,
    markAborted,
    selectAskResolution,
    selectGrant,
    selectPending,
    sweepExpired as sweepExpiredRows,
    type AnswerOutcome,
    type AskRow,
    type AskStatus,
    type PendingAsk,
} from "./queries.js";
import { uuidv7 } from "./uuidv7.js";

export type { AnswerOutcome, PendingAsk } from "./queries.js";

/** Construction deps: the harness application pool the ledger lives in. */
export interface AskGatewayDeps {
    readonly pool: Pool;
}

/**
 * Per-turn context an embedder binds into the `Ask` seam. It scopes the ask to an
 * analysis/thread, carries the turn's abort `signal`, and supplies the `emit` sink
 * the `data-ask` part flows through.
 */
export interface AskContext {
    readonly analysisId: string;
    readonly threadId?: string;
    readonly signal: AbortSignal;
    readonly emit: EmitFn;
}

/** The gateway surface: the per-turn seam plus the outward embedder-driven API. */
export interface AskGateway {
    ask(request: AskRequest, ctx: AskContext): Promise<AskApproval>;
    answer(id: string, reply: AskReply): Promise<AnswerOutcome>;
    pending(): Promise<PendingAsk[]>;
    sweepExpired(): Promise<number>;
}

/** Fixed poll cadence — imperceptible against human decision speed, low chatter. */
const POLL_INTERVAL_MS = 200;

export function createAskGateway(deps: AskGatewayDeps): AskGateway {
    const { pool } = deps;

    async function ask(request: AskRequest, ctx: AskContext): Promise<AskApproval> {
        const id = uuidv7();
        const now = new Date().toISOString();
        const row: AskRow = {
            id,
            analysisId: ctx.analysisId,
            threadId: ctx.threadId ?? null,
            title: request.title,
            command: request.command,
            detail: request.detail ?? null,
            grantKey: request.grantKey ?? null,
            createdAt: now,
        };

        // A standing grant for this ask's grant key — the command unless the tool
        // supplied a broader key — short-circuits the prompt: record the invocation as
        // `resolved` for the audit trail and return without pausing.
        if (unwrapOrThrow(await selectGrant(pool, ctx.analysisId, request.grantKey ?? request.command))) {
            unwrapOrThrow(await insertGrantedAsk(pool, row, now));
            return { kind: "always" };
        }

        unwrapOrThrow(await insertPendingAsk(pool, row));
        await emitAskPart(ctx.emit, id, request, "pending");

        // DESIGN(WHY): we poll the ask ledger instead of holding an in-memory
        // resolver map. The DB is the single source of truth, so answering is a pure
        // UPDATE, a crash-orphaned pending row just ends the poll, and an answer that
        // arrives in a different process than the loop (a hosted deployment) still
        // lands. A resolver map would be a second state to reconcile and cannot be
        // resolved once its process dies. Latency is invisible at human decision speed
        // and can be erased later with LISTEN/NOTIFY.
        // TODO(refine): these ask records might move into provenance later.
        for (;;) {
            if (ctx.signal.aborted) {
                unwrapOrThrow(await markAborted(pool, id, new Date().toISOString()));
                await emitAskPart(ctx.emit, id, request, "aborted");
                throwAbort(ctx.signal);
            }

            const resolution = unwrapOrThrow(await selectAskResolution(pool, id));
            if (resolution === null) {
                // The row vanished out from under the poll — nothing can answer it
                // now, so deny rather than spin forever. Not reachable through the
                // ordinary status machine (rows are only ever updated, never deleted).
                await emitAskPart(ctx.emit, id, request, "expired");
                throw new AskRejectedError("approval request is no longer available");
            }
            if (resolution.status !== "pending") {
                await emitAskPart(ctx.emit, id, request, resolution.status);
                return settle(resolution.status, resolution.reply, ctx.signal);
            }

            await sleepUntil(POLL_INTERVAL_MS, ctx.signal);
        }
    }

    async function answer(id: string, reply: AskReply): Promise<AnswerOutcome> {
        return unwrapOrThrow(await answerAsk(pool, id, reply, new Date().toISOString()));
    }

    async function pending(): Promise<PendingAsk[]> {
        return unwrapOrThrow(await selectPending(pool));
    }

    async function sweepExpired(): Promise<number> {
        return unwrapOrThrow(await sweepExpiredRows(pool, new Date().toISOString()));
    }

    return { ask, answer, pending, sweepExpired };
}

/** Emit (or reconcile, under the same id) the ask's `data-ask` chat part. */
function emitAskPart(emit: EmitFn, id: string, request: AskRequest, status: AskStatus): void | Promise<void> {
    return emit({
        type: "data-ask",
        data: {
            id,
            title: request.title,
            command: request.command,
            ...(request.detail !== undefined ? { detail: request.detail } : {}),
            status,
        },
    });
}

/** Resolve an approval or throw the terminal denial the ledger recorded. */
function settle(status: Exclude<AskStatus, "pending">, reply: AskReply | null, signal: AbortSignal): AskApproval {
    switch (status) {
        case "resolved":
            // Only `once` / `always` reach `resolved`; guard the JSONB round-trip and
            // default to the narrowest approval if a malformed reply ever slipped in.
            return reply && (reply.kind === "once" || reply.kind === "always") ? reply : { kind: "once" };
        case "rejected":
            throw new AskRejectedError(reply && reply.kind === "reject" ? reply.feedback : undefined);
        case "expired":
            throw new AskRejectedError("approval request expired unanswered");
        case "aborted":
            throwAbort(signal);
    }
}

/**
 * Re-raise the turn's cancellation verbatim — `signal.reason` IS the loop's own
 * cancellation, so its existing turn-abort path recognizes it unchanged. The
 * fallback covers a signal aborted with no explicit reason.
 */
function throwAbort(signal: AbortSignal): never {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** Delay `ms`, resolving early if `signal` aborts, leaving no dangling timer. */
function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
