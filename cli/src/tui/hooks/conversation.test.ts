import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { okAsync, ResultAsync } from "neverthrow";
import type { MessagePage } from "@inflexa-ai/harness";

import {
    applyEmitEvent,
    type CortexMsg,
    errorMsg,
    loadMessages,
    type LoadSeams,
    messages,
    resetHotState,
    send,
    streamPartId,
    streamText,
    type SendSeams,
} from "./conversation.ts";
import { chatStatus } from "./status.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { RunChatTurnArgs, TurnOutcome } from "../../modules/harness/turn.ts";
import type { Part, PlanCardPart, RunCardPart, ToolCallPart } from "../../types/session.ts";

// The conversation state is a module singleton (one chat screen at a time), so reset it between
// cases. resetHotState() clears messages/stream/error/adapter state and returns status to idle.
const SID = "s1";
const AID = "a1";

// A stub runtime whose pool/provider are never dereferenced: the fake engine drives the adapter and
// returns an outcome without touching them. `createStreamingChat` reads `provider.capabilities` at
// construction, so that one field is present; everything else is unused infrastructure.
const stubRuntime = {
    pool: {},
    provider: { capabilities: { toolCalling: true } },
    conversationAgent: {},
} as unknown as HarnessRuntime;

/**
 * Build send seams whose fake engine calls `drive(emit)` (to exercise the adapter) then returns
 * `outcome`. The last `RunChatTurnArgs` it saw is captured so a test can assert what `send` passed.
 */
function fakeSeams(outcome: TurnOutcome, drive: (emit: RunChatTurnArgs["emit"]) => void = () => {}): SendSeams & { last: () => RunChatTurnArgs | null } {
    let last: RunChatTurnArgs | null = null;
    return {
        runtime: () => stubRuntime,
        runChatTurn: async (args: RunChatTurnArgs): Promise<TurnOutcome> => {
            last = args;
            drive(args.emit);
            return outcome;
        },
        last: () => last,
    };
}

function findPart<T extends Part>(pred: (p: Part) => p is T): T | undefined {
    for (const m of messages) {
        for (const p of m.parts) if (pred(p)) return p;
    }
    return undefined;
}

beforeEach(() => resetHotState());
afterEach(() => resetHotState());

describe("send() null-runtime guard", () => {
    test("no booted runtime surfaces an error banner and does not push a message", async () => {
        const seams: SendSeams = { runtime: () => null, runChatTurn: async () => ({ kind: "ok", fallbackText: "" }) };
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);
        expect(errorMsg()).toContain("not ready");
        expect(chatStatus()).toBe("error");
        expect(messages.length).toBe(0);
    });
});

describe("send() drives the adapter + engine", () => {
    test("pushes user + assistant messages and passes threadId = sessionId with the TUI session", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" });
        await send({ sessionId: SID, analysisId: AID, userText: "what's the schema?" }, seams);

        expect(messages.length).toBe(2);
        expect(messages[0]?.role).toBe("user");
        expect(messages[1]?.role).toBe("assistant");
        const userText = messages[0]?.parts[0];
        expect(userText?.type).toBe("text");
        if (userText?.type === "text") expect(userText.text).toBe("what's the schema?");

        const args = seams.last();
        expect(args?.threadId).toBe(SID);
        expect(args?.analysisId).toBe(AID);
        expect(args?.session.scope.kind).toBe("analysis");
        expect(args?.session.provenance.agentId).toBe("tui-chat");
        expect(args?.session.provenance.callPath).toEqual(["tui-chat"]);
    });

    test("text deltas accumulate live, then flush into the stored part on ok", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "ignored on a streamed turn" }, (emit) => {
            void emit({ type: "text-delta", text: "Each analysis " });
            void emit({ type: "text-delta", text: "row carries a slug." });
            // Snapshot mid-turn accumulation before the outcome flushes it.
            expect(streamText()).toBe("Each analysis row carries a slug.");
            expect(streamPartId()).not.toBeNull();
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        const part = messages[1]?.parts[0];
        expect(part?.type).toBe("text");
        if (part?.type === "text") expect(part.text).toBe("Each analysis row carries a slug.");
        expect(streamPartId()).toBeNull();
        expect(streamText()).toBe("");
        expect(chatStatus()).toBe("idle");
    });

    test("fallbackText renders when the turn produced no deltas", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "no-stream answer" });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const part = messages[1]?.parts[0];
        if (part?.type === "text") expect(part.text).toBe("no-stream answer");
    });

    test("tool started/finished pair into one part with an outcome + duration", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "tool-started", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t1", name: "read_file", isError: false });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const tool = findPart((p): p is ToolCallPart => p.type === "tool-call");
        expect(tool?.name).toBe("read_file");
        expect(tool?.status).toBe("ok");
        expect(tool?.durationMs).toBeGreaterThanOrEqual(0);
        // A start+finish for one id collapses to a single part, not two.
        expect(messages[1]?.parts.filter((p) => p.type === "tool-call").length).toBe(1);
    });

    test("tool error outcome is honored", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "tool-started", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t9", name: "write_file", input: {} });
            void emit({ type: "tool-finished", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t9", name: "write_file", isError: true });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const tool = findPart((p): p is ToolCallPart => p.type === "tool-call");
        expect(tool?.status).toBe("error");
    });

    test("data-plan becomes a plan-card via readPlanCard", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({
                type: "data-plan",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { planId: "plan-1", title: "DE analysis", steps: [{ id: "s1", name: "QC", agent: "prep" }] },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const plan = findPart((p): p is PlanCardPart => p.type === "plan-card");
        expect(plan?.planId).toBe("plan-1");
        expect(plan?.title).toBe("DE analysis");
        expect(plan?.steps).toEqual([{ id: "s1", name: "QC", agent: "prep" }]);
    });

    test("data-run-card becomes a run-card via readRunCard", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({
                type: "data-run-card",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { runId: "run-1", title: "DE run", stepCount: 3 },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const run = findPart((p): p is RunCardPart => p.type === "run-card");
        expect(run?.runId).toBe("run-1");
        expect(run?.title).toBe("DE run");
        expect(run?.stepCount).toBe(3);
    });

    test("an unknown data part renders a visible tagged mention, not swallowed", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "data-file-reference", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, data: { files: [] } });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const mention = findPart((p): p is Part & { type: "text" } => p.type === "text" && "text" in p && p.text.includes("[part:data-file-reference]"));
        expect(mention).toBeDefined();
    });

    test("sub-agent events (callPath depth > 1) are dropped", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
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
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        expect(findPart((p): p is PlanCardPart => p.type === "plan-card")).toBeUndefined();
        expect(findPart((p): p is ToolCallPart => p.type === "tool-call")).toBeUndefined();
        // The top-level delta still flushed.
        const part = messages[1]?.parts[0];
        if (part?.type === "text") expect(part.text).toBe("top-level ");
    });

    test("clone-on-receive: mutating the emitted data object after emit does not corrupt the store", async () => {
        // Assigned inside `drive` (below) so the post-emit mutation sees the same reference the store copied.
        let planData: Record<string, unknown> = {};
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            planData = { planId: "plan-x", title: "original", steps: [{ id: "s1", name: "step", agent: "a" }] };
            void emit({ type: "data-plan", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, data: planData });
            // The agent loop reuses+mutates emitted references; the store must already own a copy.
            planData.title = "MUTATED";
            (planData.steps as { name: string }[])[0]!.name = "MUTATED";
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const plan = findPart((p): p is PlanCardPart => p.type === "plan-card");
        expect(plan?.title).toBe("original");
        expect(plan?.steps[0]?.name).toBe("step");
    });

    test("aborted flushes what streamed, returns to idle, and sets no error", async () => {
        const seams = fakeSeams({ kind: "aborted" }, (emit) => {
            void emit({ type: "text-delta", text: "partial answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const part = messages[1]?.parts[0];
        if (part?.type === "text") expect(part.text).toBe("partial answer");
        expect(errorMsg()).toBeNull();
        expect(chatStatus()).toBe("idle");
    });

    test("failed surfaces an actionable error banner and error status", async () => {
        const seams = fakeSeams({ kind: "failed", cause: new Error("provider exploded") });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        expect(errorMsg()).toContain("provider exploded");
        expect(chatStatus()).toBe("error");
    });

    test("prepare_failed and thread_gone raise the error banner", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "prepare_failed", cause: new Error("pg down") }));
        expect(errorMsg()).toContain("pg down");
        expect(chatStatus()).toBe("error");

        resetHotState();
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "thread_gone" }));
        expect(errorMsg()).toContain("no longer available");
        expect(chatStatus()).toBe("error");
    });

    test("an appendError is surfaced non-fatally (turn still ok, no error banner)", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "done", appendError: { type: "mutation_failed", op: "appendTurn", cause: "x" } as never });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        // A save fault does not fail the turn: status is idle and the banner stays clear.
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();
    });
});

describe("applyEmitEvent outside a turn", () => {
    test("appends nothing when no assistant turn is active (defensive no-op)", () => {
        applyEmitEvent({ type: "tool-started", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t1", name: "x", input: {} });
        expect(messages.length).toBe(0);
    });
});

describe("send() turn-generation guard (C1)", () => {
    test("a superseded turn's outcome and late events never touch the new turn's state", async () => {
        // Send A: a slow engine that streams a delta, blocks until released (modelling the old turn
        // still unwinding when a swap lands), then emits a LATE delta before returning ok.
        let releaseA!: () => void;
        const aGate = new Promise<void>((r) => {
            releaseA = r;
        });
        const seamsA: SendSeams = {
            runtime: () => stubRuntime,
            runChatTurn: async (args: RunChatTurnArgs): Promise<TurnOutcome> => {
                void args.emit({ type: "text-delta", text: "A-partial" });
                await aGate;
                // Emitted AFTER supersession — must be dropped at the guarded sink.
                void args.emit({ type: "text-delta", text: "A-late" });
                return { kind: "ok", fallbackText: "A-done" };
            },
        };
        const aPromise = send({ sessionId: SID, analysisId: AID, userText: "A" }, seamsA);

        // A session swap supersedes A mid-flight (resetHotState nulls the token).
        resetHotState();

        // Send B runs to completion in the new session and streams its own answer.
        const seamsB = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "B-answer" });
        });
        await send({ sessionId: "s2", analysisId: "a2", userText: "B" }, seamsB);

        // B's finished state, snapshotted before A resolves.
        expect(messages.length).toBe(2);
        const bPart = messages[1]?.parts[0];
        expect(bPart?.type).toBe("text");
        if (bPart?.type === "text") expect(bPart.text).toBe("B-answer");
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();

        // A's stale outcome + late delta land last; neither may perturb B.
        releaseA();
        await aPromise;

        expect(messages.length).toBe(2);
        const bAfter = messages[1]?.parts[0];
        if (bAfter?.type === "text") expect(bAfter.text).toBe("B-answer");
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();
        expect(streamPartId()).toBeNull();
        expect(streamText()).toBe("");
    });
});

describe("send() turn cleanup (W1/W2/S1)", () => {
    test("aborting with an open tool resolves the chip to a terminal state (W1)", async () => {
        const seams = fakeSeams({ kind: "aborted" }, (emit) => {
            // A tool-started with no matching tool-finished — still running when the turn aborts.
            void emit({ type: "tool-started", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t1", name: "read_file", input: {} });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        const tool = findPart((p): p is ToolCallPart => p.type === "tool-call");
        expect(tool).toBeDefined();
        // Drained to a terminal state — never left `running` at idle.
        expect(tool?.status).toBe("error");
        expect(chatStatus()).toBe("idle");
    });

    test("the assistant turn is stamped with a duration on ok (W2)", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "ok", fallbackText: "hi" }));
        expect(messages[1]?.role).toBe("assistant");
        expect(typeof messages[1]?.durationMs).toBe("number");
        expect(messages[1]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("a pre-run failure pops the empty assistant bubble (S1)", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "prepare_failed", cause: new Error("pg down") }));
        // Only the user message remains — the empty assistant bubble was removed.
        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");
        expect(errorMsg()).toContain("pg down");

        resetHotState();
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "thread_gone" }));
        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");
    });
});

describe("loadMessages staleness guard (W3)", () => {
    // A full MessagePage (single turn, no rows — the toCortex fakes ignore the rows entirely).
    const emptyPage = (total: number): MessagePage => ({ messages: [], total, page: 0, perPage: 200, hasMore: false });
    // One assistant text message, shaped enough for cortexToUiMessage to read role/id/parts.
    const cortexText = (id: string, text: string): CortexMsg[] => [{ id, role: "assistant", parts: [{ type: "text", text }] }] as unknown as CortexMsg[];

    test("an older load that lands LAST does not clobber the newer load", async () => {
        // The OLDER load (load 1) blocks at its page read until released; the NEWER load (load 2)
        // starts after it and completes first. When load 1 finally resolves it must detect the newer
        // generation and drop, leaving load 2's transcript in the store.
        let releaseOld!: () => void;
        const oldGate = new Promise<void>((r) => {
            releaseOld = r;
        });
        const oldSeams: LoadSeams = {
            runtime: () => stubRuntime,
            loadPage: () => ResultAsync.fromSafePromise(oldGate.then(() => emptyPage(1))),
            toCortex: async () => cortexText("old", "old-msg"),
        };
        const newSeams: LoadSeams = {
            runtime: () => stubRuntime,
            loadPage: () => okAsync(emptyPage(1)),
            toCortex: async () => cortexText("new", "new-msg"),
        };

        const oldLoad = loadMessages(SID, AID, oldSeams); // blocks on oldGate at its page read
        await loadMessages(SID, AID, newSeams); // starts later, completes first

        const afterNew = messages[0]?.parts[0];
        expect(afterNew?.type).toBe("text");
        if (afterNew?.type === "text") expect(afterNew.text).toBe("new-msg");

        releaseOld();
        await oldLoad;

        // The older load resolved last but was dropped — the store still shows the newer transcript.
        expect(messages.length).toBe(1);
        const final = messages[0]?.parts[0];
        if (final?.type === "text") expect(final.text).toBe("new-msg");
    });
});
