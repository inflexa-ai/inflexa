import { describe, expect, test } from "bun:test";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";
import type { AgentChat, AgentDefinition, DbError, EmitFn, ModelMessage, Pool, ThreadHistory } from "@inflexa-ai/harness";

import { buildChatSession, runChatTurn, type ChatTurnSeams, type TurnOutcome } from "./turn.ts";

// The engine is exercised entirely offline: the `prepare`/`run` harness edges are
// injected as fakes (no Postgres, no model, no credits — the BootSeams pattern),
// and a recording `ThreadHistory` captures exactly what `appendTurn` was handed.

const ANALYSIS_ID = "an-1";
const THREAD_ID = "t-1";
const USER_INPUT = "hello";
const userMessage: ModelMessage = { role: "user", content: USER_INPUT };
const assistantMessage: ModelMessage = { role: "assistant", content: "the answer" };
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

    test("an AbortError under an aborted signal persists [userMessage] only and returns aborted", async () => {
        const { history, appended } = recordingHistory();
        const controller = new AbortController();
        controller.abort();
        const outcome = await runWith({ prepare: prepareOk, run: runAborts, history, signal: controller.signal });
        expect(outcome.kind).toBe("aborted");
        // `runAgent` throws before returning its array, so only the user turn survives.
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
