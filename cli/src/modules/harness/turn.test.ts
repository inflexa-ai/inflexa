import { describe, expect, test } from "bun:test";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";
import type { AgentChat, AgentDefinition, DbError, EmitFn, ModelMessage, Pool, ThreadHistory } from "@inflexa-ai/harness";

import { buildChatSession, healTailOrphan, runChatTurn, type ChatTurnSeams, type TurnOutcome } from "./turn.ts";

// The engine is exercised entirely offline: the `prepare`/`run` harness edges are
// injected as fakes (no Postgres, no model, no credits — the BootSeams pattern),
// and a recording `ThreadHistory` captures exactly what `appendTurn` was handed.

const ANALYSIS_ID = "an-1";
const THREAD_ID = "t-1";
const USER_INPUT = "hello";
const userMessage: ModelMessage = { role: "user", content: USER_INPUT };
const assistantMessage: ModelMessage = { role: "assistant", content: "the answer" };
const partialAssistant: ModelMessage = { role: "assistant", content: "the ans" };
const conversationAgent: AgentDefinition = { id: "conv", systemPrompt: "", model: "m", tools: [], maxIterations: 1 };
const session = buildChatSession("cli-chat", ANALYSIS_ID, THREAD_ID);
const noopEmit: EmitFn = () => {};
const DB_ERROR: DbError = { type: "query_failed", op: "thread-store.appendTurn", cause: new Error("db down") } as const;

// The injected `run` seam never reads the provider, and the `prepare` seam never
// reads the pool — bare stubs stand in for the unreachable dependencies rather
// than constructing a real streaming provider / pg pool for a headless test.
const chat = {} as unknown as AgentChat;
const pool = {} as unknown as Pool;

/** A `prepare` seam that assembles one turn successfully. */
const prepareOk: ChatTurnSeams["prepare"] = () => Promise.resolve({ kind: "ok", messages: [userMessage], userMessage });
/** A `prepare` seam that reports the thread absent/foreign (→ `thread_gone`). */
const prepareNotFound: ChatTurnSeams["prepare"] = () => Promise.resolve({ kind: "not_found" });
/** A `run` seam that finishes cleanly, appending one assistant message to the loop. */
const runOk: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({ messages: [...initial, assistantMessage], finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0 } });
/**
 * A `run` seam that RESOLVES an interrupted turn: the streaming wrapper surfaces the abort as a
 * resolved "aborted" finish carrying the partial loop output (here one partial assistant message).
 */
const runResolvesAbortedWithPartial: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({ messages: [...initial, partialAssistant], finish: { reason: "aborted", cappedOut: false, truncationRecoveries: 0 } });
/** A `run` seam that resolves an "aborted" finish whose loop output is empty (nothing streamed before the abort). */
const runResolvesAbortedEmpty: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({ messages: [...initial], finish: { reason: "aborted", cappedOut: false, truncationRecoveries: 0 } });
/**
 * A `run` seam that throws the AbortError the streaming provider re-throws verbatim on cancellation
 * (name "AbortError"). The abort classification keys on the error's NAME, not merely on `signal.aborted`.
 */
const runAborts: ChatTurnSeams["run"] = () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return Promise.reject(e);
};

/** A `ThreadHistory` whose `appendTurn` records its payload; the read methods are unused here. */
function recordingHistory(append: () => ResultAsync<void, DbError> = () => okAsync(undefined)): {
    history: ThreadHistory;
    appended: { threadId: string; messages: readonly ModelMessage[] }[];
} {
    const appended: { threadId: string; messages: readonly ModelMessage[] }[] = [];
    const history: ThreadHistory = {
        appendTurn: (threadId, messages) => {
            appended.push({ threadId, messages });
            return append();
        },
        loadRecent: () => okAsync([]),
        loadPage: () => okAsync({ messages: [], total: 0, page: 1, perPage: 200, hasMore: false }),
        retractLastTurn: () => okAsync({ kind: "empty-thread" }),
    };
    return { history, appended };
}

/** Drive one turn with the given seams/history/signal, filling the fixed primitives. */
function runWith(opts: { prepare: ChatTurnSeams["prepare"]; run: ChatTurnSeams["run"]; history: ThreadHistory; signal: AbortSignal }): Promise<TurnOutcome> {
    return runChatTurn(
        {
            pool,
            conversationAgent,
            chat,
            history: opts.history,
            session,
            emit: noopEmit,
            signal: opts.signal,
            analysisId: ANALYSIS_ID,
            threadId: THREAD_ID,
            userInput: USER_INPUT,
        },
        { prepare: opts.prepare, run: opts.run },
    );
}

describe("buildChatSession", () => {
    test("stamps the agent id into provenance with a length-1 callPath", () => {
        const s = buildChatSession("tui-chat", "an-9", "t-9");
        expect(s.provenance).toEqual({ agentId: "tui-chat", callPath: ["tui-chat"] });
        expect(s.scope).toEqual({ kind: "analysis", analysisId: "an-9", threadId: "t-9" });
        expect(s.identity).toEqual({ user: "local" });
    });
});

describe("runChatTurn", () => {
    test("ok path persists [userMessage, ...loopOutput] and returns finalText", async () => {
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runOk, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("ok");
        if (outcome.kind === "ok") {
            expect(outcome.fallbackText).toBe("the answer");
            expect(outcome.appendError).toBeUndefined();
        }
        // The loop output (only the assistant reply, sliced past `initial`) is
        // appended after the standalone user message.
        expect(appended).toEqual([{ threadId: THREAD_ID, messages: [userMessage, assistantMessage] }]);
    });

    test("a resolved aborted finish persists [userMessage, ...partial] and returns aborted", async () => {
        // The interrupted run resolves with its partial transcript, so the success arm branches on
        // `finish.reason` — not on `signal.aborted` (the signal is left unaborted here to prove that).
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runResolvesAbortedWithPartial, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("aborted");
        expect(appended).toEqual([{ threadId: THREAD_ID, messages: [userMessage, partialAssistant] }]);
    });

    test("a resolved aborted finish with an empty partial persists [userMessage] alone", async () => {
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runResolvesAbortedEmpty, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("aborted");
        // No loop output beyond `initial`, so the slice is empty and only the user turn is persisted.
        expect(appended).toEqual([{ threadId: THREAD_ID, messages: [userMessage] }]);
    });

    test("an AbortError under an aborted signal persists [userMessage] only and returns aborted", async () => {
        // The DEFENSIVE path: the abort escaped as a throw before the streaming wrapper could resolve an
        // "aborted" finish, so no partial array is available and only the user turn survives.
        const { history, appended } = recordingHistory();
        const controller = new AbortController();
        controller.abort();
        const outcome = await runWith({ prepare: prepareOk, run: runAborts, history, signal: controller.signal });
        expect(outcome.kind).toBe("aborted");
        expect(appended).toEqual([{ threadId: THREAD_ID, messages: [userMessage] }]);
    });

    test("a provider failure racing an abort is failed (cause preserved), never masked as aborted", async () => {
        // The signal is aborted, but the throw is NOT the streaming provider's AbortError — it is a real
        // provider failure that happened to race a Ctrl+C. Classifying it `aborted` would silently drop
        // the cause; it must surface as `failed` so the failure is logged and inspectable.
        const { history, appended } = recordingHistory();
        const controller = new AbortController();
        controller.abort();
        const cause = new Error("provider 503");
        const outcome = await runWith({ prepare: prepareOk, run: () => Promise.reject(cause), history, signal: controller.signal });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") expect(outcome.cause).toBe(cause);
        expect(appended).toEqual([{ threadId: THREAD_ID, messages: [userMessage] }]);
    });

    test("a non-abort throw with a non-aborted signal is a failed outcome carrying the cause", async () => {
        const { history, appended } = recordingHistory();
        const cause = new Error("runAgent exploded");
        const outcome = await runWith({ prepare: prepareOk, run: () => Promise.reject(cause), history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") expect(outcome.cause).toBe(cause);
        expect(appended).toEqual([{ threadId: THREAD_ID, messages: [userMessage] }]);
    });

    test("prepare failure short-circuits before runAgent — nothing is appended", async () => {
        const { history, appended } = recordingHistory();
        const cause = new Error("pg unreachable");
        const outcome = await runWith({ prepare: () => Promise.reject(cause), run: runOk, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("prepare_failed");
        if (outcome.kind === "prepare_failed") expect(outcome.cause).toBe(cause);
        expect(appended).toEqual([]);
    });

    test("an absent/foreign thread is thread_gone — nothing is appended", async () => {
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareNotFound, run: runOk, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("thread_gone");
        expect(appended).toEqual([]);
    });

    test("an appendTurn fault is surfaced on appendError, orthogonal to the ok outcome", async () => {
        const { history } = recordingHistory(() => errAsync(DB_ERROR));
        const outcome = await runWith({ prepare: prepareOk, run: runOk, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("ok");
        if (outcome.kind === "ok") {
            expect(outcome.fallbackText).toBe("the answer");
            expect(outcome.appendError).toEqual(DB_ERROR);
        }
    });
});

// --- healTailOrphan ---------------------------------------------------------

/**
 * A `ThreadHistory` staged at one tail shape: `loadPage` reports `turns.length` as the turn count and
 * returns the addressed turn's rows, so the heal's two reads see a real thread without a Postgres. Every
 * `retractLastTurn` is counted, which is the whole point — the guard's job is to not call it.
 */
function stagedHistory(turns: ModelMessage[][]): { history: ThreadHistory; retracts: () => number } {
    let retracts = 0;
    const history: ThreadHistory = {
        appendTurn: () => okAsync(undefined),
        loadRecent: () => okAsync(turns.flat()),
        loadPage: (_threadId, page, perPage) => {
            const turn = turns[page] ?? [];
            return okAsync({
                messages: turn.map((message, seq) => ({ seq, envelope: { kind: "ai-sdk-model-message" as const, aiSdkMajor: 7 as const, message }, message })),
                total: turns.length,
                page,
                perPage,
                hasMore: page + 1 < turns.length,
            });
        },
        retractLastTurn: () => {
            retracts++;
            return okAsync({ kind: "retracted", messages: turns[turns.length - 1]?.length ?? 0 });
        },
    };
    return { history, retracts: () => retracts };
}

describe("healTailOrphan", () => {
    test("removes the tail when it is still the lone user turn a failed retract left", async () => {
        const { history, retracts } = stagedHistory([[userMessage, assistantMessage], [userMessage]]);

        const outcome = (await healTailOrphan(pool, THREAD_ID, { history: () => history }))._unsafeUnwrap();

        expect(outcome).toEqual({ kind: "retracted", messages: 1 });
        expect(retracts()).toBe(1);
    });

    test("declines when the tail is an answered turn — the retract it is healing already landed", async () => {
        // The failure that scheduled a heal cannot distinguish a rolled-back retract from one whose commit
        // landed but lost its acknowledgement. In the second case the orphan is already gone and the tail is
        // real history; a blind retry would delete it. This is the assertion that stops that.
        const { history, retracts } = stagedHistory([
            [userMessage, assistantMessage],
            [userMessage, assistantMessage],
        ]);

        const outcome = (await healTailOrphan(pool, THREAD_ID, { history: () => history }))._unsafeUnwrap();

        expect(outcome).toEqual({ kind: "not-orphaned" });
        expect(retracts()).toBe(0);
    });

    test("declines a multi-row tail turn that merely opens on a user message", async () => {
        // A turn carrying tool traffic but no final assistant text is still an answered turn, not an orphan:
        // the orphan an aborted turn leaves is exactly one row.
        const toolResult: ModelMessage = {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "t1", toolName: "search", output: { type: "text", value: "{}" } }],
        };
        const { history, retracts } = stagedHistory([[userMessage, assistantMessage, toolResult]]);

        expect((await healTailOrphan(pool, THREAD_ID, { history: () => history }))._unsafeUnwrap()).toEqual({ kind: "not-orphaned" });
        expect(retracts()).toBe(0);
    });

    test("reports empty-thread without a second read when the thread holds nothing", async () => {
        const { history, retracts } = stagedHistory([]);

        expect((await healTailOrphan(pool, THREAD_ID, { history: () => history }))._unsafeUnwrap()).toEqual({ kind: "empty-thread" });
        expect(retracts()).toBe(0);
    });
});
