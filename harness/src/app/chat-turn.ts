/**
 * The run of one chat turn: `runOpenTurn` runs the root loop over a prepared turn, stores the opening and each
 * round, and closes the turn with its outcome. A transport gives the surface and the store of the turn. The turn
 * workflow (`chat-turn-workflow.ts`) gives the transport of a workflow, and a host reaches the turn through it.
 */

import type { LanguageModelMiddleware, ModelMessage, UIMessageStreamWriter } from "ai";
import { z } from "zod";

import type { RequestSession } from "../auth/types.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { TokenUsageRollup } from "../contracts/usage.js";
import { type Connectable, type DbError } from "../lib/db-result.js";
import { presentFirst } from "../lib/present.js";
import { errorNameOf } from "../lib/thrown.js";
import type { Querier } from "../state/db.js";
import { unwrapOrThrow } from "../lib/result.js";
import { rulesForContextWindow, type CompactionPolicy } from "../loop/compaction.js";
import { finalText, runLoop, type AgentFinish, type AgentRound, type LoopOptions } from "../loop/run-loop.js";
import type { AgentDefinition, EmitFn } from "../loop/types.js";
import { compactionExchangeOf, syntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import type { ConversationDisplayRecorder } from "../memory/conversation-display-recorder.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { conversationRecordTurn, createThreadHistory, type ConversationTurn, type TurnClose } from "../memory/thread-history.js";
import { createThreadStore, type ThreadType } from "../memory/thread-store.js";
import { isWorkflowCancellation } from "../runtime/dbos.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { findProviderError, modelFailureOf } from "../providers/errors.js";
import { MEMORY_COMPACTION_REQUEST, SUMMARY_COMPACTION_REQUEST } from "../prompts/compaction.js";
import { CONVERSATION_PROMPT_CACHE } from "../providers/prompt-cache.js";
import type { ChatProvider, PromptCachePolicy } from "../providers/types.js";
import type { ThreadAgentResolver } from "../runtime/assemble.js";
import { loadAnalysisStatus, queryNonTerminalRunsByAnalysis } from "../state/index.js";
import { createToolOutputStore } from "../state/tool-outputs.js";
import type { AskGateway } from "../tools/approval/gateway.js";
import { assembleMessages, contextRecordsFor, type AssembledMessages } from "./message-assembly.js";
import { renderRunActivity, renderRunActivityUnavailable, RUN_ACTIVITY_DETAIL_LIMIT } from "./run-activity.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { bindSessionEmit, type ProvenanceSeam } from "../provenance/seam.js";

export type PrepareChatTurnDeps = {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Querier & Connectable;
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
};

export type PrepareChatTurnParams = {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
};

export type PrepareChatTurnResult = ({ readonly kind: "ok"; readonly threadType: ThreadType } & AssembledMessages) | { readonly kind: "not_found" };

/** A prepared turn: the type of its thread, the view of the thread, and the opening. */
export type PreparedChatTurn = Extract<PrepareChatTurnResult, { kind: "ok" }>;

/**
 * Prepare one chat turn: resolve thread ownership, seed the title, load
 * analysis status, and assemble the message array. Input sanitization stays
 * inside {@link assembleMessages} (applied once to the new user input only).
 */
export async function prepareChatTurn(deps: PrepareChatTurnDeps, params: PrepareChatTurnParams): Promise<PrepareChatTurnResult> {
    const opened = await openThread(deps, params);
    if (opened.kind === "not_found") return opened;
    const { pool } = deps;
    const { analysisId, threadId, userInput } = params;
    const assembled = await assembleMessages({
        threadId,
        threadType: opened.threadType,
        analysisId,
        userInput,
        ...(await readTurnContext(pool, analysisId)),
        history: createThreadHistory(pool),
        workingMemory: createWorkingMemory(pool),
        logger: deps.logger,
    });

    return { kind: "ok", threadType: opened.threadType, ...assembled };
}

/**
 * Open the thread of a turn: check that the analysis owns it, make it when it is absent, and seed its title. A
 * thread that a different analysis owns is `not_found`.
 */
export async function openThread(
    deps: PrepareChatTurnDeps,
    params: PrepareChatTurnParams,
): Promise<{ readonly kind: "ok"; readonly threadType: ThreadType } | { readonly kind: "not_found" }> {
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
            unwrapOrThrow(await store.setAutoTitle(threadId, deriveThreadTitle(userInput)));
        }
    } catch (err) {
        logger.warn("title-seed failed (non-fatal)", logger.errorFields(err));
    }
    return { kind: "ok", threadType };
}

/** The analysis context and the run activity of a turn. A failed read gives the fallback of its kind. */
export async function readTurnContext(
    pool: Querier,
    analysisId: string,
): Promise<{ readonly analysisContext: string | null; readonly runActivityContext: string }> {
    const analysisState = await loadAnalysisStatus(pool, analysisId).unwrapOr(null);
    const runActivityContext = await queryNonTerminalRunsByAnalysis(pool, analysisId, RUN_ACTIVITY_DETAIL_LIMIT).match(
        (activity) => renderRunActivity(activity),
        () => renderRunActivityUnavailable(),
    );
    return { analysisContext: analysisState?.context ?? null, runActivityContext };
}

/** The runtime values of a turn. `assembleCoreRuntime` gives them to the turn workflow. */
export type RunChatTurnDeps = PrepareChatTurnDeps & {
    /** The agent of a turn comes from the thread type, which only the preparation knows. */
    readonly agents: ThreadAgentResolver;
    /** The model of the conversation. A host that switches the model swaps the provider between two turns. */
    readonly provider: ChatProvider;
    /** Each model call of the turn reaches it, the calls of a sub-agent included. */
    readonly usageRecorder: UsageRecorder;
    /** The ledger of the asks of a turn. Absent, the loop denies each call that asks for an approval. */
    readonly askGateway?: AskGateway;
};

/**
 * The session of a turn without its provenance. The harness sets the provenance from the agent that
 * it resolves, because only the preparation knows the thread type.
 */
export type ChatTurnSession = Omit<RequestSession, "provenance">;

/** What opens a turn: the thread and the user input. */
export type OpenChatTurnParams = {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
};

export type ChatTurnOutcome =
    | { readonly status: "done"; readonly finish: AgentFinish }
    | { readonly status: "aborted"; readonly finish?: AgentFinish }
    | { readonly status: "failed"; readonly reason: string; readonly code: string; readonly cause: unknown };

/** A turn that ended before its run. It wrote no row and no turn record. */
export type ChatTurnRefusal =
    | { readonly kind: "prepare_failed"; readonly cause: unknown }
    | { readonly kind: "not_found" }
    | { readonly kind: "agent_unresolved"; readonly threadType: ThreadType };

export type ChatTurnRan = {
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

/** How a turn reaches its surface and its store. A turn workflow streams to its durable stream and runs each write as a step. */
export type TurnTransport = {
    readonly signal: AbortSignal;
    /** The emit sink of the loop. */
    readonly emit: EmitFn;
    /** Receives each text delta of the root reply. A turn workflow gives none, because its model calls stream the text. */
    readonly onText?: (text: string) => void | Promise<void>;
    /** The durable stream that the model calls write their text to. */
    readonly chatStream?: string;
    /** Receives the chunks of each tool step, on a replay too. */
    readonly toolWriter?: UIMessageStreamWriter;
    readonly recorder: ConversationDisplayRecorder;
    /** Runs one write of the turn. A turn workflow runs it as a step. */
    readonly durably: <T>(name: string, write: () => Promise<T>) => Promise<T>;
    /** The key of the group of the turn at an index, thus a write that runs again stores nothing. */
    readonly groupKey?: (index: number) => string;
    /** Called when the display starts a new assistant message, after a marker. */
    readonly announce?: (messageId: string) => Promise<void>;
    /** Model middleware inside the step of each model call. */
    readonly modelMiddleware?: readonly LanguageModelMiddleware[];
    /** The decision of the user on a call whose tool asks for approval. Absent: the loop denies such a call. */
    readonly approve?: LoopOptions["approve"];
};

/** The values of a turn that its run reads. */
export type TurnRunParams = {
    readonly session: ChatTurnSession;
    readonly author?: string;
    readonly startedAtMs: number;
    readonly promptCache?: PromptCachePolicy;
};

/**
 * Run a prepared turn: store its opening, run the root loop with a round sink that stores each round, and close the
 * turn with its outcome.
 */
export async function runOpenTurn(
    deps: RunChatTurnDeps,
    turn: OpenChatTurnParams,
    prepared: PreparedChatTurn,
    agent: AgentDefinition,
    params: TurnRunParams,
    transport: TurnTransport,
): Promise<ChatTurnRan> {
    const logger = (deps.logger ?? createNoopLogger()).named("harness.chat");
    const session: RequestSession = { ...params.session, provenance: { agentId: agent.id, callPath: [agent.id] } };
    const history = createThreadHistory(deps.pool, deps.logger);
    const { recorder } = transport;
    let groupIndex = 0;
    /** The group with its key in the turn, when the transport keys its writes. */
    const keyed = (group: ConversationTurn): ConversationTurn => {
        const index = groupIndex;
        groupIndex += 1;
        return transport.groupKey === undefined ? group : { ...group, key: transport.groupKey(index) };
    };
    // The groups that did not land yet, in the order of the turn. A failed write keeps them for the next write.
    let pending: ConversationTurn[] = [];
    let startSeq: number | undefined;
    let storeError: DbError | undefined;
    const opened = (): boolean => startSeq !== undefined || pending.length > 0;

    // A store fault never stops the turn: the error rides the result.
    const flush = async (close?: TurnClose): Promise<void> => {
        // A turn that ends before its user message was sent has no rows to close.
        if (!opened() || (pending.length === 0 && close === undefined)) return;
        const closing = close === undefined ? {} : { close: close.note === undefined ? close : { ...close, note: keyed(close.note) } };
        const write =
            startSeq === undefined
                ? { opening: presentFirst(pending, "the pending turn"), rounds: pending.slice(1), ...closing }
                : { startSeq, rounds: pending, ...closing };
        (await transport.durably("chat-turn.write", async () => await history.writeTurn(turn.threadId, write))).match(
            (written) => {
                pending = [];
                startSeq = written.startSeq;
                storeError = undefined;
            },
            (error) => {
                storeError = error;
                logger.warn("chat turn write failed", { threadId: turn.threadId, op: error.op, ...logger.errorFields(error.cause) });
            },
        );
    };

    const storeRound = async (round: AgentRound): Promise<void> => {
        if (!opened() && round.messages[0] !== prepared.userMessage) {
            // A turn-start compaction comes before the user message, thus its rows land before the turn opens. A later
            // write cannot keep that order, thus a failed write is not tried again, and the next turn compacts again.
            const group = keyed({ modelMessages: round.messages, displayMessages: recorder.takeRound(round.messages) });
            const appended = await transport.durably("chat-turn.compaction-write", async () => await history.appendTurn(turn.threadId, group));
            if (appended.isErr()) {
                logger.warn("chat turn compaction write failed", {
                    threadId: turn.threadId,
                    op: appended.error.op,
                    ...logger.errorFields(appended.error.cause),
                });
            }
            return;
        }
        const author = params.author === undefined ? {} : { author: params.author };
        const assistantBefore = recorder.assistantMessageId();
        pending.push(
            keyed(
                opened()
                    ? { modelMessages: round.messages, displayMessages: recorder.takeRound(round.messages) }
                    : { modelMessages: round.messages, displayMessages: recorder.takeOpening(), ...author },
            ),
        );
        await flush();
        if (recorder.assistantMessageId() !== assistantBefore) await transport.announce?.(recorder.assistantMessageId());
    };

    const compaction = compactionPolicy(deps, turn.analysisId, prepared.threadType, agent);
    let outcome: ChatTurnOutcome;
    let fallbackText: string | undefined;
    try {
        const run = await runLoop(agent, prepared.history, session, {
            provider: deps.provider,
            signal: transport.signal,
            emit: transport.emit,
            onText: transport.onText,
            chatStream: transport.chatStream,
            toolWriter: transport.toolWriter,
            modelMiddleware: transport.modelMiddleware,
            usageRecorder: deps.usageRecorder,
            toolOutputStore: createToolOutputStore(deps.pool),
            promptCache: params.promptCache ?? CONVERSATION_PROMPT_CACHE,
            turnInput: [prepared.userMessage, ...prepared.contextRecords],
            compaction,
            logger: deps.logger,
            approve: transport.approve,
            onRound: storeRound,
        });
        outcome = run.finish.reason === "aborted" ? { status: "aborted", finish: run.finish } : { status: "done", finish: run.finish };
        // An abort can end the run inside an exchange, and the text of an exchange is a summary, and no reply.
        // The history ends on the reply of the last turn, thus only the messages of this run can give the text.
        fallbackText = finalText(run.messages.slice(prepared.history.length).filter((message) => compactionExchangeOf(message) === undefined));
    } catch (cause) {
        // A canceled workflow writes nothing more: its recovery, or the stop of its host, closes the turn.
        if (isWorkflowCancellation(cause)) throw cause;
        // A provider failure that races an abort stays a failure, thus both facts must hold.
        const aborted = transport.signal.aborted && errorNameOf(cause) === "AbortError";
        outcome = aborted ? { status: "aborted" } : { status: "failed", reason: failureReasonOf(cause), code: failureCodeOf(cause), cause };
        // A host gets the scrubbed text and the code of the failure. This record is the one place where the whole
        // cause survives.
        if (outcome.status === "failed") logger.error("chat turn failed", { threadId: turn.threadId, code: outcome.code, ...logger.errorFields(cause) });
    }

    const durationMs = Date.now() - params.startedAtMs;
    const turnUsage = outcome.status === "failed" ? undefined : outcome.finish?.turnUsage;
    await flush({
        status: outcome.status,
        reason: outcome.status === "failed" ? outcome.reason : undefined,
        note: outcome.status === "failed" ? conversationRecordTurn(failureNote(outcome.reason)) : outcome.status === "aborted" ? interruptionNote() : undefined,
        turnUsage,
        turnDurationMs: durationMs,
    });

    const storeErrorField = storeError === undefined ? undefined : { storeError };
    return {
        kind: "ran",
        outcome,
        opened: startSeq !== undefined,
        durationMs,
        turnUsage: turnUsage === undefined ? undefined : { ...turnUsage },
        fallbackText,
        ...storeErrorField,
    };
}

/** The sanitized text of the user message, thus the display never holds a secret that the model does not see. */
export function userTextOf(message: ModelMessage): string {
    if (typeof message.content === "string") return message.content;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const WORKING_MEMORY_TOOL_ID = "update_working_memory";

function compactionPolicy(deps: RunChatTurnDeps, analysisId: string, threadType: ThreadType, agent: AgentDefinition): CompactionPolicy | undefined {
    if (agent.compaction === undefined) return undefined;
    // A report thread reads a frozen copy of the working memory, thus its agent declares no memory tool.
    const remembers = agent.tools.some((tool) => tool.id === WORKING_MEMORY_TOOL_ID);
    const workingMemory = createWorkingMemory(deps.pool);
    return {
        // The capabilities are read for each turn, because a host can switch the model of the conversation between turns.
        ...rulesForContextWindow(agent.compaction, deps.provider.capabilities.contextWindow),
        request: remembers ? MEMORY_COMPACTION_REQUEST : SUMMARY_COMPACTION_REQUEST,
        mask: remembers ? { allow: [WORKING_MEMORY_TOOL_ID] } : "none",
        keepFirstTurn: threadType === "report",
        recordsAfter: async (view) => contextRecordsFor({ threadType, analysisId, workingMemory, ...(await readTurnContext(deps.pool, analysisId)) }, view),
    };
}

/** The error that ends a turn of a turn workflow whose host gives no credential, before its next model call. */
export class TurnCredentialMissingError extends Error {
    constructor() {
        super("The turn has no credential of its user.");
        this.name = "TurnCredentialMissingError";
    }
}

/** The reason of a turn that a recovery found with no credential of its user. */
export const TURN_INTERRUPTED_REASON = "interrupted";

/** A link of the chain whose cause is an error. The error of a missing credential is an `Error`, thus the walk follows errors only. */
const CauseLinkSchema = z.looseObject({ cause: z.instanceof(Error) });

/** The depth of a cause chain that the walk reads, as a bound for a chain with a cycle. */
const CAUSE_CHAIN_DEPTH = 8;

/** Whether an error, or an error on its cause chain, carries the name. A replay of a step gives the name again. */
function carriesErrorName(err: unknown, name: string): boolean {
    let link: unknown = err;
    for (let depth = 0; depth < CAUSE_CHAIN_DEPTH && link !== undefined; depth++) {
        if (errorNameOf(link) === name) return true;
        const next = CauseLinkSchema.safeParse(link);
        link = next.success ? next.data.cause : undefined;
    }
    return false;
}

/** The reason of a failed turn. It never holds the error message, because each later turn sends the note to the vendor. */
/**
 * The machine code of a failure, which the end frame of a turn carries for a host: the suspend reason of the host for
 * a billing refusal, else `credential`, `outage`, `internal`, or `interrupted`.
 */
function failureCodeOf(err: unknown): string {
    if (carriesErrorName(err, "TurnCredentialMissingError")) return TURN_INTERRUPTED_REASON;
    const failure = modelFailureOf(err);
    switch (failure.kind) {
        case "billing":
            return failure.reason;
        case "credential":
            return "credential";
        case "outage":
            return "outage";
        case "other":
            return findProviderError(err) === undefined ? "internal" : "outage";
    }
}

function failureReasonOf(err: unknown): string {
    if (carriesErrorName(err, "TurnCredentialMissingError")) return TURN_INTERRUPTED_REASON;
    const failure = modelFailureOf(err);
    switch (failure.kind) {
        case "billing":
            return failure.reason;
        case "credential":
            return "The model endpoint refused the credential.";
        case "outage":
            return "The model request failed.";
        case "other":
            return findProviderError(err) === undefined ? "The turn stopped on an internal error." : "The model request failed.";
    }
}

/**
 * The note of an aborted turn. Without it, the next turn reads the request of the aborted turn as open, and
 * its reply also answers that request. The transcript shows the interruption from the turn record, thus the
 * note has no display.
 */
function interruptionNote(): ConversationTurn {
    return {
        modelMessages: [syntheticUserMessage("[The user interrupted the request above. Do not continue it unless the user asks you to.]")],
        displayMessages: [],
    };
}

function failureNote(reason: string): string {
    return ["[Turn Failed]", `The turn stopped before it finished. Reason: ${reason}`, "The rounds above this note ran, and their results are stored."].join(
        "\n",
    );
}
