/**
 * purgeAnalysis — the single place that knows what an analysis's persisted
 * Postgres footprint is.
 *
 * A host asks for it with an `analysisId` and nothing else: every keyed store,
 * the analysis's dynamic vector-table name, and its workflow ids are all
 * derivable from that id, so no caller enumerates tables or supplies a run list.
 * The workflow ledger is part of the footprint, not a follow-on — the sandbox
 * transcripts and run-event streams live there and are the dominant share of an
 * analysis's stored bytes — and it is reached through the injected
 * `WorkflowPurger` seam so the durability engine stays out of the state layer.
 *
 * The stages run in one order, chosen for what a failure leaves behind:
 * capture ids, cancel, delete workflow rows, delete the `cortex_*` rows, drop the
 * vector table. Each stage carries the reason it sits where it does. Ahead of all
 * of them sits the one refusal the operation can raise on its own — a derived
 * vector-table name outside the shape that may be interpolated into DDL — because
 * a refusal is only useful while there is still something left to protect. There
 * is no single transaction across them: the purge spans app tables, a DDL `DROP TABLE`,
 * and the engine's system schema, so instead of faking atomicity every stage is
 * idempotent and the whole operation is safe to re-run. A purge of an unknown or
 * already-purged analysis therefore succeeds, reporting zeroes.
 *
 * What it does not reach, so that absent coverage is never read as delivered:
 * scheduled operational workflows (they belong to no analysis and accumulate
 * independently of any purge), target assessments and their annotations (a
 * separate top-level entity), the shared regulatory corpus, `messages` rows whose
 * thread row is already gone (nothing attributes them to an analysis), and
 * workspace files on disk (the embedder owns their disposal).
 */

import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { Pool, PoolClient } from "pg";

import type { WorkflowPurger } from "../execution/workflow-purger.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { tryMutation, tryQuery, withTransaction, type DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { searchIndexName } from "../workspace/search-config.js";

/**
 * The shape a per-analysis vector table name may take. The name is derived from a
 * caller-supplied `analysisId` and interpolated into DDL, because an identifier
 * cannot be a bind parameter — so a derived name outside this shape is refused
 * rather than sent. The vector store guards the same interpolation of the same
 * name on the write side; this is the reclaim side of it, and it answers with a
 * `DbError` because a throw would escape the Result a caller reads to tell a
 * failed purge from a completed one.
 *
 * The check runs at the entry point, before any destructive stage. Raised from the
 * drop instead — the last stage — it would answer `err` only after the workflows
 * had been cancelled, their ledger rows deleted, and every `cortex_*` row removed,
 * and it would answer `err` again on every retry, since the derived name never
 * changes: an analysis whose footprint is in fact entirely reclaimed could then
 * never be reported purged. Validating first means a refused name costs nothing —
 * nothing cancelled, no workflow row and no `cortex_*` row gone.
 */
const VECTOR_INDEX_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * The analysis-keyed deletes that follow the thread/message pair, in the order
 * they run.
 *
 * `cortex_plans` carries its own statement, immediately ahead of the
 * `cortex_analysis_state` row it hangs off. The foreign key between the two
 * cascades, so on a schema that has the key the statement is redundant — but the
 * table is provisioned with `CREATE TABLE IF NOT EXISTS`, which adds no
 * constraint to a table that already exists, so a database whose `cortex_plans`
 * predates the key never acquires one. Resting on the cascade alone would make
 * the completeness of a purge contingent on a constraint being present, and would
 * silently leave the plans behind wherever it is not. The statement removes the
 * rows either way; the cascade stays a backstop behind it.
 */
const ANALYSIS_KEYED_DELETES: readonly { readonly op: string; readonly sql: string }[] = [
    { op: "purgeAnalysis.artifacts", sql: "DELETE FROM cortex_artifacts WHERE analysis_id = $1" },
    { op: "purgeAnalysis.stepExecutions", sql: "DELETE FROM cortex_step_executions WHERE analysis_id = $1" },
    { op: "purgeAnalysis.runs", sql: "DELETE FROM cortex_runs WHERE analysis_id = $1" },
    { op: "purgeAnalysis.workingMemory", sql: "DELETE FROM cortex_working_memory WHERE analysis_id = $1" },
    { op: "purgeAnalysis.asks", sql: "DELETE FROM cortex_asks WHERE analysis_id = $1" },
    { op: "purgeAnalysis.askGrants", sql: "DELETE FROM cortex_ask_grants WHERE analysis_id = $1" },
    { op: "purgeAnalysis.plans", sql: "DELETE FROM cortex_plans WHERE analysis_id = $1" },
    { op: "purgeAnalysis.analysisState", sql: "DELETE FROM cortex_analysis_state WHERE analysis_id = $1" },
];

/**
 * What one invocation reclaimed. It is a report of this call, not a claim that
 * nothing anywhere remains — a re-run after a late write reclaims more and says
 * so.
 */
export interface AnalysisPurgeOutcome {
    readonly threads: number;
    readonly messages: number;
    readonly workflows: number;
    readonly vectorIndexDropped: boolean;
}

export interface AnalysisPurgeDeps {
    readonly pool: Pool;
    /** The workflow-ledger seam. Cancellation and deletion by id, engine-agnostic. */
    readonly workflows: WorkflowPurger;
    readonly logger?: Logger;
}

export interface AnalysisPurge {
    /**
     * Remove the analysis's entire persisted Postgres footprint. Absence is a
     * normal outcome: an unknown or already-purged analysis succeeds with zeroes.
     * Every failure rides the error channel — the operation never reports a purge
     * it did not achieve.
     */
    purgeAnalysis(analysisId: string): ResultAsync<AnalysisPurgeOutcome, DbError>;
}

/** Run one delete on the transaction's client and report how many rows it took. */
function deleteRows(client: PoolClient, op: string, text: string, analysisId: string): ResultAsync<number, DbError> {
    return tryMutation(op, async () => {
        const { rowCount } = await client.query({ text, values: [analysisId] });
        return rowCount ?? 0;
    });
}

export function createAnalysisPurge({ pool, workflows, logger: injected }: AnalysisPurgeDeps): AnalysisPurge {
    const logger = (injected ?? createNoopLogger()).named("purge-analysis");

    /**
     * Every workflow id the analysis can still be traced to, read while the rows
     * that record them are all still on disk. `cortex_runs.run_id` IS the parent
     * workflow id, and those rows together with the `dataprofile:{analysisId}:` id
     * namespace are the ONLY mapping from an analysis to its workflows: a delete
     * of `cortex_runs` that lands before this read completes strands the largest
     * part of the footprint permanently out of reach.
     */
    const collectWorkflowIds = (analysisId: string): ResultAsync<string[], DbError> =>
        tryQuery("purgeAnalysis.runWorkflowIds", async () => {
            const { rows } = await pool.query<{ run_id: string }>({
                text: "SELECT run_id FROM cortex_runs WHERE analysis_id = $1",
                values: [analysisId],
            });
            return rows.map((row) => row.run_id);
        }).andThen((runIds) =>
            workflows.findByIdPrefix(`dataprofile:${analysisId}:`).map((profileIds) => {
                logger.debug("collected workflow identity", { analysisId, runs: runIds.length, dataProfiles: profileIds.length });
                // The two id sources cannot overlap, but collapsing duplicates keeps a
                // repeated id out of the reclaimed count regardless.
                return [...new Set([...runIds, ...profileIds])];
            }),
        );

    /**
     * One transaction for the whole `cortex_*` stage, so a mid-stage failure leaves
     * no half-deleted analysis behind.
     */
    const deleteCortexRows = (analysisId: string): ResultAsync<{ readonly threads: number; readonly messages: number }, DbError> =>
        withTransaction(pool, "purgeAnalysis.cortexRows", (client) =>
            // `messages` has no `analysis_id` column and no foreign key: the only
            // route from an analysis to its messages is a join through its thread
            // rows. So the messages go first and the thread rows that name them go
            // second — reversed, the messages become unattributable and unreachable
            // by any later reclamation. No `deleted_at` filter on either: an archived
            // thread is still the analysis's, and a purge takes it too.
            deleteRows(
                client,
                "purgeAnalysis.messages",
                `DELETE FROM messages
                 WHERE thread_id IN (SELECT thread_id FROM cortex_analysis_threads WHERE analysis_id = $1)`,
                analysisId,
            )
                .andThen((messages) =>
                    deleteRows(client, "purgeAnalysis.threads", "DELETE FROM cortex_analysis_threads WHERE analysis_id = $1", analysisId).map((threads) => ({
                        threads,
                        messages,
                    })),
                )
                // Folded rather than run together, because the list is ordered and each
                // statement must land before the next one starts.
                .andThen((counts) =>
                    ANALYSIS_KEYED_DELETES.reduce<ResultAsync<number, DbError>>(
                        (stage, { op, sql }) => stage.andThen(() => deleteRows(client, op, sql, analysisId)),
                        okAsync(0),
                    ).map(() => counts),
                ),
        );

    /**
     * `vectorIndexDropped` is established by a `to_regclass` probe taken
     * immediately before the drop, because `DROP TABLE IF EXISTS` reports nothing
     * about whether it found anything. The probe resolves the name exactly as the
     * drop does — both go through `search_path` — and the drop runs regardless of
     * what the probe saw, so the window between them can at worst misreport the
     * flag for an analysis already being destroyed, never leave a table behind.
     *
     * `indexName` arrives already matched against `VECTOR_INDEX_NAME`; that is the
     * whole warrant for interpolating it into the DDL below.
     */
    const dropVectorIndex = (indexName: string): ResultAsync<boolean, DbError> =>
        tryQuery("purgeAnalysis.vectorIndexPresent", async () => {
            const { rows } = await pool.query<{ present: boolean }>({
                text: "SELECT to_regclass($1::text) IS NOT NULL AS present",
                values: [indexName],
            });
            return rows[0]?.present ?? false;
        }).andThen((present) =>
            tryMutation("purgeAnalysis.dropVectorIndex", async () => {
                await pool.query(`DROP TABLE IF EXISTS "${indexName}"`);
            }).map(() => present),
        );

    const purgeAnalysis = (analysisId: string): ResultAsync<AnalysisPurgeOutcome, DbError> => {
        const indexName = searchIndexName(analysisId);
        if (!VECTOR_INDEX_NAME.test(indexName)) {
            return errAsync<AnalysisPurgeOutcome, DbError>({
                type: "mutation_failed",
                op: "purgeAnalysis.vectorIndexName",
                cause: new Error(`purge-analysis: unsafe vector index name "${indexName}"`),
            });
        }
        return (
            collectWorkflowIds(analysisId)
                // Cancel before delete. Removing the status row of a running workflow
                // does not stop the executor running it, and that executor goes on
                // writing rows behind the delete — re-materializing exactly the orphans
                // the purge exists to remove. A failed cancel leaves that risk in place,
                // so it ends the purge rather than being absorbed into a completeness
                // claim the operation can no longer make.
                .andThen((ids) => workflows.cancel(ids).map(() => ids))
                // Workflow rows go before the `cortex_*` ledger that names them: a failure
                // here leaves the id mapping on disk and a retry finds it, whereas the
                // reverse order turns one transient failure into a permanent orphan.
                // Descendants are included because a run's child step workflows carry the
                // sandbox transcripts and are reachable only through their parent.
                .andThen((ids) => workflows.deleteWorkflows(ids, true))
                .andThen((workflowsRemoved) => deleteCortexRows(analysisId).map((counts) => ({ ...counts, workflows: workflowsRemoved })))
                // The vector table is dropped after the transaction rather than inside
                // it: `DROP TABLE` takes an ACCESS EXCLUSIVE lock, and enlisting it would
                // hold that lock for the duration of every row delete above.
                .andThen((reclaimed) => dropVectorIndex(indexName).map((vectorIndexDropped) => ({ ...reclaimed, vectorIndexDropped })))
                .map((outcome) => {
                    logger.info("purged analysis", { analysisId, ...outcome });
                    return outcome;
                })
        );
    };

    return { purgeAnalysis };
}
