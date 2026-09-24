/**
 * The chat turn of a host: a turn is `runChatTurn`, and `prepareChatTurn` is its first step. The
 * host gives only its transport values, and the harness stores the opening, each round, and the outcome.
 */

import type { Pool } from "pg";

import type { AgentSession } from "../auth/types.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { TokenUsageRollup } from "../contracts/usage.js";
import type { DbError } from "../lib/db-result.js";
import { unwrapOrThrow } from "../lib/result.js";
import { finalText, runAgent, type AgentFinish } from "../loop/run-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import type { EmitFn } from "../loop/types.js";
import { createConversationDisplayRecorder } from "../memory/conversation-display-recorder.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { conversationRecordTurn, createThreadHistory, type ConversationTurn, type TurnClose } from "../memory/thread-history.js";
import { createThreadStore, type ThreadType } from "../memory/thread-store.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { findProviderError } from "../providers/errors.js";
import { CONVERSATION_PROMPT_CACHE } from "../providers/prompt-cache.js";
import type { AgentChat, PromptCachePolicy } from "../providers/types.js";
import type { ThreadAgentResolver } from "../runtime/assemble.js";
import { loadAnalysisStatus, queryNonTerminalRunsByAnalysis } from "../state/index.js";
import { createToolOutputStore } from "../state/tool-outputs.js";
import type { AskApproval, AskRequest } from "../tools/approval/contract.js";
import { suspensionOfFailure } from "../workflows/suspension.js";
import { assembleMessages, type AssembledMessages } from "./message-assembly.js";
import { renderRunActivity, renderRunActivityUnavailable, RUN_ACTIVITY_DETAIL_LIMIT } from "./run-activity.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { bindSessionEmit, type ProvenanceSeam } from "../provenance/seam.js";

export interface PrepareChatTurnDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Pool;
    /**
     * The provenance seam. The turn reads its session emit member, and no other
     * member. The turn holds the one site that writes the conversation thread of
     * an analysis, thus it is the one site that can tell the embedder the true
     * moment of that creation.
     *
     * The member is optional and fire-and-forget, the same as it is at each site
     * of a report session.
     */
    readonly provenance?: ProvenanceSeam;
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
    // An unbound member gives a call that does nothing, thus the emit below needs
    // no test of its own.
    const observe = bindSessionEmit(deps.provenance, logger);

    // Ownership check before any read/write of the thread — a `threadId`
    // owned by a different analysis is indistinguishable from a missing one.
    const store = createThreadStore(pool);
    const existing = unwrapOrThrow(await store.getThread(threadId));
    if (existing && existing.analysisId !== analysisId) {
        return { kind: "not_found" };
    }

    // The type a caller resolves the turn's agent from, and the type that the
    // message assembly reads for its context records. An existing row carries
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
            // The row that comes back is not proof that this call wrote it. The read
            // above hides an archived thread, and the idempotent insert then reads
            // that same row back. Thus a turn on an archived thread reaches here with
            // a row that a different site created, and an emit would record a start
            // that never happened.
            //
            // This site writes a live conversation thread and nothing else. An
            // archived row, or a row of another kind, is therefore one that already
            // existed. A root session has no parent, thus the event carries none.
            if (created.deletedAt === null && created.threadType === "conversation") {
                observe({ type: "create-session", analysisId, threadId, sessionKind: created.threadType });
            }
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
    const { messages, userMessage, contextRecords } = await assembleMessages({
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

    return { kind: "ok", threadType, messages, userMessage, contextRecords };
}

export interface RunChatTurnDeps extends PrepareChatTurnDeps {
    /** The agent of a turn comes from the thread type, which only the preparation knows. */
    readonly agents: ThreadAgentResolver;
}

/** The transport values of one turn. */
export interface RunChatTurnParams {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
    readonly session: AgentSession;
    /** Makes the provider of the turn over the emit sink of the display recorder. */
    readonly chat: (emit: EmitFn) => AgentChat;
    readonly emit: EmitFn;
    readonly signal: AbortSignal;
    readonly usageRecorder: UsageRecorder;
    /** The approval binding. It gets the emit sink of the display recorder, thus the display records each `data-ask`. */
    readonly ask?: (request: AskRequest, emit: EmitFn) => Promise<AskApproval>;
    /** Who sent the user message. */
    readonly author?: string;
    /** When the host opened the turn. Absent counts from the call. */
    readonly startedAtMs?: number;
    /** The cache policy of the root loop. Absent gives {@link CONVERSATION_PROMPT_CACHE}. */
    readonly promptCache?: PromptCachePolicy;
}

export type ChatTurnOutcome =
    | { readonly status: "done"; readonly finish: AgentFinish }
    | { readonly status: "aborted"; readonly finish?: AgentFinish }
    | { readonly status: "failed"; readonly reason: string; readonly cause: unknown };

export type ChatTurnResult =
    | { readonly kind: "prepare_failed"; readonly cause: unknown }
    | { readonly kind: "not_found" }
    | { readonly kind: "agent_unresolved"; readonly threadType: ThreadType }
    | {
          readonly kind: "ran";
          readonly outcome: ChatTurnOutcome;
          /** True when the opening of the turn landed. */
          readonly opened: boolean;
          /** The error of the last write, when rows of the turn or its close did not land. */
          readonly storeError?: DbError;
          readonly durationMs: number;
          readonly turnUsage?: TokenUsageRollup;
          /** The final text of a run that returned. */
          readonly fallbackText?: string;
      };

/**
 * Run one chat turn: prepare it, resolve its agent, store its opening, run the root loop with a
 * round sink that stores each round, and close the turn with its outcome.
 */
export async function runChatTurn(deps: RunChatTurnDeps, params: RunChatTurnParams): Promise<ChatTurnResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("harness.chat");
    const startedAtMs = params.startedAtMs ?? Date.now();

    let prepared: PrepareChatTurnResult;
    try {
        prepared = await prepareChatTurn(deps, { analysisId: params.analysisId, threadId: params.threadId, userInput: params.userInput });
    } catch (cause) {
        return { kind: "prepare_failed", cause };
    }
    if (prepared.kind === "not_found") return prepared;
    const agent = deps.agents.forThread(prepared.threadType);
    if (agent.isErr()) return { kind: "agent_unresolved", threadType: prepared.threadType };

    const history = createThreadHistory(deps.pool, deps.logger);
    const recorder = createConversationDisplayRecorder({ userText: params.userInput, topLevelCallPath: params.session.provenance.callPath, sink: params.emit });
    // The groups that did not land yet, in the order of the turn. A failed write keeps them for the next write.
    let pending: ConversationTurn[] = [
        {
            modelMessages: [prepared.userMessage, ...prepared.contextRecords],
            displayMessages: recorder.takeOpening(),
            ...(params.author === undefined ? {} : { author: params.author }),
        },
    ];
    let startSeq: number | undefined;
    let storeError: DbError | undefined;

    // A store fault never stops the turn: the error rides the result.
    const flush = async (close?: TurnClose): Promise<void> => {
        if (pending.length === 0 && close === undefined) return;
        const closing = close === undefined ? {} : { close };
        const write = startSeq === undefined ? { opening: pending[0]!, rounds: pending.slice(1), ...closing } : { startSeq, rounds: pending, ...closing };
        (await history.writeTurn(params.threadId, write)).match(
            (written) => {
                pending = [];
                startSeq = written.startSeq;
                storeError = undefined;
            },
            (error) => {
                storeError = error;
                logger.warn("chat turn write failed", { threadId: params.threadId, op: error.op, ...logger.errorFields(error.cause) });
            },
        );
    };

    await flush();
    const { ask } = params;
    let outcome: ChatTurnOutcome;
    let fallbackText: string | undefined;
    try {
        const run = await runAgent(agent.value, prepared.messages, params.session, {
            provider: params.chat(recorder.emit),
            signal: params.signal,
            emit: recorder.emit,
            runStep: passthroughStep,
            usageRecorder: params.usageRecorder,
            toolOutputStore: createToolOutputStore(deps.pool),
            promptCache: params.promptCache ?? CONVERSATION_PROMPT_CACHE,
            ...(deps.logger === undefined ? {} : { logger: deps.logger }),
            ...(ask === undefined ? {} : { ask: (request: AskRequest) => ask(request, recorder.emit) }),
            onRound: async (round) => {
                pending.push({ modelMessages: round.messages, displayMessages: recorder.takeRound(round.messages) });
                await flush();
            },
        });
        outcome = run.finish.reason === "aborted" ? { status: "aborted", finish: run.finish } : { status: "done", finish: run.finish };
        fallbackText = finalText(run.messages);
    } catch (cause) {
        // A provider failure that races an abort stays a failure, thus both facts must hold.
        const aborted = params.signal.aborted && cause instanceof Error && cause.name === "AbortError";
        outcome = aborted ? { status: "aborted" } : { status: "failed", reason: failureReasonOf(cause), cause };
    }

    const durationMs = Date.now() - startedAtMs;
    const turnUsage = outcome.status === "failed" ? undefined : outcome.finish?.turnUsage;
    await flush({
        status: outcome.status,
        ...(outcome.status === "failed" ? { reason: outcome.reason, note: conversationRecordTurn(failureNote(outcome.reason)) } : {}),
        ...(turnUsage === undefined ? {} : { turnUsage }),
        turnDurationMs: durationMs,
    });

    return {
        kind: "ran",
        outcome,
        opened: startSeq !== undefined,
        ...(storeError === undefined ? {} : { storeError }),
        durationMs,
        ...(turnUsage === undefined ? {} : { turnUsage: { ...turnUsage } }),
        ...(fallbackText === undefined ? {} : { fallbackText }),
    };
}

/** The reason of a failed turn. It never holds the error message, because each later turn sends the note to the vendor. */
function failureReasonOf(err: unknown): string {
    const suspension = suspensionOfFailure(err);
    if (suspension !== undefined) return suspension.reason;
    const providerError = findProviderError(err);
    if (providerError?.type === "auth") return "The model endpoint refused the credential.";
    if (providerError !== undefined) return "The model request failed.";
    return "The turn stopped on an internal error.";
}

function failureNote(reason: string): string {
    return ["[Turn Failed]", `The turn stopped before it finished. Reason: ${reason}`, "The rounds above this note ran, and their results are stored."].join(
        "\n",
    );
}
