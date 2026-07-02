/**
 * `cortex_artifacts` operations — artifact upsert, lookup, and file-id
 * reconciliation.
 */

import type { Querier } from "./db.js";
import type { ArtifactRow } from "./schema.js";

export interface RegisterArtifactInput {
    resourceId: string;
    path: string;
    hash: string;
    size: number;
    role: "input" | "step_output";
    sourceStep?: string | null;
    sourceRun?: string | null;
    fileType?: string | null;
    /**
     * Upstream file identity. Set for `input` rows at materialization so
     * provenance lineage can attribute data inputs by `fileId`; left null for
     * `step_output` rows (their `file_id` is assigned after upload-sync).
     */
    fileId?: string | null;
}

export async function upsertArtifact(pool: Querier, entry: RegisterArtifactInput): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_artifacts
          (analysis_id, path, hash, size, role, source_step, source_run, file_type, file_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (analysis_id, path) DO UPDATE SET
            hash = EXCLUDED.hash,
            size = EXCLUDED.size,
            role = EXCLUDED.role,
            source_step = EXCLUDED.source_step,
            source_run = EXCLUDED.source_run,
            file_type = COALESCE(EXCLUDED.file_type, cortex_artifacts.file_type),
            file_id = COALESCE(EXCLUDED.file_id, cortex_artifacts.file_id)`,
        values: [
            entry.resourceId,
            entry.path,
            entry.hash,
            entry.size,
            entry.role,
            entry.sourceStep ?? null,
            entry.sourceRun ?? null,
            entry.fileType ?? null,
            entry.fileId ?? null,
            now,
        ],
    });
}

const COLS_PER_ROW = 10;

/**
 * Rows per INSERT statement. The Postgres extended protocol carries the Bind
 * message's parameter count as an Int16, so a statement is capped at 65,535
 * bind parameters — beyond that the count silently wraps and the server
 * rejects with 08P01 ("bind message has N parameter formats but 0
 * parameters"). 1,000 rows × 10 columns stays an order of magnitude under the
 * cap while keeping round-trips negligible even for huge input manifests.
 */
const ROWS_PER_STATEMENT = 1_000;

/**
 * Batched upsert — writes entries in multi-row `INSERT ... VALUES` statements
 * of at most {@link ROWS_PER_STATEMENT} rows. Callers range from per-step
 * manifests (tens of files) to a data-profile's full staged-input manifest
 * (unbounded — directory inputs can reach tens of thousands of files).
 * Chunks run sequentially without a wrapping transaction: the upsert is
 * idempotent per row (`ON CONFLICT ... DO UPDATE`), so a failure between
 * chunks is healed by the caller's retry re-upserting the same manifest.
 */
export async function upsertArtifacts(pool: Querier, entries: RegisterArtifactInput[]): Promise<void> {
    const now = new Date().toISOString();
    for (let start = 0; start < entries.length; start += ROWS_PER_STATEMENT) {
        const chunk = entries.slice(start, start + ROWS_PER_STATEMENT);
        const placeholders = chunk
            .map((_, i) => {
                const base = i * COLS_PER_ROW;
                return (
                    `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
                    `$${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`
                );
            })
            .join(", ");
        const values = chunk.flatMap((e) => [
            e.resourceId,
            e.path,
            e.hash,
            e.size,
            e.role,
            e.sourceStep ?? null,
            e.sourceRun ?? null,
            e.fileType ?? null,
            e.fileId ?? null,
            now,
        ]);
        await pool.query({
            text: `INSERT INTO cortex_artifacts
          (analysis_id, path, hash, size, role, source_step, source_run, file_type, file_id, created_at)
          VALUES ${placeholders}
          ON CONFLICT (analysis_id, path) DO UPDATE SET
            hash = EXCLUDED.hash,
            size = EXCLUDED.size,
            role = EXCLUDED.role,
            source_step = EXCLUDED.source_step,
            source_run = EXCLUDED.source_run,
            file_type = COALESCE(EXCLUDED.file_type, cortex_artifacts.file_type),
            file_id = COALESCE(EXCLUDED.file_id, cortex_artifacts.file_id)`,
            values,
        });
    }
}

/** Result type for input artifact metadata lookups. */
export interface InputArtifactMeta {
    path: string;
    hash: string;
    size: number;
    fileId: string | null;
}

/**
 * Query cortex_artifacts for input-role rows matching the given paths.
 * Used at the registration boundary to resolve metadata for data-source inputs.
 */
export async function queryInputArtifacts(pool: Querier, analysisId: string, paths: string[]): Promise<InputArtifactMeta[]> {
    if (paths.length === 0) return [];
    const result = await pool.query<{
        path: string;
        hash: string;
        size: number;
        file_id: string | null;
    }>({
        text: `SELECT path, hash, size, file_id
          FROM cortex_artifacts
          WHERE analysis_id = $1 AND role = 'input' AND path = ANY($2::text[])`,
        values: [analysisId, paths],
    });
    return result.rows.map((r) => ({
        path: r.path,
        hash: r.hash,
        size: Number(r.size),
        fileId: r.file_id ?? null,
    }));
}

export async function queryUnsyncedStepArtifacts(pool: Querier, resourceId: string, runId: string, stepId: string): Promise<ArtifactRow[]> {
    const result = await pool.query({
        text: `SELECT analysis_id, path, artifact_id, file_id, hash, size, role,
                 source_step, source_run, created_at, file_type
          FROM cortex_artifacts
          WHERE analysis_id = $1 AND source_run = $2 AND source_step = $3
            AND artifact_id IS NOT NULL AND file_id IS NULL
            AND role = 'step_output'
          ORDER BY created_at`,
        values: [resourceId, runId, stepId],
    });
    return result.rows.map(mapArtifactRow);
}

/** Count step-output artifacts produced by a run — for the run-completed card. */
export async function countArtifactsForRun(pool: Querier, analysisId: string, runId: string): Promise<number> {
    const result = await pool.query<{ n: string }>({
        text: `SELECT COUNT(*)::text AS n
          FROM cortex_artifacts
          WHERE analysis_id = $1 AND source_run = $2 AND role = 'step_output'`,
        values: [analysisId, runId],
    });
    return Number(result.rows[0]?.n ?? 0);
}

export async function updateArtifactId(pool: Querier, resourceId: string, path: string, artifactId: string, fileType?: string | null): Promise<void> {
    await pool.query({
        text: `UPDATE cortex_artifacts SET artifact_id = $1,
             file_type = COALESCE($4, file_type)
           WHERE analysis_id = $2 AND path = $3`,
        values: [artifactId, resourceId, path, fileType ?? null],
    });
}

export async function updateFileIds(pool: Querier, pairs: Array<{ artifactId: string; fileId: string }>): Promise<void> {
    if (pairs.length === 0) return;
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < pairs.length; i++) {
        const base = i * 2;
        tuples.push(`($${base + 1}::text, $${base + 2}::text)`);
        values.push(pairs[i]!.artifactId, pairs[i]!.fileId);
    }
    await pool.query({
        text: `UPDATE cortex_artifacts AS a
           SET file_id = c.file_id
           FROM (VALUES ${tuples.join(", ")}) AS c(artifact_id, file_id)
           WHERE a.artifact_id = c.artifact_id`,
        values,
    });
}

function mapArtifactRow(row: Record<string, unknown>): ArtifactRow {
    return {
        resourceId: row.analysis_id as string,
        path: row.path as string,
        artifactId: (row.artifact_id as string) ?? null,
        fileId: (row.file_id as string) ?? null,
        hash: row.hash as string,
        size: Number(row.size),
        role: row.role as ArtifactRow["role"],
        sourceStep: (row.source_step as string) ?? null,
        sourceRun: (row.source_run as string) ?? null,
        createdAt: row.created_at as string,
        unrecoverableAt: (row.unrecoverable_at as string) ?? null,
        fileType: (row.file_type as string) ?? null,
    };
}
