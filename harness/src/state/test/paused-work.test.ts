/**
 * The rows of `cortex_paused_work`, their migration, and the migration that ends the suspended rows of a database
 * from before the pause.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { forgetMigrations, withSchema } from "../../__tests__/setup/postgres.js";
import { initCortexState } from "../init.js";
import { clearPause, clearPauses, clearPausesOfWork, queryPausesOfAnalysis, queryPausesOfWork, recordPause, type PauseRecord } from "../paused-work.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("paused-work"));
});

afterEach(async () => {
    await drop();
});

function pause(overrides: Partial<PauseRecord> & Pick<PauseRecord, "workflowId">): PauseRecord {
    return {
        workId: "run-1",
        workKind: "run",
        analysisId: "a1",
        state: "paused",
        cause: { kind: "host", reason: "payment_required" },
        attempt: 0,
        topic: `pause:${overrides.workflowId}`,
        pausedAt: "2026-10-28T10:00:00.000Z",
        ...overrides,
    };
}

async function record(...records: PauseRecord[]): Promise<void> {
    for (const each of records) (await recordPause(pool, each))._unsafeUnwrap();
}

async function workflowsOf(workId: string, analysisId = "a1"): Promise<string[]> {
    return (await queryPausesOfWork(pool, analysisId, workId))._unsafeUnwrap().map((row) => row.workflowId);
}

describe("the rows of the paused work", () => {
    it("reads back each value that a row records, for each cause and state", async () => {
        const retrying = pause({
            workflowId: "wf-turn",
            workId: "turn-1",
            workKind: "turn",
            threadId: "thread-1",
            state: "retrying",
            cause: { kind: "outage" },
            attempt: 2,
            retryAt: "2026-10-28T10:05:00.000Z",
        });
        const credential = pause({ workflowId: "wf-profile", workId: "profile-1", workKind: "profile", cause: { kind: "credential" } });
        const host = pause({ workflowId: "wf-step" });
        await record(retrying, credential, host);

        expect((await queryPausesOfWork(pool, "a1", "turn-1"))._unsafeUnwrap()).toEqual([retrying]);
        expect((await queryPausesOfWork(pool, "a1", "profile-1"))._unsafeUnwrap()).toEqual([credential]);
        expect((await queryPausesOfWork(pool, "a1", "run-1"))._unsafeUnwrap()).toEqual([host]);
    });

    it("reads back the run session of the pause of a run, with the opaque auth of the host", async () => {
        const runSession = {
            identity: { user: "u-1" },
            scope: { kind: "analysis", analysisId: "a1" },
            provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
            runFrame: { runId: "run-1", stepId: "step-a" },
            auth: { credential: { kind: "mandate", mandateId: "m-1" }, orgId: "o-1" },
        };
        // The host writes its own auth into the session, thus the row goes in as the JSON that a workflow writes.
        await pool.query(
            `INSERT INTO cortex_paused_work (workflow_id, work_id, work_kind, analysis_id, state, cause, attempt, topic, paused_at, run_session)
             VALUES ('wf-run', 'run-1', 'run', 'a1', 'paused', '{"kind":"outage"}', 0, 'pause:wf-run', NOW(), $1)`,
            [JSON.stringify(runSession)],
        );

        const [row] = (await queryPausesOfWork(pool, "a1", "run-1"))._unsafeUnwrap();
        const stored: unknown = row?.runSession;
        expect(stored).toEqual(runSession);
    });

    it("replaces the row of a workflow that pauses again", async () => {
        await record(pause({ workflowId: "wf-1", state: "retrying", cause: { kind: "outage" }, retryAt: "2026-10-28T10:01:00.000Z" }));
        const again = pause({ workflowId: "wf-1", attempt: 1, topic: "pause:second", pausedAt: "2026-10-28T10:02:00.000Z" });

        await record(again);

        expect((await queryPausesOfWork(pool, "a1", "run-1"))._unsafeUnwrap()).toEqual([again]);
    });

    it("lists the rows of one analysis, the oldest pause first", async () => {
        await record(
            pause({ workflowId: "wf-late", workId: "run-2", pausedAt: "2026-10-28T12:00:00.000Z" }),
            pause({ workflowId: "wf-b", pausedAt: "2026-10-28T11:00:00.000Z" }),
            pause({ workflowId: "wf-a", pausedAt: "2026-10-28T11:00:00.000Z" }),
            pause({ workflowId: "wf-elsewhere", analysisId: "a2", pausedAt: "2026-10-28T09:00:00.000Z" }),
        );

        const rows = (await queryPausesOfAnalysis(pool, "a1"))._unsafeUnwrap();

        expect(rows.map((row) => row.workflowId)).toEqual(["wf-a", "wf-b", "wf-late"]);
    });

    it("reads the rows of a work only in its own analysis", async () => {
        await record(pause({ workflowId: "wf-1" }), pause({ workflowId: "wf-other", workId: "run-2" }));

        expect(await workflowsOf("run-1")).toEqual(["wf-1"]);
        expect(await workflowsOf("run-1", "a2")).toEqual([]);
    });

    it("deletes the row of one workflow, and a second delete changes nothing", async () => {
        await record(pause({ workflowId: "wf-1" }), pause({ workflowId: "wf-2" }));

        (await clearPause(pool, "wf-1"))._unsafeUnwrap();
        (await clearPause(pool, "wf-1"))._unsafeUnwrap();

        expect(await workflowsOf("run-1")).toEqual(["wf-2"]);
    });

    it("deletes the rows of a set of workflows in one call", async () => {
        await record(pause({ workflowId: "wf-1" }), pause({ workflowId: "wf-2" }), pause({ workflowId: "wf-3" }));

        (await clearPauses(pool, ["wf-1", "wf-3"]))._unsafeUnwrap();

        expect(await workflowsOf("run-1")).toEqual(["wf-2"]);
    });

    it("deletes each row of one work, and keeps the rows of other work", async () => {
        await record(pause({ workflowId: "wf-1" }), pause({ workflowId: "wf-2" }), pause({ workflowId: "wf-other", workId: "run-2" }));

        (await clearPausesOfWork(pool, "run-1"))._unsafeUnwrap();

        expect(await workflowsOf("run-1")).toEqual([]);
        expect(await workflowsOf("run-2")).toEqual(["wf-other"]);
    });
});

describe("the migration of the paused work", () => {
    it("makes the table and its indexes on a database that has none", async () => {
        await pool.query("DROP TABLE cortex_paused_work");

        await forgetMigrations(pool);
        await initCortexState(pool);

        const { rows } = await pool.query<{ indexname: string }>(
            "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'cortex_paused_work' ORDER BY indexname",
        );
        expect(rows.map((row) => row.indexname)).toEqual(["cortex_paused_work_pkey", "idx_cortex_paused_work_analysis", "idx_cortex_paused_work_work"]);
        await record(pause({ workflowId: "wf-1" }));
        expect(await workflowsOf("run-1")).toEqual(["wf-1"]);
    });

    it("keeps the rows of a table that exists", async () => {
        await record(pause({ workflowId: "wf-1" }));

        await forgetMigrations(pool);
        await initCortexState(pool);

        expect(await workflowsOf("run-1")).toEqual(["wf-1"]);
    });
});

describe("the migration that ends the suspended runs", () => {
    it("moves each suspended run to failed with its error and its end, and each suspended analysis to active", async () => {
        await pool.query(
            `INSERT INTO cortex_analysis_state (analysis_id, status, created_at, updated_at) VALUES
               ('a-suspended', 'suspended_insufficient_funds', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
               ('a-archived', 'archived', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        );
        await pool.query(
            `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, completed_at, error) VALUES
               ('run-suspended', 'a-suspended', 'executeAnalysis', 'suspended_insufficient_funds', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 'payment_required'),
               ('run-running', 'a-suspended', 'executeAnalysis', 'running', '2026-10-02T00:00:00.000Z', NULL, NULL),
               ('run-canceled', 'a-suspended', 'executeAnalysis', 'canceled', '2026-10-03T00:00:00.000Z', '2026-10-03T01:00:00.000Z', 'external_cancel')`,
        );

        await forgetMigrations(pool);
        await initCortexState(pool);

        const runs = await pool.query<{ run_id: string; status: string; completed_at: string | null; error: string | null }>(
            "SELECT run_id, status, completed_at, error FROM cortex_runs ORDER BY run_id",
        );
        expect(runs.rows).toEqual([
            { run_id: "run-canceled", status: "canceled", completed_at: "2026-10-03T01:00:00.000Z", error: "external_cancel" },
            { run_id: "run-running", status: "running", completed_at: null, error: null },
            { run_id: "run-suspended", status: "failed", completed_at: "2026-10-01T01:00:00.000Z", error: "payment_required" },
        ]);
        const analyses = await pool.query<{ analysis_id: string; status: string }>(
            "SELECT analysis_id, status FROM cortex_analysis_state ORDER BY analysis_id",
        );
        expect(analyses.rows).toEqual([
            { analysis_id: "a-archived", status: "archived" },
            { analysis_id: "a-suspended", status: "active" },
        ]);
    });
});
