import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../lib/db-result.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore, type ThreadStore } from "../memory/thread-store.js";
import { createReportSessionSpawn, type ReportSessionSpawn } from "./spawn-report-session.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

let pool: Pool;
let drop: () => Promise<void>;
let store: ThreadStore;
let spawn: ReportSessionSpawn;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("spawn-report-session"));
    store = createThreadStore(pool);
    spawn = createReportSessionSpawn({ pool });
});

afterEach(async () => {
    await drop();
});

// --- seeding ----------------------------------------------------------------

/** Persist one two-message turn on a thread, giving it a transcript to anchor into. */
function appendTurn(threadId: string): ResultAsync<void, DbError> {
    return createThreadHistory(pool).appendTurn(threadId, {
        modelMessages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
        displayMessages: [],
    });
}

/** A live conversation parent with a first turn — the shape a legal spawn needs. */
async function seedConversation(threadId: string, analysisId: string, title: string | null): Promise<void> {
    (await store.createThread({ threadId, analysisId, ...(title === null ? {} : { title }) }))._unsafeUnwrap();
    (await appendTurn(threadId))._unsafeUnwrap();
}

/** The parent's latest seq, read the same way the spawn reads its anchor. */
async function latestSeqOf(threadId: string): Promise<number | null> {
    return (await createThreadHistory(pool).latestSeq(threadId))._unsafeUnwrap();
}

/** The count of `report` rows in the schema — 0 says a refusal wrote nothing. */
async function reportThreadCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM cortex_analysis_threads WHERE thread_type = 'report'");
    return Number(rows[0]!.count);
}

describe("spawnReportSession child shape", () => {
    it("makes a report child holding the parent id, the parent analysis, and the anchor", async () => {
        await seedConversation("p1", ANALYSIS_A, "RNA-seq QC");
        const anchor = await latestSeqOf("p1");
        expect(anchor).not.toBeNull();

        const child = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();

        expect(child.threadType).toBe("report");
        expect(child.parentThreadId).toBe("p1");
        expect(child.analysisId).toBe(ANALYSIS_A);
        expect(child.parentSeq).toBe(anchor);

        // The row is on disk, not just in the returned value.
        const read = (await store.getThread(child.threadId))._unsafeUnwrap();
        expect(read!.threadType).toBe("report");
        expect(read!.parentThreadId).toBe("p1");
        expect(read!.parentSeq).toBe(anchor);
    });

    it("lists the child under its parent", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");

        const child = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, type: "report", parentThreadId: "p1" }))._unsafeUnwrap();
        expect(page.threads.map((t) => t.threadId)).toEqual([child.threadId]);
    });
});

describe("spawnReportSession anchor", () => {
    it("sets the anchor to the parent's latest seq at the spawn", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        // A second turn moves the tail past the first, so the anchor is a value
        // only the read at the spawn produces.
        (await appendTurn("p1"))._unsafeUnwrap();
        const anchor = await latestSeqOf("p1");

        const child = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();

        expect(child.parentSeq).toBe(anchor);
    });

    it("keeps the child anchor when the parent appends a later turn", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const child = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();
        const anchorAtSpawn = child.parentSeq;

        // The parent moves on. The child records the spawn point, so its anchor
        // does not follow the parent's new tail.
        (await appendTurn("p1"))._unsafeUnwrap();

        const read = (await store.getThread(child.threadId))._unsafeUnwrap();
        expect(read!.parentSeq).toBe(anchorAtSpawn);
    });
});

describe("spawnReportSession refusals", () => {
    it("refuses an unknown parent with parent_not_found and writes no row", async () => {
        const failed = (await spawn.spawnReportSession("ghost"))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "parent_not_found", op: "spawn-report-session", parentThreadId: "ghost" });
        expect(await reportThreadCount()).toBe(0);
    });

    it("refuses an archived parent with parent_not_found and writes no row", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        (await store.archiveThread("p1"))._unsafeUnwrap();

        const failed = (await spawn.spawnReportSession("p1"))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "parent_not_found", op: "spawn-report-session", parentThreadId: "p1" });
        expect(await reportThreadCount()).toBe(0);
    });

    it("refuses a report parent with parent_not_a_conversation and writes no child", async () => {
        // A standalone report thread stands in for a report session as the parent.
        // The type gate refuses before any transcript read, so it needs no messages.
        (await store.createThread({ threadId: "r1", analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();

        const failed = (await spawn.spawnReportSession("r1"))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "parent_not_a_conversation", op: "spawn-report-session", parentThreadId: "r1", threadType: "report" });
        // Only the seed report exists — the spawn added none.
        expect(await reportThreadCount()).toBe(1);
    });

    it("refuses an empty parent transcript with empty_parent_transcript and writes no row", async () => {
        (await store.createThread({ threadId: "p1", analysisId: ANALYSIS_A, title: "Empty" }))._unsafeUnwrap();

        const failed = (await spawn.spawnReportSession("p1"))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "empty_parent_transcript", op: "spawn-report-session", parentThreadId: "p1" });
        expect(await reportThreadCount()).toBe(0);
    });
});

describe("spawnReportSession title", () => {
    it("composes 'T — Report 1' then 'T — Report 2' across two spawns", async () => {
        await seedConversation("p1", ANALYSIS_A, "RNA-seq QC");

        const first = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();
        expect(first.title).toBe("RNA-seq QC — Report 1");

        const second = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();
        expect(second.title).toBe("RNA-seq QC — Report 2");
    });

    it("falls back to 'Report 1' when the parent has no title", async () => {
        // The parent needs a transcript to pass the empty-transcript gate, but its
        // title stays null so the fallback branch composes the whole title.
        await seedConversation("p1", ANALYSIS_A, null);

        const child = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();
        expect(child.title).toBe("Report 1");
    });
});

describe("listReportSessions", () => {
    it("gives only the report sessions of the analysis", async () => {
        // Two conversations and one report session under one analysis.
        await seedConversation("c1", ANALYSIS_A, "Conversation one");
        (await store.createThread({ threadId: "c2", analysisId: ANALYSIS_A, title: "Conversation two" }))._unsafeUnwrap();
        const report = (await spawn.spawnReportSession("c1"))._unsafeUnwrap();

        const page = (await spawn.listReportSessions(ANALYSIS_A))._unsafeUnwrap();

        expect(page.total).toBe(1);
        expect(page.threads.map((t) => t.threadId)).toEqual([report.threadId]);
        expect(page.threads.every((t) => t.threadType === "report")).toBe(true);
    });

    it("scopes to one analysis", async () => {
        await seedConversation("a1", ANALYSIS_A, "A parent");
        await seedConversation("b1", ANALYSIS_B, "B parent");
        (await spawn.spawnReportSession("a1"))._unsafeUnwrap();
        (await spawn.spawnReportSession("b1"))._unsafeUnwrap();

        const page = (await spawn.listReportSessions(ANALYSIS_A))._unsafeUnwrap();

        expect(page.total).toBe(1);
        expect(page.threads.every((t) => t.analysisId === ANALYSIS_A)).toBe(true);
    });
});

describe("report children narrowed by parent", () => {
    it("gives only the children of the named parent", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent one");
        await seedConversation("p2", ANALYSIS_A, "Parent two");
        const p1a = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();
        const p1b = (await spawn.spawnReportSession("p1"))._unsafeUnwrap();
        (await spawn.spawnReportSession("p2"))._unsafeUnwrap();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, type: "report", parentThreadId: "p1" }))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.threads.map((t) => t.threadId).sort()).toEqual([p1a.threadId, p1b.threadId].sort());
    });
});
