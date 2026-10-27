import { type ResultAsync, okAsync } from "neverthrow";
import {
    createThreadHistory,
    makeLocalAuth,
    type AgentFinish,
    type ChatFrame,
    type ChatTurnEnd,
    type ChatTurns,
    type ChatTurnSession,
    type DbError,
    type Pool,
    type RetractOutcome,
    type ThreadHistory,
    type ThreadType,
} from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import { currentUserEmail } from "../auth/whoami.ts";
import { enterChatTurn } from "./agent_switch.ts";

// The headless chat turn engine that the chat route of the local server runs. It opens the turn workflow of the
// harness, gives the frames of the turn to the surface, and maps the outcome. It does no terminal output.

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
 * failure keeps the stored rounds. The four kinds that ran carry `opened`, and a store fault as `storeFailed`.
 */
export type TurnOutcome =
    | { readonly kind: "ok"; readonly opened: boolean; readonly fallbackText: string; readonly turnUsage?: TurnUsage; readonly storeFailed?: boolean }
    | {
          readonly kind: "filtered";
          readonly opened: boolean;
          readonly fallbackText: string;
          readonly rawFinishReason?: string;
          readonly turnUsage?: TurnUsage;
          readonly storeFailed?: boolean;
      }
    | { readonly kind: "aborted"; readonly opened: boolean; readonly turnUsage?: TurnUsage; readonly storeFailed?: boolean }
    | {
          readonly kind: "failed";
          readonly opened: boolean;
          /** The text of the failure, scrubbed by the harness. */
          readonly reason: string;
          /** The machine code of the failure, for example `credential`. */
          readonly code?: string;
          readonly turnUsage?: TurnUsage;
          readonly storeFailed?: boolean;
      }
    | { readonly kind: "prepare_failed"; readonly cause: unknown }
    | { readonly kind: "thread_gone" }
    | { readonly kind: "agent_unresolved"; readonly threadType: ThreadType }
    | { readonly kind: "turn_in_progress" };

/** The values of one chat turn. */
export type RunChatTurnArgs = {
    /** The chat turns of the runtime (`runtime.chatTurns`). */
    readonly chatTurns: ChatTurns;
    /**
     * Carries `threadId` in scope, so a plan launched here stamps `cortex_runs.thread_id`. The harness
     * sets the provenance from the agent of the thread.
     */
    readonly session: ChatTurnSession;
    /** The live frame sink of the surface. The end frame of the turn does not reach it, because the caller sends its own. */
    readonly emit: (frame: ChatFrame) => void;
    /** The abort of the turn, which the caller owns. It stops the turn. */
    readonly signal: AbortSignal;
    /** The resolved analysis this turn is scoped to (ownership check + context load). */
    readonly analysisId: string;
    /** The conversation thread this turn appends to. */
    readonly threadId: string;
    /** The sanitized user input opening the turn. */
    readonly userInput: string;
    /**
     * Runs one time when the turn is open, with the id of the turn. A refusal never calls it. The chat route of
     * the server registers the turn and sends its stream headers at this moment.
     */
    readonly onOpened?: (turnId: string) => void;
};

/** Injectable edges, thus {@link runChatTurn} is unit-testable offline. The chat turns themselves ride in the args. */
export type ChatTurnSeams = {
    /**
     * Who sent the message: the email of the signed-in identity, or `null` when the cli can name
     * nobody. Real: `currentUserEmail`. Injectable, because the suite runs with no auth file.
     */
    readonly readAuthor: () => string | null;
};

const realTurnSeams: ChatTurnSeams = { readAuthor: currentUserEmail };

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
 * Run one chat turn through the turn workflow of the harness, and map its outcome to a {@link TurnOutcome}.
 * The harness stores the opening, each round, and the outcome, thus a failure keeps the stored rounds. The
 * caller renders the outcome.
 */
export async function runChatTurn(args: RunChatTurnArgs, seams: ChatTurnSeams = realTurnSeams): Promise<TurnOutcome> {
    const { chatTurns, session, emit, signal, analysisId, threadId, userInput, onOpened } = args;

    // An agent switch requested during the turn waits for this token, and the `finally` lands it.
    const leaveChatTurn = enterChatTurn();
    // The live header measures from the moment the surface opens the turn, thus the stored duration does too.
    const turnStartedAt = Date.now();
    try {
        // Read at the top, because the author is who sent the message: a sign-out during the turn
        // must not erase that person. Inside the `try`, thus a throw cannot strand the turn token.
        const author = seams.readAuthor();
        const started = await chatTurns.open(session, {
            analysisId,
            threadId,
            userInput,
            startedAtMs: turnStartedAt,
            // An empty email is no sender, thus it never reaches the store as a name.
            ...(author ? { author } : {}),
        });
        switch (started.kind) {
            case "prepare_failed":
                // The surface shows one line, thus the log keeps the whole cause.
                getLogger("harness").error({ cause: started.cause }, "chat turn prepare failed");
                return { kind: "prepare_failed", cause: started.cause };
            case "not_found":
                return { kind: "thread_gone" };
            case "agent_unresolved":
                getLogger("harness").error({ threadType: started.threadType }, "chat turn agent unresolved");
                return { kind: "agent_unresolved", threadType: started.threadType };
            case "turn_in_progress":
                return { kind: "turn_in_progress" };
            case "started":
                break;
            default: {
                const exhaustive: never = started;
                throw new Error(`unhandled turn start: ${JSON.stringify(exhaustive)}`);
            }
        }

        const { turnId } = started;
        onOpened?.(turnId);
        const stop = (): void => {
            chatTurns.stop(turnId).catch((cause: unknown) => getLogger("harness").warn({ err: cause, turnId }, "the stop of a chat turn failed"));
        };
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
        try {
            for await (const frame of chatTurns.read(turnId)) {
                // The caller sends the end frame of the turn, with the remedy of a failure that it knows.
                if (frame.type === "finish" || frame.type === "error") continue;
                emit(frame);
            }
        } finally {
            signal.removeEventListener("abort", stop);
        }
        return outcomeOfEnd(await chatTurns.outcome(turnId));
    } finally {
        leaveChatTurn();
    }
}

function outcomeOfEnd(end: ChatTurnEnd | null): TurnOutcome {
    // A turn workflow that ended with no result was canceled, or its body threw past the turn.
    if (end === null) return { kind: "failed", opened: true, reason: "The turn ended with no outcome." };
    if (end.storeFailed === true) getLogger("harness").warn({ storeFailed: true }, "chat turn append failed");
    // A copy, because the value travels into the turn registry. An absent rollup leaves no key.
    const spend = {
        ...(end.turnUsage === undefined ? {} : { turnUsage: { ...end.turnUsage } }),
        ...(end.storeFailed === true ? { storeFailed: true } : {}),
    };
    const opened = end.opened;
    const fallbackText = end.fallbackText ?? "";
    switch (end.status) {
        case "done": {
            if (end.finishReason !== "content-filter") return { kind: "ok", opened, fallbackText, ...spend };
            // The one place the endpoint's own word survives — the banner shows only the generic line.
            getLogger("harness").warn({ rawFinishReason: end.rawFinishReason }, "chat turn stopped by the model content filter");
            return { kind: "filtered", opened, fallbackText, ...(end.rawFinishReason === undefined ? {} : { rawFinishReason: end.rawFinishReason }), ...spend };
        }
        case "aborted":
            return { kind: "aborted", opened, ...spend };
        case "failed":
            getLogger("harness").error({ reason: end.reason, code: end.code }, "chat turn failed");
            return {
                kind: "failed",
                opened,
                reason: end.reason ?? "The turn failed.",
                ...(end.code === undefined ? {} : { code: end.code }),
                ...spend,
            };
        default: {
            const exhaustive: never = end.status;
            throw new Error(`unhandled turn status: ${JSON.stringify(exhaustive)}`);
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
