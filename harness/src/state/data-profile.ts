/**
 * Data-profile status operations — the `data_profile_*` columns on
 * `cortex_analysis_state`. Tracks the lifecycle of the per-analysis data
 * profiling pass (pending → running → completed | failed).
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Organism } from "../schemas/data-profile-schemas.js";
import type { Querier } from "./db.js";

/**
 * One profiled input file's **drift signature**. `fileId` is a path identity the
 * embedder derives (two files at the same path share it regardless of content),
 * so `size` + `mtimeMs` are what let a consumer notice that the bytes behind a
 * path changed. The harness treats all three as opaque labels: it persists them
 * verbatim and never stats a source file or compares signatures itself.
 */
export interface DataProfileInputFile {
    fileId: string;
    size: number;
    mtimeMs: number;
}

/**
 * One profiled file's persisted record.
 *
 * `path` + `description` are the original pair every snapshot carries. Everything
 * below them is **optional on read** for the same reason `DataProfileResult.inputFiles`
 * is: a snapshot written before the record was widened carries only the pair, and a
 * reader must render that row rather than reject it. A writer fills in whatever the
 * profiler reported.
 */
export interface DataProfileFile {
    path: string;
    description: string;
    /** Semantic data type (count-matrix, variants, clinical-metadata, document, …). */
    dataType?: string;
    /** File format (CSV, h5ad, VCF, BAM, …). */
    format?: string;
    rows?: number | null;
    cols?: number | null;
    /** Searchable labels the profiler attached. */
    tags?: string[];
    /** Quality issues specific to this file. */
    warnings?: string[];
    /** Flat format-specific metrics (sparsity, medianLibrarySize, tiTvRatio, …). */
    metrics?: Record<string, string | number | boolean>;
}

/** Dataset-wide quality findings the profiler recorded. */
export interface DataProfileQualityAssessment {
    concerns: string[];
    strengths: string[];
}

/**
 * The profile snapshot `completeDataProfile` persists and `loadDataProfileStatus` reads back.
 *
 * This row is the **only** durable home of the profile: the profiler's `runs/data-profile/`
 * scratch tree is wiped when profiling completes, so there is no file to fall back on. It
 * therefore carries the profiler's full finding, not a summary of it — anything dropped here
 * is destroyed, and a downstream agent can only recover it by re-reading the raw input files.
 *
 * Every field past `summary` / `files` / `inputFileIds` / `profiledAt` is **optional on read**:
 * a snapshot written before the record was widened carries only those four, and a reader must
 * render it rather than throw. There is no parse at the read boundary (the jsonb column is cast
 * straight to this type), so optionality *is* the compatibility mechanism — exactly as it
 * already is for `inputFiles`.
 */
export interface DataProfileResult {
    summary: string;
    files: DataProfileFile[];
    /** Which files the profile covered — the audit record. */
    inputFileIds: string[];
    /**
     * Whether the same bytes were covered — the drift comparand. Optional on read:
     * a snapshot written before this field existed carries only `inputFileIds`, and
     * a consumer treats the absence as drift (re-profiling repairs it), exactly as
     * it already treats a wholly absent `result`.
     */
    inputFiles?: DataProfileInputFile[];
    profiledAt: string;

    /** Scientific domain (transcriptomics, cheminformatics, clinical, …). */
    domain?: string;
    /** Specific subtype within the domain (bulk-rna-seq, single-cell, LC-MS/MS, …). */
    subtype?: string;
    /**
     * Subject organism with its provenance and confidence. Explicit `null` is a real,
     * distinct value — the profiler looked and no input identified an organism — as
     * opposed to absent, which means the snapshot predates this field.
     */
    organism?: Organism | null;
    tissue?: string | null;
    cellType?: string | null;
    condition?: string | null;
    /** Public dataset accessions found in any input (GSE/SRP/PRJNA/E-MTAB/phs/EGAS). */
    accessions?: string[];
    /** Conditions, groups, comparisons, replicates, pairing. */
    experimentalDesign?: string;
    qualityAssessment?: DataProfileQualityAssessment;
}

export interface DataProfileStatus {
    status: "pending" | "running" | "completed" | "failed";
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    result: DataProfileResult | null;
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
            SET data_profile_status = 'running', data_profile_started_at = $1
            WHERE analysis_id = $2 AND (data_profile_status = 'pending' OR data_profile_status IS NULL) AND ${SEEDED}`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/** Claim a `failed` row back into `running` (the deliberate-retry route). Carries {@link SEEDED}. */
export function tryRetryDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryRetryDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_error = NULL, data_profile_completed_at = NULL
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
 */
export function tryRerunDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryRerunDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_error = NULL, data_profile_completed_at = NULL
            WHERE analysis_id = $2 AND data_profile_status = 'completed' AND ${SEEDED}`,
            values: [now, analysisId],
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
                data_profile_result = NULL, seed_input_file_ids = NULL
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
            seed_input_file_ids: string[] | null;
        }>({
            text: `SELECT data_profile_status, data_profile_error,
                   data_profile_started_at, data_profile_completed_at,
                   data_profile_result, seed_input_file_ids
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
