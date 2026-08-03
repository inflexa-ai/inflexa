import { describe, expect, it } from "bun:test";

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

    it("rejects an unknown data part instead of accepting an unversioned payload", async () => {
        const value = {
            ...envelopeDisplayMessages(messages),
            messages: [{ id: "a1", role: "assistant", parts: [{ type: "data-invented", data: { x: 1 } }] }],
        };
        expect(parseStoredDisplayEnvelope(value, "thread-1/0/display")).rejects.toThrow(/No data schema found/);
    });

    it("rejects unknown fields inside a known versioned data payload", async () => {
        const value = {
            ...envelopeDisplayMessages(messages),
            messages: [
                {
                    id: "a1",
                    role: "assistant",
                    parts: [
                        {
                            type: "data-file-reference",
                            data: { id: "files-1", files: [{ path: "result.csv" }], unversionedField: true },
                        },
                    ],
                },
            ],
        };
        expect(parseStoredDisplayEnvelope(value, "thread-1/0/display")).rejects.toThrow(/unrecognized/i);
    });
});
