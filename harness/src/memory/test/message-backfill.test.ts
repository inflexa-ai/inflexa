import { describe, expect, it } from "bun:test";
import { Client, type QueryResult } from "pg";

import { envelopeMessage, legacyAnthropicToModelMessage, parseStoredMessageEnvelope } from "../ai-sdk-message-storage.js";
import { backfillAiSdkMessageEnvelopes } from "../message-backfill.js";
import { parseJsonOrUndefined } from "../../lib/json.js";

type LegacyRow = {
    readonly thread_id: string;
    readonly seq: string;
    readonly role: string;
    readonly content_jsonb: string | Array<Record<string, unknown>>;
};

class FakeBackfillClient extends Client {
    legacyRows: LegacyRow[];
    remainingRows: Array<{ thread_id: string; seq: string }> = [];
    readonly updates: unknown[][] = [];
    readonly queries: string[] = [];

    constructor(rows: LegacyRow[]) {
        super();
        this.legacyRows = rows;
    }

    override query(...args: unknown[]): Promise<QueryResult> {
        if (typeof args[0] !== "string") return Promise.reject(new Error("unexpected config-form query"));
        const text = args[0];
        const values = Array.isArray(args[1]) ? args[1] : undefined;
        this.queries.push(text);
        const done = (rows: unknown[]): Promise<QueryResult> => Promise.resolve({ rows, rowCount: rows.length, command: "", oid: 0, fields: [] });
        if (text.startsWith("UPDATE messages SET message_envelope")) {
            this.updates.push(values ?? []);
            return done([]);
        }
        if (text.includes("LIMIT 1")) {
            return done(this.remainingRows);
        }
        if (text.includes("FROM messages") && text.includes("message_envelope IS NULL")) {
            return done(this.legacyRows);
        }
        return Promise.reject(new Error(`unexpected query: ${text}`));
    }

    release(): void {}
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
            content: [{ type: "tool-result", toolCallId: "toolu-1", toolName: "lookup_gene", output: { type: "error-text", value: '{"found":true}' } }],
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
        expect(
            () =>
                legacyAnthropicToModelMessage({
                    threadId: "thread-1",
                    seq: 5,
                    role: "assistant",
                    content: [
                        { type: "text", text: "before" },
                        { type: "redacted_thinking", data: "signed-opaque-blob" },
                    ],
                }),
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the failure message scan: the row identity, then any middle, then the redacted_thinking marker (the dot class spans the variable middle).
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
        ).toThrow("thread-1/6");
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

        await backfillAiSdkMessageEnvelopes(fake);
        expect(fake.updates).toHaveLength(1);
        const envelope = fake.updates[0][0];
        if (typeof envelope !== "string") throw new Error("the backfill passes the envelope text as the first query value");
        expect(parseJsonOrUndefined(envelope)).toEqual(
            envelopeMessage({ role: "user", content: [{ type: "text", text: "hello", providerOptions: undefined }] }),
        );

        fake.legacyRows = [];
        await backfillAiSdkMessageEnvelopes(fake);
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

        await expect(backfillAiSdkMessageEnvelopes(fake)).rejects.toThrow("thread-bad/7");
    });

    it("does not query DBOS operation outputs while migrating conversation messages", async () => {
        const fake = new FakeBackfillClient([]);

        await backfillAiSdkMessageEnvelopes(fake);

        expect(fake.queries.join("\n")).not.toContain("operation_outputs");
    });
});

describe("AI SDK message envelope runtime path", () => {
    it("rejects old-format rows without a message envelope", () => {
        expect(() => parseStoredMessageEnvelope([{ type: "text", text: "legacy" }], "thread-1/0")).toThrow("Invalid stored AI SDK message envelope");
    });
});
