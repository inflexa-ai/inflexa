import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore } from "../memory/thread-store.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { prepareChatTurn } from "./chat-turn.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

const COMPLETED_PROFILE = {
    summary: "Bulk RNA-seq: a count matrix, a sample sheet, and a variant set.",
    files: [
        { path: "data/inputs/f1/counts.csv", description: "Raw count matrix." },
        { path: "data/inputs/f2/samples.tsv", description: "Sample sheet." },
        { path: "data/inputs/f3/variants.vcf", description: "Variant calls." },
    ],
    inputFileIds: ["file-counts", "file-samples", "file-variants"],
    profiledAt: "2026-06-09T10:00:00.000Z",
};

/** Insert an analysis-state row carrying a given data-profile status/result. */
async function seedAnalysis(pool: Pool, analysisId: string, dpStatus: string, result: unknown | null): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, data_profile_result, seed_input_file_ids, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        values: [analysisId, dpStatus, result === null ? null : JSON.stringify(result), JSON.stringify(["file-counts"]), now, now],
    });
}

/** Count a thread's persisted briefing rows. */
async function briefingRowCount(pool: Pool, threadId: string): Promise<number> {
    const res = await pool.query<{ n: string }>({
        text: "SELECT COUNT(*)::text AS n FROM messages WHERE thread_id = $1 AND message_envelope->>'kind' = 'briefing'",
        values: [threadId],
    });
    return Number(res.rows[0]!.n);
}

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("chat-turn"));
});

afterEach(async () => {
    await drop();
});

/** Flatten a message's content to a searchable string. */
function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((b) => (typeof b === "object" && b && "text" in b ? String(b.text) : "")).join("\n");
    }
    return "";
}

describe("prepareChatTurn", () => {
    it("returns not_found when the thread is owned by a different analysis", async () => {
        const store = createThreadStore(pool);
        (
            await store.createThread({
                threadId: "t1",
                analysisId: ANALYSIS_B,
                title: "Owned by B",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t1", userInput: "hello" });

        expect(result.kind).toBe("not_found");
        // Ownership untouched — the foreign thread still belongs to B.
        const still = (await store.getThread("t1"))._unsafeUnwrap();
        expect(still!.analysisId).toBe(ANALYSIS_B);
    });

    it("creates the thread with a derived title and returns ok with history + new input", async () => {
        const store = createThreadStore(pool);
        const history = createThreadHistory(pool);

        // Seed one prior turn so it must appear in the assembled window.
        (
            await history.appendTurn("t-new", [
                { role: "user", content: "earlier question about PCA" },
                { role: "assistant", content: "earlier answer" },
            ])
        )._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool },
            {
                analysisId: ANALYSIS_A,
                threadId: "t-new",
                userInput: "run a differential expression analysis please",
            },
        );

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        // Thread row created with a derived title.
        const created = (await store.getThread("t-new"))._unsafeUnwrap();
        expect(created).not.toBeNull();
        expect(created!.analysisId).toBe(ANALYSIS_A);
        expect(created!.title).toBe(deriveThreadTitle("run a differential expression analysis please"));

        // userMessage carries the new input.
        expect(contentText(result.userMessage.content)).toContain("run a differential expression analysis please");

        // messages include the prior turn's history AND the new user input.
        const joined = result.messages.map((m) => contentText(m.content)).join("\n");
        expect(joined).toContain("earlier question about PCA");
        expect(joined).toContain("earlier answer");
        expect(joined).toContain("run a differential expression analysis please");
    });

    it("leaves an existing non-empty title unchanged", async () => {
        const store = createThreadStore(pool);
        (
            await store.createThread({
                threadId: "t-titled",
                analysisId: ANALYSIS_A,
                title: "My Existing Title",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool },
            {
                analysisId: ANALYSIS_A,
                threadId: "t-titled",
                userInput: "a brand new message that would derive a different title",
            },
        );

        expect(result.kind).toBe("ok");
        const after = (await store.getThread("t-titled"))._unsafeUnwrap();
        expect(after!.title).toBe("My Existing Title");
    });
});

describe("prepareChatTurn standing briefings", () => {
    it("briefs the first turn from a completed data profile and emits a card", async () => {
        await seedAnalysis(pool, ANALYSIS_A, "completed", COMPLETED_PROFILE);

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-profiled", userInput: "what is in my data?" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        // The assembled messages BEGIN with the data-profile briefing.
        const first = contentText(result.messages[0]!.content);
        expect(first).toContain('<briefing name="data-profile">');
        expect(first).toContain("Bulk RNA-seq");

        // Exactly one briefing-card event, captioned at a glance.
        expect(result.briefingCards).toHaveLength(1);
        expect(result.briefingCards[0]).toEqual({
            type: "data-briefing-card",
            id: "briefing-data-profile",
            name: "data-profile",
            caption: "3 files · CSV, TSV, VCF · profiled 2026-06-09 10:00",
        });

        // The briefing is persisted as one pinned row.
        expect(await briefingRowCount(pool, "t-profiled")).toBe(1);
    });

    it("omits the briefing when the profile is pending — no placeholder, no card", async () => {
        await seedAnalysis(pool, ANALYSIS_A, "pending", null);

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-pending", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        expect(result.briefingCards).toHaveLength(0);
        const joined = result.messages.map((m) => contentText(m.content)).join("\n");
        expect(joined).not.toContain("<briefing");
        expect(joined).not.toContain("pending");
        expect(await briefingRowCount(pool, "t-pending")).toBe(0);
    });

    it("re-injects nothing on the second turn", async () => {
        await seedAnalysis(pool, ANALYSIS_A, "completed", COMPLETED_PROFILE);

        const first = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-second", userInput: "first" });
        expect(first.kind).toBe("ok");
        if (first.kind !== "ok") throw new Error("unreachable");
        expect(first.briefingCards).toHaveLength(1);

        const second = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-second", userInput: "second" });
        expect(second.kind).toBe("ok");
        if (second.kind !== "ok") throw new Error("unreachable");

        // No new card, and still exactly one persisted briefing row.
        expect(second.briefingCards).toHaveLength(0);
        expect(await briefingRowCount(pool, "t-second")).toBe(1);
        const briefingMessages = second.messages.filter((m) => contentText(m.content).includes("<briefing"));
        expect(briefingMessages).toHaveLength(1);
    });
});
