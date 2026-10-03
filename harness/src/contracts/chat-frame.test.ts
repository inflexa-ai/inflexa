import { describe, expect, test } from "bun:test";

import type { ChatDataPart, EmitEvent } from "../loop/types.js";
import type { ChatStreamEvent } from "../providers/types.js";
import { applyChatFrame, checkChatPart, toChatFrame } from "./chat-frame.js";
import type { ChatMessage } from "./message.js";

const fallback = { agentId: "conversation-agent", callPath: ["conversation-agent"] };
const topLevel = { agentId: "conversation-agent", callPath: ["conversation-agent"] };
const nested = { agentId: "literature-reviewer", callPath: ["conversation-agent", "literature-reviewer"] };

describe("toChatFrame", () => {
    test("gives no frame for an iteration of the root agent", () => {
        const ev: EmitEvent = { type: "iteration", source: topLevel, index: 0, final: false };
        expect(toChatFrame(ev, fallback)).toBeNull();
    });

    test("gives the frame of an iteration of a sub-agent, with its source only", () => {
        const ev: EmitEvent = { type: "iteration", source: nested, index: 2, final: false };
        expect(toChatFrame(ev, fallback)).toEqual({ type: "iteration", source: nested });
    });

    test("gives the frame of a top-level tool-started", () => {
        const ev: EmitEvent = { type: "tool-started", source: topLevel, toolUseId: "tu_1", name: "search_gene", input: {} };
        expect(toChatFrame(ev, fallback)).toEqual({
            type: "tool-started",
            toolUseId: "tu_1",
            name: "search_gene",
            source: { agentId: "conversation-agent", callPath: ["conversation-agent"] },
        });
    });

    test("gives a top-level tool-finished with its outcome", () => {
        const ev: EmitEvent = { type: "tool-finished", source: topLevel, toolUseId: "tu_1", name: "search_gene", outcome: "error" };
        expect(toChatFrame(ev, fallback)).toEqual({
            type: "tool-finished",
            toolUseId: "tu_1",
            name: "search_gene",
            outcome: "error",
            source: { agentId: "conversation-agent", callPath: ["conversation-agent"] },
        });
    });

    test("keeps the duration of a tool-finished", () => {
        const ev: EmitEvent = {
            type: "tool-finished",
            source: topLevel,
            toolUseId: "tu_1",
            name: "search_gene",
            outcome: "ok",
            detail: "TP53",
            durationMs: 420,
        };
        expect(toChatFrame(ev, fallback)).toEqual({
            type: "tool-finished",
            toolUseId: "tu_1",
            name: "search_gene",
            outcome: "ok",
            detail: "TP53",
            durationMs: 420,
            source: topLevel,
        });
    });

    test("keeps the tool events of a sub-agent with their source", () => {
        const started: EmitEvent = { type: "tool-started", source: nested, toolUseId: "tu_2", name: "search_pubmed", input: {} };
        const finished: EmitEvent = { type: "tool-finished", source: nested, toolUseId: "tu_2", name: "search_pubmed", outcome: "ok" };
        expect(toChatFrame(started, fallback)).toEqual({ type: "tool-started", toolUseId: "tu_2", name: "search_pubmed", source: nested });
        expect(toChatFrame(finished, fallback)).toEqual({ type: "tool-finished", toolUseId: "tu_2", name: "search_pubmed", outcome: "ok", source: nested });
    });

    test("gives a text-delta the fallback source", () => {
        const ev: ChatStreamEvent = { type: "text-delta", text: "hello" };
        expect(toChatFrame(ev, fallback)).toEqual({ type: "text-delta", text: "hello", source: fallback });
    });

    test("gives no frame for the provider done envelope", () => {
        const ev = { type: "done", message: {} } as unknown as ChatStreamEvent;
        expect(toChatFrame(ev, fallback)).toBeNull();
    });

    test("flattens a data part to the wire part shape", () => {
        const part: ChatDataPart = { type: "data-presentation", data: { id: "pres-abc", title: "A chart", content: { kind: "markdown" } } };
        expect(toChatFrame(part, fallback)).toEqual({ type: "data-presentation", id: "pres-abc", title: "A chart", content: { kind: "markdown" } });
    });

    test("keeps the source of a top-level data part", () => {
        const part: ChatDataPart = { type: "data-presentation", source: topLevel, data: { id: "pres-abc", content: { kind: "markdown" } } };
        expect(toChatFrame(part, fallback)).toEqual({ type: "data-presentation", id: "pres-abc", content: { kind: "markdown" }, source: topLevel });
    });

    test("keeps a data part of a sub-agent with its source", () => {
        const part: ChatDataPart = { type: "data-presentation", source: nested, data: { id: "pres-xyz", content: { kind: "markdown" } } };
        expect(toChatFrame(part, fallback)).toEqual({ type: "data-presentation", id: "pres-xyz", content: { kind: "markdown" }, source: nested });
    });

    test("gives a compaction part of the root loop flat", () => {
        const part: ChatDataPart = { type: "data-compaction", source: topLevel, data: { id: "c-1", status: "running", tokensBefore: 151_000 } };
        expect(toChatFrame(part, fallback)).toEqual({ type: "data-compaction", id: "c-1", status: "running", tokensBefore: 151_000, source: topLevel });
    });

    // A consumer that parses the wire rejects a wrapped `{ type, data: {...} }` payload.
    test("gives no frame with a `data` envelope", () => {
        const samples: Array<EmitEvent | ChatStreamEvent | ChatDataPart> = [
            { type: "tool-started", source: topLevel, toolUseId: "tu_1", name: "x", input: {} },
            { type: "tool-finished", source: topLevel, toolUseId: "tu_1", name: "x", outcome: "ok" },
            { type: "text-delta", text: "hi" },
            { type: "data-run-started", data: { runId: "r1", planSummary: "p", stepCount: 1 } },
        ];

        for (const s of samples) {
            const frame = toChatFrame(s, fallback);
            expect(frame).not.toBeNull();
            expect(frame).not.toHaveProperty("data");
        }
    });
});

const SOURCE = { agentId: "conversation-agent", callPath: ["conversation-agent"] };
const ASSISTANT_ID = "asst-1";

function applyMany(start: ChatMessage[], frames: Parameters<typeof applyChatFrame>[1][]) {
    let messages = start;
    let terminal: ReturnType<typeof applyChatFrame>["terminal"] = null;
    for (const f of frames) {
        const result = applyChatFrame(messages, f, ASSISTANT_ID);
        messages = result.messages;
        terminal = result.terminal;
    }
    return { messages, terminal };
}

describe("applyChatFrame", () => {
    test("merges sequential text-delta into one text part", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "text-delta", text: "a", source: SOURCE },
                { type: "text-delta", text: "b", source: SOURCE },
                { type: "text-delta", text: "c", source: SOURCE },
            ],
        );
        expect(messages).toHaveLength(1);
        const assistant = messages[0]!;
        expect(assistant.role).toBe("assistant");
        expect(assistant.parts).toHaveLength(1);
        expect(assistant.parts[0]).toEqual({ type: "text", text: "abc" });
    });

    test("collapses tool-started + tool-finished into one tool-call part", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "tool-started", toolUseId: "tu_1", name: "searchGene", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_1", name: "searchGene", outcome: "ok", source: SOURCE },
            ],
        );
        const parts = messages[0]!.parts;
        expect(parts).toHaveLength(1);
        expect(parts[0]).toEqual({
            type: "tool-call",
            toolCallId: "tu_1",
            toolName: "searchGene",
            outcome: "ok",
        });
    });

    test("stamps the duration of tool-finished on the tool-call part", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "tool-started", toolUseId: "tu_1", name: "searchGene", detail: "TP53", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_1", name: "searchGene", outcome: "ok", detail: "TP53", durationMs: 420, source: SOURCE },
            ],
        );
        expect(messages[0]!.parts).toEqual([{ type: "tool-call", toolCallId: "tu_1", toolName: "searchGene", outcome: "ok", detail: "TP53", durationMs: 420 }]);
    });

    test("a finish with no start appends the finished call", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "text-delta", text: "before", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_1", name: "searchGene", outcome: "error", detail: "TP53", durationMs: 9, source: SOURCE },
            ],
        );
        expect(messages[0]!.parts).toEqual([
            { type: "text", text: "before" },
            { type: "tool-call", toolCallId: "tu_1", toolName: "searchGene", outcome: "error", detail: "TP53", durationMs: 9 },
        ]);
    });

    test("an in-flight call carries no outcome until it finishes", () => {
        const { messages } = applyMany([], [{ type: "tool-started", toolUseId: "tu_1", name: "x", source: SOURCE }]);
        expect(messages[0]!.parts[0]).toEqual({
            type: "tool-call",
            toolCallId: "tu_1",
            toolName: "x",
        });
    });

    test("a denial is preserved as its own outcome, not as an error", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "tool-started", toolUseId: "tu_1", name: "x", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_1", name: "x", outcome: "denied", source: SOURCE },
            ],
        );
        expect(messages[0]!.parts[0]).toMatchObject({ outcome: "denied" });
    });

    test("preserves the outcome on tool-finished", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "tool-started", toolUseId: "tu_1", name: "x", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_1", name: "x", outcome: "error", source: SOURCE },
            ],
        );
        const part = messages[0]!.parts[0];
        expect(part).toMatchObject({ outcome: "error" });
    });

    test("two concurrent tools are tracked independently by toolUseId", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "tool-started", toolUseId: "tu_a", name: "x", source: SOURCE },
                { type: "tool-started", toolUseId: "tu_b", name: "y", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_a", name: "x", outcome: "ok", source: SOURCE },
                { type: "tool-finished", toolUseId: "tu_b", name: "y", outcome: "ok", source: SOURCE },
            ],
        );
        const parts = messages[0]!.parts;
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatchObject({ toolCallId: "tu_a", outcome: "ok" });
        expect(parts[1]).toMatchObject({ toolCallId: "tu_b", outcome: "ok" });
    });

    test("ignores each frame of a sub-agent", () => {
        const sub = { agentId: "literature-reviewer", callPath: ["conversation-agent", "literature-reviewer"] };
        const { messages, terminal } = applyMany(
            [],
            [
                { type: "tool-started", toolUseId: "tu_1", name: "literature_review", source: SOURCE },
                { type: "iteration", source: sub },
                { type: "tool-started", toolUseId: "tu_2", name: "search_pubmed", source: sub },
                { type: "tool-finished", toolUseId: "tu_2", name: "search_pubmed", outcome: "ok", source: sub },
                { type: "data-presentation", id: "hidden", content: { kind: "markdown", body: "child" }, source: sub },
                { type: "finish", source: sub },
            ],
        );
        expect(terminal).toBeNull();
        expect(messages[0]!.parts).toEqual([{ type: "tool-call", toolCallId: "tu_1", toolName: "literature_review" }]);
    });

    test("an iteration frame of the root agent makes no part", () => {
        const { messages, terminal } = applyMany([], [{ type: "iteration", source: SOURCE }]);
        expect(terminal).toBeNull();
        expect(messages).toEqual([]);
    });

    test("keeps the source of a data part frame out of the part", () => {
        const { messages } = applyMany([], [{ type: "data-presentation", id: "p1", content: { kind: "markdown", body: "card" }, source: SOURCE }]);
        expect(messages[0]!.parts).toEqual([{ type: "data-presentation", id: "p1", content: { kind: "markdown", body: "card" } }]);
    });

    test("appends a flat data-* part", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "text-delta", text: "thinking…", source: SOURCE },
                { type: "data-run-started", runId: "r1", planSummary: "p", stepCount: 1 },
            ],
        );
        const parts = messages[0]!.parts;
        expect(parts).toHaveLength(2);
        expect(parts[1]).toEqual({
            type: "data-run-started",
            runId: "r1",
            planSummary: "p",
            stepCount: 1,
        });
    });

    test('finish yields terminal="finish" without mutating messages', () => {
        const { messages, terminal } = applyMany(
            [],
            [
                { type: "text-delta", text: "ok", source: SOURCE },
                { type: "finish", source: SOURCE },
            ],
        );
        expect(terminal).toBe("finish");
        expect(messages[0]!.parts).toEqual([{ type: "text", text: "ok" }]);
        expect(messages[0]!.usage).toBeUndefined();
    });

    test("finish stamps the turn rollup on the assistant message", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "text-delta", text: "ok", source: SOURCE },
                {
                    type: "finish",
                    source: SOURCE,
                    turnUsage: { inputTokens: 12, outputTokens: 3 },
                },
            ],
        );
        expect(messages[0]!.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    });

    test("error yields terminal with the error frame", () => {
        const { terminal } = applyMany([], [{ type: "error", message: "boom", source: SOURCE }]);
        expect(terminal).toEqual({ error: { type: "error", message: "boom", source: SOURCE } });
    });

    test("a re-emitted ask replaces the pending one in place", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "data-ask", id: "ask-1", title: "Run a script", command: "Rscript de.R", status: "pending" },
                { type: "text-delta", text: "thinking", source: SOURCE },
                { type: "data-ask", id: "ask-1", title: "Run a script", command: "Rscript de.R", status: "resolved" },
            ],
        );
        expect(messages[0]!.parts).toEqual([
            { type: "data-ask", id: "ask-1", title: "Run a script", command: "Rscript de.R", status: "resolved" },
            { type: "text", text: "thinking" },
        ]);
    });

    test("two asks with different ids both stay", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "data-ask", id: "ask-1", title: "First", command: "ls", status: "pending" },
                { type: "data-ask", id: "ask-2", title: "Second", command: "pwd", status: "pending" },
            ],
        );
        expect(messages[0]!.parts).toHaveLength(2);
    });

    test("a settled compaction replaces its running emission in place", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "text-delta", text: "before", source: SOURCE },
                { type: "data-compaction", id: "c-1", status: "running", tokensBefore: 152_000 },
                { type: "data-compaction", id: "c-1", status: "done", tokensBefore: 152_000, tokensAfter: 18_000, durationMs: 12_400 },
            ],
        );
        expect(messages[0]!.parts).toEqual([
            { type: "text", text: "before" },
            { type: "data-compaction", id: "c-1", status: "done", tokensBefore: 152_000, tokensAfter: 18_000, durationMs: 12_400 },
        ]);
    });

    test("a compaction does not reconcile with an ask that shares its id", () => {
        const { messages } = applyMany(
            [],
            [
                { type: "data-ask", id: "same", title: "Run", command: "ls", status: "pending" },
                { type: "data-compaction", id: "same", status: "running", tokensBefore: 1 },
            ],
        );
        expect(messages[0]!.parts).toHaveLength(2);
    });

    test("a data part the registry does not mark reconciling always appends", () => {
        const part = { type: "data-plan", id: "plan-1", planId: "p1" } as const;
        const { messages } = applyMany([], [part, part]);
        expect(messages[0]!.parts).toHaveLength(2);
    });

    test("a data part of a type the registry does not know appends", () => {
        const part = { type: "data-from-a-newer-emitter", id: "x-1" } as unknown as Parameters<typeof applyChatFrame>[1];
        const { messages } = applyMany([], [part, part]);
        expect(messages[0]!.parts).toHaveLength(2);
    });

    test("creates the assistant message on the first frame", () => {
        const { messages } = applyMany([], [{ type: "text-delta", text: "first", source: SOURCE }]);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.id).toBe(ASSISTANT_ID);
        expect(messages[0]!.role).toBe("assistant");
    });

    test("appends to an existing assistant message rather than creating a new one", () => {
        const start: ChatMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
        const { messages } = applyMany(start, [{ type: "text-delta", text: "reply", source: SOURCE }]);
        expect(messages).toHaveLength(2);
        expect(messages[1]!.id).toBe(ASSISTANT_ID);
    });
});

describe("checkChatPart", () => {
    // Each frame below is loose on purpose: a part frame arrives unchecked, and the check is what types it.
    type Frame = Parameters<typeof checkChatPart>[0];

    test("gives a valid part without the fields that its schema does not know, and keeps the source", () => {
        const frame = { type: "data-run-card", id: "r1", runId: "run-1", planId: "pln-0123abcd", title: "Run", stepCount: 2, stale: true, source: topLevel };
        expect(checkChatPart(frame as unknown as Frame)).toEqual({
            ok: true,
            frame: { type: "data-run-card", id: "r1", runId: "run-1", planId: "pln-0123abcd", title: "Run", stepCount: 2, source: topLevel },
        });
    });

    test("refuses a part of a known type that its schema rejects", () => {
        const checked = checkChatPart({ type: "data-ask", id: "a1", title: "Run", command: "ls", status: "maybe" } as unknown as Frame);
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.error).toContain("status");
    });

    test("gives a part of a type that the registry does not know unchanged", () => {
        const frame = { type: "data-from-a-newer-emitter", id: "x-1", anything: 1 };
        expect(checkChatPart(frame as unknown as Frame)).toEqual({ ok: true, frame: frame as unknown as Frame });
    });

    test("refuses a part of a known type whose source is malformed", () => {
        const frame = { type: "data-run-card", id: "r1", runId: "run-1", planId: "pln-0123abcd", title: "Run", stepCount: 2, source: {} };
        const checked = checkChatPart(frame as unknown as Frame);
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.error).toContain("callPath");
    });

    test("refuses a part of a type that the registry does not know whose source is malformed", () => {
        const frame = { type: "data-from-a-newer-emitter", id: "x-1", source: { agentId: "root" } };
        const checked = checkChatPart(frame as unknown as Frame);
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.error).toContain("callPath");
    });
});
