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
import { createThreadStore } from "../memory/thread-store.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { loadAnalysisStatus } from "../state/index.js";
import { assembleMessages, type AssembledMessages } from "./message-assembly.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";

export interface PrepareChatTurnDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Pool;
}

export interface PrepareChatTurnParams {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
}

export type PrepareChatTurnResult = ({ readonly kind: "ok" } & AssembledMessages) | { readonly kind: "not_found" };

/**
 * Prepare one chat turn: resolve thread ownership, seed the title, load
 * analysis status, and assemble the message array. Input sanitization stays
 * inside {@link assembleMessages} (applied once to the new user input only).
 */
export async function prepareChatTurn(deps: PrepareChatTurnDeps, params: PrepareChatTurnParams): Promise<PrepareChatTurnResult> {
    const { pool } = deps;
    const { analysisId, threadId, userInput } = params;

    // Ownership check before any read/write of the thread — a `threadId`
    // owned by a different analysis is indistinguishable from a missing one.
    const store = createThreadStore(pool);
    const existing = unwrapOrThrow(await store.getThread(threadId));
    if (existing && existing.analysisId !== analysisId) {
        return { kind: "not_found" };
    }

    // Seed the thread title from the first user message. Best-effort.
    try {
        if (!existing) {
            unwrapOrThrow(
                await store.createThread({
                    threadId,
                    analysisId,
                    title: deriveThreadTitle(userInput),
                }),
            );
        } else if (!existing.title || existing.title.length === 0) {
            unwrapOrThrow(await store.updateTitle(threadId, deriveThreadTitle(userInput)));
        }
    } catch (err) {
        const logger = (deps.logger ?? createNoopLogger()).named("harness.chat");
        logger.warn("title-seed failed (non-fatal)", logger.errorFields(err));
    }

    const analysisState = await loadAnalysisStatus(pool, analysisId).unwrapOr(null);

    const history = createThreadHistory(pool);
    const { messages, userMessage } = await assembleMessages({
        threadId,
        analysisId,
        userInput,
        analysisContext: analysisState?.context ?? null,
        history,
        workingMemory: createWorkingMemory(pool),
    });

    return { kind: "ok", messages, userMessage };
}
