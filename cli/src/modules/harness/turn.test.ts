import { describe, expect, test } from "bun:test";
import { ok, okAsync } from "neverthrow";
import {
    syntheticUserMessage,
    type AgentChat,
    type AgentDefinition,
    type AgentFinish,
    type AskApproval,
    type AskRequest,
    type ChatTurnOutcome,
    type ChatTurnResult,
    type DbError,
    type EmitFn,
    type LlmUsageRecord,
    type ModelMessage,
    type Pool,
    type RunChatTurnDeps,
    type RunChatTurnParams,
    type ThreadAgentResolver,
    type ThreadHistory,
    type UsageRecorder,
} from "@inflexa-ai/harness";

import { buildChatSession, healTailOrphan, runChatTurn, type ChatTurnSeams, type RunChatTurnArgs, type TurnOutcome } from "./turn.ts";

// The engine is exercised offline: the whole harness turn is one injected fake, thus no Postgres, no
// model, and no credits. The harness suite pins what the turn itself stores.

const ANALYSIS_ID = "an-1";
const THREAD_ID = "t-1";
const USER_INPUT = "hello";
const userMessage: ModelMessage = { role: "user", content: USER_INPUT };
const assistantMessage: ModelMessage = { role: "assistant", content: "the answer" };
const conversationAgent: AgentDefinition = { id: "conv", systemPrompt: "", model: "m", tools: [], maxIterations: 1 };
const resolver: ThreadAgentResolver = { forThread: () => ok(conversationAgent) };
const session = buildChatSession("cli-chat", ANALYSIS_ID, THREAD_ID);
const noopEmit: EmitFn = () => {};
const DB_ERROR: DbError = { type: "mutation_failed", op: "thread-history.writeTurn", cause: new Error("db down") };

// The fake turn never reads the provider or the pool, thus bare stubs stand in for them.
const chat = (_emit: EmitFn): AgentChat => ({}) as AgentChat;
const pool = {} as unknown as Pool;

const STOP: AgentFinish = { reason: "stop", cappedOut: false, truncationRecoveries: 0 };
const FILTERED: AgentFinish = { reason: "content-filter", rawFinishReason: "refusal", cappedOut: false, truncationRecoveries: 0 };
const ABORTED: AgentFinish = { reason: "aborted", cappedOut: false, truncationRecoveries: 0 };

/**
 * A whole-turn rollup as a provider reports one. It carries the cache and reasoning breakdowns beside
 * the two headline counts, thus an engine that folded them in would show an inflated headline figure.
 */
const TURN_USAGE = { inputTokens: 12_400, outputTokens: 3100, cacheReadInputTokens: 9800, reasoningTokens: 900 } as const;

/** The harness result of a turn that ran. */
function ran(outcome: ChatTurnOutcome, extra: Partial<Extract<ChatTurnResult, { kind: "ran" }>> = {}): ChatTurnResult {
    return { kind: "ran", outcome, opened: true, durationMs: 5, ...extra };
}

/** A `turn` seam that gives `result`, and keeps what the engine handed it. */
function fakeTurn(
    result: ChatTurnResult,
    onCall: (params: RunChatTurnParams) => void = () => {},
): {
    turn: ChatTurnSeams["turn"];
    calls: { deps: RunChatTurnDeps; params: RunChatTurnParams }[];
} {
    const calls: { deps: RunChatTurnDeps; params: RunChatTurnParams }[] = [];
    return {
        calls,
        turn: (deps, params) => {
            calls.push({ deps, params });
            onCall(params);
            return Promise.resolve(result);
        },
    };
}

/** A recorder that keeps what it was handed. */
function recordingRecorder(): UsageRecorder & { records: LlmUsageRecord[] } {
    const records: LlmUsageRecord[] = [];
    return {
        records,
        record: (r: LlmUsageRecord) => {
            records.push(r);
            return okAsync(undefined);
        },
    };
}

/** Drive one turn over `turn`, filling the fixed primitives. */
function runWith(
    turn: ChatTurnSeams["turn"],
    opts: { readonly readAuthor?: ChatTurnSeams["readAuthor"]; readonly usageRecorder?: UsageRecorder; readonly ask?: RunChatTurnArgs["ask"] } = {},
): Promise<TurnOutcome> {
    return runChatTurn(
        {
            pool,
            agents: resolver,
            chat,
            session,
            emit: noopEmit,
            signal: new AbortController().signal,
            usageRecorder: opts.usageRecorder ?? recordingRecorder(),
            analysisId: ANALYSIS_ID,
            threadId: THREAD_ID,
            userInput: USER_INPUT,
            ...(opts.ask ? { ask: opts.ask } : {}),
        },
        { turn, readAuthor: opts.readAuthor ?? (() => null) },
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

describe("runChatTurn maps the result of the harness turn", () => {
    test("a done turn is ok, with its final text and no append error", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "done", finish: STOP }, { fallbackText: "the answer" })).turn);

        expect(outcome).toMatchObject({ kind: "ok", opened: true, fallbackText: "the answer" });
        expect(outcome.kind === "ok" ? outcome.appendError : "wrong kind").toBeUndefined();
    });

    test("a content-filter finish is filtered, with the endpoint's own word", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "done", finish: FILTERED }, { fallbackText: "the answer" })).turn);

        expect(outcome).toMatchObject({ kind: "filtered", opened: true, fallbackText: "the answer", rawFinishReason: "refusal" });
    });

    test("an aborted outcome is aborted", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "aborted", finish: ABORTED })).turn);

        expect(outcome).toMatchObject({ kind: "aborted", opened: true });
    });

    test("a failed outcome is failed and carries the cause", async () => {
        const cause = new Error("provider 401");

        const outcome = await runWith(fakeTurn(ran({ status: "failed", reason: "The model endpoint refused the credential.", cause })).turn);

        expect(outcome.kind).toBe("failed");
        expect(outcome.kind === "failed" ? outcome.cause : undefined).toBe(cause);
    });

    test("a failed preparation is prepare_failed with its cause", async () => {
        const cause = new Error("pg unreachable");

        const outcome = await runWith(fakeTurn({ kind: "prepare_failed", cause }).turn);

        expect(outcome).toEqual({ kind: "prepare_failed", cause });
    });

    test("a thread of a different analysis is thread_gone", async () => {
        expect(await runWith(fakeTurn({ kind: "not_found" }).turn)).toEqual({ kind: "thread_gone" });
    });

    test("an unregistered thread type is agent_unresolved with the type", async () => {
        const outcome = await runWith(fakeTurn({ kind: "agent_unresolved", threadType: "report" }).turn);

        expect(outcome).toEqual({ kind: "agent_unresolved", threadType: "report" });
    });

    test("each kind that ran carries opened as the harness gave it", async () => {
        const outcomes = await Promise.all([
            runWith(fakeTurn(ran({ status: "done", finish: STOP }, { opened: false })).turn),
            runWith(fakeTurn(ran({ status: "done", finish: FILTERED }, { opened: false })).turn),
            runWith(fakeTurn(ran({ status: "aborted" }, { opened: false })).turn),
            runWith(fakeTurn(ran({ status: "failed", reason: "The model request failed.", cause: new Error("x") }, { opened: false })).turn),
        ]);

        expect(outcomes.map((outcome) => [outcome.kind, "opened" in outcome ? outcome.opened : undefined])).toEqual([
            ["ok", false],
            ["filtered", false],
            ["aborted", false],
            ["failed", false],
        ]);
    });

    test("a store fault rides as appendError, orthogonal to the outcome", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "done", finish: STOP }, { storeError: DB_ERROR, fallbackText: "the answer" })).turn);

        expect(outcome).toMatchObject({ kind: "ok", fallbackText: "the answer", appendError: DB_ERROR });
    });
});

describe("runChatTurn carries the turn's usage rollup", () => {
    test("a turn carries the rollup of the harness whole, per quantity", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "done", finish: STOP }, { turnUsage: { ...TURN_USAGE } })).turn);

        expect(outcome.kind === "ok" ? outcome.turnUsage : undefined).toEqual(TURN_USAGE);
    });

    test("an interrupted turn carries what it spent before the abort", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "aborted", finish: ABORTED }, { turnUsage: { inputTokens: 800, outputTokens: 120 } })).turn);

        expect(outcome.kind === "aborted" ? outcome.turnUsage : undefined).toEqual({ inputTokens: 800, outputTokens: 120 });
    });

    test("a turn whose calls reported nothing carries NO rollup key", async () => {
        const outcome = await runWith(fakeTurn(ran({ status: "done", finish: STOP })).turn);

        expect("turnUsage" in outcome).toBe(false);
    });

    test("the carried rollup is a copy, thus a later change of the value of the harness cannot reach it", async () => {
        const live = { inputTokens: 100, outputTokens: 10 };

        const outcome = await runWith(fakeTurn(ran({ status: "done", finish: STOP }, { turnUsage: live })).turn);
        live.inputTokens = 999_999;

        expect(outcome.kind === "ok" ? outcome.turnUsage?.inputTokens : undefined).toBe(100);
    });
});

describe("runChatTurn gives the harness the values of the surface", () => {
    test("the deps carry the pool, the resolver, a logger, and the provenance seam", async () => {
        const fake = fakeTurn(ran({ status: "done", finish: STOP }));

        await runWith(fake.turn);

        const deps = fake.calls[0]!.deps;
        expect(deps.pool).toBe(pool);
        expect(deps.agents).toBe(resolver);
        expect(deps.logger?.named).toBeInstanceOf(Function);
        expect("provenance" in deps).toBe(true);
    });

    test("the params carry the caller's recorder, the session, and the start time, and no cache policy", async () => {
        const recorder = recordingRecorder();
        const fake = fakeTurn(ran({ status: "done", finish: STOP }));
        const before = Date.now();

        await runWith(fake.turn, { usageRecorder: recorder });

        const params = fake.calls[0]!.params;
        // Identity, not presence: a no-op recorder here would typecheck and drop every call of the turn.
        expect(params.usageRecorder).toBe(recorder);
        expect(params).toMatchObject({ analysisId: ANALYSIS_ID, threadId: THREAD_ID, userInput: USER_INPUT, session });
        expect(params.startedAtMs).toBeGreaterThanOrEqual(before);
        // With no policy, the root loop uses the 1-hour default of the harness.
        expect("promptCache" in params).toBe(false);
    });

    test("the approval binding reaches the harness, and an absent one stays absent", async () => {
        const ask = (_request: AskRequest, _emit: EmitFn): Promise<AskApproval> => Promise.resolve({ kind: "once" });
        const bound = fakeTurn(ran({ status: "done", finish: STOP }));
        const unbound = fakeTurn(ran({ status: "done", finish: STOP }));

        await runWith(bound.turn, { ask });
        await runWith(unbound.turn);

        expect(bound.calls[0]!.params.ask).toBe(ask);
        expect("ask" in unbound.calls[0]!.params).toBe(false);
    });
});

describe("the author of a chat turn", () => {
    const AUTHOR = "ada@example.com";

    test("a signed-in identity rides to the harness as the author of the opening", async () => {
        const fake = fakeTurn(ran({ status: "done", finish: STOP }));

        await runWith(fake.turn, { readAuthor: () => AUTHOR });

        expect(fake.calls[0]!.params.author).toBe(AUTHOR);
    });

    test("a signed-out identity carries NO author key — an absent sender is absent, never empty", async () => {
        const fake = fakeTurn(ran({ status: "done", finish: STOP }));

        await runWith(fake.turn, { readAuthor: () => null });

        expect("author" in fake.calls[0]!.params).toBe(false);
    });

    test("an empty email carries no author key", async () => {
        const fake = fakeTurn(ran({ status: "done", finish: STOP }));

        await runWith(fake.turn, { readAuthor: () => "" });

        expect("author" in fake.calls[0]!.params).toBe(false);
    });

    test("each turn reads the identity again, so a sign-in between two turns reaches the second", async () => {
        const fake = fakeTurn(ran({ status: "done", finish: STOP }));
        const authors = ["first@example.com", "second@example.com"];
        let call = 0;
        const readAuthor = (): string | null => authors[call++] ?? null;

        await runWith(fake.turn, { readAuthor });
        await runWith(fake.turn, { readAuthor });

        expect(fake.calls.map((c) => c.params.author)).toEqual(authors);
    });

    test("a sign-out DURING the turn does not erase the author of that turn", async () => {
        let signedIn = true;
        const fake = fakeTurn(ran({ status: "done", finish: STOP }), () => {
            signedIn = false;
        });

        await runWith(fake.turn, { readAuthor: () => (signedIn ? AUTHOR : null) });

        expect(fake.calls[0]!.params.author).toBe(AUTHOR);
    });
});

// --- healTailOrphan ---------------------------------------------------------

/**
 * A `ThreadHistory` staged at one tail shape: `loadAll` returns the staged turns, so the heal's single
 * read sees a real thread without a Postgres. Every `retractLastTurn` is counted, which is the whole
 * point — the guard's job is to not call it.
 */
function stagedHistory(turns: ModelMessage[][]): { history: ThreadHistory; retracts: () => number } {
    let retracts = 0;
    const history: ThreadHistory = {
        appendTurn: () => okAsync(undefined),
        writeTurn: () => okAsync({ startSeq: 0 }),
        loadRecent: () => okAsync(turns.flat()),
        loadAll: () =>
            okAsync(
                turns.map((turn) =>
                    turn.map((message, seq) => ({ seq, envelope: { kind: "ai-sdk-model-message" as const, aiSdkMajor: 7 as const, message }, message })),
                ),
            ),
        retractLastTurn: () => {
            retracts++;
            return okAsync({ kind: "retracted", messages: turns[turns.length - 1]?.length ?? 0 });
        },
        latestSeq: () => okAsync(null),
        latestTurnAt: () => okAsync(null),
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

    test("removes a tail of a user message and its two context records", async () => {
        const records = [
            syntheticUserMessage("[Run Activity]\nNo runs are currently running or suspended."),
            syntheticUserMessage("[Working Memory]\nThe working memory is empty."),
        ];
        const { history, retracts } = stagedHistory([
            [userMessage, assistantMessage],
            [userMessage, ...records],
        ]);

        const outcome = (await healTailOrphan(pool, THREAD_ID, { history: () => history }))._unsafeUnwrap();

        expect(outcome).toEqual({ kind: "retracted", messages: 3 });
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
        // A turn carrying tool traffic but no final assistant text is still an answered turn, not an orphan.
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
