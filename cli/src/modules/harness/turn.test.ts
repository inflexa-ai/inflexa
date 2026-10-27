import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
    syntheticUserMessage,
    type AgentDefinition,
    type ChatFrame,
    type ChatTurnEnd,
    type ChatTurns,
    type ChatTurnSession,
    type ChatTurnStart,
    type ModelMessage,
    type OpenChatTurnRequest,
    type Pool,
    type ThreadHistory,
} from "@inflexa-ai/harness";

import { buildChatSession, healTailOrphan, runChatTurn, type ChatTurnSeams, type TurnOutcome } from "./turn.ts";

// The engine is exercised offline: the chat turns of the harness are one injected fake, thus no Postgres, no
// model, and no credits. The harness suite pins what the turn itself stores.

const ANALYSIS_ID = "an-1";
const THREAD_ID = "t-1";
const TURN_ID = "turn-1";
const USER_INPUT = "hello";
const userMessage: ModelMessage = { role: "user", content: USER_INPUT };
const assistantMessage: ModelMessage = { role: "assistant", content: "the answer" };
const conversationAgent: AgentDefinition = { id: "conv", systemPrompt: "", model: "m", tools: [], maxIterations: 1 };
const session = buildChatSession(ANALYSIS_ID, THREAD_ID);
const ROOT = { agentId: "conv", callPath: ["conv"] };

// The heal tests never read the pool, thus a bare pool stands in for it.
const pool = {} as unknown as Pool;

/**
 * A whole-turn rollup as a provider reports one. It carries the cache and reasoning breakdowns beside
 * the two headline counts, thus an engine that folded them in would show an inflated headline figure.
 */
const TURN_USAGE = { inputTokens: 12_400, outputTokens: 3100, cacheReadInputTokens: 9800, reasoningTokens: 900 } as const;

/** The end of a turn that ran. */
function ended(end: Partial<ChatTurnEnd> & Pick<ChatTurnEnd, "status">): ChatTurnEnd {
    return { durationMs: 5, opened: true, ...end };
}

type FakeChatTurns = ChatTurns & {
    readonly opens: { readonly session: ChatTurnSession; readonly request: OpenChatTurnRequest }[];
    readonly stops: string[];
};

/** Chat turns whose open gives `start`, whose read gives `frames` and then waits for `hold`, and whose outcome gives `end`. */
function fakeChatTurns(
    opts: {
        readonly start?: ChatTurnStart;
        readonly frames?: readonly ChatFrame[];
        readonly hold?: Promise<void>;
        readonly end?: ChatTurnEnd | null;
        readonly onOpen?: () => void;
    } = {},
): FakeChatTurns {
    const opens: FakeChatTurns["opens"] = [];
    const stops: string[] = [];
    return {
        opens,
        stops,
        open: (openSession, request) => {
            opens.push({ session: openSession, request });
            opts.onOpen?.();
            return Promise.resolve(opts.start ?? { kind: "started", turnId: TURN_ID, agent: conversationAgent });
        },
        async *read() {
            for (const frame of opts.frames ?? []) yield frame;
            await opts.hold;
        },
        stop: (turnId) => {
            stops.push(turnId);
            return Promise.resolve();
        },
        answer: () => Promise.resolve("not_found"),
        outcome: () => Promise.resolve(opts.end === undefined ? ended({ status: "done", finishReason: "stop" }) : opts.end),
    };
}

/** Drive one turn over `chatTurns`, filling the fixed primitives. */
function runWith(
    chatTurns: ChatTurns,
    opts: {
        readonly readAuthor?: ChatTurnSeams["readAuthor"];
        readonly emit?: (frame: ChatFrame) => void;
        readonly signal?: AbortSignal;
        readonly onOpened?: (turnId: string) => void;
    } = {},
): Promise<TurnOutcome> {
    return runChatTurn(
        {
            chatTurns,
            session,
            emit: opts.emit ?? (() => {}),
            signal: opts.signal ?? new AbortController().signal,
            analysisId: ANALYSIS_ID,
            threadId: THREAD_ID,
            userInput: USER_INPUT,
            ...(opts.onOpened === undefined ? {} : { onOpened: opts.onOpened }),
        },
        { readAuthor: opts.readAuthor ?? (() => null) },
    );
}

describe("buildChatSession", () => {
    test("scopes the session to the thread and leaves the provenance to the harness", () => {
        const s = buildChatSession("an-9", "t-9");
        expect("provenance" in s).toBe(false);
        expect(s.scope).toEqual({ kind: "analysis", analysisId: "an-9", threadId: "t-9" });
        expect(s.identity).toEqual({ user: "local" });
    });
});

describe("runChatTurn maps the outcome of the turn workflow", () => {
    test("a done turn is ok, with its final text and no store fault", async () => {
        const outcome = await runWith(fakeChatTurns({ end: ended({ status: "done", finishReason: "stop", fallbackText: "the answer" }) }));

        expect(outcome).toEqual({ kind: "ok", opened: true, fallbackText: "the answer" });
    });

    test("a content-filter finish is filtered, with the endpoint's own word", async () => {
        const outcome = await runWith(
            fakeChatTurns({ end: ended({ status: "done", finishReason: "content-filter", rawFinishReason: "refusal", fallbackText: "the answer" }) }),
        );

        expect(outcome).toMatchObject({ kind: "filtered", opened: true, fallbackText: "the answer", rawFinishReason: "refusal" });
    });

    test("an aborted outcome is aborted", async () => {
        expect(await runWith(fakeChatTurns({ end: ended({ status: "aborted" }) }))).toEqual({ kind: "aborted", opened: true });
    });

    test("a failed outcome is failed and carries the text and the code of the failure", async () => {
        const outcome = await runWith(
            fakeChatTurns({ end: ended({ status: "failed", reason: "The model endpoint refused the credential.", code: "credential" }) }),
        );

        expect(outcome).toEqual({ kind: "failed", opened: true, reason: "The model endpoint refused the credential.", code: "credential" });
    });

    test("a workflow that ended with no outcome is a failure", async () => {
        expect(await runWith(fakeChatTurns({ end: null }))).toMatchObject({ kind: "failed", reason: "The turn ended with no outcome." });
    });

    test("each kind that ran carries opened as the harness gave it", async () => {
        const outcomes = await Promise.all(
            [
                ended({ status: "done", finishReason: "stop", opened: false }),
                ended({ status: "done", finishReason: "content-filter", opened: false }),
                ended({ status: "aborted", opened: false }),
                ended({ status: "failed", reason: "The model request failed.", opened: false }),
            ].map((end) => runWith(fakeChatTurns({ end }))),
        );

        expect(outcomes.map((outcome) => [outcome.kind, "opened" in outcome ? outcome.opened : undefined])).toEqual([
            ["ok", false],
            ["filtered", false],
            ["aborted", false],
            ["failed", false],
        ]);
    });

    test("a store fault rides as storeFailed, orthogonal to the outcome", async () => {
        const outcome = await runWith(fakeChatTurns({ end: ended({ status: "done", finishReason: "stop", storeFailed: true, fallbackText: "the answer" }) }));

        expect(outcome).toEqual({ kind: "ok", opened: true, fallbackText: "the answer", storeFailed: true });
    });
});

describe("runChatTurn gives each refusal of the open", () => {
    test("a failed preparation is prepare_failed with its cause", async () => {
        const cause = new Error("pg unreachable");

        expect(await runWith(fakeChatTurns({ start: { kind: "prepare_failed", cause } }))).toEqual({ kind: "prepare_failed", cause });
    });

    test("a thread of a different analysis is thread_gone", async () => {
        expect(await runWith(fakeChatTurns({ start: { kind: "not_found" } }))).toEqual({ kind: "thread_gone" });
    });

    test("an unregistered thread type is agent_unresolved with the type", async () => {
        expect(await runWith(fakeChatTurns({ start: { kind: "agent_unresolved", threadType: "report" } }))).toEqual({
            kind: "agent_unresolved",
            threadType: "report",
        });
    });

    test("a thread with a turn that runs is turn_in_progress, and the engine opens no turn of its own", async () => {
        const opened: string[] = [];

        const outcome = await runWith(fakeChatTurns({ start: { kind: "turn_in_progress" } }), { onOpened: (turnId) => opened.push(turnId) });

        expect(outcome).toEqual({ kind: "turn_in_progress" });
        expect(opened).toEqual([]);
    });
});

describe("runChatTurn carries the turn's usage rollup", () => {
    test("a turn carries the rollup of the harness whole, per quantity", async () => {
        const outcome = await runWith(fakeChatTurns({ end: ended({ status: "done", finishReason: "stop", turnUsage: { ...TURN_USAGE } }) }));

        expect(outcome.kind === "ok" ? outcome.turnUsage : undefined).toEqual(TURN_USAGE);
    });

    test("an interrupted turn carries what it spent before the abort", async () => {
        const outcome = await runWith(fakeChatTurns({ end: ended({ status: "aborted", turnUsage: { inputTokens: 800, outputTokens: 120 } }) }));

        expect(outcome.kind === "aborted" ? outcome.turnUsage : undefined).toEqual({ inputTokens: 800, outputTokens: 120 });
    });

    test("a turn whose calls reported nothing carries NO rollup key", async () => {
        expect("turnUsage" in (await runWith(fakeChatTurns()))).toBe(false);
    });

    test("the carried rollup is a copy, thus a later change of the value of the harness cannot reach it", async () => {
        const live = { inputTokens: 100, outputTokens: 10 };

        const outcome = await runWith(fakeChatTurns({ end: ended({ status: "done", finishReason: "stop", turnUsage: live }) }));
        live.inputTokens = 999_999;

        expect(outcome.kind === "ok" ? outcome.turnUsage?.inputTokens : undefined).toBe(100);
    });
});

describe("runChatTurn streams the turn to the surface", () => {
    test("the surface gets each frame of the turn but its end frame, and the open names the turn", async () => {
        const frames: ChatFrame[] = [
            { type: "message-start", messageId: "0198f0a0-0000-7000-8000-000000000001", role: "assistant", source: ROOT },
            { type: "text-delta", text: "Hi", source: ROOT },
            { type: "finish", source: ROOT },
        ];
        const seen: ChatFrame[] = [];
        const opened: string[] = [];

        await runWith(fakeChatTurns({ frames }), { emit: (frame) => seen.push(frame), onOpened: (turnId) => opened.push(turnId) });

        expect(seen.map((frame) => frame.type)).toEqual(["message-start", "text-delta"]);
        expect(opened).toEqual([TURN_ID]);
    });

    test("an abort of the surface stops the turn by its id", async () => {
        const controller = new AbortController();
        let release: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const chatTurns = fakeChatTurns({ hold, end: ended({ status: "aborted" }) });

        const running = runWith(chatTurns, {
            signal: controller.signal,
            onOpened: () => {
                controller.abort();
                release();
            },
        });

        expect(await running).toEqual({ kind: "aborted", opened: true });
        expect(chatTurns.stops).toEqual([TURN_ID]);
    });

    test("the open carries the session, the user input, and the start time, and no cache policy", async () => {
        const chatTurns = fakeChatTurns();
        const before = Date.now();

        await runWith(chatTurns);

        const { session: openSession, request } = chatTurns.opens[0]!;
        expect(openSession).toBe(session);
        expect(request).toMatchObject({ analysisId: ANALYSIS_ID, threadId: THREAD_ID, userInput: USER_INPUT });
        expect(request.startedAtMs).toBeGreaterThanOrEqual(before);
        // With no policy, the root loop uses the 1-hour default of the harness.
        expect("promptCache" in request).toBe(false);
    });
});

describe("the author of a chat turn", () => {
    const AUTHOR = "ada@example.com";

    test("a signed-in identity rides to the harness as the author of the opening", async () => {
        const chatTurns = fakeChatTurns();

        await runWith(chatTurns, { readAuthor: () => AUTHOR });

        expect(chatTurns.opens[0]!.request.author).toBe(AUTHOR);
    });

    test("a signed-out identity carries NO author key — an absent sender is absent, never empty", async () => {
        const chatTurns = fakeChatTurns();

        await runWith(chatTurns, { readAuthor: () => null });

        expect("author" in chatTurns.opens[0]!.request).toBe(false);
    });

    test("an empty email carries no author key", async () => {
        const chatTurns = fakeChatTurns();

        await runWith(chatTurns, { readAuthor: () => "" });

        expect("author" in chatTurns.opens[0]!.request).toBe(false);
    });

    test("each turn reads the identity again, so a sign-in between two turns reaches the second", async () => {
        const chatTurns = fakeChatTurns();
        const authors = ["first@example.com", "second@example.com"];
        let call = 0;
        const readAuthor = (): string | null => authors[call++] ?? null;

        await runWith(chatTurns, { readAuthor });
        await runWith(chatTurns, { readAuthor });

        expect(chatTurns.opens.map((open) => open.request.author)).toEqual(authors);
    });

    test("a sign-out DURING the turn does not erase the author of that turn", async () => {
        let signedIn = true;
        const chatTurns = fakeChatTurns({
            onOpen: () => {
                signedIn = false;
            },
        });

        await runWith(chatTurns, { readAuthor: () => (signedIn ? AUTHOR : null) });

        expect(chatTurns.opens[0]!.request.author).toBe(AUTHOR);
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
        loadPage: () => okAsync({ turns: [], before: null }),
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
