import { ResultAsync, okAsync } from "neverthrow";
import {
    createThreadHistory,
    createConversationDisplayRecorder,
    finalText,
    makeLocalAuth,
    passthroughStep,
    prepareChatTurn,
    runAgent,
    type AgentChat,
    type AgentFinish,
    type AgentSession,
    type AskApproval,
    type AskRequest,
    type DbError,
    type EmitFn,
    type ModelMessage,
    type Pool,
    type RetractOutcome,
    type ThreadAgentResolver,
    type ThreadHistory,
    type ThreadType,
    type UsageRecorder,
} from "@inflexa-ai/harness";

import { getLogger, harnessLogger } from "../../lib/log.ts";
import { enterChatTurn } from "./agent_switch.ts";
import { provenanceSeam } from "./prov_bridge.ts";

// The headless chat turn engine. One transport-free sequence —
// `prepareChatTurn → runAgent → unconditional appendTurn` — shared by BOTH the
// clack/stdout REPL (`chat.ts`) and the TUI chat hook, so neither carries a
// private copy of the prepare→run→append body: one turn engine serves both
// surfaces. This module does NO terminal output: it takes
// the primitives it needs, drives the harness, and returns a discriminated
// `TurnOutcome`. Presentation (sink lines, store writes, spinners) is the
// caller's job entirely. Every harness symbol comes from the package barrel —
// never a deep path, never the DBOS SDK.

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
 * The result of running one chat turn. The four `runAgent`-reaching kinds
 * (`ok`/`filtered`/`aborted`/`failed`) each carry an optional {@link TurnOutcome.appendError}
 * because `appendTurn` runs unconditionally on all of them (the partial turn
 * must survive an abort/throw), so its persistence fault is surfaced ORTHOGONALLY
 * to the turn's own fate rather than collapsing two independent failures into
 * one. `prepare_failed`/`thread_gone`/`agent_unresolved` bail BEFORE `runAgent`,
 * so they never append and never carry an append error.
 *
 * Those same four kinds also carry an optional {@link TurnUsage}. It rides here rather
 * than being read back out of the usage ledger because the ledger structurally cannot
 * answer "what did THIS turn cost": a chat-path usage record is attributed to a thread,
 * never to a turn. The run's finish already holds the whole-turn total, so reading it
 * costs nothing and is definitionally correct. An interrupted or failed turn reports
 * whatever it spent before it ended; only a run that never resolved at all has nothing
 * to report.
 *
 * - `ok` — the loop finished; `fallbackText` is `finalText(result.messages)`,
 *   the turn's final assistant text (a streamed surface suppresses it as a
 *   duplicate; a delta-less surface renders it).
 * - `filtered` — the model's safety classifier declined and stopped the turn (an
 *   Anthropic `refusal`, normalized to `content-filter`). A completed reply, not a
 *   fault: it keeps the ok path's persistence, `fallbackText`, and cost.
 * - `aborted` — the turn-scoped signal fired mid-run; the run resolves with an
 *   "aborted" finish carrying its partial transcript, so the engine persists
 *   `[userMessage, ...partial]` (an empty partial degenerates to `[userMessage]`).
 * - `failed` — `runAgent` threw for a non-abort reason; `cause` is the raw throw.
 * - `prepare_failed` — `prepareChatTurn` threw (e.g. Postgres unreachable).
 * - `thread_gone` — the thread belongs to another analysis (an absent id is re-created
 *   by `prepareChatTurn`, so deletion never surfaces here).
 * - `agent_unresolved` — preparation SUCCEEDED, but the thread's type has no agent
 *   registered in this build, so the resolver refused on its `Result` channel.
 *   Distinct from `prepare_failed`: preparation did not fault, it produced a valid
 *   type this build cannot serve. Like `prepare_failed`/`thread_gone` it never
 *   reaches `runAgent`, so nothing is persisted — the unconditional `appendTurn`
 *   covers only the `runAgent`-reaching paths.
 */
export type TurnOutcome =
    | { readonly kind: "ok"; readonly fallbackText: string; readonly turnUsage?: TurnUsage; readonly appendError?: DbError }
    | {
          readonly kind: "filtered";
          readonly fallbackText: string;
          readonly rawFinishReason?: string;
          readonly turnUsage?: TurnUsage;
          readonly appendError?: DbError;
      }
    | { readonly kind: "aborted"; readonly turnUsage?: TurnUsage; readonly appendError?: DbError }
    | { readonly kind: "failed"; readonly cause: unknown; readonly turnUsage?: TurnUsage; readonly appendError?: DbError }
    | { readonly kind: "prepare_failed"; readonly cause: unknown }
    | { readonly kind: "thread_gone" }
    | { readonly kind: "agent_unresolved"; readonly threadType: ThreadType };

/**
 * The primitives one chat turn needs. `pool` + `agents` are lifted
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
    /**
     * The thread→agent resolver (`runtime.agents`). The engine resolves the agent
     * per turn from the thread's type, which is known only from the prepare result —
     * so a caller cannot pre-select the agent and hand it in. An unregistered type
     * surfaces as an `agent_unresolved` outcome.
     */
    readonly agents: ThreadAgentResolver;
    /** Builds the streaming provider over the recorder's emit sink. */
    readonly chat: (emit: EmitFn) => AgentChat;
    /** The pg thread store — `appendTurn` persists the turn atomically. */
    readonly history: ThreadHistory;
    /** Carries `threadId` in scope, so a plan launched here stamps `cortex_runs.thread_id`. */
    readonly session: AgentSession;
    /** The surface's live event sink; the display recorder forwards every event here. */
    readonly emit: EmitFn;
    /**
     * The booted runtime's ONE {@link UsageRecorder} (`runtime.usageRecorder`), forwarded into this
     * turn's `runAgent` options so the conversation agent's own calls land in the ledger.
     *
     * REQUIRED, not optional, and that is the whole point of it being here. `runAgent` reads its
     * recorder from the options bag and falls back to the harness's no-op when the field is absent —
     * it never reads one off the agent definition — so an assembled-with-a-recorder conversation agent
     * still recorded nothing for as long as this argument did not exist. The failure is silent: the
     * turn succeeds, the message header still shows a figure (that comes from the finish rollup, not
     * the ledger), and no row is written. A required field is what makes the omission a compile error
     * at every call site instead of a fact someone has to notice in a ledger months later.
     */
    readonly usageRecorder: UsageRecorder;
    /** Turn-scoped cancellation — the caller aborts it; on abort the engine persists `[userMessage, ...partial]` from the resolved run. */
    readonly signal: AbortSignal;
    /**
     * The per-turn user-approval binding a `ctx.ask` tool pauses on. The caller
     * binds the gateway to this turn's scope (analysis/thread, abort signal, event
     * sink) so the gateway's `data-ask` emissions ride the same guarded sink and
     * signal as every other turn event. Omitted → the harness resolves approval to
     * its deny-by-default realization, which is how the REPL stays a write-only sink
     * with no mid-turn input path.
     */
    readonly ask?: (request: AskRequest, emit: EmitFn) => Promise<AskApproval>;
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
 * callPaths) is dropped. `threadId` rides IN scope: `execute_analysis` reads
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

/**
 * Which runAgent branch was taken, paired with the messages to persist for it.
 *
 * `turnUsage` rides on ALL THREE branches, not only the clean one: the abort and the
 * failure spent real tokens before they ended, and dropping their rollup here would be
 * the same "unreported" / "nothing spent" conflation the absent-is-never-zero rule
 * exists to prevent. It is genuinely absent only where the run never resolved — the
 * throw arm has no finish to read — and on a run whose calls reported nothing.
 *
 * `durationMs` rides beside it, and it is measured on the arm where the run RESOLVED. A run
 * that threw persists the user message alone. Thus it carries no assistant row for the store to
 * write the figure onto.
 *
 * A throw before any output reads the same on both surfaces, because the live view drops the
 * empty assistant shell of an abort. A throw after output does not. The live header keeps the
 * streamed reply with the time that the surface stamped, and the reload shows that reply with no
 * time. The store has no row to hold the figure for such a turn, thus the gap stays open.
 */
type RunPhase =
    | { readonly kind: "ok"; readonly fallbackText: string; readonly turnUsage?: TurnUsage; readonly durationMs?: number }
    | {
          readonly kind: "filtered";
          readonly fallbackText: string;
          readonly rawFinishReason?: string;
          readonly turnUsage?: TurnUsage;
          readonly durationMs?: number;
      }
    | { readonly kind: "aborted"; readonly turnUsage?: TurnUsage; readonly durationMs?: number }
    | { readonly kind: "failed"; readonly cause: unknown; readonly turnUsage?: TurnUsage; readonly durationMs?: number };

/**
 * Run one chat turn headlessly: `prepareChatTurn` (ownership check, title seed,
 * status load, message assembly) → `runAgent` on the streaming provider under the
 * turn-scoped signal → UNCONDITIONAL `appendTurn`. The append runs on every
 * `runAgent`-reaching path so the turn persists even through an abort/throw. A
 * clean return persists `[userMessage, ...loopOutput]`. An interrupted run resolves
 * with an "aborted" finish and its partial transcript, so the same
 * `[userMessage, ...partial]` shape persists — an empty partial degenerating to
 * `[userMessage]`. A throw that never reached the streaming wrapper (the defensive
 * abort path, or a genuine failure) persists `[userMessage]` alone.
 *
 * Returns a {@link TurnOutcome}; the caller renders it. No sink, no clack, no
 * console here — presentation is entirely the transport's concern.
 */
export async function runChatTurn(args: RunChatTurnArgs, seams: ChatTurnSeams = realTurnSeams): Promise<TurnOutcome> {
    const { pool, agents, chat, history, session, emit, signal, analysisId, threadId, userInput, ask, usageRecorder } = args;

    // Bracket the whole turn as in-flight agent work: an agent switch requested
    // mid-turn defers to the turn boundary, and the `finally` settling this token lands a pending switch
    // before the next turn begins. Bracketing HERE covers both surfaces — the TUI hook and the REPL both
    // drive this one engine — which is why the instrumentation is on the shared seam, not the call sites.
    const leaveChatTurn = enterChatTurn();
    // The clock of the whole turn, and not of the loop alone. The live header measures from the moment
    // the surface opens the turn to the moment it settles, thus a bracket around the loop alone would
    // store a figure that reads shorter than the one the user watched.
    const turnStartedAt = Date.now();
    try {
        // The logger rides into preparation so the history-repair warning of the
        // message assembly reaches the file log — without it, a repaired thread
        // heals silently and the writer defect it covers stays invisible.
        //
        // The provenance seam rides beside it, because preparation holds the one site that writes a
        // conversation thread and thus the one site that knows the true moment of that creation. The
        // turn reads the ONE seam that the boot installed, the same object that the composition root
        // puts on the core bag. Thus a created session carries one claim whichever surface drives the
        // turn. With no booted runtime the read gives nothing, which the harness reads as absence.
        const prepared = await ResultAsync.fromPromise(
            seams.prepare({ pool, logger: harnessLogger("harness"), provenance: provenanceSeam() }, { analysisId, threadId, userInput }),
            (e): unknown => e,
        ).match(
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

        // The thread's type is known only now, from the prepared result, so the agent
        // is resolved per turn rather than pre-selected by the caller. A `ThreadType`
        // this build registered no agent for refuses on the resolver's `Result` channel:
        // surface it as `agent_unresolved` — like `prepare_failed`/`thread_gone` it never
        // reaches `runAgent`, so nothing is persisted. Log the refusal the way the
        // prepare-failure branch above does, so the file log keeps the detail the surface
        // reduces to a one-liner.
        const resolvedAgent = agents.forThread(prepared.threadType);
        if (resolvedAgent.isErr()) {
            getLogger("harness").error({ threadType: prepared.threadType }, "chat turn agent unresolved");
            return { kind: "agent_unresolved", threadType: prepared.threadType };
        }
        const agent = resolvedAgent.value;

        const initial = prepared.messages;
        const userMessage = prepared.userMessage;
        const display = createConversationDisplayRecorder({
            userText: userInput,
            topLevelCallPath: session.provenance.callPath,
            sink: emit,
        });
        const recordedEmit = display.emit;

        const run = await ResultAsync.fromPromise(
            seams.run(agent, initial, session, {
                provider: chat(recordedEmit),
                signal,
                emit: recordedEmit,
                runStep: passthroughStep,
                // UNCONDITIONAL, unlike `ask`'s spread: an absent recorder is not a policy the
                // harness resolves for us, it is the no-op that drops every call this loop makes.
                usageRecorder,
                // The loop's own account of the turn: iteration count, stop reason, whether it
                // capped out, and its tool-call/error tallies. `emit` does not cover this — the
                // surface filters sub-agent traffic off by `callPath` depth, so a planner or
                // literature-reviewer loop is emitted and then dropped. This is where it survives.
                logger: harnessLogger("harness"),
                ...(ask ? { ask: (request) => ask(request, recordedEmit) } : {}),
            }),
            (e): unknown => e,
        ).match(
            (result): { readonly phase: RunPhase; readonly toPersist: ModelMessage[] } => {
                // An interrupted run resolves here — the streaming wrapper surfaces the abort as a
                // `finish.reason` of "aborted" carrying the partial transcript, not as a throw — so its
                // partial loop output is persisted with the same shape a clean turn uses. An empty partial
                // degenerates to `[userMessage]`, matching the no-output retract window's durable behavior.
                const toPersist = [userMessage, ...result.messages.slice(initial.length)];
                // `turnUsage`, never `usage`: the options above carry no accumulator, so by the harness's
                // contract THIS loop is the turn's root and its finish's `turnUsage` covers every
                // descendant sub-agent loop, where `usage` would report only this loop's own calls.
                //
                // Copied rather than aliased. The accumulator's fields are mutable and this value travels
                // into a Solid store, so the engine hands out something it owns instead of depending on
                // the producer's current choice to spread its own. ABSENCE is preserved by construction:
                // the harness omits the field entirely when no call reported anything, so an unreported
                // turn carries no rollup rather than a zeroed one.
                const turnUsage: TurnUsage | undefined = result.finish.turnUsage ? { ...result.finish.turnUsage } : undefined;
                // The run settled, thus the span from the start of the turn to here is what the turn took.
                // The append below is deliberately outside it: the figure must exist before the write that
                // carries it, and a store round trip is not time that the reader spent waiting on an answer.
                //
                // Thus the stored span reads under the live header, and the round trip is most of the gap.
                // The two spans come from one `Date.now` pair in one process. The gap is milliseconds, thus
                // the printed figures differ only on a short turn or on a rounding step.
                const durationMs = Date.now() - turnStartedAt;
                const spend = turnUsage ? { turnUsage } : {};
                if (result.finish.reason === "aborted") return { phase: { kind: "aborted", durationMs, ...spend }, toPersist };
                // A `content-filter` finish is a refusal: a completed reply, not a fault. It
                // keeps the ok path's persistence and cost; only the kind differs.
                if (result.finish.reason === "content-filter") {
                    return {
                        phase: {
                            kind: "filtered",
                            fallbackText: finalText(result.messages),
                            ...(result.finish.rawFinishReason !== undefined ? { rawFinishReason: result.finish.rawFinishReason } : {}),
                            durationMs,
                            ...spend,
                        },
                        toPersist,
                    };
                }
                return { phase: { kind: "ok", fallbackText: finalText(result.messages), durationMs, ...spend }, toPersist };
            },
            // `runAgent` threw rather than resolving. For an abort this is the DEFENSIVE path — one that
            // never reached the streaming wrapper (e.g. the signal fired before the first model call), so
            // no resolved "aborted" finish carried a partial and only the user message survives here.
            // Classify as an abort ONLY when the throw is an AbortError (a DOMException named "AbortError",
            // which IS an `Error` instance under bun/node — so the name check keys on that, not on
            // `instanceof AbortError`) AND our own signal is aborted. A provider failure that merely RACED a
            // Ctrl+C would otherwise be swallowed as an abort and never logged; everything but a genuine
            // abort stays `failed`, carrying its cause.
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
        //
        // The rollup rides along so the turn's figure survives the reload that the live one does not:
        // the outcome below reaches only the store this process is holding, and a transcript loaded
        // from the thread would otherwise show every past turn's cost as absent — which under the
        // absent-is-not-zero rule reads as "no provider reported anything", a claim about the turn that
        // is false. The harness writes it onto the turn's own assistant row and hands it back on read.
        // Passed on EVERY branch for the same reason it rides on all three phases: an aborted or failed
        // turn spent real tokens, and only a run that never resolved has nothing to record.
        //
        // The measured duration rides along for the same reason, and it obeys the same rule: the live
        // header shows how long the turn took, and a reload that dropped the figure would show a turn
        // that nobody timed. It reads against `undefined` and never against falsiness, because a turn
        // that settled inside one millisecond measured zero and a measured zero is a figure.
        //
        // The display projection rides along for the same reason and on the same three branches: it is
        // what the transcript replays, so a turn whose projection is dropped reloads as though it had
        // shown nothing. `finish` is therefore called before the append, not inside the `ok` branch —
        // an aborted turn displayed real work, and its projection is what the retract window renders.
        const displayMessages = display.finish({
            ...(run.phase.kind === "ok" || run.phase.kind === "filtered" ? { fallbackText: run.phase.fallbackText } : {}),
            ...(run.phase.kind === "aborted" ? { interrupted: true } : {}),
        });
        const appendError = (
            await history.appendTurn(threadId, {
                modelMessages: run.toPersist,
                displayMessages,
                ...(run.phase.turnUsage ? { turnUsage: run.phase.turnUsage } : {}),
                ...(run.phase.durationMs !== undefined ? { turnDurationMs: run.phase.durationMs } : {}),
            })
        ).match(
            (): DbError | undefined => undefined,
            (e): DbError | undefined => e,
        );
        // The persistence fault rides ORTHOGONALLY on the outcome (the turn may still have succeeded);
        // log it here so the whole DbError survives even when the surface only shows a terse toast.
        if (appendError) getLogger("harness").warn({ appendError }, "chat turn append failed");

        // Forwarded by conditional spread on every branch, so a turn that reported nothing carries NO
        // `turnUsage` key at all rather than one holding `undefined` — the outcome must be readable as
        // "absent" by a consumer that only checks for the field.
        const spend = run.phase.turnUsage ? { turnUsage: run.phase.turnUsage } : {};
        switch (run.phase.kind) {
            case "ok":
                return { kind: "ok", fallbackText: run.phase.fallbackText, ...spend, appendError };
            case "filtered":
                // The one place the endpoint's own word survives — the banner shows only the generic line.
                getLogger("harness").warn({ rawFinishReason: run.phase.rawFinishReason }, "chat turn stopped by the model content filter");
                return {
                    kind: "filtered",
                    fallbackText: run.phase.fallbackText,
                    ...(run.phase.rawFinishReason !== undefined ? { rawFinishReason: run.phase.rawFinishReason } : {}),
                    ...spend,
                    appendError,
                };
            case "aborted":
                return { kind: "aborted", ...spend, appendError };
            case "failed":
                // The one place the full run failure survives — the banner collapses it to a one-liner.
                getLogger("harness").error({ cause: run.phase.cause }, "chat turn failed");
                return { kind: "failed", cause: run.phase.cause, ...spend, appendError };
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
        const only = tail.length === 1 ? tail[0] : undefined;
        if (!only || only.message.role !== "user") return okAsync<HealOutcome, DbError>({ kind: "not-orphaned" });
        return history.retractLastTurn(threadId);
    });
}
