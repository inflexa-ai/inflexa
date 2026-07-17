import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { okAsync, ResultAsync } from "neverthrow";
import type { MessagePage } from "@inflexa-ai/harness";

import {
    applyEmitEvent,
    type CortexMsg,
    cortexToUiMessage,
    errorMsg,
    lastTurnFailure,
    loadMessages,
    type LoadSeams,
    messages,
    resetHotState,
    send,
    streamPartId,
    streamText,
    turnFailureMessage,
    type SendSeams,
} from "./conversation.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { chatStatus } from "./status.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { RunChatTurnArgs, TurnOutcome } from "../../modules/harness/turn.ts";
import type { Part, PlanCardPart, RunCardPart, ToolCallPart } from "../../types/session.ts";

// The conversation state is a module singleton (one chat screen at a time), so reset it between
// cases. resetHotState() clears messages/stream/error/adapter state and returns status to idle.
const SID = "s1";
const AID = "a1";

// A stub runtime whose pool/provider are never dereferenced: the fake engine drives the adapter and
// returns an outcome without touching them. The chat path reads the CONVERSATION agent's provider, and
// `createStreamingChat` reads `provider.capabilities` at construction, so that one field is present;
// everything else is unused infrastructure.
const stubRuntime = {
    pool: {},
    conversation: { provider: { capabilities: { toolCalling: true } } },
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

    test("an unpaired tool-finished appends a finished part (no prior tool-started)", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            // No tool-started for this id — the finish must still render as a finished chip via the
            // fallback append path in updateToolPart, not vanish.
            void emit({ type: "tool-finished", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "orphan", name: "grep", isError: false });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const tool = findPart((p): p is ToolCallPart => p.type === "tool-call");
        expect(tool?.name).toBe("grep");
        expect(tool?.status).toBe("ok");
        // No matching tool-started → no start timestamp, so the duration is honestly unknown.
        expect(tool?.durationMs).toBeUndefined();
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
        expect(plan?.steps[0]?.id).toBe("s1");
        expect(plan?.steps[0]?.name).toBe("QC");
        expect(plan?.steps[0]?.agent).toBe("prep");
        expect(plan?.steps[0]?.depends_on).toEqual([]);
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
            // A `data-*` type the store has no first-class renderer for still surfaces as a tag.
            void emit({ type: "data-widget", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, data: {} } as never);
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const mention = findPart((p): p is Part & { type: "text" } => p.type === "text" && "text" in p && p.text.includes("[part:data-widget]"));
        expect(mention).toBeDefined();
    });

    test("data-presentation (markdown) becomes an inline presentation part", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({
                type: "data-presentation",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { id: "pres-1", title: "Finding", content: { kind: "markdown", body: "**TP53** up" } },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const pres = findPart((p): p is Extract<Part, { type: "presentation" }> => p.type === "presentation");
        expect(pres?.title).toBe("Finding");
        expect(pres?.body).toEqual({ kind: "markdown", body: "**TP53** up" });
    });

    test("data-presentation (echart) becomes an openable card carrying the spec + analysis scope", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({
                type: "data-presentation",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { id: "pres-chart", title: "Volcano", content: { kind: "echart", spec: { series: [{ type: "scatter" }] }, dataPath: "runs/r/out.csv" } },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const card = findPart((p): p is Extract<Part, { type: "openable-card" }> => p.type === "openable-card");
        expect(card?.analysisId).toBe(AID);
        const target = card?.entries[0]?.target;
        expect(target?.kind).toBe("echart");
        if (target?.kind === "echart") {
            expect(target.presId).toBe("pres-chart");
            expect(target.dataPath).toBe("runs/r/out.csv");
            expect(target.spec).toEqual({ series: [{ type: "scatter" }] });
        }
    });

    test("data-file-reference becomes an openable gallery card with a folder for multiple files", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({
                type: "data-file-reference",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { id: "pres-g", title: "Figures", files: [{ path: "runs/r/figures/a.png" }, { path: "runs/r/figures/b.png", caption: "heatmap" }] },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const card = findPart((p): p is Extract<Part, { type: "openable-card" }> => p.type === "openable-card");
        expect(card?.entries.length).toBe(2);
        expect(card?.entries[0]?.name).toBe("a.png");
        expect(card?.entries[1]?.caption).toBe("heatmap");
        expect(card?.folderPath).toBe("runs/r/figures");
    });

    test("data-report-preview-failed becomes a degraded openable card naming the reason", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({
                type: "data-report-preview-failed",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { id: "x", previewId: "p", version: 2, reason: "render timed out" },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const card = findPart((p): p is Extract<Part, { type: "openable-card" }> => p.type === "openable-card");
        const target = card?.entries[0]?.target;
        expect(target?.kind).toBe("unavailable");
        if (target?.kind === "unavailable") expect(target.reason).toBe("render timed out");
    });

    test("copy-on-receive: mutating an emitted echart spec after emit does not corrupt the store", async () => {
        let spec: Record<string, unknown> = {};
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            spec = { series: [{ type: "bar" }] };
            void emit({
                type: "data-presentation",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { id: "pres-m", content: { kind: "echart", spec } },
            });
            (spec.series as { type: string }[])[0]!.type = "MUTATED";
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);
        const card = findPart((p): p is Extract<Part, { type: "openable-card" }> => p.type === "openable-card");
        const target = card?.entries[0]?.target;
        if (target?.kind === "echart") expect(target.spec).toEqual({ series: [{ type: "bar" }] });
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

    test("a structured object cause renders its discriminant (not [object Object]) and is retained", async () => {
        const cause = { type: "provider", retryable: true, message: "rate limited" };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "failed", cause }));
        // The banner names the discriminant + message via describeCause — never the [object Object] hole.
        expect(errorMsg()).toContain("provider: rate limited");
        expect(errorMsg()).not.toContain("[object Object]");
        // The raw cause is retained verbatim for the details dialog.
        expect(lastTurnFailure()).toBe(cause);
    });

    test("a new send clears the retained failure", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "failed", cause: { type: "provider", message: "boom" } }));
        expect(lastTurnFailure()).not.toBeNull();
        // The next send resets hot error state before running — the stale failure must not linger.
        await send({ sessionId: SID, analysisId: AID, userText: "again" }, fakeSeams({ kind: "ok", fallbackText: "hi" }));
        expect(lastTurnFailure()).toBeNull();
        expect(errorMsg()).toBeNull();
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

describe("send() interleaves mid-turn prose and non-text parts in emission order", () => {
    // The assistant turn's parts, in mounted order, with each part's kind + text for text parts.
    function assistantParts(): { type: string; text?: string }[] {
        const parts = messages[1]?.parts ?? [];
        return parts.map((p) => (p.type === "text" ? { type: p.type, text: p.text } : { type: p.type }));
    }

    test("text -> tool -> text renders three parts in order [text][tool][text]", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "Reading the schema. " });
            void emit({ type: "tool-started", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t1", name: "read_file", input: {} });
            void emit({ type: "tool-finished", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "t1", name: "read_file", isError: false });
            void emit({ type: "text-delta", text: "It carries a slug column." });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        expect(assistantParts()).toEqual([
            { type: "text", text: "Reading the schema. " },
            { type: "tool-call" },
            { type: "text", text: "It carries a slug column." },
        ]);
    });

    test("text -> plan-card with no trailing prose renders [text][plan-card] and no empty part", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "Here is the plan." });
            void emit({
                type: "data-plan",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { planId: "plan-1", title: "DE analysis", steps: [{ id: "s1", name: "QC", agent: "prep" }] },
            });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        // Exactly two parts, in order — the card sits AFTER the prose, and nothing minted a trailing
        // empty text part for the (absent) post-card prose.
        expect(assistantParts()).toEqual([{ type: "text", text: "Here is the plan." }, { type: "plan-card" }]);
    });

    test("deltas after a card flow into a NEW text part, not the pre-card one", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "before" });
            void emit({
                type: "data-plan",
                source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                data: { planId: "plan-1", title: "t", steps: [] },
            });
            void emit({ type: "text-delta", text: "after" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        const textParts = (messages[1]?.parts ?? []).filter((p): p is Part & { type: "text" } => p.type === "text");
        // Two DISTINCT text parts — the pre-card prose and the post-card prose never merged.
        expect(textParts.map((p) => p.text)).toEqual(["before", "after"]);
        expect(textParts[0]?.id).not.toBe(textParts[1]?.id);
        expect(assistantParts()).toEqual([{ type: "text", text: "before" }, { type: "plan-card" }, { type: "text", text: "after" }]);
    });
});

describe("send() turn-generation guard", () => {
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

describe("send() turn cleanup", () => {
    test("aborting with an open tool resolves the chip to a terminal state", async () => {
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

    test("the assistant turn is stamped with a duration on ok", async () => {
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "ok", fallbackText: "hi" }));
        expect(messages[1]?.role).toBe("assistant");
        expect(typeof messages[1]?.durationMs).toBe("number");
        expect(messages[1]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("a pre-run failure pops the empty assistant bubble", async () => {
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

describe("loadMessages windows the newest turns past one page", () => {
    // A faithful page-slicing fake: the fixture is N single-message turns (turn t -> message "m<t>"),
    // and loadPage slices whole turns by page/perPage exactly as the harness does — so the test drives
    // the real concatenate-last-two-pages + trailing message cap, not a blind stub that ignores `page`.
    // The page indices fetched are recorded so a test can assert page 0 is never re-read redundantly.
    type Row = { seq: number; role: "user" | "assistant"; text: string };

    function turns(n: number): Row[][] {
        const out: Row[][] = [];
        for (let t = 0; t < n; t++) out.push([{ seq: t, role: t % 2 === 0 ? "user" : "assistant", text: `m${t}` }]);
        return out;
    }

    function pagingSeams(fixture: Row[][]): LoadSeams & { fetched: () => number[] } {
        const fetched: number[] = [];
        return {
            runtime: () => stubRuntime,
            loadPage: (_pool, _threadId, page, perPage) => {
                fetched.push(page);
                const safePerPage = Math.min(Math.max(perPage, 1), 200);
                const safePage = Math.max(page, 0);
                const offset = safePage * safePerPage;
                const pageTurns = fixture.slice(offset, offset + safePerPage);
                const result: MessagePage = {
                    messages: pageTurns.flat() as unknown as MessagePage["messages"],
                    total: fixture.length,
                    page: safePage,
                    perPage: safePerPage,
                    hasMore: offset + pageTurns.length < fixture.length,
                };
                return okAsync(result);
            },
            // Faithful reconstruction: each stored row (a fixture Row, cast through the StoredMessage
            // seam type) becomes one CortexMsg carrying its text, so the trailing message cap is exercised.
            toCortex: async (_pool, _analysisId, rows) =>
                (rows as unknown as Row[]).map((r) => ({ id: `id-${r.seq}`, role: r.role, parts: [{ type: "text", text: r.text }] })) as unknown as CortexMsg[],
            fetched: () => fetched,
        };
    }

    function textAt(i: number): string | undefined {
        const p = messages[i]?.parts[0];
        return p?.type === "text" ? p.text : undefined;
    }

    test("exactly 200 turns mount as one page (no second fetch)", async () => {
        const seams = pagingSeams(turns(200));
        await loadMessages(SID, AID, seams);
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m0");
        expect(textAt(199)).toBe("m199");
        // One page holds the whole thread — the last-two-pages branch never runs.
        expect(seams.fetched()).toEqual([0]);
    });

    test("201 turns mount the newest 200 messages, NOT the boundary remainder", async () => {
        const seams = pagingSeams(turns(201));
        await loadMessages(SID, AID, seams);
        // A page-aligned fetch of only the LAST page would collapse this thread to total mod 200 = 1
        // message; the window must hold the newest 200 messages (turns 1..200), dropping only the oldest.
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m1");
        expect(textAt(199)).toBe("m200");
    });

    test("250 turns mount the newest 200 messages across the last two pages", async () => {
        const seams = pagingSeams(turns(250));
        await loadMessages(SID, AID, seams);
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m50");
        expect(textAt(199)).toBe("m249");
    });

    test("a total divisible by the page size reuses page 0 without re-fetching it", async () => {
        const seams = pagingSeams(turns(400));
        await loadMessages(SID, AID, seams);
        expect(messages.length).toBe(200);
        expect(textAt(0)).toBe("m200");
        expect(textAt(199)).toBe("m399");
        // Window pages are [0, 1]: page 0 is already in hand from the total probe, so it is reused —
        // exactly two loadPage calls, page 0 never read twice.
        expect(seams.fetched()).toEqual([0, 1]);
    });
});

describe("loadMessages staleness guard", () => {
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

// One generation token orders BOTH store writers. `Chat` fires `loadMessages` the instant boot reaches
// `ready` — the same instant `handleSubmit`'s gate opens — so a message pre-typed during the boot
// animation is submitted while that load is still awaiting Postgres. A turn must supersede a load.
describe("a turn supersedes a transcript load in flight", () => {
    const emptyPage = (total: number): MessagePage => ({ messages: [], total, page: 0, perPage: 200, hasMore: false });
    const cortexText = (id: string, text: string): CortexMsg[] => [{ id, role: "assistant", parts: [{ type: "text", text }] }] as unknown as CortexMsg[];

    /** Load seams whose page read parks until the returned release is called. */
    function gatedLoadSeams(): { seams: LoadSeams; release: () => void } {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        return {
            seams: {
                runtime: () => stubRuntime,
                loadPage: () => ResultAsync.fromSafePromise(gate.then(() => emptyPage(1))),
                toCortex: async () => cortexText("stale", "stale-transcript"),
            },
            release: () => release(),
        };
    }

    test("a load resolving mid-send does not wipe the user message or the in-flight turn", async () => {
        const { seams: loadSeams, release } = gatedLoadSeams();
        const load = loadMessages(SID, AID, loadSeams); // parks on its page read

        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "live answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        expect(messages.length).toBe(2);

        release();
        await load;

        // The load was superseded by the turn and dropped: user + assistant survive, and the assistant
        // still carries the streamed text (a wipe would have stranded `currentAssistantId` off-store).
        expect(messages.length).toBe(2);
        expect(messages[0]?.role).toBe("user");
        expect(messages[1]?.role).toBe("assistant");
        const answer = messages[1]?.parts.find((p) => p.type === "text");
        expect(answer?.type === "text" ? answer.text : undefined).toBe("live answer");
    });

    test("parts emitted after the superseded load resolves still reach the assistant message", async () => {
        const { seams: loadSeams, release } = gatedLoadSeams();
        const load = loadMessages(SID, AID, loadSeams);

        // Release the load mid-turn: its trailing write must not land, so the adapter's later parts
        // still find the assistant message they were minted against.
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "before" });
            release();
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);
        await load;

        expect(messages.length).toBe(2);
        const answer = messages[1]?.parts.find((p) => p.type === "text");
        expect(answer?.type === "text" ? answer.text : undefined).toBe("before");
    });

    test("resetHotState drops a load already in flight for the swapped-away session", async () => {
        const { seams: loadSeams, release } = gatedLoadSeams();
        const load = loadMessages(SID, AID, loadSeams);

        resetHotState();
        release();
        await load;

        // The cleared store stays cleared — the old session's transcript never repopulates it.
        expect(messages.length).toBe(0);
    });
});

// `commitStream` writes into the part `streamPartId` names and no-ops when it is null. Any mid-turn
// seal (tool chip, plan card, run card) nulls it, so without the ok-fallback re-opening a segment, a
// delta-less final answer would sit in `streamText` and never render.
describe("a delta-less final segment renders after a mid-turn part", () => {
    test("deltas -> tool -> no further deltas: the fallback renders as a trailing part", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "THE FINAL ANSWER" }, (emit) => {
            void emit({ type: "text-delta", text: "thinking..." });
            void emit({ type: "tool-started", toolUseId: "t1", name: "read_file" } as never);
            void emit({ type: "tool-finished", toolUseId: "t1", name: "read_file", isError: false } as never);
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        // Emission order: the streamed prose, the tool chip it preceded, then the fallback BELOW it —
        // exactly what a transcript reload renders.
        const kinds = messages[1]?.parts.map((p) => p.type);
        expect(kinds).toEqual(["text", "tool-call", "text"]);
        const trailing = messages[1]?.parts[2];
        expect(trailing?.type === "text" ? trailing.text : undefined).toBe("THE FINAL ANSWER");
    });

    test("deltas -> plan card -> no further deltas: the fallback renders below the card", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "here is the plan" }, (emit) => {
            void emit({ type: "text-delta", text: "drafting" });
            void emit({ type: "data-plan", data: { planId: "p1", title: "T", steps: [] } } as never);
        });
        await send({ sessionId: SID, analysisId: AID, userText: "plan it" }, seams);

        const kinds = messages[1]?.parts.map((p) => p.type);
        expect(kinds).toEqual(["text", "plan-card", "text"]);
    });

    test("a streamed final answer is not duplicated by the fallback", async () => {
        // The buffer is non-empty at completion, so the final assistant text DID stream — rendering
        // `fallbackText` on top of it would print the answer twice. The turn's FIRST event is a tool
        // (the common bare-tool_use first iteration), so the prose must render BELOW the chip.
        const seams = fakeSeams({ kind: "ok", fallbackText: "streamed answer" }, (emit) => {
            void emit({ type: "tool-started", toolUseId: "t1", name: "read_file" } as never);
            void emit({ type: "tool-finished", toolUseId: "t1", name: "read_file", isError: false } as never);
            void emit({ type: "text-delta", text: "streamed answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        const texts = messages[1]?.parts.filter((p) => p.type === "text") ?? [];
        expect(texts.length).toBe(1);
        expect(texts[0]?.type === "text" ? texts[0].text : undefined).toBe("streamed answer");
        // Part ORDER is [tool][text]: the pre-minted empty part[0] was dropped when the tool arrived
        // first, so the prose opened a fresh segment BELOW the chip — matching a transcript reload,
        // never the pre-fix inversion where part[0] stranded the prose above the tool.
        const kinds = messages[1]?.parts.map((p) => p.type);
        expect(kinds).toEqual(["tool-call", "text"]);
    });

    test("tool-first with the answer only as fallback: prose renders below the tool, not above it", async () => {
        // The turn's first event is a tool and the final answer never streams — it arrives only as
        // `fallbackText`. Pre-fix, `streamPartId` still named the pre-minted part[0] ahead of the tool,
        // so the fallback landed above the chip; the drop-empty fix reopens a fresh segment after it.
        const seams = fakeSeams({ kind: "ok", fallbackText: "the answer" }, (emit) => {
            void emit({ type: "tool-started", toolUseId: "t1", name: "read_file" } as never);
            void emit({ type: "tool-finished", toolUseId: "t1", name: "read_file", isError: false } as never);
        });
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        const kinds = messages[1]?.parts.map((p) => p.type);
        expect(kinds).toEqual(["tool-call", "text"]);
        const trailing = messages[1]?.parts[1];
        expect(trailing?.type === "text" ? trailing.text : undefined).toBe("the answer");
    });

    test("a turn ending on a card with no fallback leaves no trailing empty part", async () => {
        const seams = fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => {
            void emit({ type: "text-delta", text: "drafting" });
            void emit({ type: "data-plan", data: { planId: "p1", title: "T", steps: [] } } as never);
        });
        await send({ sessionId: SID, analysisId: AID, userText: "plan it" }, seams);

        const kinds = messages[1]?.parts.map((p) => p.type);
        expect(kinds).toEqual(["text", "plan-card"]);
    });
});

describe("MESSAGE_CAP is coupled to loadPage's perPage clamp", () => {
    test("the mounted window never exceeds the harness's 200-turn page clamp", async () => {
        // `loadPage` clamps `perPage` to 200 (harness/src/memory/thread-history.ts). MESSAGE_CAP doubles
        // as that `perPage`, so a value above 200 would silently strand every turn past the clamp on each
        // page — `loadMessages` would mount a window missing the thread's tail rather than error. There is
        // no compile-time guard for the coupling, so pin it here.
        const seams: LoadSeams & { perPage: () => number } = {
            runtime: () => stubRuntime,
            loadPage: (_pool, _threadId, _page, perPage) => {
                seen = perPage;
                return okAsync({ messages: [], total: 0, page: 0, perPage, hasMore: false } as MessagePage);
            },
            toCortex: async () => [],
            perPage: () => seen,
        };
        let seen = 0;
        await loadMessages(SID, AID, seams);
        expect(seams.perPage()).toBeLessThanOrEqual(200);
        expect(seams.perPage()).toBeGreaterThan(0);
    });
});

// The whole live/reload contract as ONE harness: the same turn fed through the live adapter (`send` →
// `applyEmitEvent`) and through the reload path (`cortexToUiMessage` over the rows the harness would
// reconstruct, in stored order) must yield the SAME part-type sequence. `content-to-cortex` preserves
// row order, so a turn whose first event is a tool/card must render that part first LIVE too — the
// emission-order invariant these findings restore. The pre-fix bug inverted the tool-first shapes live
// while reload kept row order; here both paths are asserted to agree.
describe("live emission order matches transcript reload order", () => {
    type Shape = {
        readonly name: string;
        readonly drive: (emit: RunChatTurnArgs["emit"]) => void;
        readonly fallbackText: string;
        /** The turn as the harness reconstructs it from persisted rows, in stored order. */
        readonly reloadParts: readonly { type: "text" | "tool-call"; text?: string; toolName?: string }[];
    };

    const shapes: Shape[] = [
        {
            name: "tool-first, answer streamed",
            drive: (emit) => {
                void emit({ type: "tool-started", toolUseId: "t1", name: "read_file" } as never);
                void emit({ type: "tool-finished", toolUseId: "t1", name: "read_file", isError: false } as never);
                void emit({ type: "text-delta", text: "answer" });
            },
            fallbackText: "answer",
            reloadParts: [
                { type: "tool-call", toolName: "read_file" },
                { type: "text", text: "answer" },
            ],
        },
        {
            name: "tool-first, answer only as fallback",
            drive: (emit) => {
                void emit({ type: "tool-started", toolUseId: "t1", name: "read_file" } as never);
                void emit({ type: "tool-finished", toolUseId: "t1", name: "read_file", isError: false } as never);
            },
            fallbackText: "final",
            reloadParts: [
                { type: "tool-call", toolName: "read_file" },
                { type: "text", text: "final" },
            ],
        },
        {
            name: "text, tool, text",
            drive: (emit) => {
                void emit({ type: "text-delta", text: "before " });
                void emit({ type: "tool-started", toolUseId: "t1", name: "read_file" } as never);
                void emit({ type: "tool-finished", toolUseId: "t1", name: "read_file", isError: false } as never);
                void emit({ type: "text-delta", text: "after" });
            },
            fallbackText: "after",
            reloadParts: [
                { type: "text", text: "before " },
                { type: "tool-call", toolName: "read_file" },
                { type: "text", text: "after" },
            ],
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
            await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeSeams({ kind: "ok", fallbackText: shape.fallbackText }, shape.drive));
            const liveKinds = (messages[1]?.parts ?? []).map((p) => p.type);

            const reloaded = cortexToUiMessage(
                {
                    id: "m1",
                    role: "assistant",
                    parts: shape.reloadParts.map((p) =>
                        p.type === "tool-call" ? { type: "tool-call", toolCallId: "t1", toolName: p.toolName } : { type: "text", text: p.text },
                    ),
                } as unknown as CortexMsg,
                SID,
            );
            const reloadKinds = reloaded.parts.map((p) => p.type);

            expect(liveKinds).toEqual(reloadKinds);
            expect(liveKinds).toEqual(shape.reloadParts.map((p) => p.type));
        });
    }
});

// A load fired at the boot-ready edge and superseded by that same edge's submit: pre-fix the dropped
// load's history never remounted until a manual session swap. `send` re-fires the load after the turn;
// the pg thread now carries the appended turn, so the reload is convergent — history + the turn mount.
describe("a superseded initial load is retried after the turn finishes", () => {
    const emptyPage = (total: number): MessagePage => ({ messages: [], total, page: 0, perPage: 200, hasMore: false });

    test("history mounts once the boot-edge turn completes", async () => {
        // The initial (boot-edge) load parks on its page read; the submit below supersedes and drops it.
        let releaseInitial!: () => void;
        const initialGate = new Promise<void>((r) => {
            releaseInitial = r;
        });
        const initialLoad: LoadSeams = {
            runtime: () => stubRuntime,
            loadPage: () => ResultAsync.fromSafePromise(initialGate.then(() => emptyPage(1))),
            toCortex: async () => [{ id: "old", role: "assistant", parts: [{ type: "text", text: "never-mounted" }] }] as unknown as CortexMsg[],
        };

        // The post-turn reload seams: the pg thread now holds the prior history AND the just-finished
        // turn (what appendTurn wrote), so the convergent reconstruction carries all three messages.
        const reloadSeams: LoadSeams = {
            runtime: () => stubRuntime,
            loadPage: () => okAsync(emptyPage(3)),
            toCortex: async () =>
                [
                    { id: "h1", role: "assistant", parts: [{ type: "text", text: "prior history" }] },
                    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
                    { id: "a1", role: "assistant", parts: [{ type: "text", text: "live answer" }] },
                ] as unknown as CortexMsg[],
        };

        const load = loadMessages(SID, AID, initialLoad); // parks — the submit below supersedes it

        const seams: SendSeams = {
            runtime: () => stubRuntime,
            runChatTurn: async (args: RunChatTurnArgs): Promise<TurnOutcome> => {
                void args.emit({ type: "text-delta", text: "live answer" });
                return { kind: "ok", fallbackText: "" };
            },
            reloadTranscript: (sid, aid) => loadMessages(sid, aid, reloadSeams),
        };
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        // The convergent reload fired and mounted the prior history the dropped load never showed.
        expect(messages.length).toBe(3);
        const first = messages[0]?.parts[0];
        expect(first?.type === "text" ? first.text : undefined).toBe("prior history");

        releaseInitial();
        await load; // the dropped initial load resolves and no-ops (its generation is stale)

        // Still the convergent transcript — the stale load did not clobber it.
        expect(messages.length).toBe(3);
        const stillFirst = messages[0]?.parts[0];
        expect(stillFirst?.type === "text" ? stillFirst.text : undefined).toBe("prior history");
    });

    test("no reload when a load already mounted the session's history", async () => {
        // A completed load records the session; a subsequent turn must NOT re-fire the reload — the
        // history is already on screen, and the reload replaces the store wholesale.
        const completedLoad: LoadSeams = {
            runtime: () => stubRuntime,
            loadPage: () => okAsync(emptyPage(1)),
            toCortex: async () => [{ id: "h1", role: "assistant", parts: [{ type: "text", text: "history" }] }] as unknown as CortexMsg[],
        };
        await loadMessages(SID, AID, completedLoad);
        expect(messages.length).toBe(1);

        let reloadFired = false;
        const seams: SendSeams = {
            runtime: () => stubRuntime,
            runChatTurn: async (): Promise<TurnOutcome> => ({ kind: "ok", fallbackText: "done" }),
            reloadTranscript: async () => {
                reloadFired = true;
            },
        };
        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        // The turn appended to the mounted store (history + user + assistant); the reload was skipped.
        expect(reloadFired).toBe(false);
        expect(messages.length).toBe(3);
    });
});

describe("send() closes the emit sink at turn completion", () => {
    test("an event emitted after the turn settles is dropped, not applied to the finished message", async () => {
        // Capture the turn's emit fn so a late event can fire AFTER send resolves — modelling a tool
        // that ignored its abort signal and emits past the outcome. The supersession guard would not
        // catch it (this turn was never superseded); the closed sink must.
        let lateEmit!: RunChatTurnArgs["emit"];
        const seams = fakeSeams({ kind: "ok", fallbackText: "done" }, (emit) => {
            lateEmit = emit;
            void emit({ type: "text-delta", text: "answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        const partsBefore = messages[1]?.parts.length ?? 0;
        void lateEmit({ type: "tool-started", source: { agentId: "tui-chat", callPath: ["tui-chat"] }, toolUseId: "late", name: "read_file", input: {} });

        // The closed sink dropped the straggler: no new tool chip, the finished message is untouched.
        expect(messages[1]?.parts.length).toBe(partsBefore);
        expect(findPart((p): p is ToolCallPart => p.type === "tool-call")).toBeUndefined();
    });
});

// The chat-view contract: a display card emitted live and the same card reconstructed on reload (via
// `cortexToUiMessage` over the flat parts the harness rebuilds) must yield the SAME UI part — the shared
// builders read through the same `artifact_open` readers on both paths.
describe("display-card parts map identically live and on reload", () => {
    const TOP = { agentId: "tui-chat", callPath: ["tui-chat"] };

    test("a markdown presentation maps to the same inline part in both paths", async () => {
        const data = { id: "pres-1", title: "Finding", content: { kind: "markdown", body: "**TP53** up" } };
        await send(
            { sessionId: SID, analysisId: AID, userText: "?" },
            fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => void emit({ type: "data-presentation", source: TOP, data })),
        );
        const live = messages[1]?.parts.find((p) => p.type === "presentation");

        const reloaded = cortexToUiMessage({ id: "m1", role: "assistant", parts: [{ type: "data-presentation", ...data }] } as unknown as CortexMsg, SID, AID);
        const reloadedPart = reloaded.parts.find((p) => p.type === "presentation");

        expect(live?.type === "presentation" ? live.body : null).toEqual({ kind: "markdown", body: "**TP53** up" });
        expect(reloadedPart?.type === "presentation" ? reloadedPart.body : null).toEqual({ kind: "markdown", body: "**TP53** up" });
    });

    test("a file-reference gallery maps to the same openable card in both paths", async () => {
        const data = { id: "pres-g", title: "Figures", files: [{ path: "runs/r/a.png" }, { path: "runs/r/b.png", caption: "heatmap" }] };
        await send(
            { sessionId: SID, analysisId: AID, userText: "?" },
            fakeSeams({ kind: "ok", fallbackText: "" }, (emit) => void emit({ type: "data-file-reference", source: TOP, data })),
        );
        const live = messages[1]?.parts.find((p) => p.type === "openable-card");

        const reloaded = cortexToUiMessage(
            { id: "m1", role: "assistant", parts: [{ type: "data-file-reference", ...data }] } as unknown as CortexMsg,
            SID,
            AID,
        );
        const reloadedPart = reloaded.parts.find((p) => p.type === "openable-card");

        expect(live?.type === "openable-card" ? live.entries.length : 0).toBe(2);
        expect(reloadedPart?.type === "openable-card" ? reloadedPart.entries.length : 0).toBe(2);
        expect(reloadedPart?.type === "openable-card" ? reloadedPart.analysisId : null).toBe(AID);
        expect(reloadedPart?.type === "openable-card" ? reloadedPart.folderPath : null).toBe("runs/r");
    });

    test("an unknown reconstructed part still surfaces as a tagged mention on reload", () => {
        const reloaded = cortexToUiMessage({ id: "m1", role: "assistant", parts: [{ type: "data-widget" }] } as unknown as CortexMsg, SID, AID);
        const mention = reloaded.parts.find((p) => p.type === "text" && "text" in p && p.text.includes("[part:data-widget]"));
        expect(mention).toBeDefined();
    });
});

// turnFailureMessage resolves the connection from config, so these seed the SANDBOXED env.configPath
// (guarded like setup.test.ts's config-write tests) and exercise the pure message mapping directly.
describe("turnFailureMessage", () => {
    // The exact harness ProviderError auth shape as the turn engine surfaces it.
    const authCause = { type: "auth", retryable: false, message: "Provider rejected the credential for chat — it is expired, revoked, or absent" };

    beforeEach(() => {
        assertTestSandbox(env.configPath);
    });
    afterEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });

    function seedConfig(value: Record<string, unknown>): void {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify(value));
    }

    test("an auth failure on the default (cliproxy/anthropic) connection names the provider and the forced re-login", () => {
        const msg = turnFailureMessage(new Error("ResultError", { cause: authCause }));
        expect(msg).toContain("anthropic login has expired");
        expect(msg).toContain("inflexa setup --provider claude");
    });

    test("an auth failure in direct mode names the env key — a re-login cannot fix the user's own key", () => {
        // `telemetry` carries no zod default, so a seed without it fails the WHOLE config parse and
        // silently falls back to the default cliproxy connection — the exact miss this test exists to catch.
        seedConfig({ telemetry: false, models: { connection: { mode: "direct", provider: "openai", baseURL: "https://api.openai.com/v1" } } });
        const msg = turnFailureMessage(authCause);
        expect(msg).toContain("INFLEXA_MODEL_API_KEY");
        expect(msg).not.toContain("--provider");
    });

    test("a slug no login flow owns still names the provider, minus the re-login hint it cannot spell", () => {
        // `resolveModelConnection` guarantees a slug in both modes, so there is no slug-less banner to
        // test — only a slug whose account kind is unknown, reachable by hand-editing the config to a
        // vendor `inflexa setup` never logs into.
        seedConfig({ telemetry: false, models: { connection: { mode: "cliproxy", provider: "deepseek" } } });
        const msg = turnFailureMessage(authCause);
        expect(msg).toContain("Your deepseek login has expired");
        expect(msg).not.toContain("--provider");
    });

    test("a non-auth failure renders the generic cause line", () => {
        const msg = turnFailureMessage({ type: "provider", retryable: true, message: "rate limited" });
        expect(msg).toStartWith("The turn failed:");
        expect(msg).toContain("provider: rate limited");
    });

    test("a 401 whose auth value hides below the depth bound falls back to generic rendering rather than mislabeling", () => {
        let chain: unknown = authCause;
        for (let i = 0; i < 10; i++) chain = new Error(`wrapper-${i}`, { cause: chain });
        expect(turnFailureMessage(chain)).toStartWith("The turn failed:");
    });
});
