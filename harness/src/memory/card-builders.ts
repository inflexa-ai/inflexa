/**
 * Shared builders for the display-card data parts (`data-plan`,
 * `data-presentation`, `data-run-card`, `data-file-reference`).
 *
 * Display tools (`show_plan`, `show_user`, `show_file`) emit these cards live
 * over the chat SSE stream, but the persisted turn keeps only the Anthropic
 * transcript (text / tool_use / tool_result) — the cards are not stored. To
 * re-render a card on reload, `content-to-cortex` reconstructs it from the
 * tool_use block via these same builders, so the live and replayed cards are
 * byte-identical (the deterministic `id` matches, enabling downstream
 * reconciliation).
 *
 * The builders return the FLAT wire `data` payload (no `type` wrapper, no
 * `source`): the tool emits `{ type, source, data }` (the emit pipeline
 * flattens `data` onto the wire), while the read path spreads the payload
 * under the part `type` directly.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { okAsync, type ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import { tryQuery, type DbError } from "../lib/db-result.js";
import { tryFs, type FsError } from "../lib/fs-result.js";
import { AnalysisPlanSchema } from "../schemas/workflow-state.js";
import { loadPlan } from "../state/index.js";
import { normalizeEchartSpec } from "../tools/display/normalize-echart-spec.js";
import { validatePath } from "../tools/lib/path-validation.js";
import { latestPreviewVersion, previewDir, PREVIEWS_ROOT } from "../workspace/paths.js";

const PREVIEW_META_FILE = "preview-meta.json";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PlanCardData {
    id: string;
    planId: string;
    title?: string;
    steps: unknown;
    analytical_narrative: unknown;
    omicsType: unknown;
    omicsSubtype: unknown;
}

export interface PresentationCardData {
    id: string;
    title?: string;
    content: Record<string, unknown>;
}

export interface RunCardData {
    id: string;
    runId: string;
    planId: string;
    title: string;
    stepCount: number;
}

export interface PreviewCardData {
    id: string;
    previewId: string;
    version: number;
    title: string;
    previewPath: string;
    format: "html" | "pdf";
}

/** Deterministic presentation id — must match `show_user`'s. */
function presentationId(input: Record<string, unknown>): string {
    const hash = createHash("sha256")
        .update(JSON.stringify(input, Object.keys(input).sort()))
        .digest("hex")
        .slice(0, 16);
    return `pres-${hash}`;
}

/** Build the `data-plan` payload by loading the stored plan. `ok(null)` when
 *  the plan is missing or no longer parses (absence is NOT an error) — the
 *  caller falls back to a chip. */
export function buildPlanCardData(pool: Pool, planId: string, analysisId: string, title?: string): ResultAsync<PlanCardData | null, DbError> {
    return loadPlan(pool, planId, { analysisId }).map((plan) => {
        if (!plan) return null;
        const parsed = AnalysisPlanSchema.safeParse(plan);
        if (!parsed.success) return null;

        const id = `pres-${createHash("sha256").update(planId).digest("hex").slice(0, 16)}`;
        // Explicit `show_plan({ title })` overrides; otherwise default to the
        // planner-set plan title so both cards share one source.
        const heading = title ?? parsed.data.title;
        return {
            id,
            planId,
            ...(heading !== undefined ? { title: heading } : {}),
            steps: parsed.data.steps,
            analytical_narrative: parsed.data.analytical_narrative,
            omicsType: parsed.data.omicsType,
            omicsSubtype: parsed.data.omicsSubtype,
        };
    });
}

/** Build the `data-run-card` payload for a started analysis run. Loads the
 *  plan (for `title` + `stepCount`) the same way `buildPlanCardData` does. The
 *  live emit path passes the freshly-minted `runId`; the reconstruct-on-read
 *  path omits it and the most recent run for `(analysisId, planId)` is looked
 *  up from `cortex_runs`. Null when the plan or run cannot be resolved — the
 *  caller falls back to a chip. */
export function buildRunCardData(pool: Pool, opts: { planId: string; analysisId: string; runId?: string }): ResultAsync<RunCardData | null, DbError> {
    const { planId, analysisId } = opts;
    return loadPlan(pool, planId, { analysisId }).andThen((plan) => {
        if (!plan) return okAsync(null);
        const parsed = AnalysisPlanSchema.safeParse(plan);
        if (!parsed.success) return okAsync(null);

        const finalize = (runId: string | undefined): RunCardData | null => {
            if (!runId) return null;
            const omicsType = parsed.data.omicsType;
            const title = parsed.data.title?.trim() || (omicsType ? `${omicsType} analysis` : "Analysis run");
            const id = `pres-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
            return {
                id,
                runId,
                planId,
                title,
                stepCount: parsed.data.steps.length,
            };
        };

        if (opts.runId) return okAsync(finalize(opts.runId));

        return tryQuery("cardBuilders.buildRunCardData.latestRun", async () => {
            const result = await pool.query<{ run_id: string }>({
                text: `SELECT run_id FROM cortex_runs
               WHERE analysis_id = $1 AND plan_id = $2
               ORDER BY started_at DESC LIMIT 1`,
                values: [analysisId, planId],
            });
            return result.rows[0]?.run_id;
        }).map(finalize);
    });
}

/** Build the `data-presentation` payload from the `show_user` tool input.
 *  Self-contained — the card lives entirely in the input.
 *
 *  An `echart` spec passes through `normalizeEchartSpec` HERE rather than in the tool body, because
 *  this builder is the single construction site of a `PresentationContent`: normalizing in
 *  `show_user.execute` alone would leave the reconstruct-on-read path (which sees only the persisted
 *  raw `tool_use` input) rendering the un-normalized chart, breaking the byte-identical live/replay
 *  card this module exists to guarantee. The `id` stays keyed to the raw input, which both paths
 *  hold identically, so normalization cannot move a card's identity. */
export function buildPresentationCardData(input: Record<string, unknown>): PresentationCardData | null {
    const { kind, title, ...rest } = input;
    if (typeof kind !== "string") return null;
    const cardTitle = typeof title === "string" ? title : undefined;
    const content =
        kind === "echart" && isRecord(rest.spec)
            ? { kind, ...rest, spec: normalizeEchartSpec(rest.spec, { title: cardTitle }) }
            : // Every other kind (and an echart the model called without a `spec`) is carried through
              // untouched — there is no layout to normalize, and no spec to invent.
              { kind, ...rest };
    return {
        id: presentationId(input),
        ...(cardTitle !== undefined ? { title: cardTitle } : {}),
        content,
    };
}

/** Max files a `show_file` group may reference; multiple render as a gallery. */
export const MAX_FILES = 10;

/** One referenced file in a `data-file-reference` card. */
export interface FileReferenceEntryData {
    path: string;
    runId?: string;
    caption?: string;
}

/** The `data-file-reference` payload: a group of referenced analysis artifacts. */
export interface FileReferenceCardData {
    id: string;
    title?: string;
    files: FileReferenceEntryData[];
}

/** Extracts `runId` from paths shaped `runs/{runId}/...`; undefined otherwise. */
export function deriveRunId(path: string): string | undefined {
    const segments = path.split("/");
    if (segments.length >= 2 && segments[0] === "runs" && segments[1]!.length > 0) {
        return segments[1];
    }
    return undefined;
}

/** Stable dedup key over sorted paths + optional title. */
export function fileGroupHash(paths: string[], title: string | undefined): string {
    const sorted = [...paths].sort();
    const material = JSON.stringify({ title: title ?? null, paths: sorted });
    return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Build the `data-file-reference` payload from the `show_file` tool input. Shared by the live emit
 * and the reconstruct-on-read path so both cards are byte-identical (same group-hash id, per-entry
 * `runId` derivation, captions). `null` when no valid group can be built — no files, too many, or ANY
 * path failing the shared shape rules (leading slash / `..` traversal). The live tool maps `null` to
 * its `invalid_path` variant and emits nothing; the read path falls back to a generic tool chip.
 * Validating here is load-bearing: the transcript persists the raw tool_use, so without it a traversal
 * path the live tool rejected would be resurrected into a card on reload.
 */
export function buildFileReferenceCardData(input: Record<string, unknown>): FileReferenceCardData | null {
    const title = typeof input.title === "string" ? input.title : undefined;
    const rawFiles = Array.isArray(input.files) ? input.files : [];
    if (rawFiles.length === 0 || rawFiles.length > MAX_FILES) return null;

    const files: FileReferenceEntryData[] = [];
    for (const raw of rawFiles) {
        const file = (raw ?? {}) as Record<string, unknown>;
        const path = typeof file.path === "string" ? file.path : "";
        if (validatePath(path) !== null) return null;
        const runId = deriveRunId(path);
        const caption = typeof file.caption === "string" ? file.caption : undefined;
        files.push({
            path,
            ...(runId !== undefined ? { runId } : {}),
            ...(caption !== undefined ? { caption } : {}),
        });
    }

    const id = `pres-${fileGroupHash(
        files.map((f) => f.path),
        title,
    )}`;
    return { id, ...(title !== undefined ? { title } : {}), files };
}

interface StoredPreviewMeta {
    title?: string;
    format?: "html" | "pdf";
}

/** The stored preview metadata, or `null` when the file is absent — a malformed
 *  file is a genuine read failure (`err`), folded to `null` at the call site. */
function readPreviewMeta(previewRootAbs: string): ResultAsync<StoredPreviewMeta | null, FsError> {
    const path = join(previewRootAbs, PREVIEW_META_FILE);
    return tryFs("cardBuilders.readPreviewMeta", async () => JSON.parse(await readFile(path, "utf8")) as StoredPreviewMeta, { path, onAbsent: () => null });
}

/** Directory names (not files) directly under `dir`, or `[]` when absent. */
function subdirs(dir: string): ResultAsync<string[], FsError> {
    return tryFs("cardBuilders.subdirs", async () => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name), {
        path: dir,
        onAbsent: () => [],
    });
}

/** The most-recently-modified previewId under an analysis, or null when none. */
function latestPreviewId(previewsRootAbs: string): ResultAsync<string | null, FsError> {
    return subdirs(previewsRootAbs).map(async (dirs) => {
        if (dirs.length <= 1) return dirs[0] ?? null;
        let best: { name: string; mtimeMs: number } | null = null;
        for (const name of dirs) {
            const path = join(previewsRootAbs, name);
            const mtimeMs = await tryFs("cardBuilders.latestPreviewId.stat", async () => (await stat(path)).mtimeMs, { path }).unwrapOr(null); // skip an unreadable/absent entry
            if (mtimeMs !== null && (!best || mtimeMs > best.mtimeMs)) {
                best = { name, mtimeMs };
            }
        }
        return best?.name ?? dirs[0]!;
    });
}

/**
 * Build the `data-report-preview` payload for an `iterate_report` tool_use. The
 * preview's source of truth is the filesystem under
 * `previews/{previewId}/`: directory layout yields `version`
 * (latest `vN`) + `previewPath`, and `preview-meta.json` yields title/format.
 * Mirrors `buildRunCardData` — the live emit knows the server-generated
 * `previewId`, while the reconstruct-on-read path resolves it (from the
 * iteration's `previewId` input, or else the analysis's latest preview). The
 * card is keyed by `previewId` only, so every iteration's tool_use rebuilds
 * the same card and the frontend groups them into one with all versions selectable.
 * Null when nothing renders — the caller falls back to a chip.
 */
export async function buildPreviewCardData(
    /** Absolute host root of the analysis's workspace tree (previews live inside it). */
    workspaceRoot: string,
    opts: { previewId?: string; title?: string; format?: "html" | "pdf" },
): Promise<PreviewCardData | null> {
    const previewsRootAbs = join(workspaceRoot, PREVIEWS_ROOT);

    const resolveId: ResultAsync<string | null, FsError> = opts.previewId ? okAsync(opts.previewId) : latestPreviewId(previewsRootAbs);

    return resolveId
        .andThen((previewId) => {
            if (!previewId) return okAsync<PreviewCardData | null, FsError>(null);

            const previewRootAbs = join(workspaceRoot, previewDir(previewId));

            return subdirs(previewRootAbs).andThen((versionDirs) => {
                const version = latestPreviewVersion(versionDirs);
                if (version === 0) return okAsync<PreviewCardData | null, FsError>(null);

                return readPreviewMeta(previewRootAbs).map((meta): PreviewCardData => {
                    const id = `prev-${createHash("sha256").update(previewId).digest("hex").slice(0, 16)}`;
                    return {
                        id,
                        previewId,
                        version,
                        title: opts.title ?? meta?.title ?? "Report",
                        previewPath: `v${version}/index.html`,
                        format: opts.format ?? (meta?.format === "pdf" ? "pdf" : "html"),
                    };
                });
            });
        })
        .unwrapOr(null);
}
