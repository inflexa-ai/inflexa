/**
 * Chat-turn preparation — the host-agnostic assembly half of one chat turn.
 *
 * This is the PREPARATION half of a conversation turn, lifted out of the HTTP
 * route so callers other than the route (e.g. a CLI) can reuse it. It owns,
 * in order: thread-ownership resolution, best-effort title seeding, analysis
 * status load, and message assembly. It deliberately owns NONE of the
 * transport orchestration (streaming/SSE/queue/status codes) — that stays in
 * the caller. A turn is `prepareChatTurn → runAgent(own emit) → appendTurn`.
 *
 * Returns a typed result: `not_found` when the `threadId` is owned by a
 * different analysis (indistinguishable from absent), otherwise `ok` with the
 * assembled `messages` and the standalone `userMessage` the caller persists.
 */

import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore, type ThreadType } from "../memory/thread-store.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { loadAnalysisStatus, queryNonTerminalRunsByAnalysis } from "../state/index.js";
import { assembleMessages, type AssembledMessages } from "./message-assembly.js";
import { renderRunActivity, renderRunActivityUnavailable, RUN_ACTIVITY_DETAIL_LIMIT } from "./run-activity.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { bindReportObservation, type EmitReportObservation } from "../tools/report-observation.js";

export interface PrepareChatTurnDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Pool;
    /**
     * The session observation seam. The turn holds the one site that writes the
     * conversation thread of an analysis, thus it is the one site that can tell
     * the embedder the true moment of that creation.
     *
     * The seam is optional and fire-and-forget, the same as it is at each site of
     * a report session.
     */
    readonly emitReportObservation?: EmitReportObservation;
}

export interface PrepareChatTurnParams {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
}

export type PrepareChatTurnResult = ({ readonly kind: "ok"; readonly threadType: ThreadType } & AssembledMessages) | { readonly kind: "not_found" };

/**
 * Prepare one chat turn: resolve thread ownership, seed the title, load
 * analysis status, and assemble the message array. Input sanitization stays
 * inside {@link assembleMessages} (applied once to the new user input only).
 */
export async function prepareChatTurn(deps: PrepareChatTurnDeps, params: PrepareChatTurnParams): Promise<PrepareChatTurnResult> {
    const { pool } = deps;
    const { analysisId, threadId, userInput } = params;
    const logger = (deps.logger ?? createNoopLogger()).named("harness.chat");
    // An unbound seam gives a call that does nothing, thus the emit below needs no
    // test of its own.
    const observe = bindReportObservation(deps.emitReportObservation, logger);

    // Ownership check before any read/write of the thread — a `threadId`
    // owned by a different analysis is indistinguishable from a missing one.
    const store = createThreadStore(pool);
    const existing = unwrapOrThrow(await store.getThread(threadId));
    if (existing && existing.analysisId !== analysisId) {
        return { kind: "not_found" };
    }

    // The type a caller resolves the turn's agent from, and the type that the
    // message assembly reads for its tail. An existing row carries
    // its own. An absent one defaults to `conversation` — the store's own
    // default — so a best-effort create that fails non-fatally still leaves a
    // usable type; a successful create overrides it from the returned row.
    let threadType: ThreadType = existing ? existing.threadType : "conversation";

    // Seed the thread title from the first user message. Best-effort.
    try {
        if (!existing) {
            // `createThread` is idempotent (ON CONFLICT reads the row back), so
            // the returned row is authoritative for the type: a create that
            // races another writer reflects the stored type, not an assumed one.
            const created = unwrapOrThrow(
                await store.createThread({
                    threadId,
                    analysisId,
                    title: deriveThreadTitle(userInput),
                }),
            );
            threadType = created.threadType;
            // This branch is the one site that writes a conversation thread, thus
            // the emit lands one time for each analysis. The kind comes from the
            // row and not from an assumption, because the insert is idempotent and
            // the store tells a caller to read the type back. A root session has no
            // parent, thus the event carries none.
            observe({ type: "create-session", analysisId, threadId, sessionKind: created.threadType });
        } else if (!existing.title || existing.title.length === 0) {
            unwrapOrThrow(await store.updateTitle(threadId, deriveThreadTitle(userInput)));
        }
    } catch (err) {
        logger.warn("title-seed failed (non-fatal)", logger.errorFields(err));
    }

    const analysisState = await loadAnalysisStatus(pool, analysisId).unwrapOr(null);
    const runActivityContext = await queryNonTerminalRunsByAnalysis(pool, analysisId, RUN_ACTIVITY_DETAIL_LIMIT).match(
        (activity) => renderRunActivity(activity),
        () => renderRunActivityUnavailable(),
    );

    const history = createThreadHistory(pool);
    const { messages, userMessage } = await assembleMessages({
        threadId,
        threadType,
        analysisId,
        userInput,
        analysisContext: analysisState?.context ?? null,
        runActivityContext,
        history,
        workingMemory: createWorkingMemory(pool),
        ...(deps.logger ? { logger: deps.logger } : {}),
    });

    return { kind: "ok", threadType, messages, userMessage };
}
