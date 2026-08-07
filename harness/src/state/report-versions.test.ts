/**
 * The report version store, against the Postgres test schema.
 *
 * Each test names its own analysis and thread, thus the cases do not disturb one
 * another inside the one shared schema. The analysis id has a foreign key to
 * `cortex_analysis_state`, so every recording test seeds that row first.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import type { ReportDocument } from "../contracts/report-blocks.js";
import type { ReportSnapshot } from "../report-model/reference-resolver.js";
import { upsertAnalysis } from "./analyses.js";
import { createReportVersionStore, type ReportVersionStore } from "./report-versions.js";

const validDocument: ReportDocument = {
    title: "A report",
    sections: [
        {
            kind: "section",
            id: "s1",
            title: "Findings",
            blocks: [{ kind: "text", id: "t1", content: { prose: "A finding." } }],
        },
    ],
};

const snapshot: ReportSnapshot = {
    artifacts: {
        "runs/r1/output/de.csv": { hash: "abc123", fileType: "output" },
    },
    citations: ["pmid:12345"],
};

describe("createReportVersionStore", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    let store: ReportVersionStore;

    beforeAll(async () => {
        const ctx = await withSchema("report_versions");
        pool = ctx.pool;
        drop = ctx.drop;
        store = createReportVersionStore({ pool });
    });

    afterAll(async () => {
        await drop();
    });

    /** Seed the `cortex_analysis_state` row the version foreign key needs. */
    async function seedAnalysis(analysisId: string): Promise<void> {
        (await upsertAnalysis(pool, analysisId, null, null))._unsafeUnwrap();
    }

    /**
     * Wait until the store's insert blocks on the unique index. The poll reads
     * `pg_stat_activity` for a lock wait on the versions table, thus the race
     * driver releases its ordinal only after the store is blocked.
     */
    async function waitForBlockedInsert(): Promise<void> {
        const deadline = Date.now() + 5000;
        for (;;) {
            const { rows } = await pool.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND query ILIKE '%cortex_report_versions%'`,
            );
            if ((rows[0]?.n ?? 0) > 0) return;
            if (Date.now() > deadline) throw new Error("the store insert never blocked on the ordinal");
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    it("records a version and reads the triple back by its id", async () => {
        const analysisId = "analysis-round-trip";
        await seedAnalysis(analysisId);
        const threadId = "thread-round-trip";

        const ref = (
            await store.record({ document: validDocument, snapshot, analysisId, threadId, parentThreadId: "conv-anchor", parentSeq: 7 })
        )._unsafeUnwrap();
        expect(ref.versionNumber).toBe(1);

        const version = (await store.getVersion(ref.versionId))._unsafeUnwrap();
        expect(version).not.toBeNull();
        expect(version!.document).toEqual(validDocument);
        expect(version!.snapshot).toEqual(snapshot);
        expect(version!.analysisId).toBe(analysisId);
        expect(version!.threadId).toBe(threadId);
        expect(version!.parentThreadId).toBe("conv-anchor");
        expect(version!.parentSeq).toBe(7);
        expect(version!.versionNumber).toBe(1);
        expect(version!.parentVersionId).toBeNull();
        expect(version!.createdAt).toBeInstanceOf(Date);
    });

    it("counts ordinals up inside one thread, and independently across two threads", async () => {
        const analysisId = "analysis-ordinals";
        await seedAnalysis(analysisId);
        const threadA = "thread-ordinals-a";
        const threadB = "thread-ordinals-b";

        for (const _ of [0, 1, 2]) {
            (await store.record({ document: validDocument, snapshot, analysisId, threadId: threadA, parentThreadId: null, parentSeq: null }))._unsafeUnwrap();
        }
        const firstB = (
            await store.record({ document: validDocument, snapshot, analysisId, threadId: threadB, parentThreadId: null, parentSeq: null })
        )._unsafeUnwrap();

        const listA = (await store.listVersions(threadA))._unsafeUnwrap();
        expect(listA.map((v) => v.versionNumber)).toEqual([1, 2, 3]);

        const latestA = (await store.getLatestVersion(threadA))._unsafeUnwrap();
        expect(latestA!.versionNumber).toBe(3);

        // The second thread counts on its own, thus its first version is 1.
        expect(firstB.versionNumber).toBe(1);
        const latestB = (await store.getLatestVersion(threadB))._unsafeUnwrap();
        expect(latestB!.versionNumber).toBe(1);
    });

    it("retries the insert once when a pre-inserted conflicting ordinal loses the race", async () => {
        const analysisId = "analysis-race";
        await seedAnalysis(analysisId);
        const threadId = "thread-race";

        const holder = await pool.connect();
        try {
            await holder.query("BEGIN");
            // Hold the ordinal 1 uncommitted. The store's MAX read cannot see it,
            // so the store computes 1 too and then blocks on the unique index.
            await holder.query({
                text: `INSERT INTO cortex_report_versions
                         (version_id, analysis_id, thread_id, version_number, document, snapshot)
                       VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb)`,
                values: [randomUUID(), analysisId, threadId, JSON.stringify(validDocument), JSON.stringify(snapshot)],
            });

            const recording = store.record({ document: validDocument, snapshot, analysisId, threadId, parentThreadId: null, parentSeq: null });
            await waitForBlockedInsert();
            // Release the ordinal 1. The store loses the race and retries with 2.
            await holder.query("COMMIT");

            const ref = (await recording)._unsafeUnwrap();
            expect(ref.versionNumber).toBe(2);
        } finally {
            holder.release();
        }

        const versions = (await store.listVersions(threadId))._unsafeUnwrap();
        expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    });

    it("nulls the parent link when the parent row goes", async () => {
        const analysisId = "analysis-parent-null";
        await seedAnalysis(analysisId);
        const threadId = "thread-parent-null";

        const parent = (await store.record({ document: validDocument, snapshot, analysisId, threadId, parentThreadId: null, parentSeq: null }))._unsafeUnwrap();
        const child = (
            await store.record({
                document: validDocument,
                snapshot,
                analysisId,
                threadId,
                parentThreadId: null,
                parentSeq: null,
                parentVersionId: parent.versionId,
            })
        )._unsafeUnwrap();

        const linked = (await store.getVersion(child.versionId))._unsafeUnwrap();
        expect(linked!.parentVersionId).toBe(parent.versionId);

        await pool.query({ text: "DELETE FROM cortex_report_versions WHERE version_id = $1", values: [parent.versionId] });

        const unlinked = (await store.getVersion(child.versionId))._unsafeUnwrap();
        expect(unlinked).not.toBeNull();
        expect(unlinked!.parentVersionId).toBeNull();
    });

    it("leaves the versions when the thread row is deleted", async () => {
        const analysisId = "analysis-survive-thread";
        await seedAnalysis(analysisId);
        const threadId = "thread-survive";
        // A real thread row to delete. The versions table has no foreign key to it.
        await pool.query({
            text: `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, title) VALUES ($1, $2, 'a thread')`,
            values: [threadId, analysisId],
        });

        const ref = (await store.record({ document: validDocument, snapshot, analysisId, threadId, parentThreadId: null, parentSeq: null }))._unsafeUnwrap();

        await pool.query({ text: "DELETE FROM cortex_analysis_threads WHERE thread_id = $1", values: [threadId] });

        const version = (await store.getVersion(ref.versionId))._unsafeUnwrap();
        expect(version).not.toBeNull();
        expect(version!.versionId).toBe(ref.versionId);
    });

    it("refuses a malformed document with no row", async () => {
        const analysisId = "analysis-malformed";
        await seedAnalysis(analysisId);
        const threadId = "thread-malformed";

        const failure = (
            await store.record({ document: { notReport: true }, snapshot, analysisId, threadId, parentThreadId: null, parentSeq: null })
        )._unsafeUnwrapErr();
        expect(failure.type).toBe("malformed_document");
        if (failure.type === "malformed_document") {
            expect(failure.issues.length).toBeGreaterThan(0);
        }

        const versions = (await store.listVersions(threadId))._unsafeUnwrap();
        expect(versions).toEqual([]);
    });

    it("keeps the stored snapshot after a later ledger write", async () => {
        const analysisId = "analysis-snapshot-frozen";
        await seedAnalysis(analysisId);
        const threadId = "thread-snapshot-frozen";
        const pinned: ReportSnapshot = { artifacts: { "runs/r1/output/a.csv": { hash: "pinned-hash", fileType: "output" } } };

        const ref = (
            await store.record({ document: validDocument, snapshot: pinned, analysisId, threadId, parentThreadId: null, parentSeq: null })
        )._unsafeUnwrap();

        // A later ledger write must not reach a recorded snapshot.
        await pool.query({
            text: `INSERT INTO cortex_artifacts (analysis_id, path, hash, size, role, created_at)
                   VALUES ($1, 'runs/r2/output/b.csv', 'later-hash', 1, 'step_output', $2)`,
            values: [analysisId, new Date().toISOString()],
        });

        const version = (await store.getVersion(ref.versionId))._unsafeUnwrap();
        expect(version!.snapshot).toEqual(pinned);
    });

    it("reads a corrupted row as a typed error", async () => {
        const analysisId = "analysis-corrupt";
        await seedAnalysis(analysisId);
        const threadId = "thread-corrupt";

        const badDoc = (await store.record({ document: validDocument, snapshot, analysisId, threadId, parentThreadId: null, parentSeq: null }))._unsafeUnwrap();
        await pool.query({ text: `UPDATE cortex_report_versions SET document = '{"bad":true}'::jsonb WHERE version_id = $1`, values: [badDoc.versionId] });

        const docFailure = (await store.getVersion(badDoc.versionId))._unsafeUnwrapErr();
        expect(docFailure.type).toBe("corrupt_version");
        if (docFailure.type === "corrupt_version") {
            expect(docFailure.versionId).toBe(badDoc.versionId);
            expect(docFailure.part).toBe("document");
            expect(docFailure.issues.length).toBeGreaterThan(0);
        }

        const badSnap = (
            await store.record({ document: validDocument, snapshot, analysisId, threadId, parentThreadId: null, parentSeq: null })
        )._unsafeUnwrap();
        await pool.query({
            text: `UPDATE cortex_report_versions SET snapshot = '{"artifacts":"nope"}'::jsonb WHERE version_id = $1`,
            values: [badSnap.versionId],
        });

        const snapFailure = (await store.getVersion(badSnap.versionId))._unsafeUnwrapErr();
        expect(snapFailure.type).toBe("corrupt_version");
        if (snapFailure.type === "corrupt_version") {
            expect(snapFailure.part).toBe("snapshot");
        }
    });

    it("refuses a parent from a different analysis with no row", async () => {
        const analysisOwner = "analysis-parent-owner";
        const analysisOther = "analysis-parent-other";
        await seedAnalysis(analysisOwner);
        await seedAnalysis(analysisOther);
        const ownerThread = "thread-parent-owner";
        const otherThread = "thread-parent-other";

        const owned = (
            await store.record({ document: validDocument, snapshot, analysisId: analysisOwner, threadId: ownerThread, parentThreadId: null, parentSeq: null })
        )._unsafeUnwrap();

        const failure = (
            await store.record({
                document: validDocument,
                snapshot,
                analysisId: analysisOther,
                threadId: otherThread,
                parentThreadId: null,
                parentSeq: null,
                parentVersionId: owned.versionId,
            })
        )._unsafeUnwrapErr();
        expect(failure.type).toBe("parent_analysis_mismatch");
        if (failure.type === "parent_analysis_mismatch") {
            expect(failure.analysisId).toBe(analysisOther);
            expect(failure.parentAnalysisId).toBe(analysisOwner);
        }

        const versions = (await store.listVersions(otherThread))._unsafeUnwrap();
        expect(versions).toEqual([]);
    });

    it("refuses an unknown parent id through the foreign key", async () => {
        const analysisId = "analysis-unknown-parent";
        await seedAnalysis(analysisId);
        const threadId = "thread-unknown-parent";

        const failure = (
            await store.record({
                document: validDocument,
                snapshot,
                analysisId,
                threadId,
                parentThreadId: null,
                parentSeq: null,
                parentVersionId: randomUUID(),
            })
        )._unsafeUnwrapErr();
        expect(failure.type).toBe("constraint_violation");

        const versions = (await store.listVersions(threadId))._unsafeUnwrap();
        expect(versions).toEqual([]);
    });

    it("gives an absence for a version id that no row holds", async () => {
        const version = (await store.getVersion(randomUUID()))._unsafeUnwrap();
        expect(version).toBeNull();
    });

    it("gives an absence for the latest of an empty thread, and an empty list", async () => {
        const latest = (await store.getLatestVersion("thread-with-no-version"))._unsafeUnwrap();
        expect(latest).toBeNull();

        const versions = (await store.listVersions("thread-with-no-version"))._unsafeUnwrap();
        expect(versions).toEqual([]);
    });
});
