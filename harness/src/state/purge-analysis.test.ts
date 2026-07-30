/**
 * The purge reaches the durability engine's own system tables, so it runs against
 * the DBOS rig — a plain Postgres schema has no `dbos` schema to reach. Those
 * tables are SHARED by every test in the process and are partitioned only by
 * unique workflow ids: every workflow row here is seeded under an id minted by
 * `rig.nextWorkflowId`, the data-profile namespace carries a per-run nonce, and
 * the purge only ever deletes ids it read back out of this test's own rows.
 *
 * What a purge under test deliberately does not reach — every row behind a
 * refusal or a stubbed failure — would otherwise outlive the process, since
 * dropping the per-test schema takes nothing out of `dbos`. So `afterAll` deletes
 * exactly the rows this file wrote, scoped to the `executor_id` literal it stamps
 * on all of them and nothing else in the process writes. A delete broader than
 * that literal would destroy other tests' rows.
 *
 * The `cortex_*` rows are seeded with literal SQL rather than through the state
 * modules so the full set of analysis-keyed tables sits in one place. That set is
 * hand-written, so it is pinned against `information_schema` — a table added to the
 * schema with an `analysis_id` column fails that check until it is listed, and
 * listing it then demands a seeded row and a post-purge zero like every other
 * table's. The `dbos` cascade set is hand-written for the same reason and pinned
 * the same way, against the engine's live foreign keys. Drift therefore surfaces
 * as a failure here rather than as a silently missed store.
 *
 * Workflow rows are seeded directly rather than by running workflows — the
 * assertions are about which rows the purge reaches (a run's descendants, the
 * data-profile namespace, and the tables that cascade off `workflow_status`), and
 * a hand-built shape pins that without depending on a live workflow's timing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { errAsync } from "neverthrow";

import { createDbosLedgerSeeder, WORKFLOW_CASCADE_TABLES, type DbosLedgerSeeder } from "../__tests__/setup/dbos-ledger.js";
import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { createDbosWorkflowPurger } from "../execution/dbos-workflow-purger.js";
import type { WorkflowPurger } from "../execution/workflow-purger.js";
import { searchIndexName } from "../workspace/search-config.js";
import { createVectorStore } from "./vector-store.js";
import { createAnalysisPurge, type AnalysisPurge } from "./purge-analysis.js";

/**
 * Stamped on every `dbos.workflow_status` row this file writes, and read back by
 * `afterAll` to reclaim them. Deliberately not the rig's executor id, so the
 * launched engine's recovery pass never claims a seeded PENDING row.
 */
const SEEDED_EXECUTOR_ID = "purge-analysis-test";

/** Every table the purge must clear for an analysis, asserted by name. */
const ANALYSIS_KEYED_TABLES = [
    "cortex_analysis_state",
    "cortex_artifacts",
    "cortex_runs",
    "cortex_step_executions",
    "cortex_plans",
    "cortex_analysis_threads",
    "cortex_working_memory",
    "cortex_asks",
    "cortex_ask_grants",
] as const;

const NOTHING_LEFT: Record<string, number> = {
    cortex_analysis_state: 0,
    cortex_artifacts: 0,
    cortex_runs: 0,
    cortex_step_executions: 0,
    cortex_plans: 0,
    cortex_analysis_threads: 0,
    cortex_working_memory: 0,
    cortex_asks: 0,
    cortex_ask_grants: 0,
};

/** What `seedAnalysis` writes, so a survival assertion can name the same numbers. */
const FULLY_SEEDED: Record<string, number> = {
    cortex_analysis_state: 1,
    cortex_artifacts: 2,
    cortex_runs: 2,
    cortex_step_executions: 2,
    cortex_plans: 1,
    cortex_analysis_threads: 2,
    cortex_working_memory: 1,
    cortex_asks: 1,
    cortex_ask_grants: 1,
};

const SEEDED_MESSAGES = 4;

interface SeededAnalysis {
    readonly analysisId: string;
    readonly threadIds: readonly string[];
    /** The `cortex_runs.run_id` values, which are the parent workflow ids directly. */
    readonly runIds: readonly string[];
    /** Every workflow the analysis is traceable to: both runs, the child step, the data profile. */
    readonly workflowIds: readonly string[];
}

describe("createAnalysisPurge", () => {
    let rig: DbosTestRig;
    let purger: WorkflowPurger;
    let purge: AnalysisPurge;
    let ledger: DbosLedgerSeeder;
    // A fresh nonce per run keeps the data-profile id namespace clear of rows a
    // previous run of this file left in the shared `dbos` schema.
    const run = randomUUID().slice(0, 8);

    beforeAll(async () => {
        rig = await setupDbosForTests("purge_analysis");
        purger = createDbosWorkflowPurger({ pool: rig.pool });
        purge = createAnalysisPurge({ pool: rig.pool, workflows: purger });
        // Every cascading table is seeded, so the post-purge zero asserted for each
        // stands for a row that was actually there rather than an empty table.
        ledger = createDbosLedgerSeeder({ pool: rig.pool, executorId: SEEDED_EXECUTOR_ID });
    });

    afterAll(async () => {
        // Before the pool goes: every status row this file seeded, and — through the
        // same cascade the purge relies on — every dependent row seeded beside it.
        await rig.pool.query({
            text: `DELETE FROM dbos.workflow_status WHERE executor_id = $1`,
            values: [SEEDED_EXECUTOR_ID],
        });
        await rig.drop();
    });

    /**
     * A populated analysis: a row in every analysis-keyed table, two threads (one
     * archived) with messages, and the workflow footprint a profiled analysis with
     * two runs leaves — one run carrying a child step workflow.
     */
    async function seedAnalysis(analysisId: string, opts?: { readonly vectorIndex?: boolean }): Promise<SeededAnalysis> {
        const now = new Date().toISOString();
        await rig.pool.query({
            text: `INSERT INTO cortex_analysis_state (analysis_id, status, created_at, updated_at)
                   VALUES ($1, 'active', $2, $2)`,
            values: [analysisId, now],
        });
        await rig.pool.query({
            text: `INSERT INTO cortex_working_memory (analysis_id, data) VALUES ($1, '{"goal":"g"}'::jsonb)`,
            values: [analysisId],
        });
        await rig.pool.query({
            text: `INSERT INTO cortex_plans (plan_id, analysis_id, plan, created_at)
                   VALUES ($1, $2, '{"steps":[]}'::jsonb, $3)`,
            values: [`plan-${analysisId}`, analysisId, now],
        });
        await rig.pool.query({
            text: `INSERT INTO cortex_asks (id, analysis_id, title, command, grant_key, status, created_at)
                   VALUES ($1, $2, 'run it', 'Rscript go.R', 'Rscript go.R', 'resolved', $3)`,
            values: [`ask-${analysisId}`, analysisId, now],
        });
        await rig.pool.query({
            text: `INSERT INTO cortex_ask_grants (analysis_id, grant_key, created_at) VALUES ($1, 'Rscript go.R', $2)`,
            values: [analysisId, now],
        });

        const threadIds = [`thread-a-${analysisId}`, `thread-b-${analysisId}`];
        for (const [index, threadId] of threadIds.entries()) {
            await rig.pool.query({
                text: `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, title, deleted_at)
                       VALUES ($1, $2, 'a thread', $3)`,
                // The second thread is archived — a tombstoned thread is still the
                // analysis's, and the purge takes it and its messages too.
                values: [threadId, analysisId, index === 1 ? new Date() : null],
            });
            for (const seq of [1, 2]) {
                await rig.pool.query({
                    text: `INSERT INTO messages (thread_id, seq, message_envelope, tokens)
                           VALUES ($1, $2, '{"kind":"ai-sdk-model-message"}'::jsonb, 3)`,
                    values: [threadId, seq],
                });
            }
        }

        const runIds = [rig.nextWorkflowId(`run-1-${analysisId}-`), rig.nextWorkflowId(`run-2-${analysisId}-`)];
        for (const [index, runId] of runIds.entries()) {
            await rig.pool.query({
                text: `INSERT INTO cortex_runs (run_id, analysis_id, thread_id, workflow_name, status, started_at)
                       VALUES ($1, $2, $3, 'executeAnalysis', 'completed', $4)`,
                values: [runId, analysisId, threadIds[0], now],
            });
            await rig.pool.query({
                text: `INSERT INTO cortex_step_executions (run_id, step_id, analysis_id, wave, agent_id, status)
                       VALUES ($1, $2, $3, 0, 'rna-seq', 'completed')`,
                values: [runId, `step-${index}`, analysisId],
            });
            await rig.pool.query({
                text: `INSERT INTO cortex_artifacts (analysis_id, path, hash, size, role, source_run, created_at)
                       VALUES ($1, $2, 'h', 1, 'output', $3, $4)`,
                values: [analysisId, `runs/${index}/output/out.csv`, runId, now],
            });
            await ledger.seedWorkflow(runId);
        }

        // A child step workflow of the first run — reachable only as a descendant.
        const childWorkflowId = `${runIds[0]}-step-0`;
        await ledger.seedWorkflow(childWorkflowId, runIds[0]);

        // The data-profile attempt, reachable only through its id namespace.
        const dataProfileWorkflowId = `dataprofile:${analysisId}:${run}`;
        await ledger.seedWorkflow(dataProfileWorkflowId);

        if (opts?.vectorIndex !== false) {
            const store = createVectorStore(rig.pool);
            (await store.createIndex({ indexName: searchIndexName(analysisId), dimension: 3, metric: "cosine" }))._unsafeUnwrap();
        }

        return { analysisId, threadIds, runIds, workflowIds: [...runIds, childWorkflowId, dataProfileWorkflowId] };
    }

    async function countsByAnalysis(analysisId: string): Promise<Record<string, number>> {
        const counts: Record<string, number> = {};
        for (const table of ANALYSIS_KEYED_TABLES) {
            const { rows } = await rig.pool.query<{ n: number }>({
                // A table name cannot be a bind parameter; every value here comes from
                // the literal tuple above, so nothing caller-shaped reaches the SQL.
                text: `SELECT COUNT(*)::int AS n FROM ${table} WHERE analysis_id = $1`,
                values: [analysisId],
            });
            counts[table] = rows[0]?.n ?? 0;
        }
        return counts;
    }

    async function countMessages(threadIds: readonly string[]): Promise<number> {
        const { rows } = await rig.pool.query<{ n: number }>({
            text: `SELECT COUNT(*)::int AS n FROM messages WHERE thread_id = ANY($1)`,
            values: [[...threadIds]],
        });
        return rows[0]?.n ?? 0;
    }

    async function workflowStatuses(workflowIds: readonly string[]): Promise<string[]> {
        const { rows } = await rig.pool.query<{ status: string }>({
            text: `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ANY($1) ORDER BY workflow_uuid`,
            values: [[...workflowIds]],
        });
        return rows.map((row) => row.status);
    }

    async function vectorTableExists(analysisId: string): Promise<boolean> {
        const { rows } = await rig.pool.query<{ present: boolean }>({
            text: "SELECT to_regclass($1::text) IS NOT NULL AS present",
            values: [searchIndexName(analysisId)],
        });
        return rows[0]?.present ?? false;
    }

    it("leaves no analysis-keyed row, no vector table, and no workflow footprint", async () => {
        const doomed = await seedAnalysis(`purge-full-${run}`);

        expect(await countsByAnalysis(doomed.analysisId)).toEqual(FULLY_SEEDED);
        expect(await countMessages(doomed.threadIds)).toBe(SEEDED_MESSAGES);
        expect(await vectorTableExists(doomed.analysisId)).toBe(true);
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(4);
        expect(await ledger.countCascadeRows(doomed.workflowIds)).toEqual(ledger.cascadeRows(4));

        const outcome = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrap();
        expect(outcome).toEqual({ threads: 2, messages: SEEDED_MESSAGES, workflows: 4, vectorIndexDropped: true });

        expect(await countsByAnalysis(doomed.analysisId)).toEqual(NOTHING_LEFT);
        expect(await countMessages(doomed.threadIds)).toBe(0);
        expect(await vectorTableExists(doomed.analysisId)).toBe(false);
        // The status rows go, and every dependent row that cascades off them goes with
        // them — that is where the analysis's bulk actually lived.
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(0);
        expect(await ledger.countCascadeRows(doomed.workflowIds)).toEqual(ledger.cascadeRows(0));
    });

    it("covers exactly the analysis-keyed tables the live schema declares", async () => {
        const { rows } = await rig.pool.query<{ table_name: string }>(
            // `current_schema()` resolves the rig's per-test schema: the pool sets
            // `search_path` to it ahead of `public`, so the probe reads the same schema
            // the tables were created in.
            `SELECT table_name FROM information_schema.columns
             WHERE column_name = 'analysis_id' AND table_schema = current_schema()
             ORDER BY table_name`,
        );
        expect(rows.map((row) => row.table_name)).toEqual([...ANALYSIS_KEYED_TABLES].sort());

        // Each covered table is actually seeded, so the all-zero assertion the full
        // purge makes for it is a reclamation rather than an empty table.
        for (const table of ANALYSIS_KEYED_TABLES) {
            expect(FULLY_SEEDED[table]).toBeGreaterThan(0);
        }
    });

    it("covers exactly the dbos tables that cascade off a workflow status row", async () => {
        const { rows } = await rig.pool.query<{ table_name: string }>(
            // The engine owns this schema and adds to it across versions. A table it
            // puts behind an `ON DELETE CASCADE` key is bytes a purge starts reclaiming
            // the moment the key exists, so the set is read back from the live
            // constraints: an unlisted one fails here until it is seeded and asserted
            // like the rest.
            `SELECT c.conrelid::regclass::text AS table_name
               FROM pg_constraint c
              WHERE c.contype = 'f'
                AND c.confrelid = 'dbos.workflow_status'::regclass
                AND c.confdeltype = 'c'`,
        );
        expect(rows.map((row) => row.table_name).sort()).toEqual(WORKFLOW_CASCADE_TABLES.map((table) => `dbos.${table}`).sort());
    });

    it("leaves a second analysis, a target assessment, an orphaned message, the shared corpus, and scheduled workflows untouched", async () => {
        const doomed = await seedAnalysis(`purge-neighbour-${run}`);
        const bystander = await seedAnalysis(`purge-survivor-${run}`);

        const assessmentId = randomUUID();
        await rig.pool.query({
            text: `INSERT INTO cortex_target_assessments
                     (id, organization_id, target_id, target_label, status, billing_context_id, requested_by, workflow_id)
                   VALUES ($1, 'org-1', 'EGFR', 'EGFR', 'completed', 'bc-1', 'someone', $2)`,
            // The id column is `uuid` and `workflow_id` is `text`, so the same value has
            // to arrive as two parameters rather than one bound twice.
            values: [assessmentId, assessmentId],
        });
        // A target assessment's annotations are named separately from the assessment
        // itself, and are keyed by gene rather than by any entity id at all.
        await rig.pool.query({
            text: `INSERT INTO cortex_off_target_annotations
                     (primary_target_gene, off_target_key, off_target_name, clinical_consequence, model)
                   VALUES ($1, 'CHEMBL203', 'EGFR', 'rash', 'test-model')`,
            values: [`EGFR-${run}`],
        });
        // The regulatory corpus is shared: no analysis owns a chunk of it.
        await rig.pool.query({
            text: `INSERT INTO cortex_regulatory_chunks (source, doc_id, doc_title, doc_url, chunk_index, chunk_text)
                   VALUES ('FDA-CDER', $1, 'A guidance', 'https://example.invalid/g', 0, 'text')`,
            values: [`doc-${run}`],
        });
        // A message whose thread row is gone carries no analysis attribution, so no
        // purge can reach it — the spec's "unreachable by construction" exclusion.
        const orphanThreadId = `purge-orphan-thread-${run}`;
        await rig.pool.query({
            text: `INSERT INTO messages (thread_id, seq, message_envelope, tokens)
                   VALUES ($1, 1, '{"kind":"ai-sdk-model-message"}'::jsonb, 3)`,
            values: [orphanThreadId],
        });
        // A scheduled operational workflow belongs to no analysis: nothing maps it to
        // one, and no purge can or should reach it.
        const scheduled = rig.nextWorkflowId("purge-scheduled-");
        await ledger.seedWorkflow(scheduled);
        // A target assessment's workflow id is the assessment id — it is in neither
        // `cortex_runs` nor the `dataprofile:{analysisId}:` namespace, which is the
        // whole reason the purge cannot reach it.
        await ledger.seedWorkflow(assessmentId);

        (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrap();

        expect(await countsByAnalysis(bystander.analysisId)).toEqual(FULLY_SEEDED);
        expect(await countMessages(bystander.threadIds)).toBe(SEEDED_MESSAGES);
        expect(await vectorTableExists(bystander.analysisId)).toBe(true);
        expect(await ledger.countStatusRows(bystander.workflowIds)).toBe(4);
        expect(await ledger.countCascadeRows(bystander.workflowIds)).toEqual(ledger.cascadeRows(4));

        const { rows: survivors } = await rig.pool.query<{ assessments: number; annotations: number; chunks: number; orphans: number }>({
            text: `SELECT (SELECT COUNT(*)::int FROM cortex_target_assessments WHERE id = $1) AS assessments,
                          (SELECT COUNT(*)::int FROM cortex_off_target_annotations WHERE primary_target_gene = $2) AS annotations,
                          (SELECT COUNT(*)::int FROM cortex_regulatory_chunks WHERE doc_id = $3) AS chunks,
                          (SELECT COUNT(*)::int FROM messages WHERE thread_id = $4) AS orphans`,
            values: [assessmentId, `EGFR-${run}`, `doc-${run}`, orphanThreadId],
        });
        expect(survivors[0]).toEqual({ assessments: 1, annotations: 1, chunks: 1, orphans: 1 });

        for (const untouched of [scheduled, assessmentId]) {
            expect(await ledger.countStatusRows([untouched])).toBe(1);
            expect(await ledger.countCascadeRows([untouched])).toEqual(ledger.cascadeRows(1));
        }
    });

    it("reclaims a data-profile workflow from its id namespace", async () => {
        // No runs at all: the only route to this workflow is the
        // `dataprofile:{analysisId}:` namespace, so nothing in `cortex_runs` can be
        // standing in for the reclamation.
        const analysisId = `purge-profiled-${run}`;
        const now = new Date().toISOString();
        await rig.pool.query({
            text: `INSERT INTO cortex_analysis_state (analysis_id, status, created_at, updated_at) VALUES ($1, 'active', $2, $2)`,
            values: [analysisId, now],
        });
        const profileWorkflowId = `dataprofile:${analysisId}:${run}`;
        await ledger.seedWorkflow(profileWorkflowId);

        const outcome = (await purge.purgeAnalysis(analysisId))._unsafeUnwrap();
        expect(outcome.workflows).toBe(1);

        expect(await ledger.countStatusRows([profileWorkflowId])).toBe(0);
        expect(await ledger.countCascadeRows([profileWorkflowId])).toEqual(ledger.cascadeRows(0));
    });

    it("removes the analysis's plans on a schema that has no cascade to fall back on", async () => {
        // A schema of its own, with the plans-to-state foreign key removed, so the
        // plan row is reachable only by the purge's own statement. This is the shape
        // of a database whose `cortex_plans` predates the key: the table exists, so
        // the state DDL adds no constraint to it, and nothing cascades.
        const isolated = await withSchema("purge_analysis_no_cascade");
        try {
            const cascadesToState = async (): Promise<number> => {
                const { rows } = await isolated.pool.query<{ n: number }>(
                    `SELECT COUNT(*)::int AS n FROM pg_constraint
                     WHERE contype = 'f'
                       AND conrelid = 'cortex_plans'::regclass
                       AND confrelid = 'cortex_analysis_state'::regclass`,
                );
                return rows[0]?.n ?? 0;
            };
            expect(await cascadesToState()).toBe(1);
            // Named by Postgres's default for an inline column key. A rename would make
            // this throw rather than quietly leave the cascade in place and let the
            // assertions below pass for the wrong reason.
            await isolated.pool.query("ALTER TABLE cortex_plans DROP CONSTRAINT cortex_plans_analysis_id_fkey");
            expect(await cascadesToState()).toBe(0);

            const analysisId = `purge-nocascade-${run}`;
            const now = new Date().toISOString();
            await isolated.pool.query({
                text: `INSERT INTO cortex_analysis_state (analysis_id, status, created_at, updated_at) VALUES ($1, 'active', $2, $2)`,
                values: [analysisId, now],
            });
            await isolated.pool.query({
                text: `INSERT INTO cortex_plans (plan_id, analysis_id, plan, created_at) VALUES ($1, $2, '{"steps":[]}'::jsonb, $3)`,
                values: [`plan-${analysisId}`, analysisId, now],
            });

            const isolatedPurge = createAnalysisPurge({
                pool: isolated.pool,
                workflows: createDbosWorkflowPurger({ pool: isolated.pool }),
            });
            (await isolatedPurge.purgeAnalysis(analysisId))._unsafeUnwrap();

            const { rows } = await isolated.pool.query<{ plans: number; state: number }>({
                text: `SELECT (SELECT COUNT(*)::int FROM cortex_plans WHERE analysis_id = $1) AS plans,
                              (SELECT COUNT(*)::int FROM cortex_analysis_state WHERE analysis_id = $1) AS state`,
                values: [analysisId],
            });
            expect(rows[0]).toEqual({ plans: 0, state: 0 });
        } finally {
            await isolated.drop();
        }
    });

    it("succeeds reporting nothing for an analysis with no rows anywhere", async () => {
        const outcome = (await purge.purgeAnalysis(`purge-unknown-${run}`))._unsafeUnwrap();
        expect(outcome).toEqual({ threads: 0, messages: 0, workflows: 0, vectorIndexDropped: false });
    });

    it("succeeds reporting nothing on a second purge of the same analysis", async () => {
        const doomed = await seedAnalysis(`purge-twice-${run}`);

        const first = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrap();
        expect(first.threads).toBe(2);

        const second = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrap();
        expect(second).toEqual({ threads: 0, messages: 0, workflows: 0, vectorIndexDropped: false });
    });

    it("reports no vector index dropped when the analysis never had one", async () => {
        const doomed = await seedAnalysis(`purge-noindex-${run}`, { vectorIndex: false });
        expect(await vectorTableExists(doomed.analysisId)).toBe(false);

        const outcome = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrap();
        expect(outcome).toEqual({ threads: 2, messages: SEEDED_MESSAGES, workflows: 4, vectorIndexDropped: false });
        expect(await countsByAnalysis(doomed.analysisId)).toEqual(NOTHING_LEFT);
    });

    it("returns an error and deletes nothing when a workflow cannot be cancelled", async () => {
        const doomed = await seedAnalysis(`purge-nocancel-${run}`);

        // Only cancellation is stubbed; deletion still reaches the real ledger, so a
        // purge that pressed on regardless would show up as missing rows below.
        const cancelRefused: WorkflowPurger = {
            findByIdPrefix: (prefix) => purger.findByIdPrefix(prefix),
            cancel: () => errAsync({ type: "mutation_failed", op: "stub.cancel", cause: new Error("cancel refused") }),
            deleteWorkflows: (ids, includeDescendants) => purger.deleteWorkflows(ids, includeDescendants),
        };
        const refusing = createAnalysisPurge({ pool: rig.pool, workflows: cancelRefused });

        const failure = (await refusing.purgeAnalysis(doomed.analysisId))._unsafeUnwrapErr();
        expect(failure.op).toBe("stub.cancel");

        expect(await countsByAnalysis(doomed.analysisId)).toEqual(FULLY_SEEDED);
        expect(await countMessages(doomed.threadIds)).toBe(SEEDED_MESSAGES);
        expect(await vectorTableExists(doomed.analysisId)).toBe(true);
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(4);
    });

    it("returns an error and destroys nothing for an analysis id outside the purgeable shape", async () => {
        // An uppercase letter and a dot both survive `searchIndexName`, which only
        // swaps hyphens for underscores, so neither may reach the interpolated DDL. No
        // vector table is seeded because none can be: the vector store refuses the same
        // name on the write side.
        const analysisId = `Purge.Unsafe-${run}`;
        const doomed = await seedAnalysis(analysisId, { vectorIndex: false });

        const failure = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrapErr();
        expect(failure.op).toBe("purgeAnalysis.analysisId");

        // The refusal lands ahead of every destructive stage, so an id whose shape can
        // never conform cannot leave the analysis reclaimed-but-unreportable: its rows
        // are all still here, and a retry answers the same way at no cost.
        expect(await countsByAnalysis(doomed.analysisId)).toEqual(FULLY_SEEDED);
        expect(await countMessages(doomed.threadIds)).toBe(SEEDED_MESSAGES);
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(4);
        expect(await ledger.countCascadeRows(doomed.workflowIds)).toEqual(ledger.cascadeRows(4));
        // Untouched by the cancel stage too, which never ran.
        expect(await workflowStatuses(doomed.workflowIds)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING"]);
    });

    it("returns an error and destroys nothing for an analysis id carrying the workflow-namespace delimiter", async () => {
        // Profile workflows are found by the prefix `dataprofile:{analysisId}:`,
        // matched with `starts_with` and no delimiter check. An id holding a `:` is
        // ambiguous in that namespace: `dataprofile:a:` is equally a prefix of every
        // workflow id of an analysis named `a:x`, and each id the prefix returns is
        // cancelled and then deleted with its descendants — another analysis's ledger
        // rows and everything cascading off them. The id shape is what refuses it, so
        // the check cannot be narrowed to the derived table name without re-opening
        // this.
        const analysisId = `purge-colon-${run}:child`;
        const doomed = await seedAnalysis(analysisId, { vectorIndex: false });

        const failure = (await purge.purgeAnalysis(analysisId))._unsafeUnwrapErr();
        expect(failure.op).toBe("purgeAnalysis.analysisId");

        expect(await countsByAnalysis(analysisId)).toEqual(FULLY_SEEDED);
        expect(await countMessages(doomed.threadIds)).toBe(SEEDED_MESSAGES);
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(4);
        expect(await ledger.countCascadeRows(doomed.workflowIds)).toEqual(ledger.cascadeRows(4));
        expect(await workflowStatuses(doomed.workflowIds)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING"]);
    });

    it("returns an error for an empty analysis id, which derives a table belonging to no analysis", async () => {
        // The empty id derives the bare table prefix — a legal identifier that would
        // pass any check made of the derived name alone, while `dataprofile::` is a
        // prefix of every data-profile workflow in the ledger.
        expect(searchIndexName("")).toBe("search_");

        const failure = (await purge.purgeAnalysis(""))._unsafeUnwrapErr();
        expect(failure.op).toBe("purgeAnalysis.analysisId");
    });

    it("returns an error for an analysis id whose derived table name outgrows the identifier limit", async () => {
        // Postgres keeps only the first 63 bytes of an identifier, so two ids sharing a
        // long enough prefix derive one table — and a purge of either would drop the
        // other analysis's index.
        const analysisId = "a".repeat(60);
        const twin = `${analysisId}b`;
        expect(searchIndexName(analysisId).slice(0, 63)).toBe(searchIndexName(twin).slice(0, 63));

        const failure = (await purge.purgeAnalysis(analysisId))._unsafeUnwrapErr();
        expect(failure.op).toBe("purgeAnalysis.vectorIndexName");
    });

    it("returns an error and rolls the whole cortex stage back when one of its deletes fails", async () => {
        const doomed = await seedAnalysis(`purge-rollback-${run}`);

        // The asks delete sits in the middle of the shared transaction: the messages,
        // the thread rows, the artifacts, the step executions, the runs, and the working
        // memory have all already been deleted on the same client when this raises —
        // the partway state the transaction exists to undo.
        await rig.pool.query(
            `CREATE FUNCTION purge_asks_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated asks delete failure'; END; $$ LANGUAGE plpgsql`,
        );
        await rig.pool.query("CREATE TRIGGER purge_asks_boom_trg BEFORE DELETE ON cortex_asks FOR EACH ROW EXECUTE FUNCTION purge_asks_boom()");
        try {
            // The failing statement names which delete broke, so the rows below are the
            // rollback's work and not deletes that never got their turn.
            const failure = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrapErr();
            expect(failure.op).toBe("purgeAnalysis.asks");

            expect(await countsByAnalysis(doomed.analysisId)).toEqual(FULLY_SEEDED);
            expect(await countMessages(doomed.threadIds)).toBe(SEEDED_MESSAGES);
            // The drop is the stage after the transaction, so it never ran either.
            expect(await vectorTableExists(doomed.analysisId)).toBe(true);
        } finally {
            // The rig's pool is shared by every test in this file, so the trigger cannot
            // be left standing on the schema's `cortex_asks`.
            await rig.pool.query("DROP TRIGGER purge_asks_boom_trg ON cortex_asks");
            await rig.pool.query("DROP FUNCTION purge_asks_boom()");
        }
    });

    it("returns an error and keeps the workflow id mapping when the workflow delete fails", async () => {
        const doomed = await seedAnalysis(`purge-nodelete-${run}`);

        // Only deletion is stubbed; cancellation still reaches the real ledger, so the
        // failure lands exactly at the stage whose placement this pins.
        const deleteRefused: WorkflowPurger = {
            findByIdPrefix: (prefix) => purger.findByIdPrefix(prefix),
            cancel: (ids) => purger.cancel(ids),
            deleteWorkflows: () => errAsync({ type: "mutation_failed", op: "stub.deleteWorkflows", cause: new Error("delete refused") }),
        };
        const refusing = createAnalysisPurge({ pool: rig.pool, workflows: deleteRefused });

        const failure = (await refusing.purgeAnalysis(doomed.analysisId))._unsafeUnwrapErr();
        expect(failure.op).toBe("stub.deleteWorkflows");

        // `cortex_runs.run_id` IS the parent workflow id, and together with the
        // `dataprofile:{analysisId}:` namespace it is the only mapping from an analysis
        // to its workflows. It survives the failed stage, so the ledger rows this
        // attempt left behind are still reachable.
        const { rows } = await rig.pool.query<{ run_id: string }>({
            text: `SELECT run_id FROM cortex_runs WHERE analysis_id = $1`,
            values: [doomed.analysisId],
        });
        expect(rows.map((row) => row.run_id).sort()).toEqual([...doomed.runIds].sort());
        expect(await countsByAnalysis(doomed.analysisId)).toEqual(FULLY_SEEDED);
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(4);

        // What the surviving mapping is for: a retry over a working seam still finds
        // all four workflows and reclaims the whole footprint.
        const retried = (await purge.purgeAnalysis(doomed.analysisId))._unsafeUnwrap();
        expect(retried).toEqual({ threads: 2, messages: SEEDED_MESSAGES, workflows: 4, vectorIndexDropped: true });
        expect(await ledger.countStatusRows(doomed.workflowIds)).toBe(0);
        expect(await ledger.countCascadeRows(doomed.workflowIds)).toEqual(ledger.cascadeRows(0));
    });
});
