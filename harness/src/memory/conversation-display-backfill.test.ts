import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { backfillConversationDisplayEnvelopes } from "./conversation-display-backfill.js";
import { createThreadHistory, type ConversationTurn } from "./thread-history.js";
import { createThreadStore } from "./thread-store.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("conversation-display-backfill"));
});

afterEach(async () => {
    await drop?.();
});

/**
 * A turn as a pre-display-projection binary wrote it: model messages only. This
 * is what the backfill exists to migrate, so seeding it any other way would test
 * nothing.
 */
function modelOnly(modelMessages: ModelMessage[]): ConversationTurn {
    return { modelMessages, displayMessages: [] };
}

function legacyTurn(toolCallId: string, toolName: string, input: unknown): ModelMessage[] {
    return [
        { role: "user", content: "show it" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] },
        {
            role: "tool",
            content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value: { shown: true } } }],
        },
    ];
}

describe("conversation display startup backfill", () => {
    it("freezes reconstructable cards, batches turns, and is idempotent", async () => {
        const threadId = "thread-display-backfill";
        (await createThreadStore(pool).createThread({ threadId, analysisId: "analysis-1", title: "Backfill" }))._unsafeUnwrap();
        const history = createThreadHistory(pool);
        (
            await history.appendTurn(threadId, modelOnly(legacyTurn("show-1", "show_user", { kind: "markdown", title: "Finding", body: "old body" })))
        )._unsafeUnwrap();
        (
            await history.appendTurn(threadId, modelOnly(legacyTurn("show-2", "show_file", { files: [{ path: "runs/run-1/output/figure.png" }] })))
        )._unsafeUnwrap();

        const migrated = await backfillConversationDisplayEnvelopes({
            pool,
            resolveWorkspaceRoot: () => "/tmp/missing-analysis",
            tools: [],
            batchSize: 1,
        });
        expect(migrated).toBe(2);
        expect(await backfillConversationDisplayEnvelopes({ pool, resolveWorkspaceRoot: () => "/tmp/missing-analysis", tools: [], batchSize: 1 })).toBe(0);

        const page = (await history.loadAll(threadId))._unsafeUnwrap();
        const envelopes = page
            .flat()
            .filter((message) => message.displayEnvelope)
            .map((message) => message.displayEnvelope!);
        expect(envelopes).toHaveLength(2);
        expect(envelopes[0]!.messages[1]!.parts.some((part) => part.type === "data-presentation")).toBe(true);
        expect(envelopes[1]!.messages[1]!.parts.some((part) => part.type === "data-file-reference")).toBe(true);
    });

    it("marks a missing mutable resource migrated with the cardless legacy projection", async () => {
        const threadId = "thread-display-missing";
        (await createThreadStore(pool).createThread({ threadId, analysisId: "analysis-1", title: "Missing" }))._unsafeUnwrap();
        const history = createThreadHistory(pool);
        (await history.appendTurn(threadId, modelOnly(legacyTurn("plan-1", "show_plan", { planId: "pln-deadbeef" }))))._unsafeUnwrap();

        expect(await backfillConversationDisplayEnvelopes({ pool, resolveWorkspaceRoot: () => "/tmp/missing-analysis", tools: [] })).toBe(1);
        const page = (await history.loadAll(threadId))._unsafeUnwrap();
        const display = page.flat()[0]!.displayEnvelope!.messages;
        // The plan card cannot be rebuilt — the workspace is gone — so the call is
        // frozen as a plain tool call. Its OUTCOME still survives: that comes from the
        // paired tool-result block in the transcript, which does not depend on any
        // mutable resource.
        expect(display[1]!.parts).toEqual([
            {
                type: "data-tool-call",
                id: "plan-1",
                data: { toolCallId: "plan-1", toolName: "show_plan", outcome: "ok" },
            },
        ]);
    });

    it("freezes a failed legacy call as a failure, not as a success", async () => {
        const threadId = "thread-display-failed";
        (await createThreadStore(pool).createThread({ threadId, analysisId: "analysis-1", title: "Failed" }))._unsafeUnwrap();
        const history = createThreadHistory(pool);
        (
            await history.appendTurn(threadId, {
                modelMessages: [
                    { role: "user", content: "run it" },
                    { role: "assistant", content: [{ type: "tool-call", toolCallId: "boom", toolName: "run_pca", input: {} }] },
                    {
                        role: "tool",
                        content: [{ type: "tool-result", toolCallId: "boom", toolName: "run_pca", output: { type: "error-text", value: "exploded" } }],
                    },
                ],
                displayMessages: [],
            })
        )._unsafeUnwrap();

        expect(await backfillConversationDisplayEnvelopes({ pool, resolveWorkspaceRoot: () => "/tmp/missing-analysis", tools: [] })).toBe(1);
        const page = (await history.loadAll(threadId))._unsafeUnwrap();
        expect(page.flat()[0]!.displayEnvelope!.messages[1]!.parts).toEqual([
            { type: "data-tool-call", id: "boom", data: { toolCallId: "boom", toolName: "run_pca", outcome: "error" } },
        ]);
    });
});
