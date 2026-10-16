/**
 * Shared builders for the display-card data parts (`data-plan`,
 * `data-presentation`, `data-run-card`, `data-file-reference`).
 *
 * Display tools (`show_plan`, `show_user`, `show_file`) emit these cards live
 * over the chat SSE stream, and the turn persists what it emitted, so a reload
 * replays the built card rather than rebuilding it. These builders therefore run
 * once per card, on the live path only. The `id` stays deterministic all the
 * same: it is what a re-emission of the same card reconciles on.
 *
 * The builders return the FLAT wire `data` payload (no `type` wrapper, no
 * `source`): the tool emits `{ type, source, data }` (the emit pipeline
 * flattens `data` onto the wire), while the read path spreads the payload
 * under the part `type` directly.
 */

import { createHash } from "node:crypto";

import { okAsync, type ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import { tryQuery, type DbError } from "../lib/db-result.js";
import { maybeRecord, plainRecord } from "../lib/shape.js";
import type { PlanPart } from "../contracts/chat-parts.js";
import { PlanPartSchema } from "../contracts/schemas/chat-parts.js";
import { AnalysisPlanSchema } from "../schemas/workflow-state.js";
import { loadPlan, loadPlanRecord, type PlanRecord } from "../state/index.js";
import { parseStructureUrl } from "../contracts/structure-source.js";
import { normalizeEchartSpec } from "../tools/display/normalize-echart-spec.js";
import { validatePath } from "../tools/lib/path-validation.js";

export type PlanCardData = {
    id: string;
    planId: string;
    parentPlanId?: string;
    title?: string;
    steps: unknown;
    analytical_narrative: unknown;
    omicsType: unknown;
    omicsSubtype: unknown;
};

export type PresentationCardData = {
    id: string;
    title?: string;
    content: Record<string, unknown>;
};

export type RunCardData = {
    id: string;
    runId: string;
    planId: string;
    title: string;
    stepCount: number;
};

/** Deterministic presentation id — must match `show_user`'s. */
function presentationId(input: Record<string, unknown>): string {
    const hash = createHash("sha256")
        .update(JSON.stringify(input, Object.keys(input).sort()))
        .digest("hex")
        .slice(0, 16);
    return `pres-${hash}`;
}

/** Build the `data-plan` payload of a stored plan record. `null` when the
 *  document no longer parses. An explicit `title` overrides the plan title. */
export function planCardOf(record: PlanRecord, title?: string): PlanCardData | null {
    const parsed = AnalysisPlanSchema.safeParse(record.plan);
    if (!parsed.success) return null;

    const id = `pres-${createHash("sha256").update(record.planId).digest("hex").slice(0, 16)}`;
    // Explicit `show_plan({ title })` overrides; otherwise default to the
    // planner-set plan title so both cards share one source.
    const heading = title ?? parsed.data.title;
    const card: PlanCardData = {
        id,
        planId: record.planId,
        steps: parsed.data.steps,
        analytical_narrative: parsed.data.analytical_narrative,
        omicsType: parsed.data.omicsType,
        omicsSubtype: parsed.data.omicsSubtype,
    };
    // Absent keys stay absent: the consumers test key presence with toHaveProperty.
    if (record.parentPlanId !== null) card.parentPlanId = record.parentPlanId;
    if (heading !== undefined) card.title = heading;
    return card;
}

/** The `data-plan` part of a stored plan record, with the title of the plan. The
 *  part schema drops each key that it does not name, thus the part equals the
 *  stored card of a transcript. `null` when the document does not parse or the
 *  schema refuses the part. */
export function planPartOf(record: PlanRecord): PlanPart | null {
    const card = planCardOf(record);
    if (!card) return null;
    const part = PlanPartSchema.safeParse({ type: "data-plan", ...card });
    return part.success ? part.data : null;
}

/** Build the `data-plan` payload by loading the stored plan. `ok(null)` when
 *  the plan is missing or no longer parses (absence is NOT an error) — the
 *  caller falls back to a chip. */
export function buildPlanCardData(pool: Pool, planId: string, analysisId: string, title?: string): ResultAsync<PlanCardData | null, DbError> {
    return loadPlanRecord(pool, planId, { analysisId }).map((record) => (record ? planCardOf(record, title) : null));
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
 *  hold identically, so normalization cannot move a card's identity.
 *
 *  A `structure` is normalized here for the same reason: the URL the model named is parsed by the one
 *  grammar (`parseStructureUrl`) and the content is built from the parse alone — never by spreading the
 *  flat tool input, so a stray field cannot ride along. A URL the grammar refuses yields `null` on BOTH
 *  paths; the transcript persists the raw `tool_use` input, and this is what keeps a refused URL from
 *  being resurrected into a card on reload. */
export function buildPresentationCardData(input: Record<string, unknown>): PresentationCardData | null {
    const { kind, title, ...rest } = input;
    if (typeof kind !== "string") return null;
    const cardTitle = typeof title === "string" ? title : undefined;
    let content: Record<string, unknown>;
    const spec = plainRecord(rest.spec);
    if (kind === "structure") {
        const source = typeof rest.url === "string" ? parseStructureUrl(rest.url) : null;
        if (source === null) return null;
        content = { kind, format: source.format, url: source.url, provider: source.provider, accession: source.accession, version: source.version };
    } else if (kind === "echart" && spec !== undefined) {
        content = { kind, ...rest, spec: normalizeEchartSpec(spec, { title: cardTitle }) };
    } else {
        // Every other kind (and an echart the model called without a `spec`) is carried through
        // untouched — there is no layout to normalize, and no spec to invent.
        content = { kind, ...rest };
    }
    return {
        id: presentationId(input),
        title: cardTitle !== undefined ? cardTitle : undefined,
        content,
    };
}

/** Max files a `show_file` group may reference; multiple render as a gallery. */
export const MAX_FILES = 10;

/** One referenced file in a `data-file-reference` card. */
export type FileReferenceEntryData = {
    path: string;
    runId?: string;
    caption?: string;
};

/** The `data-file-reference` payload: a group of referenced analysis artifacts. */
export type FileReferenceCardData = {
    id: string;
    title?: string;
    files: FileReferenceEntryData[];
};

/** Extracts `runId` from paths shaped `runs/{runId}/...`; undefined otherwise. */
export function deriveRunId(path: string): string | undefined {
    const segments = path.split("/");
    if (segments.length >= 2 && segments[0] === "runs" && segments[1].length > 0) {
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
        const file = maybeRecord(raw) ?? {};
        const path = typeof file.path === "string" ? file.path : "";
        if (validatePath(path) !== null) return null;
        const runId = deriveRunId(path);
        const caption = typeof file.caption === "string" ? file.caption : undefined;
        files.push({
            path,
            runId: runId !== undefined ? runId : undefined,
            caption: caption !== undefined ? caption : undefined,
        });
    }

    const id = `pres-${fileGroupHash(
        files.map((f) => f.path),
        title,
    )}`;
    return { id, title: title !== undefined ? title : undefined, files };
}
