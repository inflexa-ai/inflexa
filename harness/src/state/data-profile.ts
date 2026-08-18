/**
 * Data-profile status operations — the `data_profile_*` columns on
 * `cortex_analysis_state`. Tracks the lifecycle of the per-analysis data
 * profiling pass (pending → running → completed | failed).
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { DataProfileLifecycleStatus, DataProfileResult } from "../contracts/data-profile.js";
import type { Querier } from "./db.js";

/**
 * The persisted profile's shape lives in `contracts/` — it is read by consumers outside
 * this package (a host route, a UI), and they must not import this module, which pulls in
 * `pg` and the whole ledger query surface, to obtain a type. Re-exported here so ledger
 * call sites keep one import.
 */
export type {
    DataProfileAxis,
    DataProfileCoverage,
    DataProfileFile,
    DataProfileInputFile,
    DataProfileInputSignature,
    DataProfileKind,
    DataProfileOrganism,
    DataProfileQualityAssessment,
    DataProfileLifecycleStatus,
    DataProfileResult,
    DataProfileSubjectSource,
} from "../contracts/data-profile.js";

export interface DataProfileStatus {
    status: DataProfileLifecycleStatus;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    result: DataProfileResult | null;
    /**
     * The DBOS workflow id of the profile attempt that owns this row — the durable
     * event stream a consumer subscribes to for this profile's activity. `null` means
     * this profile's stream is not addressable (see
     * {@link recordDataProfileWorkflowId}).
     */
    workflowId: string | null;
    seedInputFileIds: string[] | null;
}

/**
 * The conjunct every claim into `running` carries: the row names a non-empty set
 * of seeded input files.
 *
 * It rides in the CAS rather than in a caller's pre-read because "a `running` row
 * records the input set it is profiling" is an invariant of the LEDGER, not of any
 * one orchestration — and `clearDataProfile` can null the seed of any non-`running`
 * row at any moment, so a pre-read followed by a claim is a race, not an enforcement.
 *
 * An empty array is not a seed. `upsertAnalysis` writes NULL to mean "leave the
 * stored seed alone" (its `COALESCE` conflict branch), so `[]` is a real value that
 * names zero files — a set no profile may run against. `jsonb_array_length` raises on
 * a non-array jsonb; the column is only ever written from `JSON.stringify(string[])`,
 * and surfacing a hand-corrupted row as a `DbError` beats silently claiming it.
 */
const SEEDED = "seed_input_file_ids IS NOT NULL AND jsonb_array_length(seed_input_file_ids) > 0";

/**
 * Try to claim a startable row into `running`. Startable means `'pending'` (seeded,
 * not yet run) or NULL (no profile: never profiled, or cleared by `clearDataProfile`).
 *
 * NULL must be claimable or a cleared analysis whose inputs return can never be
 * profiled again: the seed upsert's ON CONFLICT deliberately never rewrites profile
 * status, so the row stays NULL — and NULL matches neither the rerun (`completed`)
 * nor retry (`failed`) claims. A cleared row is therefore claimable only once a later
 * seed upsert has repopulated `seed_input_file_ids` (see {@link SEEDED}).
 *
 * `ok(true)` when this call won the CAS; `ok(false)` when it lost or the row is
 * unseeded — neither is an error, both stay in the ok channel.
 */
export function tryStartDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryStartDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_workflow_id = NULL
            WHERE analysis_id = $2 AND (data_profile_status = 'pending' OR data_profile_status IS NULL) AND ${SEEDED}`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Claim a `failed` row back into `running` (the deliberate-retry route). Carries {@link SEEDED}.
 *
 * Clears `data_profile_workflow_id`, because the claim IS the moment a new attempt takes the row
 * and the prior attempt's workflow is finished. Left in place it would leave the row `running`
 * while naming a stream that has already drained, so a consumer would subscribe and observe
 * nothing without knowing why; NULL says "not addressable yet", which is exactly true until the
 * new body records its own id (see {@link recordDataProfileWorkflowId}).
 */
export function tryRetryDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryRetryDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_error = NULL, data_profile_completed_at = NULL,
                data_profile_workflow_id = NULL
            WHERE analysis_id = $2 AND data_profile_status = 'failed' AND ${SEEDED}`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Claim a `completed` row back into `running` (the re-profile route). `data_profile_result`
 * is deliberately preserved so a consumer can keep serving the prior profile while the new
 * one runs. Carries {@link SEEDED}.
 *
 * `data_profile_workflow_id` is NOT preserved alongside it, and the asymmetry is the point: the
 * result is CONTENT that stays valid until replaced, while the id is a POINTER to a live stream
 * whose workflow is now finished. Keeping it would leave the row `running` while naming a drained
 * stream — see {@link tryRetryDataProfile} for the same reasoning.
 */
export function tryRerunDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryRerunDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_error = NULL, data_profile_completed_at = NULL,
                data_profile_workflow_id = NULL
            WHERE analysis_id = $2 AND data_profile_status = 'completed' AND ${SEEDED}`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Record the DBOS workflow id of the attempt that owns a claimed-`running` row, so a
 * consumer resolves which durable event stream carries this profile's activity from the
 * ledger row alone — no durability-engine query, no id reconstructed from the workflow-id
 * string format. The workflow BODY calls this, never the trigger: the claim CAS runs
 * before the workflow id is minted, so only the body can report the id of the attempt
 * that actually started.
 *
 * `AND data_profile_status = 'running'` buys exactly one thing: a write that lands late
 * cannot stamp a row that has already settled, which would otherwise point a consumer at
 * a workflow for a profile that is already finished. What it does NOT buy is
 * disambiguation between two attempts that each believe they are the running one — the
 * stale-expiry claim admits precisely that, since a row whose `data_profile_started_at`
 * has aged past the timeout can be claimed by a second attempt while the first body is
 * still alive but has not completed its first step, and that first step then overwrites
 * the second's id.
 *
 * That residue is deliberately left open rather than closed. Its worst outcome is already
 * a specified-normal state: a consumer subscribed to a superseded workflow reads a stream
 * that has already drained, so it observes no activity — indistinguishable from "running,
 * nothing reported yet". A missing activity line for one profile is acceptable; a wrong
 * one would not be. And closing it costs more than it buys: either the three claim
 * functions widen their `Result<boolean>` returns to carry the id — their callers branch
 * on truthiness (`if (!retried)`), so an object return makes every such branch
 * always-taken, a silent behaviour change in the embedder's recovery path — or the
 * embedder mints the workflow ids, putting a harness-internal construction in a
 * consumer's hands.
 *
 * `ok(true)` when this call stamped the row; `ok(false)` when the CAS refused it — a
 * normal in-band outcome, not an error.
 */
export function recordDataProfileWorkflowId(pool: Querier, analysisId: string, workflowId: string): ResultAsync<boolean, DbError> {
    return tryMutation("dataProfile.recordDataProfileWorkflowId", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_workflow_id = $1
            WHERE analysis_id = $2 AND data_profile_status = 'running'`,
            values: [workflowId, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Stamp a claimed-`running` row `completed` and record its result — a terminal
 * write CAS'd on `data_profile_status = 'running'`.
 *
 * The running guard is load-bearing, not decoration. This write runs as plain
 * workflow-body code, and the row it targets can be moved out from under it in the
 * window between the claim and this call: `clearDataProfile` nulls an emptied-inputs
 * row (its own guard only defers on a *running* row, so it succeeds on a `failed` one),
 * `expireStaleDataProfile` flips a slow run to `failed`, and DBOS recovery may replay
 * this body after either has landed. Without the guard a late completion re-stamps
 * `completed` + result over a since-cleared row, resurrecting exactly the seedless-
 * completed state the seed CAS forbids (`completed` with a NULL `seed_input_file_ids`).
 * Every legitimate caller reaches here from a row it claimed into `running`, so the
 * guard only ever refuses a row another writer already moved on from.
 *
 * `ok(true)` when this call stamped the row; `ok(false)` when the guard refused it
 * (the row was cleared/expired/replayed away) — a no-op the caller logs, not an error.
 */
export function completeDataProfile(pool: Querier, analysisId: string, result?: DataProfileResult): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.completeDataProfile", async () => {
        const res = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'completed', data_profile_completed_at = $1,
                data_profile_result = $2::jsonb
            WHERE analysis_id = $3 AND data_profile_status = 'running'`,
            values: [now, result ? JSON.stringify(result) : null, analysisId],
        });
        return (res.rowCount ?? 0) > 0;
    });
}

/**
 * Stamp a claimed-`running` row `failed` with a reason — the terminal-failure
 * counterpart to {@link completeDataProfile}, CAS'd on `data_profile_status = 'running'`
 * for the same reason: a workflow that fails after its row was cleared/expired
 * out from under it (or a recovery replay of that body) must not resurrect a
 * `failed` status over a cleared row. `data_profile_result` is left untouched so a
 * prior profile survives the failure (the re-profile/retry route can keep serving it).
 *
 * `ok(true)` when this call stamped the row; `ok(false)` when the guard refused it —
 * a logged no-op, not an error.
 */
export function failDataProfile(pool: Querier, analysisId: string, error: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.failDataProfile", async () => {
        const res = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'failed', data_profile_error = $1,
                data_profile_completed_at = $2
            WHERE analysis_id = $3 AND data_profile_status = 'running'`,
            values: [error, now, analysisId],
        });
        return (res.rowCount ?? 0) > 0;
    });
}

export function expireStaleDataProfile(pool: Querier, analysisId: string, timeoutMs: number): ResultAsync<boolean, DbError> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
    return tryMutation("dataProfile.expireStaleDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'failed',
                data_profile_error = 'Data profiling timed out',
                data_profile_completed_at = $1
            WHERE analysis_id = $2 AND data_profile_status = 'running'
              AND data_profile_started_at < $3`,
            values: [now.toISOString(), analysisId, cutoff],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Reset a ledger row wedged at `running` with no workflow behind it back to
 * `failed`, so the normal retry path can re-profile it.
 *
 * A start that rejects after the CAS already flipped the row to `running`
 * compensates itself (`triggerDataProfile`/`runDataProfile` fail the ledger in
 * their catch). This covers the residual case that compensation cannot: a host
 * that dies in the window between the CAS and the `DBOS.startWorkflow` insert
 * leaves a `running` row with no workflow for recovery to resume — nothing
 * would ever move it off `running`, and every later trigger reports
 * `already_running` forever.
 *
 * The `NOT EXISTS` guard keys off the DBOS workflow ledger directly (the same
 * `dataprofile:{analysisId}:{nonce}` id space this module's trigger mints) so a
 * genuinely in-flight or recovery-requeued run — whose `dbos.workflow_status`
 * row is PENDING/ENQUEUED/DELAYED — is never disturbed: only a row with no
 * active workflow is reset. Call it AFTER `DBOS.launch()` has run recovery, so
 * a resumable run has already been re-queued and is visible to the guard.
 */
export function reconcileOrphanedDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.reconcileOrphanedDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'failed',
                data_profile_error = 'Profiling never started (no backing workflow); reset for retry',
                data_profile_completed_at = $1
            WHERE analysis_id = $2 AND data_profile_status = 'running'
              AND NOT EXISTS (
                  SELECT 1 FROM dbos.workflow_status
                  WHERE workflow_uuid LIKE 'dataprofile:' || $2 || ':%'
                    AND status IN ('PENDING', 'ENQUEUED', 'DELAYED'))`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Clear an analysis's data profile back to the honest "no profile" state,
 * nulling every `data_profile_*` column plus the `seed_input_file_ids` the
 * profile was taken against. `ok(true)` when a row was cleared, `ok(false)`
 * when the clear was skipped (no such analysis, or a live profile) — a skip
 * stays in the ok channel, exactly like the sibling CAS ops.
 *
 * An emptied input set makes any existing profile a lie: it describes files
 * the analysis no longer has, so the UI must fall back to "not profiled". The
 * `IS DISTINCT FROM 'running'` guard defers the clear while a profiling workflow
 * is live, so this write does not race that workflow's own ledger updates;
 * reconciliation waits for the caller's next parity check once it settles.
 *
 * Deferring here is NOT what stops a late workflow from resurrecting a cleared
 * row — it cannot be, because a clear still succeeds once the row has left
 * `running`. The dangerous interleave is: `expireStaleDataProfile` flips a slow
 * run to `failed`, this clear then succeeds on that `failed` row, and the
 * still-live workflow finally reaches its terminal write against a since-cleared
 * row. That resurrection is closed at the OTHER end: `completeDataProfile` /
 * `failDataProfile` CAS on `data_profile_status = 'running'`, so a terminal write
 * finds no running row to stamp and no-ops instead of re-seeding the cleared one.
 */
export function clearDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    return tryMutation("dataProfile.clearDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = NULL, data_profile_error = NULL,
                data_profile_started_at = NULL, data_profile_completed_at = NULL,
                data_profile_result = NULL, data_profile_workflow_id = NULL,
                seed_input_file_ids = NULL
            WHERE analysis_id = $1 AND data_profile_status IS DISTINCT FROM 'running'`,
            values: [analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Load an analysis's data-profile ledger state. Returns `null` for BOTH miss
 * conditions, deliberately indistinguishable to consumers:
 *   - the analysis row does not exist, AND
 *   - the row exists but `data_profile_status IS NULL` — set by
 *     {@link clearDataProfile} when the input set empties (the cleared state is
 *     the same wire shape as a never-profiled analysis on purpose, so the UI
 *     falls back to "not profiled" uniformly).
 *
 * This collapsed null is a public contract: a non-null `analysisId` does NOT
 * guarantee a non-null status. Consumers must treat `null` uniformly as "no
 * profile" — never assume "row exists ⇒ status non-null" — and never read
 * `seedInputFileIds` from a `null` return (it rides along only on the non-null
 * branch). The pre-clearance state to check seed is not exposed here; read
 * `seed_input_file_ids` directly when a caller needs that distinction
 * (e.g. the seed-first guard in `triggerDataProfile`).
 */
export function loadDataProfileStatus(pool: Querier, analysisId: string): ResultAsync<DataProfileStatus | null, DbError> {
    return tryQuery("dataProfile.loadDataProfileStatus", async () => {
        const result = await pool.query<{
            data_profile_status: DataProfileStatus["status"] | null;
            data_profile_error: string | null;
            data_profile_started_at: string | null;
            data_profile_completed_at: string | null;
            data_profile_result: DataProfileStatus["result"];
            data_profile_workflow_id: string | null;
            seed_input_file_ids: string[] | null;
        }>({
            text: `SELECT data_profile_status, data_profile_error,
                   data_profile_started_at, data_profile_completed_at,
                   data_profile_result, data_profile_workflow_id, seed_input_file_ids
            FROM cortex_analysis_state WHERE analysis_id = $1`,
            values: [analysisId],
        });
        const row = result.rows[0];
        if (!row || row.data_profile_status === null) return null;
        return {
            status: row.data_profile_status,
            error: row.data_profile_error ?? null,
            startedAt: row.data_profile_started_at ?? null,
            completedAt: row.data_profile_completed_at ?? null,
            result: row.data_profile_result ?? null,
            workflowId: row.data_profile_workflow_id ?? null,
            seedInputFileIds: row.seed_input_file_ids ?? null,
        };
    });
}

/**
 * Read an analysis's raw `seed_input_file_ids`, without the NULL-status collapse
 * {@link loadDataProfileStatus} applies (which hides the seed of any cleared row).
 * Returns the seeded set, or `null` for BOTH "no such analysis row" AND "the row
 * exists but the column is NULL" — the two are deliberately indistinguishable here,
 * exactly as they are to the consumer: both mean "nothing to profile, no claim would
 * match". A stored `[]` returns as an empty array — a real value naming zero files,
 * which a caller refuses distinctly from a missing seed.
 *
 * Advisory only: this read never gates a claim. The seed conjunct that actually makes
 * a seedless `running` row impossible rides in each claim's CAS (see {@link SEEDED});
 * this exists so a caller can name WHY no claim would match before it fires one (the
 * seed-first guard in `triggerDataProfile`).
 */
export function loadSeedInputFileIds(pool: Querier, analysisId: string): ResultAsync<string[] | null, DbError> {
    return tryQuery("dataProfile.loadSeedInputFileIds", async () => {
        const result = await pool.query<{ seed: string[] | null }>({
            text: "SELECT seed_input_file_ids AS seed FROM cortex_analysis_state WHERE analysis_id = $1",
            values: [analysisId],
        });
        return result.rows[0]?.seed ?? null;
    });
}
