import { ResultAsync, okAsync } from "neverthrow";
import {
    createThreadHistory,
    finalText,
    makeLocalAuth,
    passthroughStep,
    prepareChatTurn,
    runAgent,
    type AgentChat,
    type AgentDefinition,
    type AgentSession,
    type AskApproval,
    type AskRequest,
    type DbError,
    type EmitFn,
    type ModelMessage,
    type Pool,
    type RetractOutcome,
    type ThreadHistory,
} from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import { enterChatTurn } from "./agent_switch.ts";

// The headless chat turn engine. One transport-free sequence —
// `prepareChatTurn → runAgent → unconditional appendTurn` — shared by BOTH the
// clack/stdout REPL (`chat.ts`) and the TUI chat hook, so neither carries a
// private copy of the prepare→run→append body (chat-command spec: "one turn
// engine serves both surfaces"). This module does NO terminal output: it takes
// the primitives it needs, drives the harness, and returns a discriminated
// `TurnOutcome`. Presentation (sink lines, store writes, spinners) is the
// caller's job entirely. Every harness symbol comes from the package barrel —
// never a deep path, never the DBOS SDK.

/**
 * The result of running one chat turn. The three `runAgent`-reaching kinds
 * (`ok`/`aborted`/`failed`) each carry an optional {@link TurnOutcome.appendError}
 * because `appendTurn` runs unconditionally on all of them (the partial turn
 * must survive an abort/throw), so its persistence fault is surfaced ORTHOGONALLY
 * to the turn's own fate rather than collapsing two independent failures into
 * one. `prepare_failed`/`thread_gone` bail BEFORE `runAgent`, so they never
 * append and never carry an append error.
 *
 * - `ok` — the loop finished; `fallbackText` is `finalText(result.messages)`,
 *   the turn's final assistant text (a streamed surface suppresses it as a
 *   duplicate; a delta-less surface renders it).
 * - `aborted` — the turn-scoped signal fired mid-run; `runAgent` threw its
 *   AbortError before returning, so only `[userMessage]` was persisted.
 * - `failed` — `runAgent` threw for a non-abort reason; `cause` is the raw throw.
 * - `prepare_failed` — `prepareChatTurn` threw (e.g. Postgres unreachable).
 * - `thread_gone` — the thread belongs to another analysis (an absent id is re-created
 *   by `prepareChatTurn`, so deletion never surfaces here).
 */
export type TurnOutcome =
    | { readonly kind: "ok"; readonly fallbackText: string; readonly appendError?: DbError }
    | { readonly kind: "aborted"; readonly appendError?: DbError }
    | { readonly kind: "failed"; readonly cause: unknown; readonly appendError?: DbError }
    | { readonly kind: "prepare_failed"; readonly cause: unknown }
    | { readonly kind: "thread_gone" };

/**
 * The primitives one chat turn needs. `pool` + `conversationAgent` are lifted
 * off the booted {@link HarnessRuntime} handle by the caller (the engine stays
 * decoupled from the whole runtime type); `chat` is the STREAMING `AgentChat`
 * wrapper (not the raw provider — a non-streaming provider never emits deltas);
 * `emit` is the surface's `EmitFn` sink; `signal` is the turn-scoped abort
 * signal the CALLER owns (the REPL wires SIGINT into it, the TUI an
 * AbortController), so cancellation policy stays with the transport.
 */
export type RunChatTurnArgs = {
    /** App pool over the harness ledger — `prepareChatTurn` reads/creates the thread through it. */
    readonly pool: Pool;
    /** The assembled conversation agent (`runtime.conversationAgent`) whose loop this turn runs. */
    readonly conversationAgent: AgentDefinition;
    /** Streaming provider wrapper — forwards each text delta so answers render as they arrive. */
    readonly chat: AgentChat;
    /** The pg thread store — `appendTurn` persists the turn atomically. */
    readonly history: ThreadHistory;
    /** Carries `threadId` in scope, so a plan launched here stamps `cortex_runs.thread_id`. */
    readonly session: AgentSession;
    /** The surface's event sink — loop/tool/data events flow here during `runAgent`. */
    readonly emit: EmitFn;
    /** Turn-scoped cancellation — the caller aborts it; on abort the engine persists `[userMessage]`. */
    readonly signal: AbortSignal;
    /**
     * The per-turn user-approval binding a `ctx.ask` tool pauses on. The caller
     * binds the gateway to this turn's scope (analysis/thread, abort signal, event
     * sink) so the gateway's `data-ask` emissions ride the same guarded sink and
     * signal as every other turn event. Omitted → the harness resolves approval to
     * its deny-by-default realization, which is how the REPL stays a write-only sink
     * with no mid-turn input path.
     */
    readonly ask?: (request: AskRequest) => Promise<AskApproval>;
    /** The resolved analysis this turn is scoped to (ownership check + context load). */
    readonly analysisId: string;
    /** The conversation thread this turn appends to. */
    readonly threadId: string;
    /** The sanitized user input opening the turn. */
    readonly userInput: string;
};

/**
 * Injectable harness edges so {@link runChatTurn} is unit-testable offline (no
 * Postgres, no model, no credits) — mirrors the {@link BootSeams} pattern in
 * `runtime.ts`. Production callers omit the second argument and get the real
 * `prepareChatTurn`/`runAgent`; tests pass fakes that drive each outcome branch
 * deterministically.
 */
export type ChatTurnSeams = {
    /** Thread ownership + message assembly. Real: `prepareChatTurn`. */
    readonly prepare: typeof prepareChatTurn;
    /** The agent tool loop. Real: `runAgent`. */
    readonly run: typeof runAgent;
};

const realTurnSeams: ChatTurnSeams = { prepare: prepareChatTurn, run: runAgent };

/**
 * Build the {@link AgentSession} a chat turn runs under. Parameterized
 * by `agentId` so the surfaces are distinguishable in provenance yet identical in
 * shape: the REPL passes `"cli-chat"`, the TUI `"tui-chat"`. `callPath` is
 * `[agentId]` — length 1, so this top-level agent's events PASS the printer's
 * sub-agent depth filter while planner / literature-reviewer traffic (deeper
 * callPaths) is dropped. `threadId` rides IN scope: `execute_plan` reads
 * `session.scope.threadId` to stamp `cortex_runs.thread_id`, giving a
 * chat-launched run its thread lineage.
 */
export function buildChatSession(agentId: string, analysisId: string, threadId: string): AgentSession {
    return {
        identity: { user: "local" },
        scope: { kind: "analysis", analysisId, threadId },
        provenance: { agentId, callPath: [agentId] },
        auth: makeLocalAuth(),
    };
}

/** Which runAgent branch was taken, paired with the messages to persist for it. */
type RunPhase = { readonly kind: "ok"; readonly fallbackText: string } | { readonly kind: "aborted" } | { readonly kind: "failed"; readonly cause: unknown };

/**
 * Run one chat turn headlessly: `prepareChatTurn` (ownership check, title seed,
 * status load, message assembly) → `runAgent` on the streaming provider under the
 * turn-scoped signal → UNCONDITIONAL `appendTurn`. The append runs on every
 * `runAgent`-reaching path so the turn persists even through an abort/throw: on a
 * clean return that is `[userMessage, ...loopOutput]`; on abort/throw only
 * `[userMessage]`, because `runAgent` throws BEFORE returning its message array
 * (the AbortError propagates out of the streaming provider), leaving the partial
 * loop output structurally unavailable — though whatever streamed before the
 * abort is already on the surface.
 *
 * Returns a {@link TurnOutcome}; the caller renders it. No sink, no clack, no
 * console here — presentation is entirely the transport's concern.
 */
export async function runChatTurn(args: RunChatTurnArgs, seams: ChatTurnSeams = realTurnSeams): Promise<TurnOutcome> {
    const { pool, conversationAgent, chat, history, session, emit, signal, analysisId, threadId, userInput, ask } = args;

    // Bracket the whole turn as in-flight agent work: an agent switch requested
    // mid-turn defers to the turn boundary, and the `finally` settling this token lands a pending switch
    // before the next turn begins. Bracketing HERE covers both surfaces — the TUI hook and the REPL both
    // drive this one engine — which is why the instrumentation is on the shared seam, not the call sites.
    const leaveChatTurn = enterChatTurn();
    try {
        const prepared = await ResultAsync.fromPromise(seams.prepare({ pool }, { analysisId, threadId, userInput }), (e): unknown => e).match(
            (r) => r,
            (cause): { readonly kind: "prepare_failed"; readonly cause: unknown } => ({ kind: "prepare_failed", cause }),
        );
        if (prepared.kind === "prepare_failed") {
            // pino serializes the whole structured cause into the file log; the surface renders only a
            // one-liner, so this record is the ONLY place the full failure detail survives for later
            // inspection.
            getLogger("harness").error({ cause: prepared.cause }, "chat turn prepare failed");
            return { kind: "prepare_failed", cause: prepared.cause };
        }
        // `prepareChatTurn` refuses ONLY a thread owned by another analysis — an absent id is
        // re-created there, not refused — so this branch is the ownership refusal. It reports as
        // "gone" because callers deliberately do not distinguish foreign from vanished threads.
        if (prepared.kind === "not_found") return { kind: "thread_gone" };

        const initial = prepared.messages;
        const userMessage = prepared.userMessage;

        const run = await ResultAsync.fromPromise(
            seams.run(conversationAgent, initial, session, { provider: chat, signal, emit, runStep: passthroughStep, ...(ask ? { ask } : {}) }),
            (e): unknown => e,
        ).match(
            (result): { readonly phase: RunPhase; readonly toPersist: ModelMessage[] } => ({
                phase: { kind: "ok", fallbackText: finalText(result.messages) },
                toPersist: [userMessage, ...result.messages.slice(initial.length)],
            }),
            // `runAgent` threw. Classify as an abort ONLY when the throw is the AbortError the streaming
            // provider re-throws verbatim (`streaming-chat.ts` re-throws it as control flow, name
            // "AbortError" — a DOMException, which IS an `Error` instance under bun/node) AND our own signal
            // is aborted. A provider failure that merely RACED a Ctrl+C would otherwise be swallowed as an
            // abort and never logged; everything but a genuine abort stays `failed`, carrying its cause.
            (cause): { readonly phase: RunPhase; readonly toPersist: ModelMessage[] } => {
                const aborted = signal.aborted && cause instanceof Error && cause.name === "AbortError";
                return {
                    phase: aborted ? { kind: "aborted" } : { kind: "failed", cause },
                    toPersist: [userMessage],
                };
            },
        );

        // Persist unconditionally — the partial turn must survive an abort/throw. The
        // append fault is carried on the outcome, never conflated with the turn's fate.
        const appendError = (await history.appendTurn(threadId, run.toPersist)).match(
            (): DbError | undefined => undefined,
            (e): DbError | undefined => e,
        );
        // The persistence fault rides ORTHOGONALLY on the outcome (the turn may still have succeeded);
        // log it here so the whole DbError survives even when the surface only shows a terse toast.
        if (appendError) getLogger("harness").warn({ appendError }, "chat turn append failed");

        switch (run.phase.kind) {
            case "ok":
                return { kind: "ok", fallbackText: run.phase.fallbackText, appendError };
            case "aborted":
                return { kind: "aborted", appendError };
            case "failed":
                // The one place the full run failure survives — the banner collapses it to a one-liner.
                getLogger("harness").error({ cause: run.phase.cause }, "chat turn failed");
                return { kind: "failed", cause: run.phase.cause, appendError };
            default: {
                const exhaustive: never = run.phase;
                throw new Error(`unhandled run phase: ${JSON.stringify(exhaustive)}`);
            }
        }
    } finally {
        leaveChatTurn();
    }
}

/**
 * Remove a thread's most recent turn durably — the tail-turn half of a TUI retract. Built over
 * `createThreadHistory(pool)`, the SAME factory {@link runChatTurn}'s caller wires as its `history`,
 * so the retract rides the exact pool the turn appended through rather than introducing a parallel
 * store concept (the factory is a stateless closure over the pool, so a fresh instance is equivalent —
 * mirroring how the transcript-load path builds one per read). Returns the harness {@link RetractOutcome}
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
 * turn holding exactly one message, the user's, with no assistant reply.
 *
 * The check exists because the fault that schedules a heal is ambiguous about what it left on disk. A
 * retract commits in one transaction, but a `COMMIT` whose acknowledgement is lost (a connection dropped
 * at exactly the wrong moment) surfaces as a `DbError` from a transaction the server actually applied. A
 * blind retry would then take a SECOND turn off the tail — the previous, fully-answered exchange —
 * silently destroying real history to undo something already undone. Re-reading the tail first turns
 * that into a no-op: if the orphan is gone, the tail is an answered turn and the heal declines.
 *
 * Two whole-thread reads (`loadPage` reads every row and slices by turn, so the first call is what
 * yields the turn count the second one indexes with) are affordable precisely because this path is
 * reached only after a database fault, never on a healthy retract.
 */
export function healTailOrphan(pool: Pool, threadId: string, seams: HealSeams = realHealSeams): ResultAsync<HealOutcome, DbError> {
    const history = seams.history(pool);
    return history.loadPage(threadId, 0, 1).andThen((first) => {
        if (first.total === 0) return okAsync<HealOutcome, DbError>({ kind: "empty-thread" });
        return history.loadPage(threadId, first.total - 1, 1).andThen((tail) => {
            const only = tail.messages.length === 1 ? tail.messages[0] : undefined;
            if (!only || only.message.role !== "user") return okAsync<HealOutcome, DbError>({ kind: "not-orphaned" });
            return history.retractLastTurn(threadId);
        });
    });
}
