import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import {
    toChatFrame,
    type ChatFrame,
    type ChatMessage,
    type CompactionPart,
    type FileReferencePart,
    type MessagePart,
    type PlanPart,
    type PresentationPart,
    type RunCardPart,
} from "@inflexa-ai/harness/contracts/index.js";

import type { MessageList, TurnSummary } from "../../api/conversation.ts";
import type { ClientError } from "../../client/api.ts";
import {
    applyServerFrame,
    errorMsg,
    lastTurnFailure,
    loadMessages,
    type LoadOpts,
    hasPromptHistory,
    messages,
    noteAskFeedback,
    promptHistory,
    resetHotState,
    send,
    sessionOpenables,
    streamPartId,
    streamText,
    type SendOpts,
} from "./conversation.ts";
import { activeAsk, queuedCount } from "./asks.ts";
import { __resetNoticesForTest, currentNotice } from "./notice.ts";
import { chatStatus } from "./status.ts";
import { readFileReference, readPlanCard, readPresentation } from "../../modules/harness/chat_printer.ts";
import type { LiveAskPart, LiveTextPart, LiveToolCallPart, Part } from "../../types/session.ts";

// The conversation state is a module singleton (one chat screen at a time), so reset it between
// cases. resetHotState() clears messages/stream/error/adapter state and returns status to idle.
//
// The local server is a fake: each turn is a stream of the frames that the chat route sends, and the
// cases drive it with the events of the agent loop, which the fake translates with `toChatFrame`, as
// the route does. The route tests (`server/routes/conversation.test.ts`) pin what the server does.
const SID = "s1";
const AID = "a1";
// The source of the top-level chat agent: its call path has one entry.
const ROOT = { agentId: "tui-chat", callPath: ["tui-chat"] };
// The source that the chat route gives a text delta of the root provider, and its terminal frame.
const ROUTE_SOURCE = { agentId: "chat", callPath: ["chat"] };
// A plan step that the schema of a `data-plan` part accepts.
const PLAN_STEP: NonNullable<PlanPart["steps"]>[number] = {
    id: "s1",
    name: "QC",
    agent: "prep",
    question: "Is the matrix clean?",
    depends_on: [],
    maxSteps: 30,
};

/** One event that the agent loop emits, which the chat route turns into a frame. */
type LoopEvent = Parameters<typeof toChatFrame>[0];

/** Send the frame of one loop event to the hook. It resolves after the hook applied the frame. */
type Emit = (event: LoopEvent) => Promise<void>;

/** What a turn of the fake server ends with: the fields of the summary that `GET {T}/turns/:turnId` gives. */
type End = Pick<TurnSummary, "status"> & Partial<Pick<TurnSummary, "opened" | "turnUsage" | "fallbackText" | "storeFailed" | "failure">>;

/** The end of a turn that answered. */
function done(over: Partial<End> = {}): End {
    return { status: "done", opened: true, ...over };
}

// The failure of an assertion inside the drive of a fake turn. The drive runs apart from the case, thus
// the failure reaches the case here, and `afterEach` asserts that none happened.
const driveFailures: unknown[] = [];

/**
 * The frame stream of one turn. Each frame is serialized and parsed again, as the wire does, thus the hook
 * never holds a reference that the case still owns. A frame resolves its `send` when the reader asks for
 * the next one, which is after the hook applied it.
 */
function frameChannel(): { send: (frame: ChatFrame) => Promise<void>; close: () => void; frames: AsyncGenerator<Result<ChatFrame, ClientError>> } {
    const waiting: { frame: ChatFrame; applied: () => void }[] = [];
    let closed = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
        const resume = wake;
        wake = null;
        resume?.();
    };
    async function* frames(): AsyncGenerator<Result<ChatFrame, ClientError>> {
        for (;;) {
            const item = waiting.shift();
            if (item !== undefined) {
                // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the hook, which the rule cannot follow
                yield ok(item.frame);
                item.applied();
                continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    }
    return {
        send: (frame) =>
            new Promise<void>((applied) => {
                // The parse gives back the frame that went in: it is JSON by the wire contract.
                waiting.push({ frame: JSON.parse(JSON.stringify(frame)) as ChatFrame, applied });
                notify();
            }),
        close: () => {
            closed = true;
            notify();
        },
        frames: frames(),
    };
}

/** The frame that ends the stream of a turn: `error` for a failed turn, else `finish`, as the route sends them. */
function terminalFrame(end: End): ChatFrame {
    if (end.status === "failed") return { type: "error", message: end.failure?.message ?? "The turn failed.", source: ROUTE_SOURCE };
    return { type: "finish", source: ROUTE_SOURCE, ...(end.turnUsage === undefined ? {} : { turnUsage: end.turnUsage }) };
}

/** A fake of the local server, with what the hook sent it. */
type FakeServer = SendOpts & {
    /** Each `POST {A}/chat` that the hook sent. */
    readonly started: { analysisId: string; threadId: string; message: string }[];
    /** Each turn id that the hook sent an abort for. */
    readonly aborted: string[];
};

/**
 * A server whose turn streams the frames of what `drive` emits, then the terminal frame of `end`, and
 * whose summary is `end`. The transcript reload after the turn does nothing, unless a case replaces it.
 */
function fakeServer(end: End, drive: (emit: Emit) => void | Promise<void> = () => {}): FakeServer {
    const started: FakeServer["started"] = [];
    const aborted: string[] = [];
    let count = 0;
    return {
        started,
        aborted,
        startTurn: (analysisId, threadId, message) => {
            started.push({ analysisId, threadId, message });
            const turnId = `turn-${++count}`;
            const channel = frameChannel();
            const emit: Emit = (event) => {
                const frame = toChatFrame(event, ROUTE_SOURCE);
                return frame === null ? Promise.resolve() : channel.send(frame);
            };
            void (async () => {
                try {
                    await drive(emit);
                } catch (cause) {
                    driveFailures.push(cause);
                }
                await channel.send(terminalFrame(end));
                channel.close();
            })();
            return okAsync({ turnId, frames: channel.frames });
        },
        abortTurn: (_analysisId, _threadId, turnId) => {
            aborted.push(turnId);
            return okAsync({ turnId, outcome: "aborting" });
        },
        fetchTurn: (analysisId, threadId, turnId) => okAsync({ turnId, threadId, analysisId, startedAt: "2026-10-02T00:00:00.000Z", ...end }),
        reloadTranscript: async () => undefined,
        healRetract: () => okAsync({ kind: "retracted", messages: 0 }),
    };
}

/** A server that refuses the turn before it opens, with `error`. */
function refusingServer(error: ClientError): SendOpts {
    return { ...fakeServer(done()), startTurn: () => errAsync(error) };
}

/** The refusal of the chat route for a thread of a different analysis. */
const THREAD_NOT_FOUND: ClientError = { type: "http", status: 404, body: { error: "not_found", message: "Thread not found." } };

/** The refusal of the chat route for a turn that could not prepare. */
const PREPARE_FAILED: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "The server failed to handle the request." } };

/** A transcript as `GET {T}/messages` gives it. */
function messageList(list: ChatMessage[]): MessageList {
    return { messages: list, total: list.length, page: 0, perPage: list.length, hasMore: false };
}

/** Load options whose read gives `list`. */
function loadOf(list: ChatMessage[]): LoadOpts {
    return { fetchMessages: () => okAsync(messageList(list)) };
}

function findPart<T extends Part>(pred: (p: Part) => p is T): T | undefined {
    for (const m of messages) {
        for (const p of m.parts) if (pred(p)) return p;
    }
    return undefined;
}

/** The first part that `pred` matches. A missing part fails the test. */
function requirePart<T extends Part>(pred: (p: Part) => p is T): T {
    const part = findPart(pred);
    expect(part).toBeDefined();
    // `expect` above fails the case when no part matched.
    return part!;
}

const isToolCall = (p: Part): p is LiveToolCallPart => p.type === "tool-call";

beforeEach(() => {
    resetHotState();
    __resetNoticesForTest();
});
afterEach(() => {
    resetHotState();
    __resetNoticesForTest();
    expect(driveFailures.splice(0)).toEqual([]);
});

describe("send() drives the adapter over the turn stream", () => {
    test("pushes user + assistant messages and starts the turn on the analysis and the thread = sessionId", async () => {
        const server = fakeServer(done());
        await send({ sessionId: SID, analysisId: AID, userText: "what's the schema?" }, server);

        expect(messages.length).toBe(2);
        expect(messages[0]?.role).toBe("user");
        expect(messages[1]?.role).toBe("assistant");
        const userText = messages[0]?.parts[0];
        expect(userText?.type).toBe("text");
        if (userText?.type === "text") expect(userText.text).toBe("what's the schema?");

        expect(server.started).toEqual([{ analysisId: AID, threadId: SID, message: "what's the schema?" }]);
    });

    test("text deltas accumulate live, then flush into the stored part on done", async () => {
        const server = fakeServer(done({ fallbackText: "ignored on a streamed turn" }), async (emit) => {
            await emit({ type: "text-delta", text: "Each analysis " });
            await emit({ type: "text-delta", text: "row carries a slug." });
            // Snapshot mid-turn accumulation before the end flushes it.
            expect(streamText()).toBe("Each analysis row carries a slug.");
            expect(streamPartId()).not.toBeNull();
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const part = messages[1]?.parts[0];
        expect(part?.type).toBe("text");
        if (part?.type === "text") expect(part.text).toBe("Each analysis row carries a slug.");
        expect(streamPartId()).toBeNull();
        expect(streamText()).toBe("");
        expect(chatStatus()).toBe("idle");
    });

    test("fallbackText renders when the turn produced no deltas", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(done({ fallbackText: "no-stream answer" })));
        const part = messages[1]?.parts[0];
        expect(part?.type === "text" ? part.text : undefined).toBe("no-stream answer");
    });

    test("tool started/finished pair into one part with an outcome + duration", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const tool = findPart(isToolCall);
        expect(tool?.toolName).toBe("read_file");
        expect(tool?.outcome).toBe("ok");
        expect(tool?.durationMs).toBeGreaterThanOrEqual(0);
        // A start+finish for one id collapses to a single part, not two.
        expect(messages[1]?.parts.filter((p) => p.type === "tool-call").length).toBe(1);
    });

    test("each chip reports its own frame's duration, not a shared round figure", async () => {
        // The adapter's own bracket measures the ROUND, because the harness emits
        // every start before it dispatches and every finish after the round
        // settles. Only the harness figure separates the two calls.
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "slow", name: "read_file", input: {} });
            void emit({ type: "tool-started", source: ROOT, toolUseId: "fast", name: "list_files", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "slow", name: "read_file", outcome: "ok", durationMs: 480 });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "fast", name: "list_files", outcome: "ok", durationMs: 3 });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const chips = messages[1]!.parts.filter(isToolCall);
        expect(chips.map((c) => c.durationMs)).toEqual([480, 3]);
    });

    test("a zero duration from the harness is kept, not replaced by the bracket", async () => {
        // The fallback must be `??` and never `||`. A sub-millisecond call reports
        // a real `0`, and `||` would discard it for the round-wide bracket — the
        // exact false figure this requirement removes.
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t0", name: "list_files", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t0", name: "list_files", outcome: "ok", durationMs: 0 });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(findPart(isToolCall)?.durationMs).toBe(0);
    });

    test("a frame without a duration falls back to the observed elapsed time", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(typeof findPart(isToolCall)?.durationMs).toBe("number");
    });

    test("an unpaired finished frame still renders, and carries the frame's duration", async () => {
        // No start arrived, thus the adapter has no stamp of its own to bracket.
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "orphan", name: "grep", outcome: "ok", durationMs: 0 });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const tool = findPart(isToolCall);
        expect(tool?.toolName).toBe("grep");
        // There is no start stamp to bracket, thus `||` would yield `undefined` here.
        expect(tool?.durationMs).toBe(0);
    });

    test("tool error outcome is honored", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t9", name: "write_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t9", name: "write_file", outcome: "error" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(findPart(isToolCall)?.outcome).toBe("error");
    });

    // A denial is the user refusing an approval. Folding it into `error` would report their own
    // decision as a fault of the tool, which is why the harness reports three outcomes and not two.
    test("a denied outcome is distinct from an error", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t7", name: "execute_analysis", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t7", name: "execute_analysis", outcome: "denied" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(findPart(isToolCall)?.outcome).toBe("denied");
    });

    test("a described call carries its detail from tool-started onward", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t2", name: "update_working_memory", input: {}, detail: "hypothesis retire h3" });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t2", name: "update_working_memory", outcome: "ok", detail: "hypothesis retire h3" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const tool = findPart(isToolCall);
        expect(tool?.detail).toBe("hypothesis retire h3");
        expect(tool?.outcome).toBe("ok");
    });

    // A tool that describes its own result names the outcome on the finish — the page it wrote, the
    // version it recorded. That fact does not exist at dispatch, so the chip must take the newer line.
    test("a present finished detail replaces the one the start showed", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t4", name: "preview_report", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t4", name: "preview_report", outcome: "ok", detail: "page /w/t4/index.html" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const tool = findPart(isToolCall);
        expect(tool?.detail).toBe("page /w/t4/index.html");
        expect(tool?.outcome).toBe("ok");
    });

    // The finish can only improve the chip. A tool that describes no result finishes with no detail,
    // and blanking the started line there would lose the only description the call ever had.
    test("an absent finished detail never blanks the one the start showed", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t5", name: "read_file", input: {}, detail: "output/summary.md" });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t5", name: "read_file", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(findPart(isToolCall)?.detail).toBe("output/summary.md");
    });

    // An error keeps the started detail by construction: the harness runs no result hook on a failed
    // call. The chip must show that line beside the failure, and not fall back to the bare tool name.
    test("a failed call keeps the detail its start showed", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t6", name: "add_block", input: {}, detail: 'add section "Summary"' });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t6", name: "add_block", outcome: "error", detail: 'add section "Summary"' });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const tool = findPart(isToolCall);
        expect(tool?.detail).toBe('add section "Summary"');
        expect(tool?.outcome).toBe("error");
    });

    test("a call from a tool with no hook carries no detail", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t3", name: "search_semantic_scholar", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t3", name: "search_semantic_scholar", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        // Absent, never an empty string — the block keys its layout off the field being undefined.
        expect(findPart(isToolCall)?.detail).toBeUndefined();
    });

    // Sub-agent frames used to be discarded outright, which made a long tool call indistinguishable
    // from a wedged one. They are ROUTED to the tool block they run inside — never to the transcript
    // root, where their sheer number would bury the conversation.
    describe("sub-agent activity routing", () => {
        const SUB = { agentId: "planner", callPath: ["tui-chat", "planner"] };
        const DEEPER = { agentId: "literature-reviewer", callPath: ["tui-chat", "planner", "literature-reviewer"] };

        // The line is LIVE state: it exists only while the call is running, and a turn that ends with
        // the call still open has it closed (and its activity cleared) by `drainOpenTools`. So these
        // read the store from inside the drive, after each frame applied, while the sub-agent works.
        function activityDuring(drive: (emit: Emit) => void): Promise<string | undefined> {
            let seen: string | undefined;
            const server = fakeServer(done(), async (emit) => {
                const applied: Promise<void>[] = [];
                drive((event) => {
                    const sent = emit(event);
                    applied.push(sent);
                    return sent;
                });
                await Promise.all(applied);
                seen = findPart(isToolCall)?.activity;
            });
            return send({ sessionId: SID, analysisId: AID, userText: "?" }, server).then(() => seen);
        }

        test("a sub-agent's frames update the running tool's activity line and create no block of their own", async () => {
            const activity = await activityDuring((emit) => {
                void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "plan_analysis", input: {} });
                // The route gives no frame for an `iteration`, thus only the tool frame reaches the hook.
                void emit({ type: "iteration", source: SUB, index: 1, final: false } as LoopEvent);
                void emit({ type: "tool-started", source: SUB, toolUseId: "sub-1", name: "search_papers", input: {} });
            });
            // The activity carries the sub-agent's newest work, attributed to who is doing it.
            expect(activity).toBe("planner: search_papers");

            const tools = messages[1]?.parts.filter((p) => p.type === "tool-call") ?? [];
            // Exactly ONE tool block: the top-level call. The sub-agent's own tool never became one.
            expect(tools.length).toBe(1);
            expect((tools[0] as LiveToolCallPart).toolName).toBe("plan_analysis");
        });

        test("the INNERMOST sub-agent owns the line — a shallower caller does not overwrite it", async () => {
            const activity = await activityDuring((emit) => {
                void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "plan_analysis", input: {} });
                void emit({ type: "tool-started", source: DEEPER, toolUseId: "sub-2", name: "fetch_abstract", input: {} });
                // The planner is merely WAITING on the reviewer; its own call is not what is happening.
                void emit({ type: "tool-started", source: SUB, toolUseId: "sub-3", name: "rank_papers", input: {} });
            });
            expect(activity).toBe("literature-reviewer: fetch_abstract");
        });

        test("the activity line is cleared when the call finishes", async () => {
            const server = fakeServer(done(), (emit) => {
                void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "plan_analysis", input: {} });
                void emit({ type: "tool-started", source: SUB, toolUseId: "sub-1", name: "search_papers", input: {} });
                void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "plan_analysis", outcome: "ok" });
            });
            await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

            const tool = findPart(isToolCall);
            expect(tool?.outcome).toBe("ok");
            // A finished call has an outcome, which answers the same question better. Leaving the
            // activity would strand "planner: search_papers" under a chip that already says ok.
            expect(tool?.activity).toBeUndefined();
        });

        test("a sub-agent frame outside any tool call is dropped, not rendered at the root", async () => {
            const server = fakeServer(done(), (emit) => {
                void emit({ type: "tool-started", source: SUB, toolUseId: "sub-1", name: "search_papers", input: {} });
            });
            await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
            // Nothing to be subordinate TO — and putting it at the root is the burial the rule prevents.
            expect(messages[1]?.parts.filter((p) => p.type === "tool-call").length).toBe(0);
        });
    });

    test("an unpaired tool-finished appends a finished part (no prior tool-started)", async () => {
        const server = fakeServer(done(), (emit) => {
            // No tool-started for this id — the finish must still render as a finished chip, not vanish.
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "orphan", name: "grep", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const tool = findPart(isToolCall);
        expect(tool?.toolName).toBe("grep");
        expect(tool?.outcome).toBe("ok");
        // No matching tool-started → no start timestamp, so the duration is honestly unknown.
        expect(tool?.durationMs).toBeUndefined();
    });

    test("data-plan lands as the harness part, and the card reads it through readPlanCard", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "data-plan", source: ROOT, data: { id: "plan-card-1", planId: "pln-00000001", title: "DE analysis", steps: [PLAN_STEP] } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const part = requirePart((p): p is PlanPart => p.type === "data-plan");
        // The source of a frame routes the frame, and it is not a field of the part.
        expect(part).toEqual({ type: "data-plan", id: "plan-card-1", planId: "pln-00000001", title: "DE analysis", steps: [PLAN_STEP] });
        const plan = readPlanCard(part);
        expect(plan.planId).toBe("pln-00000001");
        expect(plan.title).toBe("DE analysis");
        expect(plan.steps[0]?.id).toBe("s1");
        expect(plan.steps[0]?.name).toBe("QC");
        expect(plan.steps[0]?.agent).toBe("prep");
        expect(plan.steps[0]?.depends_on).toEqual([]);
    });

    test("data-run-card lands as the harness part", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({
                type: "data-run-card",
                source: ROOT,
                data: { id: "run-card-1", runId: "run-1", planId: "pln-00000001", title: "DE run", stepCount: 3 },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const run = requirePart((p): p is RunCardPart => p.type === "data-run-card");
        expect(run.runId).toBe("run-1");
        expect(run.title).toBe("DE run");
        expect(run.stepCount).toBe(3);
    });

    test("an invalid part of a known type is dropped at receipt, and the parts around it still land", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "text-delta", text: "before" });
            // A run card with no `runId` fails the check of its type.
            void emit({ type: "data-run-card", source: ROOT, data: { id: "run-card-1", planId: "pln-00000001", title: "DE run", stepCount: 3 } });
            void emit({
                type: "data-run-card",
                source: ROOT,
                data: { id: "run-card-2", runId: "run-2", planId: "pln-00000001", title: "QC run", stepCount: 1 },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(messages[1]?.parts.map((p) => p.type)).toEqual(["text", "data-run-card"]);
        expect(requirePart((p): p is RunCardPart => p.type === "data-run-card").runId).toBe("run-2");
    });

    test("an unknown data part stays in the transcript, not swallowed", async () => {
        const server = fakeServer(done(), (emit) => {
            // A `data-*` type with no first-class renderer still lands; the renderer shows it as a tagged mention.
            void emit({ type: "data-widget", source: ROOT, data: {} });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(messages[1]?.parts.map((p): string => p.type)).toEqual(["data-widget"]);
    });

    test("data-presentation (markdown) reads as an inline presentation", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({
                type: "data-presentation",
                source: ROOT,
                data: { id: "pres-1", title: "Finding", content: { kind: "markdown", body: "**TP53** up" } },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const view = readPresentation(requirePart((p): p is PresentationPart => p.type === "data-presentation"));
        expect(view).toEqual({ shape: "inline", title: "Finding", body: { kind: "markdown", body: "**TP53** up" } });
    });

    test("data-presentation (echart) is an openable entry carrying the spec + analysis scope", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({
                type: "data-presentation",
                source: ROOT,
                data: { id: "pres-chart", title: "Volcano", content: { kind: "echart", spec: { series: [{ type: "scatter" }] }, dataPath: "runs/r/out.csv" } },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const [openable] = sessionOpenables(AID);
        expect(openable?.analysisId).toBe(AID);
        const target = openable?.entry.target;
        expect(target?.kind).toBe("echart");
        if (target?.kind === "echart") {
            expect(target.presId).toBe("pres-chart");
            expect(target.dataPath).toBe("runs/r/out.csv");
            expect(target.spec).toEqual({ series: [{ type: "scatter" }] });
        }
    });

    test("data-file-reference reads as an openable gallery with a folder for multiple files", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({
                type: "data-file-reference",
                source: ROOT,
                data: { id: "pres-g", title: "Figures", files: [{ path: "runs/r/figures/a.png" }, { path: "runs/r/figures/b.png", caption: "heatmap" }] },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const view = readFileReference(requirePart((p): p is FileReferencePart => p.type === "data-file-reference"));
        expect(view.entries.length).toBe(2);
        expect(view.entries[0]?.name).toBe("a.png");
        expect(view.entries[1]?.caption).toBe("heatmap");
        expect(view.folderPath).toBe("runs/r/figures");
        // Newest first: the last file of the gallery is the first openable.
        expect(sessionOpenables(AID).map((o) => o.entry.name)).toEqual(["b.png", "a.png"]);
    });

    test("sub-agent frames (callPath depth > 1) never enter the transcript", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "text-delta", text: "top-level " });
            // A deeper callPath => sub-agent traffic; its data part must not enter the transcript.
            void emit({ type: "data-plan", source: { agentId: "planner", callPath: ["tui-chat", "planner"] }, data: { planId: "hidden" } });
            void emit({
                type: "tool-started",
                source: { agentId: "planner", callPath: ["tui-chat", "planner"] },
                toolUseId: "sub",
                name: "hidden_tool",
                input: {},
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(findPart((p): p is PlanPart => p.type === "data-plan")).toBeUndefined();
        expect(findPart(isToolCall)).toBeUndefined();
        // The top-level delta still flushed.
        const part = messages[1]?.parts[0];
        expect(part?.type === "text" ? part.text : undefined).toBe("top-level ");
    });

    test("aborted flushes what streamed, returns to idle, and sets no error", async () => {
        const server = fakeServer({ status: "aborted", opened: true }, (emit) => {
            void emit({ type: "text-delta", text: "partial answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const part = messages[1]?.parts[0];
        expect(part?.type === "text" ? part.text : undefined).toBe("partial answer");
        expect(errorMsg()).toBeNull();
        expect(chatStatus()).toBe("idle");
    });

    test("failed surfaces the message of the server as the banner, with the details hint, and error status", async () => {
        const server = fakeServer({
            status: "failed",
            opened: true,
            failure: { message: "The turn failed: provider exploded", detailLines: ["Error: provider exploded"] },
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(errorMsg()).toStartWith("The turn failed: provider exploded — ");
        expect(errorMsg()).toContain("for details");
        expect(chatStatus()).toBe("error");
    });

    test("the detail lines of a failed turn are retained for the details dialog", async () => {
        const detailLines = ["Error: rate limited", "  cause: provider: rate limited"];
        await send(
            { sessionId: SID, analysisId: AID, userText: "?" },
            fakeServer({ status: "failed", opened: true, failure: { message: "The turn failed: provider: rate limited", detailLines } }),
        );
        expect(lastTurnFailure()).toEqual(detailLines);
        expect(errorMsg()).not.toContain("[object Object]");
    });

    test("a new send clears the retained failure", async () => {
        await send(
            { sessionId: SID, analysisId: AID, userText: "?" },
            fakeServer({ status: "failed", opened: true, failure: { message: "The turn failed: boom", detailLines: ["boom"] } }),
        );
        expect(lastTurnFailure()).not.toBeNull();
        // The next send resets hot error state before running — the stale failure must not linger.
        await send({ sessionId: SID, analysisId: AID, userText: "again" }, fakeServer(done({ fallbackText: "hi" })));
        expect(lastTurnFailure()).toBeNull();
        expect(errorMsg()).toBeNull();
    });

    test("a filtered turn flushes its prose, then raises the content-filter banner with the server's detail", async () => {
        const server = fakeServer(
            {
                status: "filtered",
                opened: true,
                fallbackText: "partial prose",
                failure: {
                    message: "The model declined this request and stopped the turn.",
                    reason: "content_filter",
                    detailLines: ["content_filter: refusal"],
                },
            },
            () => {},
        );
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        const part = messages[1]?.parts[0];
        expect(part?.type === "text" ? part.text : undefined).toBe("partial prose");
        expect(errorMsg()).toContain("content filter");
        expect(lastTurnFailure()).toEqual(["content_filter: refusal"]);
        expect(chatStatus()).toBe("error");
    });

    test("a refusal before the turn opens raises the banner: a server failure, and a thread that is gone", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, refusingServer(PREPARE_FAILED));
        expect(errorMsg()).toContain("Could not start the turn");
        expect(errorMsg()).toContain("internal_error");
        expect(chatStatus()).toBe("error");

        resetHotState();
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, refusingServer(THREAD_NOT_FOUND));
        expect(errorMsg()).toContain("no longer available");
        expect(chatStatus()).toBe("error");
    });

    test("a refused thread type is named by the server, and the empty bubble drops", async () => {
        const unresolved: ClientError = {
            type: "http",
            status: 500,
            body: { error: "internal_error", message: 'No agent is registered for "report" threads in this build.' },
        };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, refusingServer(unresolved));
        // The banner names the refused type — a retry cannot change which agents this build registered.
        expect(errorMsg()).toContain('"report"');
        expect(chatStatus()).toBe("error");
        // The details dialog holds the one line of the refusal.
        expect(lastTurnFailure()?.join("\n")).toContain('"report"');
        // A refusal comes before the turn opened, thus only the user message stands.
        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");
    });

    test("a store fault is surfaced non-fatally (turn still done, no error banner)", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(done({ fallbackText: "done", storeFailed: true })));
        // A save fault does not fail the turn: status is idle and the banner stays clear.
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();
        expect(currentNotice()?.text).toContain("Could not save the turn");
    });
});

describe("send() reads the end of a turn from its stream when the summary is gone", () => {
    test("a `finish` frame with an unreadable summary ends the turn as done, with the usage of the frame", async () => {
        const turnUsage = { inputTokens: 40, outputTokens: 7 };
        const server: SendOpts = {
            ...fakeServer(done({ turnUsage }), (emit) => void emit({ type: "text-delta", text: "answer" })),
            fetchTurn: () => errAsync(PREPARE_FAILED),
        };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();
        expect(messages[1]?.usage).toEqual(turnUsage);
    });

    test("an `error` frame with an unreadable summary raises its message", async () => {
        const server: SendOpts = {
            ...fakeServer({ status: "failed", opened: true, failure: { message: "The turn failed: overloaded", detailLines: [] } }),
            fetchTurn: () => errAsync(PREPARE_FAILED),
        };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(errorMsg()).toStartWith("The turn failed: overloaded");
        expect(chatStatus()).toBe("error");
    });

    test("a stream that breaks with no terminal frame and no summary raises the broken-stream banner", async () => {
        const broken: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:1", cause: new Error("reset") };
        async function* frames(): AsyncGenerator<Result<ChatFrame, ClientError>> {
            // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the hook, which the rule cannot follow
            yield ok({ type: "text-delta", text: "partial", source: ROUTE_SOURCE });
            // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the hook, which the rule cannot follow
            yield err(broken);
        }
        const server: SendOpts = { ...fakeServer(done()), startTurn: () => okAsync({ turnId: "turn-x", frames: frames() }), fetchTurn: () => errAsync(broken) };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(errorMsg()).toContain("The stream of the turn broke");
        expect(chatStatus()).toBe("error");
        // What streamed before the break stays on screen.
        const part = messages[1]?.parts[0];
        expect(part?.type === "text" ? part.text : undefined).toBe("partial");
    });
});

describe("send() handles data-ask parts: reconcile-by-id + the pending-asks store", () => {
    /** Every ask-card part on the assistant message, in mounted order. */
    function askCards(): LiveAskPart[] {
        return (messages[1]?.parts ?? []).filter((p): p is LiveAskPart => p.type === "data-ask");
    }

    test("pending then resolved under one id reconciles to ONE card with the updated status", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "Run refs", command: "inflexa refs list", status: "pending" } });
            void emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "Run refs", command: "inflexa refs list", status: "resolved" } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const cards = askCards();
        expect(cards.length).toBe(1);
        expect(cards[0]?.id).toBe("ask-1");
        expect(cards[0]?.command).toBe("inflexa refs list");
        expect(cards[0]?.status).toBe("resolved");
    });

    test("a pending ask pushes the store as the head; its terminal re-emit settles it", async () => {
        const seen: { active: string | null; queued: number }[] = [];
        const server = fakeServer(done(), async (emit) => {
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "c", status: "pending" } });
            seen.push({ active: activeAsk()?.askId ?? null, queued: queuedCount() });
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "c", status: "resolved" } });
            seen.push({ active: activeAsk()?.askId ?? null, queued: queuedCount() });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        // Mid-turn: the pending push made ask-1 the head; the terminal re-emit drained it.
        expect(seen[0]).toEqual({ active: "ask-1", queued: 0 });
        expect(seen[1]).toEqual({ active: null, queued: 0 });
    });

    test("two concurrent pending asks queue FIFO; the head answers first", async () => {
        const seen: { active: string | null; queued: number }[] = [];
        const server = fakeServer(done(), async (emit) => {
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t1", command: "c1", status: "pending" } });
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-2", title: "t2", command: "c2", status: "pending" } });
            seen.push({ active: activeAsk()?.askId ?? null, queued: queuedCount() });
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t1", command: "c1", status: "resolved" } });
            seen.push({ active: activeAsk()?.askId ?? null, queued: queuedCount() });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(seen[0]).toEqual({ active: "ask-1", queued: 1 });
        expect(seen[1]).toEqual({ active: "ask-2", queued: 0 });
        // Both cards remain in the transcript; ask-1 reconciled to resolved, ask-2 stays pending.
        expect(askCards().map((c) => `${c.id}:${c.status}`)).toEqual(["ask-1:resolved", "ask-2:pending"]);
    });

    test("a terminal-only re-emit with no prior pending appends one settled card (append-if-missing)", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "data-ask", source: ROOT, data: { id: "ask-9", title: "t", command: "c", status: "rejected" } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const cards = askCards();
        expect(cards.length).toBe(1);
        expect(cards[0]?.id).toBe("ask-9");
        expect(cards[0]?.status).toBe("rejected");
        // A terminal-only emission never docks a prompt.
        expect(activeAsk()).toBeNull();
    });

    test("turn teardown clears the pending store — an abort leaves no stale docked prompt", async () => {
        const server = fakeServer({ status: "aborted", opened: true }, (emit) => {
            // A pending ask that never receives its terminal re-emit (the turn aborts first).
            void emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "c", status: "pending" } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(activeAsk()).toBeNull();
        expect(queuedCount()).toBe(0);
    });

    test("an invalid data-ask is dropped at receipt — it never docks a prompt and never lands a card", async () => {
        const server = fakeServer(done(), (emit) => {
            // No id, and a status outside the union: the check of the ask type refuses the part.
            void emit({ type: "data-ask", source: ROOT, data: { title: "t", command: "c", status: "granted" } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(activeAsk()).toBeNull();
        expect(queuedCount()).toBe(0);
        expect(askCards()).toEqual([]);
    });

    // The answer-side feedback echo (noteAskFeedback) and the gateway's terminal re-emit race: neither
    // ordering is guaranteed at runtime, and both write the same card. These two cases pin that they
    // CONVERGE — noteAskFeedback spreads + adds `feedback`, and the store copy of the re-emit keeps a
    // `feedback` already noted, so whichever lands second preserves the other's write.
    test("feedback survives the terminal re-emit — noteAskFeedback THEN reconcile", async () => {
        const server = fakeServer(done(), async (emit) => {
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "rm -rf out", status: "pending" } });
            noteAskFeedback("ask-1", "archive, don't delete");
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "rm -rf out", status: "rejected" } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const cards = askCards();
        expect(cards.length).toBe(1);
        expect(cards[0]?.status).toBe("rejected");
        expect(cards[0]?.feedback).toBe("archive, don't delete");
    });

    test("feedback survives the terminal re-emit — reconcile THEN noteAskFeedback", async () => {
        const server = fakeServer(done(), async (emit) => {
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "rm -rf out", status: "pending" } });
            await emit({ type: "data-ask", source: ROOT, data: { id: "ask-1", title: "t", command: "rm -rf out", status: "rejected" } });
            noteAskFeedback("ask-1", "archive, don't delete");
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const cards = askCards();
        expect(cards.length).toBe(1);
        expect(cards[0]?.status).toBe("rejected");
        expect(cards[0]?.feedback).toBe("archive, don't delete");
    });
});

describe("send() handles data-compaction parts: one part updated in place by its id", () => {
    function compactionParts(): CompactionPart[] {
        return (messages[1]?.parts ?? []).filter((p): p is CompactionPart => p.type === "data-compaction");
    }

    test("running then done under one id gives one compaction part with the status and the figures of the second emission", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "data-compaction", source: ROOT, data: { id: "c-1", status: "running", tokensBefore: 162_000 } });
            void emit({
                type: "data-compaction",
                source: ROOT,
                data: { id: "c-1", status: "done", tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(compactionParts()).toEqual([
            { type: "data-compaction", id: "c-1", status: "done", tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 },
        ]);
    });

    test("the card keeps its part while the text after it streams, and it settles in place", async () => {
        // The emission order of a compaction round: the part runs, the round streams, then the part settles.
        let running: Part | undefined;
        const server = fakeServer(done(), async (emit) => {
            await emit({ type: "text-delta", text: "before " });
            await emit({ type: "data-compaction", source: ROOT, data: { id: "c-1", status: "running", tokensBefore: 162_000 } });
            running = messages[1]?.parts[1];
            await emit({ type: "text-delta", text: "af" });
            await emit({ type: "text-delta", text: "ter" });
            // A delta changes only the stream signal: the card keeps its part, thus its component keeps its state.
            expect(messages[1]?.parts[1]).toBe(running);
            expect(streamText()).toBe("after");
            await emit({ type: "data-compaction", source: ROOT, data: { id: "c-1", status: "done", tokensBefore: 162_000, tokensAfter: 14_000 } });
            // The settled part takes the slot of the running one, and the text after it keeps streaming.
            expect(messages[1]?.parts[1]).not.toBe(running);
            expect(streamText()).toBe("after");
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(messages[1]?.parts.map((p) => (p.type === "text" ? p.text : p.type))).toEqual(["before ", "data-compaction", "after"]);
        expect(compactionParts().map((p) => p.status)).toEqual(["done"]);
    });

    test("an invalid compaction part is dropped at receipt", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "data-compaction", source: ROOT, data: { id: "c-1", status: "paused", tokensBefore: "many" } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(compactionParts()).toEqual([]);
    });

    test("a reloaded divider mounts as a system message with one compaction part", async () => {
        const divider: ChatMessage = {
            id: "c-1",
            role: "system",
            parts: [{ type: "data-compaction", id: "c-1", status: "done", tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 }],
        };
        await loadMessages(AID, SID, loadOf([divider]));

        expect(messages.map((m) => ({ ...m }))).toEqual([divider]);
    });
});

describe("applyServerFrame outside a turn", () => {
    test("appends nothing when no assistant turn is active (defensive no-op)", () => {
        applyServerFrame({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "x" });
        expect(messages.length).toBe(0);
    });
});

describe("send() interleaves mid-turn prose and non-text parts in emission order", () => {
    // The assistant turn's parts, in mounted order, with each part's kind + text for text parts.
    function assistantParts(): { type: string; text?: string }[] {
        const parts = messages[1]?.parts ?? [];
        return parts.map((p) => (p.type === "text" ? { type: p.type, text: p.text } : { type: p.type }));
    }

    test("text -> tool -> text renders three parts in order [text][tool][text]", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "text-delta", text: "Reading the schema. " });
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
            void emit({ type: "text-delta", text: "It carries a slug column." });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(assistantParts()).toEqual([
            { type: "text", text: "Reading the schema. " },
            { type: "tool-call" },
            { type: "text", text: "It carries a slug column." },
        ]);
    });

    test("text -> plan card with no trailing prose renders [text][data-plan] and no empty part", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "text-delta", text: "Here is the plan." });
            void emit({ type: "data-plan", source: ROOT, data: { id: "plan-card-1", planId: "pln-00000001", title: "DE analysis", steps: [PLAN_STEP] } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        // Exactly two parts, in order — the card sits AFTER the prose, and nothing minted a trailing
        // empty text part for the (absent) post-card prose.
        expect(assistantParts()).toEqual([{ type: "text", text: "Here is the plan." }, { type: "data-plan" }]);
    });

    test("deltas after a card flow into a NEW text part, not the pre-card one", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "text-delta", text: "before" });
            void emit({ type: "data-plan", source: ROOT, data: { id: "plan-card-1", planId: "pln-00000001", title: "t", steps: [] } });
            void emit({ type: "text-delta", text: "after" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const textParts = (messages[1]?.parts ?? []).filter((p): p is LiveTextPart => p.type === "text");
        // Two DISTINCT text parts — the pre-card prose and the post-card prose never merged.
        expect(textParts.map((p) => p.text)).toEqual(["before", "after"]);
        expect(textParts[0]?.key).not.toBe(textParts[1]?.key);
        expect(assistantParts()).toEqual([{ type: "text", text: "before" }, { type: "data-plan" }, { type: "text", text: "after" }]);
    });
});

describe("send() turn-generation guard", () => {
    test("a superseded turn's result and late frames never touch the new turn's state", async () => {
        // Turn A: a slow server stream that sends a delta, blocks until released (modelling the old turn
        // still unwinding when a swap lands), then sends a LATE delta before it ends.
        let releaseA!: () => void;
        const aGate = new Promise<void>((r) => {
            releaseA = r;
        });
        const serverA = fakeServer(done({ fallbackText: "A-done" }), async (emit) => {
            void emit({ type: "text-delta", text: "A-partial" });
            await aGate;
            // Sent AFTER supersession — must be dropped at the guarded sink.
            void emit({ type: "text-delta", text: "A-late" });
        });
        const aPromise = send({ sessionId: SID, analysisId: AID, userText: "A" }, serverA);

        // A session swap supersedes A mid-flight (resetHotState nulls the token, and aborts A).
        resetHotState();

        // Turn B runs to completion in the new session and streams its own answer.
        const serverB = fakeServer(done(), (emit) => void emit({ type: "text-delta", text: "B-answer" }));
        await send({ sessionId: "s2", analysisId: "a2", userText: "B" }, serverB);

        // B's finished state, snapshotted before A resolves.
        expect(messages.length).toBe(2);
        const bPart = messages[1]?.parts[0];
        expect(bPart?.type === "text" ? bPart.text : undefined).toBe("B-answer");
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();

        // A's stale result + late delta land last; neither may perturb B.
        releaseA();
        await aPromise;

        expect(messages.length).toBe(2);
        const bAfter = messages[1]?.parts[0];
        expect(bAfter?.type === "text" ? bAfter.text : undefined).toBe("B-answer");
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();
        expect(streamPartId()).toBeNull();
        expect(streamText()).toBe("");
        // The swap sent the abort of A to the server.
        expect(serverA.aborted).toEqual(["turn-1"]);
    });
});

describe("send() turn cleanup", () => {
    test("aborting with an open tool resolves the chip to a terminal state", async () => {
        const server = fakeServer({ status: "aborted", opened: true }, (emit) => {
            // A tool-started with no matching tool-finished — still running when the turn aborts.
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        const tool = findPart(isToolCall);
        expect(tool).toBeDefined();
        // Drained to a terminal state — never left `running` at idle.
        expect(tool?.outcome).toBe("error");
        // No tool-finished arrived, thus nothing measured this call. The elapsed
        // time since its start stamp would be the round's, and a multi-call round
        // would strand every chip with one identical figure.
        expect(tool?.durationMs).toBeUndefined();
        expect(chatStatus()).toBe("idle");
    });

    test("the assistant turn is stamped with a duration on done", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(done({ fallbackText: "hi" })));
        expect(messages[1]?.role).toBe("assistant");
        expect(typeof messages[1]?.durationMs).toBe("number");
        expect(messages[1]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    // What a turn cost rides the finished assistant message beside its duration. The server reports a
    // rollup only when some call reported one, and the store must preserve that: absent means nothing
    // was reported, which is a different fact from nothing having been spent.
    test("a reported rollup is stamped on the assistant turn beside its duration, whole", async () => {
        // The cache and reasoning quantities are breakdowns OF the two headline counts, so a store that
        // reduced the rollup to a total would double-count the cached prefix. It is carried verbatim.
        const turnUsage = { inputTokens: 12_400, outputTokens: 3100, cacheReadInputTokens: 9800, reasoningTokens: 900 };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(done({ fallbackText: "hi", turnUsage })));
        expect(typeof messages[1]?.durationMs).toBe("number");
        expect(messages[1]?.usage).toEqual(turnUsage);
    });

    test("a summary with no rollup leaves the message without one — the duration alone, never a zeroed usage", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(done({ fallbackText: "hi" })));
        expect(typeof messages[1]?.durationMs).toBe("number");
        expect(messages[1]?.usage).toBeUndefined();
    });

    test("an interrupted turn that streamed output keeps what it spent before the abort", async () => {
        const turnUsage = { inputTokens: 800, outputTokens: 120 };
        // A delta makes this a turn that produced content, so the abort marks the message rather than
        // dropping the empty shell — which is the only abort shape with a message left to stamp.
        const server = fakeServer({ status: "aborted", opened: true, turnUsage }, (emit) => void emit({ type: "text-delta", text: "the ans" }));
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);
        expect(messages[1]?.interrupted).toBe(true);
        expect(messages[1]?.usage).toEqual(turnUsage);
    });

    test("a refusal pops the empty assistant bubble", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, refusingServer(PREPARE_FAILED));
        // Only the user message remains — the empty assistant bubble was removed.
        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");

        resetHotState();
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, refusingServer(THREAD_NOT_FOUND));
        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");
    });
});

describe("loadMessages mounts the newest MESSAGE_CAP messages of a long thread", () => {
    // The fixture is N single-message turns (message t -> "m<t>"), handed back whole because the server
    // reads no window. What is under test is the trailing cap: the mount holds the NEWEST messages and
    // drops the oldest, whatever the thread's length.
    function transcript(n: number): ChatMessage[] {
        return Array.from({ length: n }, (_, t): ChatMessage => ({
            id: `id-${t}`,
            role: t % 2 === 0 ? "user" : "assistant",
            parts: [{ type: "text", text: `m${t}` }],
        }));
    }

    function countingLoad(list: ChatMessage[]): LoadOpts & { reads: () => number } {
        let reads = 0;
        return {
            fetchMessages: () => {
                reads++;
                return okAsync(messageList(list));
            },
            reads: () => reads,
        };
    }

    function textAt(i: number): string | undefined {
        const p = messages[i]?.parts[0];
        return p?.type === "text" ? p.text : undefined;
    }

    test("a thread at the cap mounts whole", async () => {
        await loadMessages(AID, SID, countingLoad(transcript(200)));
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m0");
        expect(textAt(199)).toBe("m199");
    });

    test("one past the cap drops the oldest message, not the newest", async () => {
        await loadMessages(AID, SID, countingLoad(transcript(201)));
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m1");
        expect(textAt(199)).toBe("m200");
    });

    test("a thread far past the cap still ends on its newest message", async () => {
        await loadMessages(AID, SID, countingLoad(transcript(400)));
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m200");
        expect(textAt(199)).toBe("m399");
    });

    test("a thread shorter than the cap mounts whole", async () => {
        await loadMessages(AID, SID, countingLoad(transcript(3)));
        expect(messages.length).toBe(3);
        expect(textAt(0)).toBe("m0");
        expect(textAt(2)).toBe("m2");
    });

    test("one read, whatever the thread's length", async () => {
        const load = countingLoad(transcript(400));
        await loadMessages(AID, SID, load);
        expect(load.reads()).toBe(1);
    });
});

describe("loadMessages reads absence and failure apart", () => {
    test("a thread with no row (404) mounts an empty transcript and raises nothing", async () => {
        await loadMessages(AID, SID, { fetchMessages: () => errAsync(THREAD_NOT_FOUND) });
        expect(messages.length).toBe(0);
        expect(errorMsg()).toBeNull();
        expect(chatStatus()).toBe("idle");
    });

    test("a failed read raises the load banner", async () => {
        await loadMessages(AID, SID, { fetchMessages: () => errAsync(PREPARE_FAILED) });
        expect(errorMsg()).toContain("Failed to load the conversation");
        expect(chatStatus()).toBe("error");
    });
});

describe("loadMessages staleness guard", () => {
    const chatText = (id: string, text: string): ChatMessage[] => [{ id, role: "assistant", parts: [{ type: "text", text }] }];

    test("an older load that lands LAST does not clobber the newer load", async () => {
        // The OLDER load (load 1) blocks at its read until released; the NEWER load (load 2) starts after
        // it and completes first. When load 1 finally resolves it must detect the newer generation and
        // drop, leaving load 2's transcript in the store.
        let releaseOld!: () => void;
        const oldGate = new Promise<void>((r) => {
            releaseOld = r;
        });
        const oldLoad: LoadOpts = { fetchMessages: () => ResultAsync.fromSafePromise(oldGate.then(() => messageList(chatText("old", "old-msg")))) };

        const parked = loadMessages(AID, SID, oldLoad); // blocks on oldGate at its read
        await loadMessages(AID, SID, loadOf(chatText("new", "new-msg"))); // starts later, completes first

        const afterNew = messages[0]?.parts[0];
        expect(afterNew?.type === "text" ? afterNew.text : undefined).toBe("new-msg");

        releaseOld();
        await parked;

        // The older load resolved last but was dropped — the store still shows the newer transcript.
        expect(messages.length).toBe(1);
        const final = messages[0]?.parts[0];
        expect(final?.type === "text" ? final.text : undefined).toBe("new-msg");
    });
});

// One generation token orders BOTH store writers. `Chat` fires `loadMessages` the instant boot reaches
// `ready` — the same instant `handleSubmit`'s gate opens — so a message pre-typed during the boot
// animation is submitted while that load is still awaiting the server. A turn must supersede a load.
describe("a turn supersedes a transcript load in flight", () => {
    /** Load options whose read parks until the returned release is called. */
    function gatedLoad(): { load: LoadOpts; release: () => void } {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        return {
            load: {
                fetchMessages: () =>
                    ResultAsync.fromSafePromise(
                        gate.then(() => messageList([{ id: "stale", role: "assistant", parts: [{ type: "text", text: "stale-transcript" }] }])),
                    ),
            },
            release: () => release(),
        };
    }

    test("a load resolving mid-send does not wipe the user message or the in-flight turn", async () => {
        const { load, release } = gatedLoad();
        const parked = loadMessages(AID, SID, load); // parks on its read

        await send(
            { sessionId: SID, analysisId: AID, userText: "hi" },
            fakeServer(done(), (emit) => void emit({ type: "text-delta", text: "live answer" })),
        );

        expect(messages.length).toBe(2);

        release();
        await parked;

        // The load was superseded by the turn and dropped: user + assistant survive, and the assistant
        // still carries the streamed text (a wipe would have stranded `currentAssistantId` off-store).
        expect(messages.length).toBe(2);
        expect(messages[0]?.role).toBe("user");
        expect(messages[1]?.role).toBe("assistant");
        const answer = messages[1]?.parts.find((p) => p.type === "text");
        expect(answer?.type === "text" ? answer.text : undefined).toBe("live answer");
    });

    test("parts streamed after the superseded load resolves still reach the assistant message", async () => {
        const { load, release } = gatedLoad();
        const parked = loadMessages(AID, SID, load);

        // Release the load mid-turn: its trailing write must not land, so the adapter's later parts
        // still find the assistant message they were minted against.
        const server = fakeServer(done(), async (emit) => {
            await emit({ type: "text-delta", text: "before" });
            release();
            await parked;
            await emit({ type: "text-delta", text: " after" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, server);

        expect(messages.length).toBe(2);
        const answer = messages[1]?.parts.find((p) => p.type === "text");
        expect(answer?.type === "text" ? answer.text : undefined).toBe("before after");
    });

    test("resetHotState drops a load already in flight for the swapped-away session", async () => {
        const { load, release } = gatedLoad();
        const parked = loadMessages(AID, SID, load);

        resetHotState();
        release();
        await parked;

        // The cleared store stays cleared — the old session's transcript never repopulates it.
        expect(messages.length).toBe(0);
    });
});

// `commitStream` writes into the part `streamPartId` names and no-ops when it is null. Any mid-turn
// seal (tool chip, plan card, run card) nulls it, so without the done-fallback re-opening a segment, a
// delta-less final answer would sit in `streamText` and never render.
describe("a delta-less final segment renders after a mid-turn part", () => {
    test("deltas -> tool -> no further deltas: the fallback renders as a trailing part", async () => {
        const server = fakeServer(done({ fallbackText: "THE FINAL ANSWER" }), (emit) => {
            void emit({ type: "text-delta", text: "thinking..." });
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, server);

        // Emission order: the streamed prose, the tool chip it preceded, then the fallback BELOW it —
        // exactly what a transcript reload renders.
        expect(messages[1]?.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
        const trailing = messages[1]?.parts[2];
        expect(trailing?.type === "text" ? trailing.text : undefined).toBe("THE FINAL ANSWER");
    });

    test("deltas -> plan card -> no further deltas: the fallback renders below the card", async () => {
        const server = fakeServer(done({ fallbackText: "here is the plan" }), (emit) => {
            void emit({ type: "text-delta", text: "drafting" });
            void emit({ type: "data-plan", data: { id: "p1", planId: "pln-00000001", title: "T", steps: [] } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "plan it" }, server);

        expect(messages[1]?.parts.map((p) => p.type)).toEqual(["text", "data-plan", "text"]);
    });

    test("a streamed final answer is not duplicated by the fallback", async () => {
        // The buffer is non-empty at completion, so the final assistant text DID stream — rendering
        // `fallbackText` on top of it would print the answer twice. The turn's FIRST frame is a tool
        // (the common bare-tool_use first iteration), so the prose must render BELOW the chip.
        const server = fakeServer(done({ fallbackText: "streamed answer" }), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
            void emit({ type: "text-delta", text: "streamed answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, server);

        const texts = messages[1]?.parts.filter((p) => p.type === "text") ?? [];
        expect(texts.length).toBe(1);
        expect(texts[0]?.type === "text" ? texts[0].text : undefined).toBe("streamed answer");
        // Part ORDER is [tool][text]: the prose opened a fresh segment BELOW the chip — matching a
        // transcript reload.
        expect(messages[1]?.parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
    });

    test("tool-first with the answer only as fallback: prose renders below the tool, not above it", async () => {
        const server = fakeServer(done({ fallbackText: "the answer" }), (emit) => {
            void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, server);

        expect(messages[1]?.parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
        const trailing = messages[1]?.parts[1];
        expect(trailing?.type === "text" ? trailing.text : undefined).toBe("the answer");
    });

    test("a turn ending on a card with no fallback leaves no trailing empty part", async () => {
        const server = fakeServer(done(), (emit) => {
            void emit({ type: "text-delta", text: "drafting" });
            void emit({ type: "data-plan", data: { id: "p1", planId: "pln-00000001", title: "T", steps: [] } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "plan it" }, server);

        expect(messages[1]?.parts.map((p) => p.type)).toEqual(["text", "data-plan"]);
    });
});

describe("MESSAGE_CAP answers to the display alone", () => {
    test("the read asks for the whole thread, never for a window", async () => {
        // MESSAGE_CAP once doubled as a page size that the store clamped to 200 — so a larger cap silently
        // stranded every turn past the clamp. The read takes no size, so the cap is a display bound and
        // nothing else. Pin the read taking no window, since a reintroduced size argument would quietly
        // restore the coupling.
        let seen: unknown[] = [];
        const load: LoadOpts = {
            fetchMessages: (...args: unknown[]) => {
                seen = args;
                return okAsync(messageList([]));
            },
        };
        await loadMessages(AID, SID, load);
        expect(seen).toEqual([AID, SID]);
    });
});

/** Mount a replay through the real load path: the server gives `replayed` as the transcript of the thread. */
async function mountReplay(replayed: ChatMessage[]): Promise<void> {
    await loadMessages(AID, SID, loadOf(replayed));
}

// A turn's cost and the time it took are both durable — the harness stores them for the turn and gives
// them back on its assistant message — so reload has to carry them back onto the
// message. Without this the transcript reads as a wall of turns nobody measured, which under the
// absent-is-not-zero rule is a false claim about every one of them rather than a missing decoration.
describe("a reloaded turn keeps the figures the live header showed", () => {
    test("a stored rollup lands on the message; absence stays structurally absent", async () => {
        const stored = { inputTokens: 49_600, outputTokens: 42 };
        await mountReplay([
            { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }], usage: stored },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
        ]);
        expect(messages[0]?.usage).toEqual(stored);

        // No stored rollup means no key — not a key holding `undefined`. Absence has exactly ONE
        // meaning on this field (no provider reported anything), and a reload that introduced a second
        // one would make the header unable to say which it is showing.
        expect(Object.keys(messages[1] ?? {})).not.toContain("usage");
    });

    test("a stored duration lands on the message, beside the rollup", async () => {
        await mountReplay([{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }], usage: { inputTokens: 10 }, durationMs: 2400 }]);
        expect(messages[0]?.durationMs).toBe(2400);
        expect(messages[0]?.usage).toEqual({ inputTokens: 10 });
    });

    test("a measured zero survives the reload — it is a figure, not an absence", async () => {
        // A turn that settled inside one millisecond measured zero. A reader that tested the field for
        // truth would drop that figure and render the turn as one nobody timed.
        await mountReplay([{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }], durationMs: 0 }]);
        expect(messages[0]?.durationMs).toBe(0);
    });

    test("a row that predates the durable field carries no duration, and nothing reconstructs one", async () => {
        // The elapsed time of a past turn is unknowable now, thus a header that invented one would be
        // fabricating a meta value. The other facts of the row still arrive.
        await mountReplay([{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }], usage: { inputTokens: 10 } }]);
        // No key, and not a key holding `undefined`: absence keeps ONE meaning on this field.
        expect(Object.keys(messages[0] ?? {})).not.toContain("durationMs");
        expect(messages[0]?.usage).toEqual({ inputTokens: 10 });
        const text = messages[0]?.parts[0];
        expect(text?.type === "text" && text.text).toBe("hi");
    });
});

// The whole live/reload contract as ONE harness: the same turn fed through the live adapter (`send` →
// `applyServerFrame`) and through the reload path (the replay of the stored parts, in stored order)
// must yield the SAME part-type sequence. The stored projection keeps emission order, so a turn whose
// first frame is a tool/card must render that part first LIVE too.
describe("live emission order matches transcript reload order", () => {
    type Shape = {
        readonly name: string;
        readonly drive: (emit: Emit) => void;
        readonly fallbackText: string;
        /** The turn as the harness reconstructs it from persisted rows, in stored order. */
        readonly reloadParts: readonly MessagePart[];
    };

    const call: MessagePart = { type: "tool-call", toolCallId: "t1", toolName: "read_file", outcome: "ok" };
    const shapes: Shape[] = [
        {
            name: "tool-first, answer streamed",
            drive: (emit) => {
                void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
                void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
                void emit({ type: "text-delta", text: "answer" });
            },
            fallbackText: "answer",
            reloadParts: [call, { type: "text", text: "answer" }],
        },
        {
            name: "tool-first, answer only as fallback",
            drive: (emit) => {
                void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
                void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
            },
            fallbackText: "final",
            reloadParts: [call, { type: "text", text: "final" }],
        },
        {
            name: "text, tool, text",
            drive: (emit) => {
                void emit({ type: "text-delta", text: "before " });
                void emit({ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {} });
                void emit({ type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok" });
                void emit({ type: "text-delta", text: "after" });
            },
            fallbackText: "after",
            reloadParts: [{ type: "text", text: "before " }, call, { type: "text", text: "after" }],
        },
        {
            name: "text only",
            drive: (emit) => void emit({ type: "text-delta", text: "hello" }),
            fallbackText: "hello",
            reloadParts: [{ type: "text", text: "hello" }],
        },
    ];

    for (const shape of shapes) {
        test(`${shape.name}: live and reload agree on the part sequence`, async () => {
            await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(done({ fallbackText: shape.fallbackText }), shape.drive));
            const liveKinds = (messages[1]?.parts ?? []).map((p) => p.type);

            await mountReplay([{ id: "m1", role: "assistant", parts: [...shape.reloadParts] }]);
            const reloadKinds = (messages[0]?.parts ?? []).map((p) => p.type);

            expect(liveKinds).toEqual(reloadKinds);
            expect(liveKinds).toEqual(shape.reloadParts.map((p) => p.type));
        });
    }
});

// The reconstructed tool part's outcome and detail. Before the converter paired each stored call with
// its `tool-result` block, every reloaded call reported success — so a call the user had watched fail
// came back wearing a green check. The store mounts what the harness recovered, and `MessageBlock`
// renders each outcome (`message_block.test.tsx`).
describe("a reload keeps the outcome and the detail of each call", () => {
    test("each outcome and each detail lands on its part as the harness gives it", async () => {
        await mountReplay([
            {
                id: "m1",
                role: "assistant",
                parts: [
                    { type: "tool-call", toolCallId: "t1", toolName: "read_file", outcome: "error" },
                    { type: "tool-call", toolCallId: "t2", toolName: "read_file", outcome: "denied" },
                    { type: "tool-call", toolCallId: "t3", toolName: "read_file", outcome: "ok", detail: "runs/r1/s2/output/summary.md" },
                    // A call the turn never saw finish carries `incomplete` — the one field says so.
                    { type: "tool-call", toolCallId: "t4", toolName: "read_file", outcome: "incomplete" },
                ],
            },
        ]);
        const calls = (messages[0]?.parts ?? []).filter(isToolCall);
        expect(calls.map((c) => c.outcome)).toEqual(["error", "denied", "ok", "incomplete"]);
        // A call the resolver could not describe carries no detail.
        expect(calls.map((c) => c.detail)).toEqual([undefined, undefined, "runs/r1/s2/output/summary.md", undefined]);
    });
});

// A load fired at the boot-ready edge and superseded by that same edge's submit: the dropped load's
// history would never remount until a manual session swap. `send` re-fires the load after the turn;
// the thread now carries the appended turn, so the reload is convergent — history + the turn mount.
describe("a superseded initial load is retried after the turn finishes", () => {
    test("history mounts once the boot-edge turn completes", async () => {
        // The initial (boot-edge) load parks on its read; the submit below supersedes and drops it.
        let releaseInitial!: () => void;
        const initialGate = new Promise<void>((r) => {
            releaseInitial = r;
        });
        const initialLoad: LoadOpts = {
            fetchMessages: () =>
                ResultAsync.fromSafePromise(
                    initialGate.then(() => messageList([{ id: "old", role: "assistant", parts: [{ type: "text", text: "never-mounted" }] }])),
                ),
        };

        // The post-turn reload: the thread now holds the prior history AND the just-finished turn (what
        // the server wrote), so the convergent replay carries all three messages.
        const reloadLoad = loadOf([
            { id: "h1", role: "assistant", parts: [{ type: "text", text: "prior history" }] },
            { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
            { id: "a1", role: "assistant", parts: [{ type: "text", text: "live answer" }] },
        ]);

        const parked = loadMessages(AID, SID, initialLoad); // parks — the submit below supersedes it

        const server: SendOpts = {
            ...fakeServer(done(), (emit) => void emit({ type: "text-delta", text: "live answer" })),
            reloadTranscript: (aid, sid) => loadMessages(aid, sid, reloadLoad),
        };
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, server);

        // The convergent reload fired and mounted the prior history the dropped load never showed.
        expect(messages.length).toBe(3);
        const first = messages[0]?.parts[0];
        expect(first?.type === "text" ? first.text : undefined).toBe("prior history");

        releaseInitial();
        await parked; // the dropped initial load resolves and no-ops (its generation is stale)

        // Still the convergent transcript — the stale load did not clobber it.
        expect(messages.length).toBe(3);
        const stillFirst = messages[0]?.parts[0];
        expect(stillFirst?.type === "text" ? stillFirst.text : undefined).toBe("prior history");
    });

    test("no reload when a load already mounted the session's history", async () => {
        // A completed load records the session; a subsequent turn must NOT re-fire the reload — the
        // history is already on screen, and the reload replaces the store wholesale.
        await loadMessages(AID, SID, loadOf([{ id: "h1", role: "assistant", parts: [{ type: "text", text: "history" }] }]));
        expect(messages.length).toBe(1);

        let reloadFired = false;
        const server: SendOpts = {
            ...fakeServer(done({ fallbackText: "done" })),
            reloadTranscript: async () => {
                reloadFired = true;
            },
        };
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, server);

        // The turn appended to the mounted store (history + user + assistant); the reload was skipped.
        expect(reloadFired).toBe(false);
        expect(messages.length).toBe(3);
    });
});

describe("send() closes the frame sink at turn completion", () => {
    test("a frame applied after the turn settles is dropped, not applied to the finished message", async () => {
        // The server ends the stream after its terminal frame, thus a straggler can reach the hook only
        // through a frame the adapter still applies. The settled turn cleared its adapter state, so the
        // straggler finds no message to land in.
        await send(
            { sessionId: SID, analysisId: AID, userText: "?" },
            fakeServer(done({ fallbackText: "done" }), (emit) => void emit({ type: "text-delta", text: "answer" })),
        );

        const partsBefore = messages[1]?.parts.length ?? 0;
        applyServerFrame({ type: "tool-started", source: ROOT, toolUseId: "late", name: "read_file" });

        // No new tool chip, the finished message is untouched.
        expect(messages[1]?.parts.length).toBe(partsBefore);
        expect(findPart(isToolCall)).toBeUndefined();
    });
});

// The chat-view contract: a display card streamed live and the same card replayed on reload land as the
// SAME harness part, and the renderer reads both through the same shared readers of `chat_printer`.
describe("display-card parts map identically live and on reload", () => {
    /** The store parts of a live turn that streams `emitted`, then of a reload whose replay holds `stored`. */
    async function liveThenReloaded(emitted: LoopEvent, stored: MessagePart): Promise<{ live: Part[]; reloaded: Part[] }> {
        await send(
            { sessionId: SID, analysisId: AID, userText: "?" },
            fakeServer(done(), (emit) => void emit(emitted)),
        );
        const live = [...(messages[1]?.parts ?? [])];
        await mountReplay([{ id: "m1", role: "assistant", parts: [stored] }]);
        return { live, reloaded: [...(messages[0]?.parts ?? [])] };
    }

    test("a markdown presentation reads as the same inline body in both paths", async () => {
        const data: Omit<PresentationPart, "type"> = { id: "pres-1", title: "Finding", content: { kind: "markdown", body: "**TP53** up" } };
        const { live, reloaded } = await liveThenReloaded({ type: "data-presentation", source: ROOT, data }, { type: "data-presentation", ...data });

        expect(live).toEqual(reloaded);
        const [card] = live;
        expect(card?.type).toBe("data-presentation");
        if (card?.type === "data-presentation") {
            expect(readPresentation(card)).toEqual({ shape: "inline", title: "Finding", body: { kind: "markdown", body: "**TP53** up" } });
        }
    });

    test("a file-reference gallery reads as the same openable card in both paths", async () => {
        const data: Omit<FileReferencePart, "type"> = {
            id: "pres-g",
            title: "Figures",
            files: [{ path: "runs/r/a.png" }, { path: "runs/r/b.png", caption: "heatmap" }],
        };
        const { live, reloaded } = await liveThenReloaded({ type: "data-file-reference", source: ROOT, data }, { type: "data-file-reference", ...data });

        expect(live).toEqual(reloaded);
        const [card] = reloaded;
        expect(card?.type).toBe("data-file-reference");
        if (card?.type === "data-file-reference") {
            const view = readFileReference(card);
            expect(view.entries.length).toBe(2);
            expect(view.folderPath).toBe("runs/r");
        }
        // The reloaded entries resolve against the analysis of the open workspace.
        expect(sessionOpenables(AID).map((o) => o.analysisId)).toEqual([AID, AID]);
    });

    test("a report-session spawn lands as the same part in both paths", async () => {
        const data = { threadId: "child-1", parentThreadId: SID, threadType: "report" };
        const { live, reloaded } = await liveThenReloaded(
            { type: "data-child-session-started", source: ROOT, data },
            { type: "data-child-session-started", ...data },
        );

        expect(live).toEqual(reloaded);
        expect(reloaded).toEqual([{ type: "data-child-session-started", threadId: "child-1", parentThreadId: SID, threadType: "report" }]);
    });

    test("an unknown replayed part still lands in the transcript on reload", async () => {
        // The renderer shows it as a tagged mention (`message_block.test.tsx`). The cast names a part of a
        // type that the vocabulary of this build does not hold, which is the case under test.
        await mountReplay([{ id: "m1", role: "assistant", parts: [{ type: "data-widget" } as unknown as MessagePart] }]);
        expect(messages[0]?.parts.map((p): string => p.type)).toEqual(["data-widget"]);
    });
});

describe("promptHistory", () => {
    // Seeded through the REAL load path rather than a hand-built store, so the reader is exercised over
    // the messages a thread replay actually produces (the replay keeps one text part for each stored text
    // part, which is what makes the multi-part join case reachable at all).
    type Turn = { role: "user" | "assistant"; texts: string[] };

    function seed(fixture: Turn[]): LoadOpts {
        return loadOf(
            fixture.map((t, i): ChatMessage => ({ id: `id-${i}`, role: t.role, parts: t.texts.map((text): MessagePart => ({ type: "text", text })) })),
        );
    }

    const user = (...texts: string[]): Turn => ({ role: "user", texts });
    const assistant = (text: string): Turn => ({ role: "assistant", texts: [text] });

    async function historyFor(fixture: Turn[]): Promise<string[]> {
        await loadMessages(AID, SID, seed(fixture));
        return promptHistory();
    }

    test("an unloaded session has no history", () => {
        expect(promptHistory()).toEqual([]);
    });

    test("sent prompts come back newest first, with assistant turns excluded", async () => {
        expect(await historyFor([user("first"), assistant("a1"), user("second"), assistant("a2")])).toEqual(["second", "first"]);
    });

    test("a replayed turn's multiple text parts join in order", async () => {
        expect(await historyFor([user("line one", "line two"), assistant("a1")])).toEqual(["line one\nline two"]);
    });

    test("a prompt re-sent right after a failed turn collapses to one entry", async () => {
        expect(await historyFor([user("retry me"), assistant("boom"), user("retry me"), assistant("ok")])).toEqual(["retry me"]);
    });

    test("identical prompts separated by another stay DISTINCT entries", async () => {
        // The non-adjacent-duplicate case the stored recall position exists for: searching this list for
        // the buffer's text would resolve both "A"s to index 0 and skip "B" entirely on the way back.
        expect(await historyFor([user("A"), assistant("a1"), user("B"), assistant("a2"), user("A"), assistant("a3")])).toEqual(["A", "B", "A"]);
    });

    test("a user turn carrying no text is skipped", async () => {
        expect(await historyFor([user(), assistant("a1"), user("real"), assistant("a2")])).toEqual(["real"]);
    });

    test("a session with only assistant turns has no history", async () => {
        expect(await historyFor([assistant("greeting")])).toEqual([]);
    });
});

describe("hasPromptHistory", () => {
    // The cheap config-time counterpart the recall binding asks on every keystroke: it must agree with
    // `promptHistory().length > 0` in every case, while returning at the first qualifying turn rather than
    // building the list. These pin the agreement — a drift between them would either eat `up` in a session
    // with nothing to recall, or leave it unbound in one that has something.
    type Turn = { role: "user" | "assistant"; texts: string[] };

    function seed(fixture: Turn[]): LoadOpts {
        return loadOf(
            fixture.map((t, i): ChatMessage => ({ id: `id-${i}`, role: t.role, parts: t.texts.map((text): MessagePart => ({ type: "text", text })) })),
        );
    }

    async function agreementFor(fixture: Turn[]): Promise<{ has: boolean; list: number }> {
        await loadMessages(AID, SID, seed(fixture));
        return { has: hasPromptHistory(), list: promptHistory().length };
    }

    const user = (...texts: string[]): Turn => ({ role: "user", texts });
    const assistant = (text: string): Turn => ({ role: "assistant", texts: [text] });

    test("an unloaded session has nothing to recall", () => {
        expect(hasPromptHistory()).toBe(false);
        expect(promptHistory().length).toBe(0);
    });

    test("a sent prompt makes it true, agreeing with the list", async () => {
        const { has, list } = await agreementFor([user("a prompt"), assistant("a1")]);
        expect(has).toBe(true);
        expect(list).toBe(1);
    });

    test("assistant-only turns leave it false", async () => {
        const { has, list } = await agreementFor([assistant("greeting"), assistant("more")]);
        expect(has).toBe(false);
        expect(list).toBe(0);
    });

    test("a text-less user turn does not count, matching the list's skip", async () => {
        const { has, list } = await agreementFor([user(), assistant("a1")]);
        expect(has).toBe(false);
        expect(list).toBe(0);
    });
});
