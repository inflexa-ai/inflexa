/**
 * `cortex_analysis_state` operations — analysis lifecycle and billing context.
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

/**
 * Upsert a cortex_analysis_state row.
 *
 * The seed endpoint is called repeatedly; this function handles both the
 * initial INSERT and subsequent UPDATEs by writing ALL mutable fields on
 * every call. Re-upserts replace `context` and `billing_context` wholesale.
 *
 * User identity is derived from the ambient credential's JWT `sub` claim
 * at request time — not persisted in this table.
 *
 * INTENTIONAL: split-attribution across a single run.
 * If the seed re-upserts mid-workflow (e.g., the billing context's VK rotates),
 * in-flight steps that have already issued LLM calls keep the old attribution
 * on those calls, while subsequent steps in the same run pick up the new
 * identity on their next `billedAgent` resolution. This is by design —
 * usage rows contain full per-call attribution, so spend is
 * always assignable even when it crosses a rotation boundary.
 */
export function upsertAnalysis(
    pool: Querier,
    resourceId: string,
    context: string | null,
    billingContext: Record<string, string> | null,
    inputFileIds?: string[],
): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("analyses.upsertAnalysis", async () => {
        await pool.query({
            text: `INSERT INTO cortex_analysis_state
            (analysis_id, status, context, billing_context, data_profile_status,
             seed_input_file_ids, created_at, updated_at)
            VALUES ($1, 'active', $2, $3::jsonb, 'pending', $4::jsonb, $5, $6)
            ON CONFLICT (analysis_id) DO UPDATE SET
              context = EXCLUDED.context,
              billing_context = EXCLUDED.billing_context,
              seed_input_file_ids = COALESCE(EXCLUDED.seed_input_file_ids, cortex_analysis_state.seed_input_file_ids),
              updated_at = EXCLUDED.updated_at`,
            values: [
                resourceId,
                context ?? null,
                billingContext === null ? null : JSON.stringify(billingContext),
                inputFileIds ? JSON.stringify(inputFileIds) : null,
                now,
                now,
            ],
        });
    });
}

export function loadAnalysisStatus(pool: Querier, resourceId: string): ResultAsync<{ status: string; context: string | null } | null, DbError> {
    return tryQuery("analyses.loadAnalysisStatus", async () => {
        const result = await pool.query<{ status: string; context: string | null }>({
            text: "SELECT status, context FROM cortex_analysis_state WHERE analysis_id = $1",
            values: [resourceId],
        });
        const row = result.rows[0];
        if (!row) return null;
        return { status: row.status, context: row.context ?? null };
    });
}

/**
 * Suspend an analysis due to a 402 `budget_exceeded` error.
 * Idempotent — no-op if already suspended.
 *
 * The only cause of suspension today is budget exhaustion; no reason is
 * persisted. If a second cause arises, add a column rather than a param so
 * history is queryable.
 */
export function suspendAnalysis(pool: Querier, analysisId: string): ResultAsync<void, DbError> {
    return tryMutation("analyses.suspendAnalysis", async () => {
        await pool.query({
            text: `UPDATE cortex_analysis_state
            SET status = 'suspended_insufficient_funds', updated_at = $1
            WHERE analysis_id = $2 AND status != 'suspended_insufficient_funds'`,
            values: [new Date().toISOString(), analysisId],
        });
    });
}

/**
 * Resume a suspended analysis after the user tops up.
 * Only transitions from `suspended_insufficient_funds` → `active`.
 */
export function resumeAnalysis(pool: Querier, analysisId: string): ResultAsync<void, DbError> {
    return tryMutation("analyses.resumeAnalysis", async () => {
        await pool.query({
            text: `UPDATE cortex_analysis_state
            SET status = 'active', updated_at = $1
            WHERE analysis_id = $2 AND status = 'suspended_insufficient_funds'`,
            values: [new Date().toISOString(), analysisId],
        });
    });
}

/**
 * Resolve the persisted billing context for an analysis.
 *
 * Single DB-read chokepoint used by `requireAnalysisBilling` middleware and
 * by any downstream code that needs to re-read billing identity. The driver
 * read is wrapped as a `DbError`; the missing-row / null-billing /
 * unparseable-JSON cases are control-flow throws (a misconfiguration, not a
 * driver failure) that short-circuit the chain and surface verbatim.
 *
 * User identity (`HEADERS.User`) is derived from the ambient credential's
 * JWT `sub` claim by `credential-middleware`, not from the DB.
 */
export function resolveAnalysisBilling(pool: Querier, analysisId: string): ResultAsync<{ billingContext: Record<string, string> }, DbError> {
    return tryQuery("analyses.resolveAnalysisBilling", () =>
        pool.query<{
            billing_context: Record<string, string> | string | null;
        }>({
            text: "SELECT billing_context FROM cortex_analysis_state WHERE analysis_id = $1",
            values: [analysisId],
        }),
    ).map((result) => {
        const row = result.rows[0];
        if (!row) {
            throw new Error(`resolveAnalysisBilling: no cortex_analysis_state row for analysisId=${analysisId}`);
        }
        const rawBilling = row.billing_context;
        if (rawBilling === null || rawBilling === undefined) {
            throw new Error(`resolveAnalysisBilling: billing_context missing for analysisId=${analysisId}`);
        }
        // JSONB is parsed by `pg` into native objects. Legacy TEXT rows (if any
        // slipped through) arrive as strings — parse them.
        let billingContext: Record<string, string>;
        if (typeof rawBilling === "string") {
            try {
                billingContext = JSON.parse(rawBilling) as Record<string, string>;
            } catch (err) {
                throw new Error(
                    `resolveAnalysisBilling: billing_context is not valid JSON for analysisId=${analysisId}: ${err instanceof Error ? err.message : err}`,
                );
            }
        } else {
            billingContext = rawBilling;
        }
        return { billingContext };
    });
}
