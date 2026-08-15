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
import { createReportSessionStateStore, type DerivationRecord, type ReportSessionStateStore } from "./report-session-state.js";

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
        (await upsertAnalysis(pool, analysisId, null))._unsafeUnwrap();
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
        (
            await store.appendDerivation(threadId, {
                outputPath: `report-sessions/${threadId}/derived/a.csv`,
                outputHash: "sha256:aaaaaa",
                sources: [{ path: "runs/r1/output/de.csv", hash: "abc123" }],
                scriptHash: "sha256:bbbbbb",
                script: "import pandas\n",
            })
        )._unsafeUnwrap();
        expect((await store.readState(threadId))._unsafeUnwrap()).not.toBeNull();

        // The analysis_id foreign key cascades. A purge removes the analysis-state row,
        // thus the session-state row and the derivations that it holds go with it.
        await pool.query({ text: "DELETE FROM cortex_analysis_state WHERE analysis_id = $1", values: [analysisId] });

        expect((await store.readState(threadId))._unsafeUnwrap()).toBeNull();
    });

    it("lands the two stamps, and the row reads them back", async () => {
        const analysisId = "analysis-stamps";
        await seedAnalysis(analysisId);
        const threadId = "thread-stamps";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        // A fresh row carries neither marker.
        const fresh = (await store.readState(threadId))._unsafeUnwrap();
        expect(fresh!.renderedDocumentHash).toBeNull();
        expect(fresh!.seenDocumentHash).toBeNull();

        // The rendered stamp lands the hash, and the seen hash stays null until a look.
        expect((await store.stampRendered(threadId, "hash-rendered"))._unsafeUnwrap()).toBe("stamped");
        const afterRendered = (await store.readState(threadId))._unsafeUnwrap();
        expect(afterRendered!.renderedDocumentHash).toBe("hash-rendered");
        expect(afterRendered!.seenDocumentHash).toBeNull();

        // The seen stamp copies the rendered hash, thus the two markers agree.
        expect((await store.stampSeen(threadId))._unsafeUnwrap()).toBe("stamped");
        const afterSeen = (await store.readState(threadId))._unsafeUnwrap();
        expect(afterSeen!.seenDocumentHash).toBe("hash-rendered");
        expect(afterSeen!.renderedDocumentHash).toBe("hash-rendered");
    });

    it("gives a no-rendered outcome when the seen stamp finds no rendered hash", async () => {
        const analysisId = "analysis-seen-no-rendered";
        await seedAnalysis(analysisId);
        const threadId = "thread-seen-no-rendered";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        // A fresh row holds no rendered hash, thus the seen stamp finds none to copy.
        expect((await store.stampSeen(threadId))._unsafeUnwrap()).toBe("no-rendered");
        // The seen hash stays null, because the copy had no rendered hash to take.
        const after = (await store.readState(threadId))._unsafeUnwrap();
        expect(after!.seenDocumentHash).toBeNull();
    });

    it("gives an absence for a stamp against a thread with no row", async () => {
        expect((await store.stampRendered("thread-stamp-absent", "h"))._unsafeUnwrap()).toBe("absent");
        expect((await store.stampSeen("thread-stamp-absent"))._unsafeUnwrap()).toBe("absent");
    });

    /** One derivation record. Each test names its own output path, thus the name rule reads one case. */
    function derivation(output: string, sourcePath = "runs/r1/output/de.csv"): DerivationRecord {
        return {
            outputPath: `report-sessions/thread-x/derived/${output}`,
            outputHash: `sha256:${output}`,
            sources: [{ path: sourcePath, hash: "abc123" }],
            scriptHash: "sha256:script",
            script: "import pandas\n",
        };
    }

    it("appends each derivation, and the read gives them in the order that they landed", async () => {
        const analysisId = "analysis-derivations";
        await seedAnalysis(analysisId);
        const threadId = "thread-derivations";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        // A fresh row holds no list at all, thus the read gives an empty list.
        expect((await store.readState(threadId))._unsafeUnwrap()!.derivations).toEqual([]);

        const first = derivation("a.csv");
        const second = derivation("b.csv", "runs/r1/output/counts.csv");
        expect((await store.appendDerivation(threadId, first))._unsafeUnwrap()).toBe("appended");
        expect((await store.appendDerivation(threadId, second))._unsafeUnwrap()).toBe("appended");

        // A second store instance reads the same durable list, with each record whole.
        const read = (await createReportSessionStateStore({ pool }).readState(threadId))._unsafeUnwrap();
        expect(read!.derivations).toEqual([first, second]);
        // The record carries what a second run needs: the script, the sources, and the output hash.
        expect(read!.derivations[0]!.script).toBe("import pandas\n");
        expect(read!.derivations[0]!.sources).toEqual([{ path: "runs/r1/output/de.csv", hash: "abc123" }]);
    });

    it("refuses a second record that holds an output path of the list", async () => {
        const analysisId = "analysis-derivation-name";
        await seedAnalysis(analysisId);
        const threadId = "thread-derivation-name";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        const landed = derivation("yield.csv");
        expect((await store.appendDerivation(threadId, landed))._unsafeUnwrap()).toBe("appended");

        // The output path is unique across the list, thus a second record of that path refuses.
        const repeated: DerivationRecord = { ...landed, outputHash: "sha256:different", script: "import numpy\n" };
        expect((await store.appendDerivation(threadId, repeated))._unsafeUnwrap()).toBe("duplicate");

        // The stored list keeps the first record, thus the refusal changed nothing.
        const read = (await store.readState(threadId))._unsafeUnwrap();
        expect(read!.derivations).toEqual([landed]);
    });

    it("gives an absence for an append against a thread with no row", async () => {
        expect((await store.appendDerivation("thread-derivation-absent", derivation("a.csv")))._unsafeUnwrap()).toBe("absent");
    });

    it("reads a row whose list predates the column as an empty list", async () => {
        const analysisId = "analysis-derivation-legacy";
        await seedAnalysis(analysisId);
        const threadId = "thread-derivation-legacy";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        // A row written before the column existed carries SQL NULL. The read gives an empty list, and it
        // gives no error, because a session that derived nothing holds none.
        await pool.query({ text: "UPDATE cortex_report_session_state SET derivations = NULL WHERE thread_id = $1", values: [threadId] });
        const read = (await store.readState(threadId))._unsafeUnwrap();
        expect(read!.derivations).toEqual([]);
        expect(read!.snapshot).toEqual(snapshot);
    });

    it("reads a corrupted derivation list as a typed error", async () => {
        const analysisId = "analysis-derivation-corrupt";
        await seedAnalysis(analysisId);
        const threadId = "thread-derivation-corrupt";
        (await store.writeSnapshot({ threadId, analysisId, snapshot }))._unsafeUnwrap();

        await pool.query({
            text: `UPDATE cortex_report_session_state SET derivations = '[{"outputPath":1}]'::jsonb WHERE thread_id = $1`,
            values: [threadId],
        });

        const failure = (await store.readState(threadId))._unsafeUnwrapErr();
        expect(failure.type).toBe("corrupt_session_state");
        if (failure.type === "corrupt_session_state") {
            expect(failure.part).toBe("derivations");
            expect(failure.issues.length).toBeGreaterThan(0);
        }
    });
});
