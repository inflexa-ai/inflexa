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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import type { Scope } from "../auth/types.js";
import { createThreadStore } from "../memory/thread-store.js";
import type { DraftDocument } from "../report-model/draft.js";
import { upsertAnalysis } from "../state/analyses.js";
import { upsertArtifact, type RegisterArtifactInput } from "../state/artifacts.js";
import type { DerivationRecord } from "../state/report-session-state.js";
import { insertRun } from "../state/runs.js";
import { makeToolContext } from "../tools/__fixtures__/tool-context.js";
import { createReportAuthoringTools } from "../tools/report-authoring/authoring-tools.js";
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
        (await upsertAnalysis(pool, analysisId, null))._unsafeUnwrap();
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

    /** Write the synthesis record of a run under a workspace root. */
    async function writeSynthesis(root: string, runId: string, pmids: string[]): Promise<void> {
        const dir = join(root, "runs", runId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "synthesis.json"), JSON.stringify({ runId, keyReferences: pmids.map((pmid) => ({ pmid })) }), "utf8");
    }

    it("carries the citation evidence into the stored snapshot through the seam", async () => {
        const analysisId = "analysis-citations";
        const threadId = "thread-citations";
        const runId = "run-citations";
        await seedAnalysis(analysisId);
        await seedThread(threadId, analysisId);
        (await insertRun(pool, { runId, analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        const root = await mkdtemp(join(tmpdir(), "session-citations-"));
        try {
            await writeSynthesis(root, runId, ["12345", "678"]);

            const runtime = createReportSessionRuntime({ pool, resolveWorkspaceRoot: () => root });
            const ensured = await runtime.ensureSessionState(threadId);
            expect(ensured.outcome).toBe("ready");

            // The stored row is the anchor. A fresh runtime reads it back, thus the assertion is on the
            // durable state and not on the return of the pin.
            const loaded = await createReportSessionRuntime({ pool, resolveWorkspaceRoot: () => root }).gateway.load(threadId);
            expect(loaded.outcome).toBe("found");
            if (loaded.outcome !== "found") throw new Error("expected found");
            expect(loaded.state.snapshot.citations).toEqual(["pmid:12345", "pmid:678"]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    /**
     * One derivation record over a source of the pinned set. The hashes are well-formed `algorithm:hex`
     * values, because the grammar of a reference refuses any other shape.
     */
    function derivation(threadId: string, output: string, sourcePath: string, sourceHash: string): DerivationRecord {
        return {
            outputPath: `report-sessions/${threadId}/derived/${output}`,
            outputHash: "sha256:dddddd",
            sources: [{ path: sourcePath, hash: sourceHash }],
            scriptHash: "sha256:eeeeee",
            script: "import pandas\n",
        };
    }

    it("serves each derivation as a member, and the stored pin stays as it was written", async () => {
        const analysisId = "analysis-derived-membership";
        const threadId = "thread-derived-membership";
        await seedAnalysis(analysisId);
        await seedThread(threadId, analysisId);
        const pinnedPath = "runs/r1/output/de.csv";
        await upsertArtifact(pool, artifact(analysisId, pinnedPath, "sha256:aaa"));

        const runtime = createReportSessionRuntime({ pool });
        const pinned = await runtime.gateway.load(threadId);
        expect(pinned.outcome).toBe("found");
        if (pinned.outcome !== "found") throw new Error("expected found");
        expect(Object.keys(pinned.state.snapshot.artifacts)).toEqual([pinnedPath]);
        // The stored pin, as the row holds it before any derivation lands.
        const { rows: before } = await pool.query<{ snapshot: unknown }>({
            text: "SELECT snapshot FROM cortex_report_session_state WHERE thread_id = $1",
            values: [threadId],
        });

        const record = derivation(threadId, "yield.csv", pinnedPath, "sha256:aaa");
        expect((await runtime.derivations.appendDerivation(threadId, record))._unsafeUnwrap()).toBe("appended");

        // A fresh runtime reads the row, thus the merge runs on the durable state and not on a value that
        // the append held.
        const served = await createReportSessionRuntime({ pool }).gateway.load(threadId);
        expect(served.outcome).toBe("found");
        if (served.outcome !== "found") throw new Error("expected found");
        expect(Object.keys(served.state.snapshot.artifacts).sort()).toEqual([record.outputPath, pinnedPath].sort());
        // The served entry carries the output hash of the record.
        expect(served.state.snapshot.artifacts[record.outputPath]).toEqual({ hash: record.outputHash });
        // The pinned entry is untouched by the merge.
        expect(served.state.snapshot.artifacts[pinnedPath]!.hash).toBe("sha256:aaa");

        // The stored snapshot column holds the pin alone, thus the anchor stays honest.
        const { rows: after } = await pool.query<{ snapshot: unknown }>({
            text: "SELECT snapshot FROM cortex_report_session_state WHERE thread_id = $1",
            values: [threadId],
        });
        expect(after[0]!.snapshot).toEqual(before[0]!.snapshot);
        expect(Object.keys(after[0]!.snapshot as Record<string, unknown>)).not.toContain(record.outputPath);
    });

    it("binds a derived path through the authoring tools, and the stamp fills its hash", async () => {
        const analysisId = "analysis-derived-binding";
        const threadId = "thread-derived-binding";
        await seedAnalysis(analysisId);
        await seedThread(threadId, analysisId);
        await upsertArtifact(pool, artifact(analysisId, "runs/r1/output/de.csv", "sha256:aaa"));

        const runtime = createReportSessionRuntime({ pool });
        await runtime.gateway.load(threadId);
        const record = derivation(threadId, "yield.csv", "runs/r1/output/de.csv", "sha256:aaa");
        expect((await runtime.derivations.appendDerivation(threadId, record))._unsafeUnwrap()).toBe("appended");

        const tools = createReportAuthoringTools(runtime.gateway);
        const { ctx } = makeToolContext();
        const scope: Scope = { kind: "analysis", analysisId, threadId };
        const call = { ...ctx, session: { ...ctx.session, scope } };

        expect((await tools.add_block.execute({ block: { kind: "section", id: "s1", title: "Findings", blocks: [] } }, call))._unsafeUnwrap().applied).toBe(
            true,
        );
        // The reference names the derived path alone. The stamp fills the hash from the served membership,
        // thus a derived table binds the same way as a pinned artifact.
        const added = (
            await tools.add_block.execute(
                { block: { kind: "table", id: "t1", binding: { kind: "artifact-table", path: record.outputPath } }, parentId: "s1", place: "end" },
                call,
            )
        )._unsafeUnwrap();
        expect(added.applied).toBe(true);

        const loaded = await runtime.gateway.load(threadId);
        if (loaded.outcome !== "found") throw new Error("expected found");
        const section = loaded.state.document.sections[0]!;
        const table = section.blocks[0]!;
        expect(table).toMatchObject({ kind: "table", id: "t1", binding: { path: record.outputPath, hash: record.outputHash } });
    });

    it("lands the pin with no citation when the deps bind no workspace root", async () => {
        const analysisId = "analysis-no-seam";
        const threadId = "thread-no-seam";
        const runId = "run-no-seam";
        await seedAnalysis(analysisId);
        await seedThread(threadId, analysisId);
        (await insertRun(pool, { runId, analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        const root = await mkdtemp(join(tmpdir(), "session-no-seam-"));
        try {
            await writeSynthesis(root, runId, ["12345"]);

            // The deps bind no root, thus the record on disk reaches no key.
            const runtime = createReportSessionRuntime({ pool });
            const ensured = await runtime.ensureSessionState(threadId);
            expect(ensured.outcome).toBe("ready");

            const loaded = await runtime.gateway.load(threadId);
            expect(loaded.outcome).toBe("found");
            if (loaded.outcome !== "found") throw new Error("expected found");
            expect(loaded.state.snapshot.citations).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
