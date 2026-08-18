import { describe, expect, it } from "bun:test";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { envelopeDisplayMessages, parseStoredDisplayEnvelope, type ConversationUIMessage } from "./conversation-display-storage.js";

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
        messages[1]!.id = "mutated";

        const parsed = await parseStoredDisplayEnvelope(envelope, "thread-1/0/display");
        expect(parsed.kind).toBe("ai-sdk-ui-messages");
        expect(parsed.aiSdkMajor).toBe(7);
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed.messages[1]!.id).toBe("a1");
    });

    it.each([
        ["kind", { ...envelopeDisplayMessages(messages), kind: "other" }],
        ["AI SDK major", { ...envelopeDisplayMessages(messages), aiSdkMajor: 8 }],
        ["display version", { ...envelopeDisplayMessages(messages), schemaVersion: 2 }],
        ["messages", { ...envelopeDisplayMessages(messages), messages: [{ id: "x", role: "assistant", parts: [{ type: "text" }] }] }],
    ])("rejects an unsupported or malformed %s", async (_label, value) => {
        expect(parseStoredDisplayEnvelope(value, "thread-1/0/display")).rejects.toThrow(/Invalid stored conversation display envelope/);
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
        expect(parsed.messages[0]!.parts).toHaveLength(1);
    });
});

describe("a stored display part the vocabulary can no longer render", () => {
    function envelopeWithParts(parts: unknown[]): unknown {
        return { ...envelopeDisplayMessages(messages), messages: [{ id: "a1", role: "assistant", parts }] };
    }

    const known = { type: "data-file-reference", data: { id: "files-1", files: [{ path: "result.csv" }] } };

    it("drops a part whose key has been retired, keeping the rest of the turn", async () => {
        const parsed = await parseStoredDisplayEnvelope(envelopeWithParts([{ type: "data-retired-card", data: { x: 1 } }, known]), "t/0/display");
        expect(parsed.messages[0]!.parts).toEqual([known] as never);
    });

    it("drops a part whose payload no longer satisfies its schema", async () => {
        // `files` is required, so a row written before it was is unrenderable
        // under the current schema even though its key still exists.
        const stale = { type: "data-file-reference", data: { id: "files-2" } };
        const parsed = await parseStoredDisplayEnvelope(envelopeWithParts([stale, known]), "t/0/display");
        expect(parsed.messages[0]!.parts).toEqual([known] as never);
    });

    it("does not resolve a part key up the prototype chain", async () => {
        const parsed = await parseStoredDisplayEnvelope(envelopeWithParts([{ type: "data-constructor", data: {} }, known]), "t/0/display");
        expect(parsed.messages[0]!.parts).toEqual([known] as never);
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

    it("leaves structural corruption to fail, having no part it can identify", async () => {
        const value = { ...envelopeDisplayMessages(messages), messages: [{ id: "a1", role: "assistant", parts: [{ data: { x: 1 } }] }] };
        expect(parseStoredDisplayEnvelope(value, "t/0/display")).rejects.toThrow(/Invalid stored conversation display envelope/);
    });
});
