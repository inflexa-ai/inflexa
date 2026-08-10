/**
 * The report session-state store, against the Postgres test schema.
 *
 * Each test names its own analysis and thread, thus the cases do not disturb one
 * another inside the one shared schema. The analysis id has a foreign key to
 * `cortex_analysis_state`, so every test seeds that row first.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import type { DraftDocument } from "../report-model/draft.js";
import type { ReportSnapshot } from "../report-model/reference-resolver.js";
import { upsertAnalysis } from "./analyses.js";
import { createReportSessionStateStore, type ReportSessionStateStore } from "./report-session-state.js";

const validDraft: DraftDocument = {
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

describe("createReportSessionStateStore", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    let store: ReportSessionStateStore;

    beforeAll(async () => {
        const ctx = await withSchema("report_session_state");
        pool = ctx.pool;
        drop = ctx.drop;
        store = createReportSessionStateStore({ pool });
    });

    afterAll(async () => {
        await drop();
    });

    /** Seed the `cortex_analysis_state` row the session-state foreign key needs. */
    async function seedAnalysis(analysisId: string): Promise<void> {
        (await upsertAnalysis(pool, analysisId, null, null))._unsafeUnwrap();
    }

    it("keeps the snapshot and the document across two store instances", async () => {
        const analysisId = "analysis-durable";
        await seedAnalysis(analysisId);
        const threadId = "thread-durable";

        const writer = createReportSessionStateStore({ pool });
        const created = (await writer.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();
        // The pin writes the snapshot first, thus the document is absent at creation.
        expect(created.snapshot).toEqual(snapshot);
        expect(created.document).toBeNull();
        expect(created.analysisId).toBe(analysisId);
        expect(created.createdAt).toBeInstanceOf(Date);

        // A fresh row holds a null document, thus the prior document of the persist is null.
        expect((await writer.persistDocument({ threadId, document: validDraft, expected: null }))._unsafeUnwrap()).toBe("persisted");

        // A second store instance reads the same durable row.
        const reader = createReportSessionStateStore({ pool });
        const state = (await reader.readState(threadId))._unsafeUnwrap();
        expect(state).not.toBeNull();
        expect(state!.document).toEqual(validDraft);
        expect(state!.snapshot).toEqual(snapshot);
    });

    it("keeps the first row when a second write runs on the same thread", async () => {
        const analysisId = "analysis-insert-if-absent";
        await seedAnalysis(analysisId);
        const threadId = "thread-insert-if-absent";

        const first: ReportSnapshot = { artifacts: { "runs/r1/output/a.csv": { hash: "first-hash", fileType: "output" } } };
        const second: ReportSnapshot = { artifacts: { "runs/r2/output/b.csv": { hash: "second-hash", fileType: "output" } } };

        const created = (await store.writeSnapshot({ threadId, analysisId, snapshot: first }))._unsafeUnwrap();
        expect(created.snapshot).toEqual(first);

        (await store.persistDocument({ threadId, document: validDraft, expected: null }))._unsafeUnwrap();

        // The second write is insert-if-absent. The row already exists, thus the
        // winner keeps its snapshot and its document, and the store reads that row back.
        const again = (await store.writeSnapshot({ threadId, analysisId, snapshot: second }))._unsafeUnwrap();
        expect(again.snapshot).toEqual(first);
        expect(again.document).toEqual(validDraft);

        // The thread still holds exactly one row.
        const { rows } = await pool.query<{ n: number }>({
            text: "SELECT COUNT(*)::int AS n FROM cortex_report_session_state WHERE thread_id = $1",
            values: [threadId],
        });
        expect(rows[0]!.n).toBe(1);
    });

    it("refuses the second of two interleaved persists, and keeps the first landing", async () => {
        const analysisId = "analysis-cas";
        await seedAnalysis(analysisId);
        const threadId = "thread-cas";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        // Two turns read the fresh row, thus both hold the null prior document.
        const secondLanding: DraftDocument = {
            title: "A different report",
            sections: [{ kind: "section", id: "s2", title: "Summary", blocks: [{ kind: "text", id: "t2", content: { prose: "Another finding." } }] }],
        };

        const first = (await store.persistDocument({ threadId, document: validDraft, expected: null }))._unsafeUnwrap();
        expect(first).toBe("persisted");

        // The second turn still holds the null prior document, but the row now holds the
        // first landing, thus the compare-and-swap refuses.
        const second = (await store.persistDocument({ threadId, document: secondLanding, expected: null }))._unsafeUnwrap();
        expect(second).toBe("conflict");

        // The row holds the first landing, and the second turn did not overwrite it.
        const state = (await store.readState(threadId))._unsafeUnwrap();
        expect(state!.document).toEqual(validDraft);
    });

    it("lands a second persist that carries the prior document as its token", async () => {
        const analysisId = "analysis-cas-chain";
        await seedAnalysis(analysisId);
        const threadId = "thread-cas-chain";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        // The first persist lands against the null prior document.
        expect((await store.persistDocument({ threadId, document: validDraft, expected: null }))._unsafeUnwrap()).toBe("persisted");

        // The next turn reads the stored document, thus its token is the first landing. The prior document
        // still holds, thus the compare-and-swap against the parsed token lands.
        const read = (await store.readState(threadId))._unsafeUnwrap();
        const nextDoc: DraftDocument = {
            title: "A second landing",
            sections: [{ kind: "section", id: "s3", title: "Notes", blocks: [{ kind: "text", id: "t3", content: { prose: "More." } }] }],
        };
        expect((await store.persistDocument({ threadId, document: nextDoc, expected: read!.document }))._unsafeUnwrap()).toBe("persisted");

        const after = (await store.readState(threadId))._unsafeUnwrap();
        expect(after!.document).toEqual(nextDoc);
    });

    it("gives an absence for a persist against a thread with no row", async () => {
        const outcome = (await store.persistDocument({ threadId: "thread-persist-absent", document: validDraft, expected: null }))._unsafeUnwrap();
        expect(outcome).toBe("absent");
    });

    it("gives an absence for a thread with no row", async () => {
        const state = (await store.readState("thread-with-no-row"))._unsafeUnwrap();
        expect(state).toBeNull();
    });

    it("reads a corrupted row as a typed error", async () => {
        const analysisId = "analysis-corrupt";
        await seedAnalysis(analysisId);
        const docThread = "thread-corrupt-doc";
        const snapThread = "thread-corrupt-snapshot";

        (await store.writeSnapshot({ threadId: docThread, analysisId, snapshot }))._unsafeUnwrap();
        await pool.query({ text: `UPDATE cortex_report_session_state SET document = '{"bad":true}'::jsonb WHERE thread_id = $1`, values: [docThread] });

        const docFailure = (await store.readState(docThread))._unsafeUnwrapErr();
        expect(docFailure.type).toBe("corrupt_session_state");
        if (docFailure.type === "corrupt_session_state") {
            expect(docFailure.threadId).toBe(docThread);
            expect(docFailure.part).toBe("document");
            expect(docFailure.issues.length).toBeGreaterThan(0);
        }

        (await store.writeSnapshot({ threadId: snapThread, analysisId, snapshot }))._unsafeUnwrap();
        await pool.query({
            text: `UPDATE cortex_report_session_state SET snapshot = '{"artifacts":"nope"}'::jsonb WHERE thread_id = $1`,
            values: [snapThread],
        });

        const snapFailure = (await store.readState(snapThread))._unsafeUnwrapErr();
        expect(snapFailure.type).toBe("corrupt_session_state");
        if (snapFailure.type === "corrupt_session_state") {
            expect(snapFailure.part).toBe("snapshot");
        }
    });

    it("removes the row when the analysis is purged", async () => {
        const analysisId = "analysis-purge-cascade";
        await seedAnalysis(analysisId);
        const threadId = "thread-purge-cascade";

        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();
        expect((await store.readState(threadId))._unsafeUnwrap()).not.toBeNull();

        // The analysis_id foreign key cascades. A purge removes the analysis-state row,
        // thus the session-state row goes with it.
        await pool.query({ text: "DELETE FROM cortex_analysis_state WHERE analysis_id = $1", values: [analysisId] });

        expect((await store.readState(threadId))._unsafeUnwrap()).toBeNull();
    });
});
