import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../lib/db-result.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { conversationRecordTurn, createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore, type ThreadStore } from "../memory/thread-store.js";
import { createWorkingMemory, type WorkingMemoryStore } from "../memory/working-memory.js";
import { upsertAnalysis } from "../state/analyses.js";
import { upsertArtifact, type RegisterArtifactInput } from "../state/artifacts.js";
import { createReportSessionRuntime } from "./report-session-runtime.js";
import { compositionHasEyes, createReportSessionSpawn, REPORT_CHILD_PAGE_SIZE, type ReportBrief, type ReportSessionSpawn } from "./spawn-report-session.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

let pool: Pool;
let drop: () => Promise<void>;
let store: ThreadStore;
let memory: WorkingMemoryStore;
let spawn: ReportSessionSpawn;

/** A chrome config that names a browser, thus the eyes gate passes and the spawn reaches its own rules. */
const WITH_BROWSER = { browserUrl: "http://localhost:9222" };

/** The intent brief that each spawn carries. Every field is present, thus the seed shows each label. */
const BRIEF: ReportBrief = {
    objective: "Explain the sample quality outcome",
    audience: "The lab lead",
    angle: "The samples that the study keeps",
    exclusions: "The raw alignment logs",
    openQuestions: "The threshold of the batch correction",
};

beforeEach(async () => {
    ({ pool, drop } = await withSchema("spawn-report-session"));
    store = createThreadStore(pool);
    memory = createWorkingMemory(pool);
    spawn = createReportSessionSpawn({ pool, chrome: WITH_BROWSER });
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

/** Append one record of out-of-band work — a synthetic message that opens no turn. */
function appendRecord(threadId: string, text: string): ResultAsync<void, DbError> {
    return createThreadHistory(pool).appendTurn(threadId, conversationRecordTurn(text));
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

/** The text of each message of a transcript, oldest first. */
async function transcriptOf(threadId: string): Promise<string[]> {
    const page = (await createThreadHistory(pool).loadPage(threadId, 0, 50))._unsafeUnwrap();
    return page.messages.map((row) => (typeof row.message.content === "string" ? row.message.content : JSON.stringify(row.message.content)));
}

/**
 * Make each later insert into `messages` fail. The trigger is real database
 * state, thus the seed write fails the same way that a driver fault fails it. A
 * delete stays permitted, thus the purge of the child still runs.
 */
async function refuseMessageInserts(): Promise<void> {
    await pool.query("CREATE FUNCTION refuse_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'seed write refused'; END; $$");
    await pool.query("CREATE TRIGGER refuse_message_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION refuse_message_insert()");
}

/**
 * Insert report children of one parent directly. One statement seeds a whole
 * page, thus the walk over the pages gets its coverage with no spawn for each
 * row. `updatedSecondsAgo` places the row in the listing, which orders by
 * `updated_at`.
 */
async function insertReportChildren(prefix: string, count: number, parentThreadId: string, anchor: number, updatedSecondsAgo: number): Promise<void> {
    await pool.query(
        `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, title, thread_type, parent_thread_id, parent_seq, created_at, updated_at)
         SELECT $1 || '-' || g, $2, $1 || ' ' || g, 'report', $3, $4::bigint, NOW(), NOW() - ($5::int * INTERVAL '1 second')
           FROM generate_series(1, $6::int) AS g`,
        [prefix, ANALYSIS_A, parentThreadId, anchor, updatedSecondsAgo, count],
    );
}

/** Seed the analysis-state row that the foreign key of the session state needs. */
async function seedAnalysisRow(analysisId: string): Promise<void> {
    (await upsertAnalysis(pool, analysisId, null, null))._unsafeUnwrap();
}

/** One artifact of the ledger, which the pin reads into the snapshot. */
function artifact(analysisId: string, path: string, hash: string): RegisterArtifactInput {
    return { resourceId: analysisId, path, hash, size: 128, role: "step_output", fileType: "output" };
}

/**
 * The artifact paths of the stored snapshot of one thread, or `null` when no
 * session-state row exists. The read goes to the row itself, thus it shows the
 * state that the spawn left and not a value that a later pin composed.
 */
async function storedSnapshotPaths(threadId: string): Promise<string[] | null> {
    const { rows } = await pool.query<{ snapshot: { artifacts: Record<string, unknown> } | null }>(
        "SELECT snapshot FROM cortex_report_session_state WHERE thread_id = $1",
        [threadId],
    );
    const row = rows[0];
    if (row === undefined || row.snapshot === null) return null;
    return Object.keys(row.snapshot.artifacts);
}

describe("spawnReportSession child shape", () => {
    it("makes a report child holding the parent id, the parent analysis, and the anchor", async () => {
        await seedConversation("p1", ANALYSIS_A, "RNA-seq QC");
        const anchor = await latestSeqOf("p1");
        expect(anchor).not.toBeNull();

        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

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

        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

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

        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        expect(child.parentSeq).toBe(anchor);
    });

    it("keeps the child anchor when the parent appends a later turn", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        const anchorAtSpawn = child.parentSeq;

        // The parent moves on. The child records the spawn point, so its anchor
        // does not follow the parent's new tail.
        (await appendTurn("p1"))._unsafeUnwrap();

        const read = (await store.getThread(child.threadId))._unsafeUnwrap();
        expect(read!.parentSeq).toBe(anchorAtSpawn);
    });
});

describe("the eyes rule", () => {
    it("is true for each of the three routes to a look", () => {
        // A bound eyes seam gives a browser for one look.
        expect(compositionHasEyes({ chrome: {}, eyes: () => Promise.resolve({ browserUrl: WITH_BROWSER.browserUrl, release: () => Promise.resolve() }) })).toBe(
            true,
        );
        // A capture seam replaces the transport of the look.
        expect(compositionHasEyes({ chrome: {}, capture: () => Promise.resolve({ screenshotBase64: "", consoleErrors: [], failedRequests: [] }) })).toBe(true);
        // A config that names a browser is the route of a standing sidecar.
        expect(compositionHasEyes({ chrome: WITH_BROWSER })).toBe(true);
    });

    it("is false for a composition with no route", () => {
        expect(compositionHasEyes({ chrome: {} })).toBe(false);
    });
});

describe("spawnReportSession refusals", () => {
    it("refuses with no_browser when the composition gives no eyes seam, no capture seam, and no browser, and writes no row", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        // The parent is legal in every other way, thus only the absent routes to a look refuse.
        const blind = createReportSessionSpawn({ pool, chrome: {} });

        const failed = (await blind.spawnReportSession("p1", BRIEF))._unsafeUnwrapErr();

        expect(failed.type).toBe("no_browser");
        expect(await reportThreadCount()).toBe(0);
    });

    it("spawns when the composition injects a capture seam and names no browser", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        // An injected seam is a route to a look, thus the gate passes with no browser endpoint.
        const seamed = createReportSessionSpawn({
            pool,
            chrome: {},
            capture: () => Promise.resolve({ screenshotBase64: "", consoleErrors: [], failedRequests: [] }),
        });

        const child = (await seamed.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        expect(child.threadType).toBe("report");
        expect(await reportThreadCount()).toBe(1);
    });

    it("spawns when the composition binds an eyes seam and names no browser", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        // A bound seam gives a browser for one look, thus the gate passes with no browser endpoint and
        // no capture seam. The spawn reads the presence of the seam, thus this lease never opens.
        const seeing = createReportSessionSpawn({
            pool,
            chrome: {},
            eyes: () => Promise.resolve({ browserUrl: WITH_BROWSER.browserUrl, release: () => Promise.resolve() }),
        });

        const child = (await seeing.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        expect(child.threadType).toBe("report");
        expect(await reportThreadCount()).toBe(1);
    });

    it("refuses an unknown parent with parent_not_found and writes no row", async () => {
        const failed = (await spawn.spawnReportSession("ghost", BRIEF))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "parent_not_found", op: "spawn-report-session", parentThreadId: "ghost" });
        expect(await reportThreadCount()).toBe(0);
    });

    it("refuses an archived parent with parent_not_found and writes no row", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        (await store.archiveThread("p1"))._unsafeUnwrap();

        const failed = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "parent_not_found", op: "spawn-report-session", parentThreadId: "p1" });
        expect(await reportThreadCount()).toBe(0);
    });

    it("refuses a report parent with parent_not_a_conversation and writes no child", async () => {
        // A standalone report thread stands in for a report session as the parent.
        // The type gate refuses before any transcript read, so it needs no messages.
        (await store.createThread({ threadId: "r1", analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();

        const failed = (await spawn.spawnReportSession("r1", BRIEF))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "parent_not_a_conversation", op: "spawn-report-session", parentThreadId: "r1", threadType: "report" });
        // Only the seed report exists — the spawn added none.
        expect(await reportThreadCount()).toBe(1);
    });

    it("refuses an empty parent transcript with empty_parent_transcript and writes no row", async () => {
        (await store.createThread({ threadId: "p1", analysisId: ANALYSIS_A, title: "Empty" }))._unsafeUnwrap();

        const failed = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "empty_parent_transcript", op: "spawn-report-session", parentThreadId: "p1" });
        expect(await reportThreadCount()).toBe(0);
    });
});

describe("spawnReportSession title", () => {
    it("composes 'T — Report 1' then 'T — Report 2' across two spawns", async () => {
        await seedConversation("p1", ANALYSIS_A, "RNA-seq QC");

        const first = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        expect(first.title).toBe("RNA-seq QC — Report 1");

        const second = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        expect(second.title).toBe("RNA-seq QC — Report 2");
    });

    it("falls back to 'Report 1' when the parent has no title", async () => {
        // The parent needs a transcript to pass the empty-transcript gate, but its
        // title stays null so the fallback branch composes the whole title.
        await seedConversation("p1", ANALYSIS_A, null);

        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        expect(child.title).toBe("Report 1");
    });
});

describe("listReportSessions", () => {
    it("gives only the report sessions of the analysis", async () => {
        // Two conversations and one report session under one analysis.
        await seedConversation("c1", ANALYSIS_A, "Conversation one");
        (await store.createThread({ threadId: "c2", analysisId: ANALYSIS_A, title: "Conversation two" }))._unsafeUnwrap();
        const report = (await spawn.spawnReportSession("c1", BRIEF))._unsafeUnwrap();

        const page = (await spawn.listReportSessions(ANALYSIS_A))._unsafeUnwrap();

        expect(page.total).toBe(1);
        expect(page.threads.map((t) => t.threadId)).toEqual([report.threadId]);
        expect(page.threads.every((t) => t.threadType === "report")).toBe(true);
    });

    it("scopes to one analysis", async () => {
        await seedConversation("a1", ANALYSIS_A, "A parent");
        await seedConversation("b1", ANALYSIS_B, "B parent");
        (await spawn.spawnReportSession("a1", BRIEF))._unsafeUnwrap();
        (await spawn.spawnReportSession("b1", BRIEF))._unsafeUnwrap();

        const page = (await spawn.listReportSessions(ANALYSIS_A))._unsafeUnwrap();

        expect(page.total).toBe(1);
        expect(page.threads.every((t) => t.analysisId === ANALYSIS_A)).toBe(true);
    });
});

describe("spawnReportSession seed", () => {
    it("writes one seed message that holds the brief and the working-memory render", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        (await memory.updateSection(ANALYSIS_A, "goal", { text: "Find the batch effect" }))._unsafeUnwrap();

        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        const transcript = await transcriptOf(child.threadId);
        expect(transcript).toHaveLength(1);
        expect(transcript[0]).toContain(`Objective: ${BRIEF.objective}`);
        expect(transcript[0]).toContain(`Audience: ${BRIEF.audience}`);
        expect(transcript[0]).toContain(`Angle: ${BRIEF.angle}`);
        expect(transcript[0]).toContain(`Exclusions: ${BRIEF.exclusions}`);
        expect(transcript[0]).toContain(`Open questions: ${BRIEF.openQuestions}`);
        expect(transcript[0]).toContain("# Working Memory");
        expect(transcript[0]).toContain("Find the batch effect");
    });

    it("keeps the seed as it is when the working memory changes after the spawn", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        (await memory.updateSection(ANALYSIS_A, "goal", { text: "The goal at the spawn" }))._unsafeUnwrap();
        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        (await memory.updateSection(ANALYSIS_A, "goal", { text: "The goal after the spawn" }))._unsafeUnwrap();

        const transcript = await transcriptOf(child.threadId);
        expect(transcript).toHaveLength(1);
        expect(transcript[0]).toContain("The goal at the spawn");
        expect(transcript[0]).not.toContain("The goal after the spawn");
    });

    it("purges the child when the seed write fails, and returns the fault", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        // The parent transcript is complete before the refusal, thus only the seed
        // write fails, and it fails after the thread insert.
        await refuseMessageInserts();

        const failed = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrapErr();

        expect(failed.type).toBe("mutation_failed");
        expect(await reportThreadCount()).toBe(0);
    });
});

describe("spawnReportSession pin", () => {
    const EARLY = "runs/r1/output/de.csv";
    const LATE = "runs/r2/output/late.csv";

    /** A spawn whose anchor operation is the real session runtime over the same pool. */
    function pinningSpawn(): ReportSessionSpawn {
        const runtime = createReportSessionRuntime({ pool });
        return createReportSessionSpawn({ pool, chrome: WITH_BROWSER, anchorSession: runtime.ensureSessionState });
    }

    it("pins the snapshot of the child before any turn of the child runs", async () => {
        await seedAnalysisRow(ANALYSIS_A);
        await seedConversation("p1", ANALYSIS_A, "Parent");
        await upsertArtifact(pool, artifact(ANALYSIS_A, EARLY, "sha256:aaa"));

        const child = (await pinningSpawn().spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        // The row holds the snapshot at the moment of the spawn, thus the session
        // anchors with no turn and no tool call.
        expect(await storedSnapshotPaths(child.threadId)).toEqual([EARLY]);
    });

    it("keeps an artifact that lands after the spawn out of the stored snapshot", async () => {
        await seedAnalysisRow(ANALYSIS_A);
        await seedConversation("p1", ANALYSIS_A, "Parent");
        await upsertArtifact(pool, artifact(ANALYSIS_A, EARLY, "sha256:aaa"));
        const child = (await pinningSpawn().spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        // A run registers an artifact between the spawn and the first turn.
        await upsertArtifact(pool, artifact(ANALYSIS_A, LATE, "sha256:bbb"));
        // The first turn anchors again. The operation is idempotent, thus it reads
        // the stored snapshot and it pins nothing.
        const firstTurn = await createReportSessionRuntime({ pool }).ensureSessionState(child.threadId);

        expect(firstTurn.outcome).toBe("ready");
        if (firstTurn.outcome !== "ready") return;
        expect(Object.keys(firstTurn.state.snapshot?.artifacts ?? {})).toEqual([EARLY]);
        expect(await storedSnapshotPaths(child.threadId)).toEqual([EARLY]);
    });

    it("keeps the child when the pin fails, and the next call pins", async () => {
        await seedAnalysisRow(ANALYSIS_A);
        await seedConversation("p1", ANALYSIS_A, "Parent");
        await upsertArtifact(pool, artifact(ANALYSIS_A, EARLY, "sha256:aaa"));
        // The anchor operation fails the same way a transient store fault fails it.
        const failing = createReportSessionSpawn({
            pool,
            chrome: WITH_BROWSER,
            anchorSession: () => Promise.resolve({ outcome: "failed" as const, kind: "unavailable" as const, detail: "the artifact ledger read failed" }),
        });

        const child = (await failing.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        // The spawn gives the child, and the child stays on disk.
        expect((await store.getThread(child.threadId))._unsafeUnwrap()).not.toBeNull();
        expect(await reportThreadCount()).toBe(1);
        // A failed pin writes no row, thus a later call pins again.
        expect(await storedSnapshotPaths(child.threadId)).toBeNull();
        const later = await createReportSessionRuntime({ pool }).ensureSessionState(child.threadId);
        expect(later.outcome).toBe("ready");
        expect(await storedSnapshotPaths(child.threadId)).toEqual([EARLY]);
    });
});

describe("reportSessionDelta", () => {
    it("gives no child and no count for a parent with no report child", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");

        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();

        expect(delta.newestChild).toBeNull();
        // No child gives no anchor to count from, thus the count is absent.
        expect(delta.userTurnsSinceAnchor).toBeNull();
    });

    it("gives the anchor of the one child at the end of the transcript, and a count of zero", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();

        expect(delta.newestChild?.threadId).toBe(child.threadId);
        expect(delta.newestChild?.title).toBe(child.title);
        expect(delta.newestChild?.anchor).toBe(await latestSeqOf("p1"));
        expect(delta.userTurnsSinceAnchor).toBe(0);
    });

    it("counts the turns of the parent past the anchor", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();

        (await appendTurn("p1"))._unsafeUnwrap();
        expect((await spawn.reportSessionDelta("p1"))._unsafeUnwrap().userTurnsSinceAnchor).toBe(1);

        (await appendTurn("p1"))._unsafeUnwrap();
        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();
        expect(delta.newestChild?.threadId).toBe(child.threadId);
        expect(delta.newestChild!.anchor).toBeLessThan((await latestSeqOf("p1"))!);
        expect(delta.userTurnsSinceAnchor).toBe(2);
    });

    it("finds the greatest anchor on a later page of the children listing", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const anchor = (await latestSeqOf("p1"))!;
        // The listing orders by `updated_at`, thus the oldest stamp puts the child
        // with the greatest anchor on the second page, behind one full page.
        await insertReportChildren("filler", REPORT_CHILD_PAGE_SIZE, "p1", 0, 0);
        await insertReportChildren("winner", 1, "p1", anchor, 3600);

        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();

        expect(delta.newestChild?.threadId).toBe("winner-1");
        expect(delta.newestChild?.anchor).toBe(anchor);
        // The count reads the anchor of the winner, not the anchor of a filler
        // row: a count from seq 0 would report the one turn of the parent.
        expect(delta.userTurnsSinceAnchor).toBe(0);
    });

    it("names the child with the newest createdAt when two children share the greatest anchor", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const first = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        const second = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        expect(second.parentSeq).toBe(first.parentSeq);
        // The second child takes the older stamp, thus the tie rule and the order of
        // the two inserts point at different rows.
        await pool.query("UPDATE cortex_analysis_threads SET created_at = NOW() - INTERVAL '1 hour' WHERE thread_id = $1", [second.threadId]);

        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();

        expect(delta.newestChild?.threadId).toBe(first.threadId);
    });

    it("gives no child and no count when the one report child is archived", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        const child = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        (await store.archiveThread(child.threadId))._unsafeUnwrap();

        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();

        expect(delta.newestChild).toBeNull();
        expect(delta.userTurnsSinceAnchor).toBeNull();
    });

    it("does not count a record of the host past the anchor", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent");
        (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        // One ask, then one record of out-of-band work. The record carries the
        // `user` role, and nobody typed it, thus the count stays at the one ask.
        (await appendTurn("p1"))._unsafeUnwrap();
        (await appendRecord("p1", "Run GSEA cross-species comparison completed: 3/3 steps."))._unsafeUnwrap();

        const delta = (await spawn.reportSessionDelta("p1"))._unsafeUnwrap();

        expect(delta.userTurnsSinceAnchor).toBe(1);
    });
});

describe("report children narrowed by parent", () => {
    it("gives only the children of the named parent", async () => {
        await seedConversation("p1", ANALYSIS_A, "Parent one");
        await seedConversation("p2", ANALYSIS_A, "Parent two");
        const p1a = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        const p1b = (await spawn.spawnReportSession("p1", BRIEF))._unsafeUnwrap();
        (await spawn.spawnReportSession("p2", BRIEF))._unsafeUnwrap();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, type: "report", parentThreadId: "p1" }))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.threads.map((t) => t.threadId).sort()).toEqual([p1a.threadId, p1b.threadId].sort());
    });
});
