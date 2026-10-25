import { describe, expect, it } from "bun:test";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import type { PlanApprovalPart, SubAgentActivityPart } from "../../contracts/chat-parts.js";
import type { ToolCallPart } from "../../contracts/message.js";
import {
    conversationDisplayPart,
    conversationUIToChatMessages,
    envelopeDisplayMessages,
    parseStoredDisplayEnvelope,
    type ConversationUIMessage,
} from "../conversation-display-storage.js";
import { presentAt } from "../../lib/present.js";

const messages: ConversationUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "show results" }] },
    {
        id: "a1",
        role: "assistant",
        parts: [
            {
                type: "data-file-reference",
                id: "files-1",
                data: { id: "files-1", title: "Results", files: [{ path: "runs/run-1/output/results.csv", runId: "run-1" }] },
            },
        ],
    },
];

describe("stored conversation display envelope", () => {
    it("validates and copies a versioned AI SDK UI message envelope", async () => {
        const envelope = envelopeDisplayMessages(messages);
        presentAt(messages, 1).id = "mutated";

        const parsed = await parseStoredDisplayEnvelope(envelope, "thread-1/0/display");
        expect(parsed.kind).toBe("ai-sdk-ui-messages");
        expect(parsed.aiSdkMajor).toBe(7);
        expect(parsed.schemaVersion).toBe(1);
        expect(presentAt(parsed.messages, 1).id).toBe("a1");
    });

    it.each([
        ["kind", { ...envelopeDisplayMessages(messages), kind: "other" }],
        ["AI SDK major", { ...envelopeDisplayMessages(messages), aiSdkMajor: 8 }],
        ["display version", { ...envelopeDisplayMessages(messages), schemaVersion: 2 }],
        ["messages", { ...envelopeDisplayMessages(messages), messages: [{ id: "x", role: "assistant", parts: [{ type: "text" }] }] }],
    ])("rejects an unsupported or malformed %s", (_label, value) => {
        expect(parseStoredDisplayEnvelope(value, "thread-1/0/display")).rejects.toThrow("Invalid stored conversation display envelope");

        return Promise.resolve();
    });

    it("keeps a stale field inside a known data payload rather than failing the read", async () => {
        const value = {
            ...envelopeDisplayMessages(messages),
            messages: [
                {
                    id: "a1",
                    role: "assistant",
                    parts: [{ type: "data-file-reference", data: { id: "files-1", files: [{ path: "result.csv" }], retiredField: true } }],
                },
            ],
        };
        const parsed = await parseStoredDisplayEnvelope(value, "thread-1/0/display");
        expect(presentAt(parsed.messages, 0).parts).toHaveLength(1);
    });
});

describe("a stored display part the vocabulary can no longer render", () => {
    function envelopeWithParts(parts: unknown[]): unknown {
        return { ...envelopeDisplayMessages(messages), messages: [{ id: "a1", role: "assistant", parts }] };
    }

    const known: ConversationUIMessage["parts"][number] = { type: "data-file-reference", data: { id: "files-1", files: [{ path: "result.csv" }] } };

    it("drops a part whose key has been retired, keeping the rest of the turn", async () => {
        const parsed = await parseStoredDisplayEnvelope(envelopeWithParts([{ type: "data-retired-card", data: { x: 1 } }, known]), "t/0/display");
        expect(presentAt(parsed.messages, 0).parts).toEqual([known]);
    });

    it("drops a part whose payload no longer satisfies its schema", async () => {
        // `files` is required, so a row written before it was is unrenderable
        // under the current schema even though its key still exists.
        const stale = { type: "data-file-reference", data: { id: "files-2" } };
        const parsed = await parseStoredDisplayEnvelope(envelopeWithParts([stale, known]), "t/0/display");
        expect(presentAt(parsed.messages, 0).parts).toEqual([known]);
    });

    it("does not resolve a part key up the prototype chain", async () => {
        const parsed = await parseStoredDisplayEnvelope(envelopeWithParts([{ type: "data-constructor", data: {} }, known]), "t/0/display");
        expect(presentAt(parsed.messages, 0).parts).toEqual([known]);
    });

    it("reports each drop with the row identity and the reason", async () => {
        const logger = createCapturingLogger();
        const stale = { type: "data-file-reference", data: { id: "files-2" } };
        await parseStoredDisplayEnvelope(envelopeWithParts([{ type: "data-retired-card", data: {} }, stale, known]), "t/7/display", logger);

        const warn = logger.records.find((r) => r.level === "warn");
        expect(warn?.msg).toBe("dropped unrenderable stored display parts");
        expect(warn?.fields).toEqual({
            identity: "t/7/display",
            unknownKey: ["data-retired-card"],
            schemaMismatch: ["data-file-reference"],
        });
    });

    it("says nothing when every part still renders", async () => {
        const logger = createCapturingLogger();
        await parseStoredDisplayEnvelope(envelopeDisplayMessages(messages), "t/0/display", logger);
        expect(logger.records).toEqual([]);
    });

    it("leaves structural corruption to fail, having no part it can identify", () => {
        const value = { ...envelopeDisplayMessages(messages), messages: [{ id: "a1", role: "assistant", parts: [{ data: { x: 1 } }] }] };
        expect(parseStoredDisplayEnvelope(value, "t/0/display")).rejects.toThrow("Invalid stored conversation display envelope");

        return Promise.resolve();
    });
});

describe("a stored tool call", () => {
    it("reads a row stored with no duration, and gives no duration key", async () => {
        const call = { toolCallId: "t1", toolName: "read_file", outcome: "ok", detail: "data/counts.csv" } as const;
        const value = {
            ...envelopeDisplayMessages(messages),
            messages: [{ id: "a1", role: "assistant", parts: [{ type: "data-tool-call", id: "t1", data: call }] }],
        };

        const parts = presentAt(conversationUIToChatMessages((await parseStoredDisplayEnvelope(value, "t/0/display")).messages), 0).parts;

        const expected: ToolCallPart = { type: "tool-call", ...call };
        expect(parts).toEqual([expected]);
        expect(parts[0]).not.toHaveProperty("durationMs");
    });
});

describe("a stored compaction divider", () => {
    it("round-trips a system message with a data-compaction part and reads it back as the part", async () => {
        const figures = { id: "c-1", status: "done" as const, tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 };
        const divider: ConversationUIMessage = { id: "c-1", role: "system", parts: [{ type: "data-compaction", id: "c-1", data: figures }] };

        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
        const parsed = await parseStoredDisplayEnvelope(JSON.parse(JSON.stringify(envelopeDisplayMessages([divider]))), "t/0/display");

        expect(parsed.messages).toEqual([divider]);
        expect(conversationUIToChatMessages(parsed.messages)).toEqual([{ id: "c-1", role: "system", parts: [{ type: "data-compaction", ...figures }] }]);
    });
});

describe("a stored sub-agent activity part", () => {
    const entry = {
        agentId: "planner",
        callPath: ["conversation-agent", "planner"],
        tool: "search_pubmed",
        label: "TP53",
        startedAt: "2026-10-12T10:00:00.000Z",
        endedAt: "2026-10-12T10:00:00.800Z",
        outcome: "ok" as const,
    };
    const part: SubAgentActivityPart = { type: "data-subagent-activity", id: "subagent-activity-t1", toolCallId: "t1", entries: [entry], dropped: 3 };

    it("round-trips field for field", async () => {
        const stored: ConversationUIMessage = { id: "a1", role: "assistant", parts: [conversationDisplayPart(part)] };

        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
        const parsed = await parseStoredDisplayEnvelope(JSON.parse(JSON.stringify(envelopeDisplayMessages([stored]))), "t/0/display");

        expect(parsed.messages).toEqual([stored]);
        expect(presentAt(conversationUIToChatMessages(parsed.messages), 0).parts).toEqual([part]);
    });

    it("stores an open entry as incomplete, with no end time", () => {
        const { outcome: _outcome, endedAt: _endedAt, ...open } = entry;

        const stored = conversationDisplayPart({ ...part, entries: [open, entry] });

        expect(stored).toEqual({
            type: "data-subagent-activity",
            id: "subagent-activity-t1",
            data: { toolCallId: "t1", dropped: 3, id: "subagent-activity-t1", entries: [{ ...open, outcome: "incomplete" }, entry] },
        });
    });

    it("drops a stored part whose entry has no outcome", async () => {
        const { outcome: _outcome, ...open } = entry;
        const { type: _type, ...data } = part;
        const value = {
            ...envelopeDisplayMessages(messages),
            messages: [
                {
                    id: "a1",
                    role: "assistant",
                    parts: [
                        { type: "data-subagent-activity", id: "x", data: { ...data, entries: [open] } },
                        { type: "text", text: "kept" },
                    ],
                },
            ],
        };

        const parsed = await parseStoredDisplayEnvelope(value, "t/0/display");

        expect(presentAt(parsed.messages, 0).parts).toEqual([{ type: "text", text: "kept" }]);
    });
});

describe("a stored plan-approval part", () => {
    const part: PlanApprovalPart = { type: "data-plan-approval", planId: "pln-0000000a", runId: "r1", approvedAt: "2026-10-13T10:00:00.000Z" };

    it("round-trips field for field", async () => {
        const stored: ConversationUIMessage = { id: "s1", role: "system", parts: [conversationDisplayPart(part)] };

        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
        const parsed = await parseStoredDisplayEnvelope(JSON.parse(JSON.stringify(envelopeDisplayMessages([stored]))), "t/0/display");

        expect(parsed.messages).toEqual([stored]);
        expect(presentAt(conversationUIToChatMessages(parsed.messages), 0).parts).toEqual([part]);
    });
});
