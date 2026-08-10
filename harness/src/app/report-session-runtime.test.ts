/**
 * The report session-state runtime, against the Postgres test schema.
 *
 * Each test names its own analysis and thread, thus the cases do not disturb one
 * another inside the one shared schema. The runtime writes the session-state row,
 * whose analysis id has a foreign key to `cortex_analysis_state`, thus every test
 * seeds that row and a thread row first. The thread row carries the analysis that
 * the anchor operation resolves.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore } from "../memory/thread-store.js";
import type { DraftDocument } from "../report-model/draft.js";
import { upsertAnalysis } from "../state/analyses.js";
import { upsertArtifact, type RegisterArtifactInput } from "../state/artifacts.js";
import { createReportSessionRuntime } from "./report-session-runtime.js";

const DOC_ONE: DraftDocument = {
    title: "Report one",
    sections: [{ kind: "section", id: "s1", title: "Findings", blocks: [{ kind: "text", id: "t1", content: { prose: "One." } }] }],
};

const DOC_TWO: DraftDocument = {
    title: "Report two",
    sections: [{ kind: "section", id: "s9", title: "Summary", blocks: [{ kind: "text", id: "t9", content: { prose: "Two." } }] }],
};

describe("createReportSessionRuntime", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("report_session_runtime");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    /** Seed the analysis-state row the session-state foreign key needs. */
    async function seedAnalysis(analysisId: string): Promise<void> {
        (await upsertAnalysis(pool, analysisId, null, null))._unsafeUnwrap();
    }

    /** Seed the report thread row the anchor operation resolves to an analysis. */
    async function seedThread(threadId: string, analysisId: string): Promise<void> {
        (await createThreadStore(pool).createThread({ threadId, analysisId, type: "report" }))._unsafeUnwrap();
    }

    function artifact(analysisId: string, path: string, hash: string): RegisterArtifactInput {
        return { resourceId: analysisId, path, hash, size: 128, role: "step_output", fileType: "output" };
    }

    async function rowCount(threadId: string): Promise<number> {
        const { rows } = await pool.query<{ n: number }>({
            text: "SELECT COUNT(*)::int AS n FROM cortex_report_session_state WHERE thread_id = $1",
            values: [threadId],
        });
        return rows[0]!.n;
    }

    it("pins one time and freezes the membership across two loads", async () => {
        const analysisId = "analysis-once";
        const threadId = "thread-once";
        await seedAnalysis(analysisId);
        await seedThread(threadId, analysisId);
        const earlyPath = "runs/r1/output/de.csv";
        await upsertArtifact(pool, artifact(analysisId, earlyPath, "sha256:aaa"));

        const runtime = createReportSessionRuntime({ pool });

        const first = await runtime.gateway.load(threadId);
        expect(first.outcome).toBe("found");
        if (first.outcome !== "found") throw new Error("expected found");
        expect(Object.keys(first.state.snapshot.artifacts)).toEqual([earlyPath]);
        // A fresh row holds the snapshot and no document, thus the load gives the empty draft.
        expect(first.state.document).toEqual({ title: "", sections: [] });

        // A new artifact lands after the pin. The stored membership must not grow.
        await upsertArtifact(pool, artifact(analysisId, "runs/r2/output/late.csv", "sha256:bbb"));

        const second = await runtime.gateway.load(threadId);
        expect(second.outcome).toBe("found");
        if (second.outcome !== "found") throw new Error("expected found");
        // The membership is the frozen anchor. The late artifact is not a member, thus
        // the pin ran one time and the second load read the stored snapshot.
        expect(Object.keys(second.state.snapshot.artifacts)).toEqual([earlyPath]);
    });

    it("recovers after a failed ensure writes no row", async () => {
        const analysisId = "analysis-recover";
        const threadId = "thread-recover";
        await seedAnalysis(analysisId);

        const runtime = createReportSessionRuntime({ pool });

        // The thread does not exist yet. The anchor resolves no analysis, thus it fails.
        const failed = await runtime.ensureSessionState(threadId);
        expect(failed.outcome).toBe("failed");
        // A failed ensure writes no row, thus a later run pins again.
        expect(await rowCount(threadId)).toBe(0);

        // The store recovers: the thread lands. The analysis holds no artifact, which is a
        // valid empty snapshot and not a failure.
        await seedThread(threadId, analysisId);
        const ready = await runtime.ensureSessionState(threadId);
        expect(ready.outcome).toBe("ready");
        expect(await rowCount(threadId)).toBe(1);

        const loaded = await runtime.gateway.load(threadId);
        expect(loaded.outcome).toBe("found");
        if (loaded.outcome !== "found") throw new Error("expected found");
        expect(loaded.state.snapshot.artifacts).toEqual({});
    });

    it("refuses a conversation thread and writes no session row", async () => {
        const analysisId = "analysis-conversation";
        const threadId = "thread-conversation";
        await seedAnalysis(analysisId);
        // A conversation thread, not a report thread. The anchor operation carries a report session only.
        (await createThreadStore(pool).createThread({ threadId, analysisId }))._unsafeUnwrap();

        const runtime = createReportSessionRuntime({ pool });

        const failed = await runtime.ensureSessionState(threadId);
        expect(failed.outcome).toBe("failed");
        if (failed.outcome === "failed") {
            expect(failed.detail).toContain("conversation");
        }
        // A wrong-type thread writes no row.
        expect(await rowCount(threadId)).toBe(0);
    });

    it("holds two documents for two threads", async () => {
        const analysisId = "analysis-two";
        const threadOne = "thread-two-a";
        const threadTwo = "thread-two-b";
        await seedAnalysis(analysisId);
        await seedThread(threadOne, analysisId);
        await seedThread(threadTwo, analysisId);

        const runtime = createReportSessionRuntime({ pool });

        // The load anchors each row before the persist. The pin writes the row first, and
        // the load hands the persist the prior document as the concurrency token.
        const loadedOne = await runtime.gateway.load(threadOne);
        const loadedTwo = await runtime.gateway.load(threadTwo);
        if (loadedOne.outcome !== "found" || loadedTwo.outcome !== "found") throw new Error("expected found");

        expect((await runtime.gateway.persist(threadOne, DOC_ONE, loadedOne.token)).outcome).toBe("persisted");
        expect((await runtime.gateway.persist(threadTwo, DOC_TWO, loadedTwo.token)).outcome).toBe("persisted");

        const readOne = await runtime.gateway.load(threadOne);
        const readTwo = await runtime.gateway.load(threadTwo);
        if (readOne.outcome !== "found" || readTwo.outcome !== "found") throw new Error("expected found");
        // Two threads hold two documents. Neither draft leaks into the other.
        expect(readOne.state.document).toEqual(DOC_ONE);
        expect(readTwo.state.document).toEqual(DOC_TWO);
    });

    it("reads the stored membership from a fresh runtime after the ledger changes", async () => {
        const analysisId = "analysis-reload";
        const threadId = "thread-reload";
        await seedAnalysis(analysisId);
        await seedThread(threadId, analysisId);
        const earlyPath = "runs/r1/output/de.csv";
        await upsertArtifact(pool, artifact(analysisId, earlyPath, "sha256:aaa"));

        // The first runtime instance pins the snapshot and writes the row.
        const writer = createReportSessionRuntime({ pool });
        const written = await writer.gateway.load(threadId);
        expect(written.outcome).toBe("found");

        // A new artifact lands after the row is written.
        await upsertArtifact(pool, artifact(analysisId, "runs/r2/output/late.csv", "sha256:bbb"));

        // A fresh runtime instance reads the stored snapshot, and it pins nothing.
        const reader = createReportSessionRuntime({ pool });
        const reloaded = await reader.gateway.load(threadId);
        expect(reloaded.outcome).toBe("found");
        if (reloaded.outcome !== "found") throw new Error("expected found");
        expect(Object.keys(reloaded.state.snapshot.artifacts)).toEqual([earlyPath]);
    });
});
