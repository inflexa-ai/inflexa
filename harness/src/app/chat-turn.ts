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

import type { BriefingCardPart } from "../contracts/index.js";
import { unwrapOrThrow } from "../lib/result.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { createThreadHistory, type ThreadHistory } from "../memory/thread-history.js";
import { createThreadStore } from "../memory/thread-store.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { composeBriefing, dataProfileBriefing, type ComposedBriefing } from "../prompts/briefings/index.js";
import { loadAnalysisStatus, loadDataProfileStatus } from "../state/index.js";
import { assembleMessages, type AssembledMessages } from "./message-assembly.js";

export interface PrepareChatTurnDeps {
    readonly pool: Pool;
}

export interface PrepareChatTurnParams {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
}

export type PrepareChatTurnResult =
    ({ readonly kind: "ok"; readonly briefingCards: readonly BriefingCardPart[] } & AssembledMessages) | { readonly kind: "not_found" };

/**
 * Compose and persist the main conversation's standing briefings on a thread's
 * first turn, returning one briefing-card part per injected briefing for the
 * caller to emit. Composition is caller-owned, ordered, and omits briefings
 * whose input is unavailable: the data-profile briefing is injected only when
 * the profile has completed (a pending/failed/running profile injects nothing,
 * never a placeholder). `appendBriefings` is idempotent, so a concurrent first
 * turn does not double-inject.
 */
async function composeStandingBriefings(pool: Pool, analysisId: string, threadId: string, history: ThreadHistory): Promise<BriefingCardPart[]> {
    const composed: ComposedBriefing[] = [];

    const profile = await loadDataProfileStatus(pool, analysisId).unwrapOr(null);
    if (profile?.status === "completed" && profile.result) {
        composed.push(composeBriefing(dataProfileBriefing, profile.result));
    }

    if (composed.length === 0) return [];

    unwrapOrThrow(await history.appendBriefings(threadId, composed));

    return composed.map((c) => ({
        type: "data-briefing-card" as const,
        id: `briefing-${c.name}`,
        name: c.name,
        caption: c.caption,
    }));
}

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
        console.warn("[harness.chat] title-seed failed (non-fatal):", err instanceof Error ? err.message : err);
    }

    const analysisState = await loadAnalysisStatus(pool, analysisId).unwrapOr(null);

    const history = createThreadHistory(pool);

    // Standing briefings compose once, on the thread's first turn. A thread that
    // existed before this call already carries its immutable prefix (or was
    // started when the input was unavailable and deliberately has none), so we
    // never recompose. This runs BEFORE assembly so the persisted briefing rows
    // ride the front of `loadRecent`'s window.
    //
    // "First turn" is detected by thread-row ABSENCE: a host that pre-creates
    // thread rows before the first prepareChatTurn call would never brief.
    // Hosts must let this call create the thread (the CLI does).
    const briefingCards = existing ? [] : await composeStandingBriefings(pool, analysisId, threadId, history);

    const { messages, userMessage } = await assembleMessages({
        threadId,
        analysisId,
        userInput,
        analysisContext: analysisState?.context ?? null,
        history,
        workingMemory: createWorkingMemory(pool),
    });

    return { kind: "ok", messages, userMessage, briefingCards };
}
