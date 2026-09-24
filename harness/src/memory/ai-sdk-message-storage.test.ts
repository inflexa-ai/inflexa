import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { createHash } from "node:crypto";

import {
    compactionExchangeOf,
    compactionMarkerOf,
    contextRecordMessage,
    contextRecordOf,
    dropMarkerMessage,
    envelopeMessage,
    HARNESS_PROVIDER_NAMESPACE,
    INTERRUPTED_MESSAGE_KEY,
    isInterruptedMessage,
    isSyntheticRecordMessage,
    isSyntheticUserMessage,
    markCompactionExchange,
    markInterruptedMessage,
    parseStoredMessageEnvelope,
    summaryMarkerMessage,
    SYNTHETIC_MESSAGE_KEY,
    syntheticUserMessage,
} from "./ai-sdk-message-storage.js";

describe("interruption marker helpers", () => {
    it("marks a message so isInterruptedMessage reports true", () => {
        const marked = markInterruptedMessage({ role: "assistant", content: "partial" });
        expect(isInterruptedMessage(marked)).toBe(true);
    });

    it("reads an unmarked message as not interrupted", () => {
        expect(isInterruptedMessage({ role: "assistant", content: "a clean reply" })).toBe(false);
    });

    it("returns a copy without mutating the input", () => {
        const original: ModelMessage = { role: "assistant", content: "partial" };
        const marked = markInterruptedMessage(original);
        expect(marked).not.toBe(original);
        // The input keeps no marker — mark is pure.
        expect(original.providerOptions).toBeUndefined();
        expect(isInterruptedMessage(original)).toBe(false);
    });

    it("preserves an existing provider namespace on the message when marking", () => {
        const withSignature: ModelMessage = {
            role: "assistant",
            content: "partial",
            providerOptions: { anthropic: { signature: "SIG-abc" } },
        };
        const marked = markInterruptedMessage(withSignature);

        expect(isInterruptedMessage(marked)).toBe(true);
        // The pre-existing anthropic namespace is untouched — merge, not replace.
        expect(marked.providerOptions?.anthropic).toEqual({ signature: "SIG-abc" });
        expect(marked.providerOptions?.[HARNESS_PROVIDER_NAMESPACE]?.[INTERRUPTED_MESSAGE_KEY]).toBe(true);
    });

    it("merges into an existing harness namespace rather than dropping its other keys", () => {
        // Marking keeps every key already present in the harness namespace.
        const synthetic = syntheticUserMessage("continue concisely");
        const marked = markInterruptedMessage(synthetic);

        const harness = marked.providerOptions?.[HARNESS_PROVIDER_NAMESPACE];
        expect(harness?.[SYNTHETIC_MESSAGE_KEY]).toBe(true);
        expect(harness?.[INTERRUPTED_MESSAGE_KEY]).toBe(true);
    });
});

describe("context records", () => {
    const text = "[Working Memory]\nThe working memory is empty.";

    it("round-trips the kind and the hash through the stored envelope", () => {
        const stored = JSON.parse(JSON.stringify(envelopeMessage(contextRecordMessage("working-memory", text)))) as unknown;

        const { message } = parseStoredMessageEnvelope(stored, "thread/0");

        expect(message.content).toBe(text);
        expect(contextRecordOf(message)).toEqual({ kind: "working-memory", hash: createHash("sha256").update(text).digest("hex") });
    });

    it("is a synthetic message and no host record", () => {
        const record = contextRecordMessage("run-activity", "[Run Activity]\nNo runs are currently running or suspended.");

        expect(record.role).toBe("user");
        expect(isSyntheticUserMessage(record)).toBe(true);
        expect(isSyntheticRecordMessage(record)).toBe(false);
    });

    it("reads a plain message as no record", () => {
        expect(contextRecordOf({ role: "user", content: "what is BRCA1?" })).toBeUndefined();
        expect(contextRecordOf(syntheticUserMessage("continue concisely"))).toBeUndefined();
    });
});

describe("compaction marks", () => {
    const summary = summaryMarkerMessage("The user compares two groups.", {
        kind: "summary",
        id: "c-1",
        tokensBefore: 162_000,
        tokensAfter: 14_000,
        durationMs: 21_000,
    });
    const drop = dropMarkerMessage({ kind: "drop", id: "c-2", tokensBefore: 170_000, tokensAfter: 90_000, durationMs: 3_000, keptTurns: 4 });

    function throughStorage(message: ModelMessage): ModelMessage {
        return parseStoredMessageEnvelope(JSON.parse(JSON.stringify(envelopeMessage(message))) as unknown, "thread/0").message;
    }

    it("round-trips a summary marker and a drop marker through the stored envelope", () => {
        const storedSummary = throughStorage(summary);
        const storedDrop = throughStorage(drop);

        expect(storedSummary.content).toBe("[Conversation Summary]\nThe user compares two groups.");
        expect(compactionMarkerOf(storedSummary)).toEqual({ kind: "summary", id: "c-1", tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 });
        expect(storedDrop.content).toBe("[Compaction Failed]");
        expect(compactionMarkerOf(storedDrop)).toEqual({
            kind: "drop",
            id: "c-2",
            tokensBefore: 170_000,
            tokensAfter: 90_000,
            durationMs: 3_000,
            keptTurns: 4,
        });
    });

    it("makes a marker synthetic and no host record", () => {
        for (const marker of [summary, drop]) {
            expect(marker.role).toBe("user");
            expect(isSyntheticUserMessage(marker)).toBe(true);
            expect(isSyntheticRecordMessage(marker)).toBe(false);
        }
    });

    it("keeps the anthropic signature of a marked assistant message", () => {
        const reply: ModelMessage = {
            role: "assistant",
            content: [
                { type: "reasoning", text: "the user wants a summary", providerOptions: { anthropic: { signature: "SIG-abc" } } },
                { type: "text", text: "the summary" },
            ],
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        };

        const marked = throughStorage(markCompactionExchange(reply, "c-1"));

        expect(compactionExchangeOf(marked)).toBe("c-1");
        expect(marked.content).toEqual(reply.content);
        expect(marked.providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
    });

    it("keeps the synthetic mark of a marked request", () => {
        const marked = markCompactionExchange(syntheticUserMessage("Summarize the conversation."), "c-1");

        expect(isSyntheticUserMessage(marked)).toBe(true);
        expect(compactionExchangeOf(marked)).toBe("c-1");
    });

    it("reads a plain message as no marker and no exchange message", () => {
        const plain: ModelMessage = { role: "user", content: "what is BRCA1?" };

        expect(compactionMarkerOf(plain)).toBeUndefined();
        expect(compactionExchangeOf(plain)).toBeUndefined();
        expect(compactionMarkerOf(syntheticUserMessage("continue concisely"))).toBeUndefined();
        expect(compactionExchangeOf(summary)).toBeUndefined();
    });
});
