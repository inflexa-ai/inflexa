import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore } from "../memory/thread-store.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { insertRun, updateRunStatus } from "../state/index.js";
import type { SessionProvenanceEvent } from "../provenance/seam.js";
import { prepareChatTurn } from "./chat-turn.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

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
            await history.appendTurn("t-new", {
                modelMessages: [
                    { role: "user", content: "earlier question about PCA" },
                    { role: "assistant", content: "earlier answer" },
                ],
                displayMessages: [],
            })
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
        expect(joined).toContain("[Run Activity]");
        expect(joined).toContain("No runs are currently running or suspended.");
        expect(contentText(result.userMessage.content)).not.toContain("[Run Activity]");
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

    it("injects analysis-wide running and suspended runs regardless of launching thread", async () => {
        (
            await insertRun(pool, { runId: "run-other-thread", analysisId: ANALYSIS_A, threadId: "other-thread", workflowName: "executeAnalysis" })
        )._unsafeUnwrap();
        (
            await insertRun(pool, {
                runId: "run-suspended",
                analysisId: ANALYSIS_A,
                threadId: "another-thread",
                workflowName: "executeAnalysis",
            })
        )._unsafeUnwrap();
        (await updateRunStatus(pool, "run-suspended", "suspended_insufficient_funds"))._unsafeUnwrap();
        (await insertRun(pool, { runId: "run-other-analysis", analysisId: ANALYSIS_B, workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "current-thread", userInput: "status?" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("Running:");
        expect(joined).toContain("runId: run-other-thread");
        expect(joined).toContain("Suspended:");
        expect(joined).toContain("runId: run-suspended");
        expect(joined).toContain("planId: none");
        expect(joined).not.toContain("run-other-analysis");
    });

    it("injects an unavailable state when only the activity read fails", async () => {
        const activityFailingPool = {
            query: (query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
                const text = typeof query === "string" ? query : query.text;
                if (text.includes("status IN ('running','suspended_insufficient_funds')")) {
                    return Promise.reject(new Error("activity unavailable"));
                }
                return pool.query(query as never, values as never);
            },
        } as unknown as Pool;

        const result = await prepareChatTurn({ pool: activityFailingPool }, { analysisId: ANALYSIS_A, threadId: "unavailable-thread", userInput: "hello" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("Run status is temporarily unavailable.");
        expect(joined).not.toContain("No runs are currently running or suspended.");
    });

    it("carries the stored conversation type on an existing thread", async () => {
        const store = createThreadStore(pool);
        (
            await store.createThread({
                threadId: "t-conv",
                analysisId: ANALYSIS_A,
                title: "A conversation",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-conv", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");
        expect(result.threadType).toBe("conversation");
    });

    it("carries the conversation type on a first-turn thread it creates", async () => {
        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-first", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");
        expect(result.threadType).toBe("conversation");

        // The created row matches the surfaced type.
        const created = (await createThreadStore(pool).getThread("t-first"))._unsafeUnwrap();
        expect(created!.threadType).toBe("conversation");
    });

    it("carries the stored report type on a report thread", async () => {
        // No production path creates a report thread yet — write one directly.
        (
            await createThreadStore(pool).createThread({
                threadId: "t-report",
                analysisId: ANALYSIS_A,
                title: "A report",
                type: "report",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-report", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");
        expect(result.threadType).toBe("report");
    });

    it("assembles no working-memory render on a report thread", async () => {
        (await createWorkingMemory(pool).updateSection(ANALYSIS_A, "goal", { text: "Find the driver genes." }))._unsafeUnwrap();
        (
            await createThreadStore(pool).createThread({
                threadId: "t-report-tail",
                analysisId: ANALYSIS_A,
                title: "A report",
                type: "report",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-report-tail", userInput: "draft the summary" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).not.toContain("# Working Memory");
        expect(joined).not.toContain("Find the driver genes.");
        // The other two tail messages stay.
        expect(joined).toContain("[Run Activity]");
        expect(joined).toContain("draft the summary");
    });

    it("emits one create-session event when it writes a new conversation thread", async () => {
        const events: SessionProvenanceEvent[] = [];

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-observed", userInput: "hello" },
        );

        expect(result.kind).toBe("ok");
        expect(events).toEqual([{ type: "create-session", analysisId: ANALYSIS_A, threadId: "t-observed", sessionKind: "conversation" }]);
    });

    it("emits nothing on a turn over a thread that the store already holds", async () => {
        const events: SessionProvenanceEvent[] = [];
        (await createThreadStore(pool).createThread({ threadId: "t-already", analysisId: ANALYSIS_A, title: "Already here" }))._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-already", userInput: "hello again" },
        );

        expect(result.kind).toBe("ok");
        expect(events).toEqual([]);
    });

    it("emits nothing on a turn over an archived thread", async () => {
        const events: SessionProvenanceEvent[] = [];
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: "t-archived", analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        (await store.archiveThread("t-archived"))._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-archived", userInput: "hello again" },
        );

        expect(result.kind).toBe("ok");
        expect(events).toEqual([]);
    });

    it("emits nothing for a thread that another analysis owns", async () => {
        const events: SessionProvenanceEvent[] = [];
        (await createThreadStore(pool).createThread({ threadId: "t-foreign", analysisId: ANALYSIS_B, title: "Owned by B" }))._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-foreign", userInput: "hello" },
        );

        expect(result.kind).toBe("not_found");
        expect(events).toEqual([]);
    });

    it("assembles the working-memory render on a conversation thread", async () => {
        (await createWorkingMemory(pool).updateSection(ANALYSIS_A, "goal", { text: "Find the driver genes." }))._unsafeUnwrap();
        (
            await createThreadStore(pool).createThread({
                threadId: "t-conv-tail",
                analysisId: ANALYSIS_A,
                title: "A conversation",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-conv-tail", userInput: "draft the summary" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("# Working Memory");
        expect(joined).toContain("Find the driver genes.");
    });
});
