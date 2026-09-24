import { type ResultAsync, okAsync } from "neverthrow";
import {
    createThreadHistory,
    makeLocalAuth,
    runChatTurn as runHarnessChatTurn,
    type AgentChat,
    type AgentFinish,
    type AskApproval,
    type AskRequest,
    type ChatTurnResult,
    type ChatTurnSession,
    type DbError,
    type EmitFn,
    type Pool,
    type RetractOutcome,
    type ThreadAgentResolver,
    type ThreadHistory,
    type ThreadType,
    type UsageRecorder,
} from "@inflexa-ai/harness";

import { getLogger, harnessLogger } from "../../lib/log.ts";
import { currentUserEmail } from "../auth/whoami.ts";
import { enterChatTurn } from "./agent_switch.ts";
import { provenanceSeam } from "./prov_bridge.ts";

// The headless chat turn engine that the REPL (`dev/chat.ts`) and the TUI chat hook share. It gives the
// `runChatTurn` of the harness the values of the surface and maps the result. It does no terminal output.

/**
 * What one whole turn spent, per quantity — the harness's own rollup shape, carried
 * WHOLE rather than reduced to a number. Its five fields are not siblings and must
 * never be summed: `cacheCreationInputTokens`/`cacheReadInputTokens` are breakdowns
 * *of* `inputTokens` and `reasoningTokens` a breakdown *of* `outputTokens`, so a
 * single total would count a cached prefix (and reasoning) twice.
 *
 * Each field stays absent until some call actually reported it, so "the provider told
 * us nothing" never masquerades as a measured zero — the discipline every surface
 * downstream inherits.
 *
 * Derived from {@link AgentFinish} rather than imported: the harness exports the
 * finish but not the `AgentRunUsage` behind it, and the house rule admits only the
 * package barrel, never a deep path. `Readonly` because what the engine hands out is a
 * SNAPSHOT — the harness's own accumulator is mutable, and callers must not write to
 * the copy they are given.
 */
export type TurnUsage = Readonly<NonNullable<AgentFinish["turnUsage"]>>;

/**
 * The result of one chat turn. The harness stores the opening, each round, and the outcome, thus a
 * throw keeps the stored rounds. The four kinds that ran carry `opened`, and a store fault as `appendError`.
 */
export type TurnOutcome =
    | { readonly kind: "ok"; readonly opened: boolean; readonly fallbackText: string; readonly turnUsage?: TurnUsage; readonly appendError?: DbError }
    | {
          readonly kind: "filtered";
          readonly opened: boolean;
          readonly fallbackText: string;
          readonly rawFinishReason?: string;
          readonly turnUsage?: TurnUsage;
          readonly appendError?: DbError;
      }
    | { readonly kind: "aborted"; readonly opened: boolean; readonly turnUsage?: TurnUsage; readonly appendError?: DbError }
    | { readonly kind: "failed"; readonly opened: boolean; readonly cause: unknown; readonly turnUsage?: TurnUsage; readonly appendError?: DbError }
    | { readonly kind: "prepare_failed"; readonly cause: unknown }
    | { readonly kind: "thread_gone" }
    | { readonly kind: "agent_unresolved"; readonly threadType: ThreadType };

/** The transport values of one chat turn, which the harness turn stores and runs. */
export type RunChatTurnArgs = {
    /** App pool over the harness ledger. */
    readonly pool: Pool;
    /** The thread→agent resolver (`runtime.agents`). The harness resolves the agent from the type of the thread. */
    readonly agents: ThreadAgentResolver;
    /** Builds the streaming provider over the recorder's emit sink. */
    readonly chat: (emit: EmitFn) => AgentChat;
    /**
     * Carries `threadId` in scope, so a plan launched here stamps `cortex_runs.thread_id`. The harness
     * sets the provenance from the agent of the thread.
     */
    readonly session: ChatTurnSession;
    /** The surface's live event sink; the display recorder forwards every event here. */
    readonly emit: EmitFn;
    /**
     * The booted runtime's ONE {@link UsageRecorder} (`runtime.usageRecorder`). Required, because the
     * harness falls back to its no-op when the value is absent, and the turn then records nothing.
     */
    readonly usageRecorder: UsageRecorder;
    /** Turn-scoped cancellation, which the caller owns. */
    readonly signal: AbortSignal;
    /**
     * The per-turn user-approval binding a `ctx.ask` tool pauses on. Omitted → the harness resolves
     * approval to its deny-by-default realization, which is how the REPL stays a write-only sink.
     */
    readonly ask?: (request: AskRequest, emit: EmitFn) => Promise<AskApproval>;
    /** The resolved analysis this turn is scoped to (ownership check + context load). */
    readonly analysisId: string;
    /** The conversation thread this turn appends to. */
    readonly threadId: string;
    /** The sanitized user input opening the turn. */
    readonly userInput: string;
};

/** Injectable harness edges, thus {@link runChatTurn} is unit-testable offline. */
export type ChatTurnSeams = {
    /** The whole chat turn. Real: the `runChatTurn` of the harness. */
    readonly turn: typeof runHarnessChatTurn;
    /**
     * Who sent the message: the email of the signed-in identity, or `null` when the cli can name
     * nobody. Real: `currentUserEmail`. Injectable, because the suite runs with no auth file.
     */
    readonly readAuthor: () => string | null;
};

const realTurnSeams: ChatTurnSeams = { turn: runHarnessChatTurn, readAuthor: currentUserEmail };

/**
 * Build the {@link ChatTurnSession} a chat turn runs under. The harness stamps the provenance of the
 * agent that the thread resolves to, with a length-1 `callPath`, so its events PASS the printer's
 * sub-agent depth filter. `threadId` rides IN scope: `execute_analysis` reads
 * `session.scope.threadId` to stamp `cortex_runs.thread_id`, giving a chat-launched run its thread
 * lineage.
 */
export function buildChatSession(analysisId: string, threadId: string): ChatTurnSession {
    return {
        identity: { user: "local" },
        scope: { kind: "analysis", analysisId, threadId },
        auth: makeLocalAuth(),
    };
}

/**
 * Run one chat turn through the `runChatTurn` of the harness, and map its result to a
 * {@link TurnOutcome}. The harness stores the opening, each round, and the outcome, thus a throw
 * keeps the stored rounds. The caller renders the outcome.
 */
export async function runChatTurn(args: RunChatTurnArgs, seams: ChatTurnSeams = realTurnSeams): Promise<TurnOutcome> {
    const { pool, agents, chat, session, emit, signal, analysisId, threadId, userInput, ask, usageRecorder } = args;

    // An agent switch requested during the turn waits for this token, and the `finally` lands it.
    const leaveChatTurn = enterChatTurn();
    // The live header measures from the moment the surface opens the turn, thus the stored duration does too.
    const turnStartedAt = Date.now();
    try {
        // Read at the top, because the author is who sent the message: a sign-out during the turn
        // must not erase that person. Inside the `try`, thus a throw cannot strand the turn token.
        const author = seams.readAuthor();
        const result = await seams.turn(
            { pool, agents, logger: harnessLogger("harness"), provenance: provenanceSeam() },
            {
                analysisId,
                threadId,
                userInput,
                session,
                chat,
                emit,
                signal,
                usageRecorder,
                startedAtMs: turnStartedAt,
                ...(ask ? { ask } : {}),
                // An empty email is no sender, thus it never reaches the store as a name.
                ...(author ? { author } : {}),
            },
        );
        switch (result.kind) {
            case "prepare_failed":
                // The surface shows one line, thus the log keeps the whole cause.
                getLogger("harness").error({ cause: result.cause }, "chat turn prepare failed");
                return { kind: "prepare_failed", cause: result.cause };
            case "not_found":
                return { kind: "thread_gone" };
            case "agent_unresolved":
                getLogger("harness").error({ threadType: result.threadType }, "chat turn agent unresolved");
                return { kind: "agent_unresolved", threadType: result.threadType };
            case "ran":
                return outcomeOfRun(result);
            default: {
                const exhaustive: never = result;
                throw new Error(`unhandled turn result: ${JSON.stringify(exhaustive)}`);
            }
        }
    } finally {
        leaveChatTurn();
    }
}

function outcomeOfRun(result: Extract<ChatTurnResult, { kind: "ran" }>): TurnOutcome {
    const { opened, outcome } = result;
    const appendError = result.storeError;
    if (appendError) getLogger("harness").warn({ appendError }, "chat turn append failed");
    // A copy, because the value travels into a Solid store. An absent rollup leaves no key.
    const spend = result.turnUsage ? { turnUsage: { ...result.turnUsage } } : {};
    const fallbackText = result.fallbackText ?? "";
    switch (outcome.status) {
        case "done": {
            const { rawFinishReason } = outcome.finish;
            if (outcome.finish.reason !== "content-filter") return { kind: "ok", opened, fallbackText, ...spend, appendError };
            // The one place the endpoint's own word survives — the banner shows only the generic line.
            getLogger("harness").warn({ rawFinishReason }, "chat turn stopped by the model content filter");
            return { kind: "filtered", opened, fallbackText, ...(rawFinishReason !== undefined ? { rawFinishReason } : {}), ...spend, appendError };
        }
        case "aborted":
            return { kind: "aborted", opened, ...spend, appendError };
        case "failed":
            getLogger("harness").error({ cause: outcome.cause }, "chat turn failed");
            return { kind: "failed", opened, cause: outcome.cause, ...spend, appendError };
        default: {
            const exhaustive: never = outcome;
            throw new Error(`unhandled turn outcome: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Remove a thread's most recent turn durably — the tail-turn half of a TUI retract. Built over
 * `createThreadHistory(pool)` of the pool that the turn wrote through (the factory is a stateless
 * closure over the pool, so a fresh instance is equivalent). Returns the harness {@link RetractOutcome}
 * (or a `DbError`) verbatim for the caller to reduce: `retracted` removed the orphan, while
 * `empty-thread`/`no-user-turn` removed nothing.
 */
export function retractTailTurn(pool: Pool, threadId: string): ResultAsync<RetractOutcome, DbError> {
    return createThreadHistory(pool).retractLastTurn(threadId);
}

/**
 * The outcome of {@link healTailOrphan}: whatever the tail retract reported, plus the one verdict only
 * the heal can reach — the tail is a real, answered turn, so there is no orphan and nothing was touched.
 */
export type HealOutcome = RetractOutcome | { readonly kind: "not-orphaned" };

/**
 * Injectable store edge so {@link healTailOrphan}'s three verdicts are unit-testable offline (no
 * Postgres) — mirrors {@link ChatTurnSeams}. Production callers omit the trailing argument and get the
 * real `createThreadHistory`; tests pass a fake thread store staged at the tail shape under test.
 */
export type HealSeams = {
    /** Build the thread store over the pool. Real: `createThreadHistory`. */
    readonly history: (pool: Pool) => ThreadHistory;
};

const realHealSeams: HealSeams = { history: createThreadHistory };

/**
 * Remove a thread's tail turn ONLY IF it still looks like the orphan a failed retract left behind — a
 * turn with no assistant row: the user message and its context records.
 *
 * The check exists because the fault that schedules a heal is ambiguous about what it left on disk. A
 * retract commits in one transaction, but a `COMMIT` whose acknowledgement is lost (a connection dropped
 * at exactly the wrong moment) surfaces as a `DbError` from a transaction the server actually applied. A
 * blind retry would then take a SECOND turn off the tail — the previous, fully-answered exchange —
 * silently destroying real history to undo something already undone. Re-reading the tail first turns
 * that into a no-op: if the orphan is gone, the tail is an answered turn and the heal declines.
 *
 * One whole-thread read. `loadAll` hands back the grouping it already computed, so the tail turn is
 * the last element rather than a second read indexed by a count the first one yielded. The full read
 * is affordable precisely because this path is reached only after a database fault, never on a
 * healthy retract.
 */
export function healTailOrphan(pool: Pool, threadId: string, seams: HealSeams = realHealSeams): ResultAsync<HealOutcome, DbError> {
    const history = seams.history(pool);
    return history.loadAll(threadId).andThen((turns) => {
        const tail = turns.at(-1);
        if (!tail) return okAsync<HealOutcome, DbError>({ kind: "empty-thread" });
        if (tail.some((row) => row.message.role === "assistant")) return okAsync<HealOutcome, DbError>({ kind: "not-orphaned" });
        return history.retractLastTurn(threadId);
    });
}
