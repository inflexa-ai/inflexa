import { describe, expect, test } from "bun:test";
import { ok, err, okAsync, errAsync, type ResultAsync } from "neverthrow";
import type {
    AgentChat,
    AgentDefinition,
    ConversationTurn,
    DbError,
    EmitFn,
    LlmUsageRecord,
    ModelMessage,
    Pool,
    ThreadHistory,
    UsageRecorder,
} from "@inflexa-ai/harness";

import { buildChatSession, healTailOrphan, runChatTurn, type ChatTurnSeams, type RunChatTurnArgs, type TurnOutcome } from "./turn.ts";

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
const chat = (_emit: EmitFn): AgentChat => ({}) as AgentChat;
const pool = {} as unknown as Pool;

/** A `prepare` seam that assembles one turn successfully. */
const prepareOk: ChatTurnSeams["prepare"] = () => Promise.resolve({ kind: "ok", threadType: "conversation", messages: [userMessage], userMessage });
/** A `prepare` seam that reports the thread absent/foreign (→ `thread_gone`). */
const prepareNotFound: ChatTurnSeams["prepare"] = () => Promise.resolve({ kind: "not_found" });
/** A `run` seam that finishes cleanly, appending one assistant message to the loop. */
const runOk: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({ messages: [...initial, assistantMessage], finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0 } });
/** A `run` seam that resolves a `content-filter` finish — the model declined and stopped. */
const runFiltered: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({
        messages: [...initial, assistantMessage],
        finish: { reason: "content-filter", rawFinishReason: "refusal", cappedOut: false, truncationRecoveries: 0 },
    });
/**
 * A `run` seam that RESOLVES an interrupted turn: the streaming wrapper surfaces the abort as a
 * resolved "aborted" finish carrying the partial loop output (here one partial assistant message).
 */
const runResolvesAbortedWithPartial: ChatTurnSeams["run"] = async (_agent, initial, _session, options) => {
    await options.emit({ type: "text-delta", text: "the ans" });
    return { messages: [...initial, partialAssistant], finish: { reason: "aborted", cappedOut: false, truncationRecoveries: 0 } };
};
/** A `run` seam that resolves an "aborted" finish whose loop output is empty (nothing streamed before the abort). */
const runResolvesAbortedEmpty: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({ messages: [...initial], finish: { reason: "aborted", cappedOut: false, truncationRecoveries: 0 } });
/**
 * A whole-turn rollup as a provider reports one. It deliberately carries the cache and reasoning
 * breakdowns alongside the two headline counts: those are breakdowns OF `inputTokens`/`outputTokens`,
 * so an engine that folded them in anywhere would show up as an inflated headline figure here.
 */
const TURN_USAGE = { inputTokens: 12_400, outputTokens: 3100, cacheReadInputTokens: 9800, reasoningTokens: 900 } as const;
/** What the TOP-LEVEL loop alone reported — deliberately smaller than {@link TURN_USAGE}, which includes its sub-agents. */
const LOOP_OWN_USAGE = { inputTokens: 4000, outputTokens: 1000 } as const;
/** What an interrupted turn had spent by the time the abort landed. */
const PARTIAL_USAGE = { inputTokens: 800, outputTokens: 120 } as const;

/**
 * A `run` seam that finishes cleanly reporting BOTH figures the harness offers: `usage` (this loop's
 * own calls) and `turnUsage` (the whole turn, every descendant sub-agent loop included). The engine
 * passes no accumulator into `runAgent`, so its loop is the turn's root and `turnUsage` is the one to
 * carry — having both here is what makes a regression to `usage` visible.
 */
const runOkWithUsage: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({
        messages: [...initial, assistantMessage],
        finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0, usage: { ...LOOP_OWN_USAGE }, turnUsage: { ...TURN_USAGE } },
    });
/** A `run` seam that resolves an "aborted" finish reporting what the turn had already spent. */
const runResolvesAbortedWithUsage: ChatTurnSeams["run"] = (_agent, initial) =>
    Promise.resolve({
        messages: [...initial, partialAssistant],
        finish: { reason: "aborted", cappedOut: false, truncationRecoveries: 0, turnUsage: { ...PARTIAL_USAGE } },
    });
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
    appended: { threadId: string; turn: ConversationTurn }[];
} {
    const appended: { threadId: string; turn: ConversationTurn }[] = [];
    const history: ThreadHistory = {
        appendTurn: (threadId, turn) => {
            appended.push({ threadId, turn });
            return append();
        },
        loadRecent: () => okAsync([]),
        loadPage: () => okAsync({ messages: [], total: 0, page: 1, perPage: 200, hasMore: false }),
        retractLastTurn: () => okAsync({ kind: "empty-thread" }),
        latestSeq: () => okAsync(null),
        countUserTurnsAfter: () => okAsync(0),
    };
    return { history, appended };
}

/**
 * A recorder that keeps what it was handed. Total and synchronous, matching the seam's own contract
 * (`record` neither throws nor awaits) — a stub that violated it would make a passing turn prove less
 * than it appears to.
 */
function recordingRecorder(): UsageRecorder & { records: LlmUsageRecord[] } {
    const records: LlmUsageRecord[] = [];
    return { records, record: (r: LlmUsageRecord) => void records.push(r) };
}

/** Drive one turn with the given seams/history/signal, filling the fixed primitives. */
function runWith(opts: {
    prepare: ChatTurnSeams["prepare"];
    run: ChatTurnSeams["run"];
    history: ThreadHistory;
    signal: AbortSignal;
    usageRecorder?: UsageRecorder;
    agents?: RunChatTurnArgs["agents"];
}): Promise<TurnOutcome> {
    return runChatTurn(
        {
            pool,
            // The resolver a turn resolves its agent through. The default registers the fixed
            // conversation agent for every type; the refusal case overrides it to refuse.
            agents: opts.agents ?? { forThread: () => ok(conversationAgent) },
            chat,
            history: opts.history,
            session,
            emit: noopEmit,
            signal: opts.signal,
            usageRecorder: opts.usageRecorder ?? recordingRecorder(),
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
    test("hands runAgent a logger, so the loop's account of the turn is not discarded", async () => {
        // `RunAgentOptions.logger` is optional and falls back to `createNoopLogger()`.
        // Omitting it is neither a type error nor a runtime error — the loop just stops
        // reporting its iteration count, stop reason, and tool-error tally, and
        // `runToTerminal` stops reporting that it salvaged a run. Every sub-agent loop a
        // turn drives goes dark with it, because hosts filter that traffic off the chat
        // surface by `callPath` depth and the record is what survives instead.
        let seen: Parameters<ChatTurnSeams["run"]>[3] | undefined;
        const captureRun: ChatTurnSeams["run"] = (agent, initial, session, opts) => {
            seen = opts;
            return runOk(agent, initial, session, opts);
        };

        const { history } = recordingHistory();
        await runWith({ prepare: prepareOk, run: captureRun, history, signal: new AbortController().signal });

        expect(seen?.logger).toBeDefined();
        expect(seen?.logger?.named).toBeInstanceOf(Function);
    });

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
        expect(appended[0]?.threadId).toBe(THREAD_ID);
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage, assistantMessage]);
        expect(appended[0]?.turn.displayMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
        // A turn that reported nothing carries no `turnUsage` KEY, not one holding `undefined` — the
        // engine spreads it conditionally so absence has one representation all the way to storage.
        expect(appended[0]?.turn && "turnUsage" in appended[0].turn).toBe(false);
    });

    test("a content-filter finish persists like ok and returns filtered with the endpoint's word", async () => {
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runFiltered, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("filtered");
        if (outcome.kind === "filtered") {
            expect(outcome.fallbackText).toBe("the answer");
            expect(outcome.rawFinishReason).toBe("refusal");
            expect(outcome.appendError).toBeUndefined();
        }
        // The refusal keeps the ok path's persistence: the reply and its display projection land.
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage, assistantMessage]);
        expect(appended[0]?.turn.displayMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    });

    test("a resolved aborted finish persists [userMessage, ...partial] and returns aborted", async () => {
        // The interrupted run resolves with its partial transcript, so the success arm branches on
        // `finish.reason` — not on `signal.aborted` (the signal is left unaborted here to prove that).
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runResolvesAbortedWithPartial, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("aborted");
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage, partialAssistant]);
        expect(appended[0]?.turn.displayMessages[1]?.metadata).toEqual({ interrupted: true });
    });

    test("a resolved aborted finish with an empty partial persists [userMessage] alone", async () => {
        const { history, appended } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runResolvesAbortedEmpty, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("aborted");
        // No loop output beyond `initial`, so the slice is empty and only the user turn is persisted.
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage]);
    });

    test("an AbortError under an aborted signal persists [userMessage] only and returns aborted", async () => {
        // The DEFENSIVE path: the abort escaped as a throw before the streaming wrapper could resolve an
        // "aborted" finish, so no partial array is available and only the user turn survives.
        const { history, appended } = recordingHistory();
        const controller = new AbortController();
        controller.abort();
        const outcome = await runWith({ prepare: prepareOk, run: runAborts, history, signal: controller.signal });
        expect(outcome.kind).toBe("aborted");
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage]);
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
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage]);
    });

    test("a non-abort throw with a non-aborted signal is a failed outcome carrying the cause", async () => {
        const { history, appended } = recordingHistory();
        const cause = new Error("runAgent exploded");
        const outcome = await runWith({ prepare: prepareOk, run: () => Promise.reject(cause), history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") expect(outcome.cause).toBe(cause);
        expect(appended[0]?.turn.modelMessages).toEqual([userMessage]);
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

    test("an unregistered thread type is agent_unresolved — runAgent is never reached and nothing is appended", async () => {
        // Preparation SUCCEEDS and yields a valid `report` thread, but this build registered no agent
        // for that type, so the resolver refuses on its `Result` channel. Distinct from `prepare_failed`:
        // nothing faulted — the type is simply one this build cannot serve — so the turn bails BEFORE
        // `runAgent` and persists nothing, exactly as the thread-gone bail does.
        const { history, appended } = recordingHistory();
        let ran = false;
        // `runOk` is typed `ChatTurnSeams["run"]` (= `typeof runAgent`), so its four
        // parameters are all required at the call site even though its body reads only
        // the first two. Forward all four — dropping `s`/`opts` is a `tsc` error, not a
        // cleanup (an automated-review bot flagged them as superfluous; they are not).
        const run: ChatTurnSeams["run"] = (agent, initial, s, opts) => {
            ran = true;
            return runOk(agent, initial, s, opts);
        };
        const prepareReport: ChatTurnSeams["prepare"] = () => Promise.resolve({ kind: "ok", threadType: "report", messages: [userMessage], userMessage });
        const outcome = await runWith({
            prepare: prepareReport,
            run,
            history,
            signal: new AbortController().signal,
            agents: { forThread: () => err({ type: "unregistered_thread_type", threadType: "report" }) },
        });
        expect(outcome).toEqual({ kind: "agent_unresolved", threadType: "report" });
        expect(ran).toBe(false);
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

// The turn's own total rides the outcome rather than being read back from the usage ledger: a
// chat-path usage record is attributed to a thread, never to a turn, so the ledger structurally
// cannot answer "what did THIS turn cost". These pin what the engine forwards, and — just as
// importantly — when it forwards nothing.
describe("runChatTurn carries the turn's usage rollup", () => {
    test("an ok turn carries the finish's rollup whole, per quantity", async () => {
        const { history } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runOkWithUsage, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("ok");
        // Whole, not reduced: every quantity the provider reported survives, and the two headline
        // counts are exactly what was reported — nothing folded the cache/reasoning breakdowns in.
        if (outcome.kind === "ok") expect(outcome.turnUsage).toEqual(TURN_USAGE);
    });

    test("the rollup is the TURN's, not the root loop's own — a sub-agent's spend is included", async () => {
        const { history } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runOkWithUsage, history, signal: new AbortController().signal });
        if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
        // The finish offered both. Reading `usage` would report only the top-level loop's calls and
        // silently undercount every turn that dispatched a sub-agent.
        expect(outcome.turnUsage?.inputTokens).toBe(TURN_USAGE.inputTokens);
        expect(outcome.turnUsage?.inputTokens ?? 0).toBeGreaterThan(LOOP_OWN_USAGE.inputTokens);
    });

    test("an interrupted turn carries what it spent before the abort", async () => {
        const { history } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runResolvesAbortedWithUsage, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("aborted");
        if (outcome.kind === "aborted") expect(outcome.turnUsage).toEqual(PARTIAL_USAGE);
    });

    test("a turn whose calls reported nothing carries NO rollup — no key, and no zeroed stand-in", async () => {
        const { history } = recordingHistory();
        const outcome = await runWith({ prepare: prepareOk, run: runOk, history, signal: new AbortController().signal });
        expect(outcome.kind).toBe("ok");
        if (outcome.kind === "ok") expect(outcome.turnUsage).toBeUndefined();
        // Absence is structural, not a field holding `undefined`: a consumer that tests for the key
        // must read "nothing was reported", never "reported as unknown".
        expect("turnUsage" in outcome).toBe(false);
    });

    test("a failed turn carries no rollup — a run that THREW resolved no finish to read one from", async () => {
        const { history } = recordingHistory();
        const outcome = await runWith({
            prepare: prepareOk,
            run: () => Promise.reject(new Error("provider 503")),
            history,
            signal: new AbortController().signal,
        });
        expect(outcome.kind).toBe("failed");
        expect("turnUsage" in outcome).toBe(false);
    });

    test("the rollup is also PERSISTED, so a reloaded transcript is not a wall of unreported turns", async () => {
        // The outcome above reaches only the store this process is holding. Without the third argument
        // the harness has nothing to write onto the turn's assistant row, and every past turn reloads
        // with its figure absent — which under the absent-is-not-zero rule reads as "no provider
        // reported anything", a claim about the turn that is false.
        const { history, appended } = recordingHistory();
        await runWith({ prepare: prepareOk, run: runOkWithUsage, history, signal: new AbortController().signal });
        expect(appended).toHaveLength(1);
        expect(appended[0]?.turn.turnUsage).toEqual(TURN_USAGE);
    });

    test("an interrupted turn persists what it spent, and a turn that reported nothing persists nothing", async () => {
        // The abort spent real tokens before it landed, so dropping its rollup at the write would be
        // the same unreported/nothing-spent conflation the whole ledger is built to avoid...
        const aborted = recordingHistory();
        await runWith({ prepare: prepareOk, run: runResolvesAbortedWithUsage, history: aborted.history, signal: new AbortController().signal });
        expect(aborted.appended[0]?.turn.turnUsage).toEqual(PARTIAL_USAGE);

        // ...while a turn whose calls reported nothing writes `undefined`, never a zeroed stand-in the
        // reload would then render as a measurement.
        const silent = recordingHistory();
        await runWith({ prepare: prepareOk, run: runOk, history: silent.history, signal: new AbortController().signal });
        expect(silent.appended[0]?.turn.turnUsage).toBeUndefined();
    });

    test("the carried rollup is a snapshot — the harness mutating its accumulator afterwards cannot change it", async () => {
        // `AgentRunUsage`'s fields are mutable and the value travels into a Solid store, so the engine
        // hands out something it owns rather than an alias of the loop's accumulator.
        const live = { inputTokens: 100, outputTokens: 10 };
        const { history } = recordingHistory();
        const outcome = await runWith({
            prepare: prepareOk,
            run: (_agent, initial) =>
                Promise.resolve({
                    messages: [...initial, assistantMessage],
                    finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0, turnUsage: live },
                }),
            history,
            signal: new AbortController().signal,
        });
        live.inputTokens = 999_999;
        if (outcome.kind === "ok") expect(outcome.turnUsage?.inputTokens).toBe(100);
    });
});

// How long the turn took is the second meta fact the header shows, and the store is the only place it
// can survive a reload: the elapsed time of a past turn is unknowable once the process that timed it is
// gone. These pin what the engine writes, and — as with the rollup — when it writes nothing.
describe("runChatTurn persists what the turn took", () => {
    test("a settled turn persists its measured duration, so a reloaded header reads as the live one did", async () => {
        // The measurement is the whole of the claim: a key holding a value that no clock produced would
        // satisfy a presence assertion and still show a figure that nothing earned. The seam waits, thus
        // the stored number must cover at least that wait.
        const SLEEP_MS = 12;
        const runSlowly: ChatTurnSeams["run"] = async (_agent, initial) => {
            await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
            return { messages: [...initial, assistantMessage], finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0 } };
        };

        const { history, appended } = recordingHistory();
        await runWith({ prepare: prepareOk, run: runSlowly, history, signal: new AbortController().signal });

        // A small margin under the wait, because a clock reads in whole milliseconds. The claim is a real
        // span, and not an exact one.
        expect(appended[0]?.turn.turnDurationMs).toBeGreaterThanOrEqual(SLEEP_MS - 2);
    });

    test("a turn that reported no quantity still persists its duration — the two figures are independent", async () => {
        // The duration keeps a column of its own in the store. A turn whose provider reported nothing must
        // still read back with the time that the reader watched it take.
        const { history, appended } = recordingHistory();
        await runWith({ prepare: prepareOk, run: runOk, history, signal: new AbortController().signal });

        expect(appended[0]?.turn.turnUsage).toBeUndefined();
        expect(typeof appended[0]?.turn.turnDurationMs).toBe("number");
    });

    test("an aborted turn that never resolved persists NO duration — no key, and no zeroed stand-in", async () => {
        // The DEFENSIVE abort path: the run threw before the streaming wrapper resolved a finish, thus only
        // the user message persists and no assistant row exists to carry a figure. The live surface drops
        // that turn's empty assistant shell, so both surfaces show the same turn with no header at all.
        const { history, appended } = recordingHistory();
        const controller = new AbortController();
        controller.abort();
        await runWith({ prepare: prepareOk, run: runAborts, history, signal: controller.signal });

        expect(appended[0]?.turn.modelMessages).toEqual([userMessage]);
        expect(appended[0]?.turn && "turnDurationMs" in appended[0].turn).toBe(false);
    });

    test("an interrupted turn that DID resolve persists its duration, thus the marked header keeps its figure", async () => {
        // A resolved abort carries a partial reply, thus it has an assistant row and a header. The live view
        // stamps that header with a duration, and a reload that dropped it would show one turn two ways.
        const { history, appended } = recordingHistory();
        await runWith({ prepare: prepareOk, run: runResolvesAbortedWithPartial, history, signal: new AbortController().signal });

        expect(appended[0]?.turn.displayMessages[1]?.metadata).toEqual({ interrupted: true });
        expect(typeof appended[0]?.turn.turnDurationMs).toBe("number");
    });
});

// What the engine hands `runAgent` is the whole of this loop's accounting: the harness reads the
// recorder off the OPTIONS bag and falls back to its no-op when the field is absent, never consulting
// the agent definition. So the bag is the artifact worth asserting on — a test that hands `runAgent` a
// fake and checks the fake ran proves the loop happened, not that anything was accounted for, which is
// how the conversation agent went unrecorded while a scenario claiming its coverage passed.
//
// `usage_ledger.test.ts` closes the loop with the REAL `runAgent` and a real persisted row; these pin
// the composition itself, including the branches where a turn ends badly and its spend must still count.
describe("runChatTurn hands runAgent the caller's usage recorder", () => {
    /** Run one turn, returning the options `runChatTurn` composed for the loop. */
    async function optionsFor(
        run: ChatTurnSeams["run"],
        usageRecorder: UsageRecorder,
        signal = new AbortController().signal,
    ): Promise<Parameters<ChatTurnSeams["run"]>[3]> {
        let captured: Parameters<ChatTurnSeams["run"]>[3] | undefined;
        const { history } = recordingHistory();
        await runWith({
            prepare: prepareOk,
            run: (agent, initial, s, opts) => {
                captured = opts;
                return run(agent, initial, s, opts);
            },
            history,
            signal,
            usageRecorder,
        });
        if (captured === undefined) throw new Error("runAgent was never reached");
        return captured;
    }

    test("the composed options carry the caller's recorder, not a no-op stand-in", async () => {
        const recorder = recordingRecorder();
        const opts = await optionsFor(runOk, recorder);
        // Identity, not merely presence: a `createNoopUsageRecorder()` here would satisfy the type,
        // satisfy every other assertion in this file, and drop every call the turn made.
        expect(opts.usageRecorder).toBe(recorder);
    });

    test("it rides the options unconditionally, on the abort and failure branches too", async () => {
        // Unlike `ask`, which is conditionally spread because the harness resolves an absent one to a
        // deny-by-default policy, an absent recorder is not a policy — it is silence. A turn that ends
        // in an abort or a provider failure spent real tokens before it ended.
        const aborting = new AbortController();
        aborting.abort();
        for (const [run, signal] of [
            [runResolvesAbortedWithPartial, new AbortController().signal],
            [runAborts, aborting.signal],
            [() => Promise.reject(new Error("provider 503")), new AbortController().signal],
        ] as const) {
            const recorder = recordingRecorder();
            expect((await optionsFor(run, recorder, signal)).usageRecorder).toBe(recorder);
        }
    });

    test("the turn carries no accumulator, so the loop it starts is the turn's root", async () => {
        // The reason the outcome reads `finish.turnUsage` rather than `finish.usage`: a loop handed no
        // `turnUsage` creates its own and reports the whole turn's total, sub-agent loops included.
        const opts = await optionsFor(runOk, recordingRecorder());
        expect(opts.turnUsage).toBeUndefined();
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
        latestSeq: () => okAsync(null),
        countUserTurnsAfter: () => okAsync(0),
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
