import { describe, expect, it } from "bun:test";
import type { PoolClient } from "pg";

import { contentToCortexMessages } from "./content-to-cortex.js";
import { envelopeMessage, legacyAnthropicToModelMessage, parseStoredMessageEnvelope } from "./ai-sdk-message-storage.js";
import { backfillAiSdkMessageEnvelopes } from "./message-backfill.js";

interface LegacyRow {
    readonly thread_id: string;
    readonly seq: string;
    readonly role: string;
    readonly content_jsonb: string | Array<Record<string, unknown>>;
}

class FakeBackfillClient {
    legacyRows: LegacyRow[];
    remainingRows: Array<{ thread_id: string; seq: string }> = [];
    readonly updates: unknown[][] = [];
    readonly queries: string[] = [];

    constructor(rows: LegacyRow[]) {
        this.legacyRows = rows;
    }

    async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
        this.queries.push(text);
        if (/^UPDATE messages SET message_envelope/.test(text)) {
            this.updates.push(values ?? []);
            return { rows: [] };
        }
        if (/LIMIT 1/.test(text)) {
            return { rows: this.remainingRows };
        }
        if (/FROM messages/.test(text) && /message_envelope IS NULL/.test(text)) {
            return { rows: this.legacyRows };
        }
        throw new Error(`unexpected query: ${text}`);
    }
}

function asClient(fake: FakeBackfillClient): PoolClient {
    return fake as unknown as PoolClient;
}

describe("legacyAnthropicToModelMessage", () => {
    it("preserves tool-call ids, tool names, inputs, results, and error markers", () => {
        const assistant = legacyAnthropicToModelMessage({
            threadId: "thread-1",
            seq: 1,
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu-1", name: "lookup_gene", input: { symbol: "BRCA1" } }],
        });
        const tool = legacyAnthropicToModelMessage({
            threadId: "thread-1",
            seq: 2,
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu-1", name: "lookup_gene", content: { found: true }, is_error: true }],
        });

        expect(assistant).toEqual({
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "toolu-1", toolName: "lookup_gene", input: { symbol: "BRCA1" }, providerOptions: undefined }],
        });
        expect(tool).toEqual({
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "toolu-1", toolName: "lookup_gene", output: { type: "error-text", value: "{\"found\":true}" } }],
        });
    });

    it("preserves signed Anthropic reasoning metadata as provider-scoped options", () => {
        const migrated = legacyAnthropicToModelMessage({
            threadId: "thread-1",
            seq: 3,
            role: "assistant",
            content: [{ type: "thinking", thinking: "private reasoning", signature: "sig-123" }],
        });

        expect(migrated).toEqual({
            role: "assistant",
            content: [{ type: "reasoning", text: "private reasoning", providerOptions: { anthropic: { signature: "sig-123" } } }],
        });
    });

    it("preserves signature and cache_control together on one block", () => {
        const migrated = legacyAnthropicToModelMessage({
            threadId: "thread-1",
            seq: 4,
            role: "assistant",
            content: [{ type: "thinking", thinking: "cached reasoning", signature: "sig-456", cache_control: { type: "ephemeral" } }],
        });

        expect(migrated).toEqual({
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "cached reasoning",
                    providerOptions: { anthropic: { signature: "sig-456", cacheControl: { type: "ephemeral" } } },
                },
            ],
        });
    });

    it("fails the row on an unrepresentable assistant block instead of dropping it", () => {
        expect(() =>
            legacyAnthropicToModelMessage({
                threadId: "thread-1",
                seq: 5,
                role: "assistant",
                content: [
                    { type: "text", text: "before" },
                    { type: "redacted_thinking", data: "signed-opaque-blob" },
                ],
            }),
        ).toThrow(/thread-1\/5.*redacted_thinking/);
    });

    it("fails the row when a user turn mixes tool_result with other blocks", () => {
        expect(() =>
            legacyAnthropicToModelMessage({
                threadId: "thread-1",
                seq: 6,
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
                    { type: "text", text: "also this" },
                ],
            }),
        ).toThrow(/thread-1\/6/);
    });
});

describe("backfillAiSdkMessageEnvelopes", () => {
    it("backfills legacy rows idempotently", async () => {
        const fake = new FakeBackfillClient([
            {
                thread_id: "thread-1",
                seq: "0",
                role: "user",
                content_jsonb: [{ type: "text", text: "hello" }],
            },
        ]);

        await backfillAiSdkMessageEnvelopes(asClient(fake));
        expect(fake.updates).toHaveLength(1);
        expect(JSON.parse(String(fake.updates[0]![0]))).toEqual(envelopeMessage({ role: "user", content: [{ type: "text", text: "hello", providerOptions: undefined }] }));

        fake.legacyRows = [];
        await backfillAiSdkMessageEnvelopes(asClient(fake));
        expect(fake.updates).toHaveLength(1);
    });

    it("fails with row identity for unconvertible legacy rows", async () => {
        const fake = new FakeBackfillClient([
            {
                thread_id: "thread-bad",
                seq: "7",
                role: "assistant",
                content_jsonb: [{ type: "tool_use", id: "missing-name" }],
            },
        ]);

        await expect(backfillAiSdkMessageEnvelopes(asClient(fake))).rejects.toThrow(/thread-bad\/7/);
    });

    it("does not query DBOS operation outputs while migrating conversation messages", async () => {
        const fake = new FakeBackfillClient([]);

        await backfillAiSdkMessageEnvelopes(asClient(fake));

        expect(fake.queries.join("\n")).not.toContain("operation_outputs");
    });
});

describe("AI SDK message envelope runtime path", () => {
    it("rejects old-format rows without a message envelope", () => {
        expect(() => parseStoredMessageEnvelope([{ type: "text", text: "legacy" }], "thread-1/0")).toThrow(/Invalid stored AI SDK message envelope/);
    });

    it("converts stored AI SDK messages to Cortex display without mutating storage", async () => {
        const message = {
            role: "assistant" as const,
            content: [
                { type: "reasoning" as const, text: "hidden", providerOptions: { anthropic: { signature: "sig" } } },
                { type: "text" as const, text: "Visible" },
                { type: "tool-call" as const, toolCallId: "call-1", toolName: "show_plan", input: { planId: "pln-1" } },
            ],
        };
        const before = JSON.stringify(message);

        const display = await contentToCortexMessages([{ seq: 0, envelope: envelopeMessage(message), message }]);

        expect(display).toEqual([
            {
                id: "0",
                role: "assistant",
                parts: [
                    { type: "text", text: "Visible" },
                    { type: "tool-call", toolCallId: "call-1", toolName: "show_plan", status: "finished" },
                ],
            },
        ]);
        expect(JSON.stringify(message)).toBe(before);
    });
});
