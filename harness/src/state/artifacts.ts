/**
 * `cortex_artifacts` operations — artifact upsert, lookup, and file-id
 * reconciliation.
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import type { ArtifactRole, ArtifactRow } from "./schema.js";

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

export function upsertArtifact(pool: Querier, entry: RegisterArtifactInput): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("artifacts.upsertArtifact", async () => {
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
export function upsertArtifacts(pool: Querier, entries: RegisterArtifactInput[]): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("artifacts.upsertArtifacts", async () => {
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
    });
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
export function queryInputArtifacts(pool: Querier, analysisId: string, paths: string[]): ResultAsync<InputArtifactMeta[], DbError> {
    return tryQuery("artifacts.queryInputArtifacts", async () => {
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
    });
}

export function queryUnsyncedStepArtifacts(pool: Querier, resourceId: string, runId: string, stepId: string): ResultAsync<ArtifactRow[], DbError> {
    return tryQuery("artifacts.queryUnsyncedStepArtifacts", async () => {
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
    });
}

/** One registered step output, as a downstream consumer needs to name it. */
export interface StepArtifactRef {
    /** Workspace-root-relative path (`runs/{runId}/{stepId}/output/de.csv`). */
    path: string;
    fileType: string | null;
}

/**
 * The artifacts a completed step registered, most consequential first. Ordered
 * by artifact kind (outputs, then figures, notebooks, scripts, logs) and then by
 * path, so a `limit` truncates the tail of the list rather than an arbitrary
 * slice of it — and so the same call replays to the same rows.
 */
export function queryStepArtifactPaths(
    pool: Querier,
    resourceId: string,
    runId: string,
    stepId: string,
    limit: number,
): ResultAsync<StepArtifactRef[], DbError> {
    return tryQuery("artifacts.queryStepArtifactPaths", async () => {
        if (limit <= 0) return [];
        const result = await pool.query<{ path: string; file_type: string | null }>({
            text: `SELECT path, file_type
          FROM cortex_artifacts
          WHERE analysis_id = $1 AND source_run = $2 AND source_step = $3
            AND role = 'step_output'
          ORDER BY CASE file_type
                     WHEN 'output' THEN 0
                     WHEN 'figure' THEN 1
                     WHEN 'notebook' THEN 2
                     WHEN 'script' THEN 3
                     ELSE 4
                   END,
                   path
          LIMIT $4`,
            values: [resourceId, runId, stepId, limit],
        });
        return result.rows.map((r) => ({ path: r.path, fileType: r.file_type ?? null }));
    });
}

/** One registered artifact of an analysis, as a reader of the full artifact set names it. */
export interface AnalysisArtifactRef {
    /** Workspace-root-relative path (`runs/{runId}/{stepId}/output/de.csv`). */
    path: string;
    hash: string;
    fileType: string | null;
}

/**
 * Every artifact of one analysis, ordered by path so the same call gives the same rows.
 *
 * The query applies no filter. An input row is a member, the same as a step output. A row that carries
 * `unrecoverable_at` is a member too, because the artifact existed at the moment of this read. If the
 * query drops such a row, a later refusal says that the artifact never existed, and that reason is
 * false.
 */
export function queryAnalysisArtifacts(pool: Querier, analysisId: string): ResultAsync<AnalysisArtifactRef[], DbError> {
    return tryQuery("artifacts.queryAnalysisArtifacts", async () => {
        const result = await pool.query<{ path: string; hash: string; file_type: string | null }>({
            text: `SELECT path, hash, file_type
          FROM cortex_artifacts
          WHERE analysis_id = $1
          ORDER BY path`,
            values: [analysisId],
        });
        return result.rows.map((r) => ({ path: r.path, hash: r.hash, fileType: r.file_type ?? null }));
    });
}

/** The sort of {@link queryArtifactPage}: `path` is path order, `recent` is newest registration first. */
export type ArtifactPageSort = "path" | "recent";

/**
 * The extension of `path` in lower case: the text after the last dot of the file name, which is the part after the
 * last `/`. The pattern needs one character or more before that dot and one or more after it, thus a name with no dot,
 * a name whose only dot is its first character, and a name that ends with a dot give `NULL`.
 */
const EXTENSION_SQL = `lower(substring(regexp_replace(path, '^.*/', '') from '^.+\\.([^.]+)$'))`;

/** The filters, the sort, and the window of {@link queryArtifactPage}. A filter that is absent selects each row. */
export interface ArtifactPageQuery {
    runId?: string;
    stepId?: string;
    fileType?: string;
    /** A part of the path, with no regard to case. Each character matches only itself. */
    q?: string;
    /** The whole path, with case. It selects the one row of that path. */
    path?: string;
    /**
     * Extensions in lower case, with no dot. A row is selected when the extension of its path is a member. A row with
     * no extension never matches, and an empty list selects each row. The read compares the members as they are.
     */
    extensions?: readonly string[];
    sort: ArtifactPageSort;
    limit: number;
    offset: number;
}

/** One ledger row of {@link queryArtifactPage}. */
export interface ArtifactPageEntry {
    /** Workspace-root-relative path (`runs/{runId}/{stepId}/output/de.csv`). */
    path: string;
    /** Bytes. */
    size: number;
    fileType: string | null;
    role: ArtifactRole;
    runId: string | null;
    stepId: string | null;
    createdAt: string;
}

/** The count of the selected rows that have one extension. */
export interface ArtifactExtensionCount {
    /** The extension in lower case with no dot, or `null` for the rows that have no extension. */
    extension: string | null;
    count: number;
}

/** One page of the ledger, and the count of the rows that the filters select. */
export interface ArtifactPage {
    entries: ArtifactPageEntry[];
    total: number;
    /** The selected rows by extension, in the order of the extension with `null` last. The counts sum to `total`. */
    extensionCounts: ArtifactExtensionCount[];
}

/**
 * One page of the artifact ledger of an analysis, in two statements: the count of the rows that the filters
 * select, grouped by extension, and the page. The count is a separate statement because a page past the end has no
 * row to carry it. `total` is the sum of the groups.
 *
 * Every row of the analysis is a member, an `input` row and a row with `unrecoverable_at` included. The cost
 * grows with the ledger of the one analysis, because the count reads each filtered row.
 */
export function queryArtifactPage(pool: Querier, analysisId: string, query: ArtifactPageQuery): ResultAsync<ArtifactPage, DbError> {
    return tryQuery("artifacts.queryArtifactPage", async () => {
        const values: unknown[] = [analysisId];
        const conditions = ["analysis_id = $1"];
        const bind = (value: unknown): string => {
            values.push(value);
            return `$${values.length}`;
        };
        if (query.runId !== undefined) conditions.push(`source_run = ${bind(query.runId)}`);
        if (query.stepId !== undefined) conditions.push(`source_step = ${bind(query.stepId)}`);
        if (query.fileType !== undefined) conditions.push(`file_type = ${bind(query.fileType)}`);
        // `LIKE` would turn `%` and `_` of the input into wildcards.
        if (query.q !== undefined) conditions.push(`strpos(lower(path), lower(${bind(query.q)}::text)) > 0`);
        if (query.path !== undefined) conditions.push(`path = ${bind(query.path)}`);
        if (query.extensions !== undefined && query.extensions.length > 0) {
            conditions.push(`${EXTENSION_SQL} = ANY(${bind([...query.extensions])}::text[])`);
        }
        const where = conditions.join(" AND ");

        const countResult = await pool.query<{ extension: string | null; n: number }>({
            text: `SELECT ${EXTENSION_SQL} AS extension, COUNT(*)::int AS n
          FROM cortex_artifacts
          WHERE ${where}
          GROUP BY 1
          ORDER BY 1 ASC NULLS LAST`,
            values,
        });
        const extensionCounts = countResult.rows.map((r) => ({ extension: r.extension ?? null, count: Number(r.n) }));
        // `path` is unique in one analysis, thus it breaks each tie and two pages never overlap.
        const order = query.sort === "recent" ? "created_at DESC, path ASC" : "path ASC";
        const rowsResult = await pool.query<{
            path: string;
            size: string | number;
            file_type: string | null;
            role: ArtifactRole;
            source_run: string | null;
            source_step: string | null;
            created_at: string;
        }>({
            text: `SELECT path, size, file_type, role, source_run, source_step, created_at
          FROM cortex_artifacts
          WHERE ${where}
          ORDER BY ${order}
          LIMIT ${bind(query.limit)} OFFSET ${bind(query.offset)}`,
            values,
        });
        return {
            entries: rowsResult.rows.map((r) => ({
                path: r.path,
                size: Number(r.size),
                fileType: r.file_type ?? null,
                role: r.role,
                runId: r.source_run ?? null,
                stepId: r.source_step ?? null,
                createdAt: r.created_at,
            })),
            total: extensionCounts.reduce((sum, e) => sum + e.count, 0),
            extensionCounts,
        };
    });
}

/** The step-output count of one run, from {@link countArtifactsByRuns}. */
export interface RunArtifactCount {
    runId: string;
    count: number;
}

/**
 * The step-output count of each run of a list, in one statement. A run with no step output has no entry,
 * and a caller reads it as 0. An `input` row never counts. The run-completed card and a list of runs use
 * this one rule.
 */
export function countArtifactsByRuns(pool: Querier, analysisId: string, runIds: readonly string[]): ResultAsync<RunArtifactCount[], DbError> {
    return tryQuery("artifacts.countArtifactsByRuns", async () => {
        if (runIds.length === 0) return [];
        const result = await pool.query<{ source_run: string; n: number }>({
            text: `SELECT source_run, COUNT(*)::int AS n
          FROM cortex_artifacts
          WHERE analysis_id = $1 AND source_run = ANY($2::text[]) AND role = 'step_output'
          GROUP BY source_run`,
            values: [analysisId, [...runIds]],
        });
        return result.rows.map((r) => ({ runId: r.source_run, count: Number(r.n) }));
    });
}

export function updateArtifactId(pool: Querier, resourceId: string, path: string, artifactId: string, fileType?: string | null): ResultAsync<void, DbError> {
    return tryMutation("artifacts.updateArtifactId", async () => {
        await pool.query({
            text: `UPDATE cortex_artifacts SET artifact_id = $1,
             file_type = COALESCE($4, file_type)
           WHERE analysis_id = $2 AND path = $3`,
            values: [artifactId, resourceId, path, fileType ?? null],
        });
    });
}

export function updateFileIds(pool: Querier, pairs: Array<{ artifactId: string; fileId: string }>): ResultAsync<void, DbError> {
    return tryMutation("artifacts.updateFileIds", async () => {
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
