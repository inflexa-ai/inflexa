/**
 * Report authoring tools for the conversation agent: `plan_report` + `submit_report`.
 *
 * WHY TWO TOOLS. The report brief (title/audience/sources plus the section
 * union — narrative/metrics/figure/table/chart, each with its own
 * encoding/transform/asset sub-fields) is a ~12k-char JSON schema. Every
 * registered tool's schema ships on EVERY conversation turn, so parking that
 * brief on an always-on tool would tax every turn for a tool used only when a
 * report is actually built. We split the single former tool in two and deliver
 * the heavy schema just-in-time:
 *
 *  - `plan_report` — a tiny, always-on trigger (no-arg). Its `execute` RETURNS
 *    the brief schema (`z.toJSONSchema(ReportBriefSchema)`) plus the authoring
 *    rules as its tool RESULT, so the full contract enters context only on a
 *    report-building turn — and thereafter rides in the cached history prefix,
 *    not at full price on every request.
 *  - `submit_report` — takes the composed brief and does the real work
 *    (pre-flight staging, previewId/versioning, `runReportIteration`, preview
 *    publishing). It accepts the brief as `unknown` so the 12k schema stays off
 *    the always-on surface, then validates it against `ReportBriefSchema` INSIDE
 *    `execute`, returning `{ ok: false, issues }` as DATA the model can fix (not
 *    a thrown error). That is the same trade `validate_plan` makes: a runtime
 *    contract in exchange for keeping the schema out of every request. The small
 *    iterate-mode + common fields (modifications / previewId / baseVersion /
 *    sources / format) stay fully typed — they cost little and guide iteration.
 *
 * On a valid brief, `submit_report`'s behaviour is identical to the former
 * `iterate_report`: two modes (Create v1 via `report`; Iterate v2+ via
 * `modifications` + `previewId`), pre-flight stages every source into the
 * preview's assets/ dir, and it emits a `data-report-preview` chat data part on
 * success or `data-report-preview-failed` on pre-flight/builder failure. The
 * hosted preview surface is reached through an injected `PreviewPublisher` seam
 * (managed default mints a short-lived run-authorization grant; local default
 * returns "unavailable"). The 4 custom report tools the builder drives are
 * constructed inside `runReportIteration` — see design.md Decision #9.
 *
 * Naming note: the report-builder SUB-agent has its OWN same-id `submit_report`
 * terminal tool (`tools/report/submit-report.ts`). The two never share a tool
 * roster — this one is the conversation agent's brief-submission entry point;
 * that one is the builder's finalize gate.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { scopeResource } from "../auth/types.js";
import type { ChatProvider } from "../providers/types.js";
import { defineTool, type Tool, type ToolError } from "./define-tool.js";
import { previewDir, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { runReportIteration } from "../execution/report-runner.js";
import { formatBytes, stageReportAssets, type StagedAsset } from "./lib/report-preflight.js";
import type { PreviewPublisher } from "./report/preview-publisher.js";
import type { ChromeConfig } from "../lib/chrome.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { hintForZodIssue } from "../lib/zod-issues.js";

const REPORT_TOOL_ACCESS_TTL_SECONDS = 3600;
const PREVIEW_META_FILE = "preview-meta.json";

interface PreviewMeta {
    title: string;
    audience?: string;
    format: "html" | "pdf";
}

async function readPreviewMeta(metaPath: string): Promise<PreviewMeta | null> {
    try {
        const raw = await readFile(metaPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<PreviewMeta>;
        if (typeof parsed.title === "string" && (parsed.format === "html" || parsed.format === "pdf")) {
            return {
                title: parsed.title,
                audience: typeof parsed.audience === "string" ? parsed.audience : undefined,
                format: parsed.format,
            };
        }
    } catch {
        /* missing or malformed — caller falls back */
    }
    return null;
}

async function writePreviewMeta(metaPath: string, meta: PreviewMeta): Promise<void> {
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

// ── Source + section schemas ────────────────────────────────────────

const SourceSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Path relative to the analysis root (e.g. 'runs/abc/output/foo.csv'). " +
                "Pre-flight copies the file into the preview's assets/ dir and, for " +
                "CSV/TSV, parses the header + first 5 rows + total row count into the brief.",
        ),
    as: z
        .string()
        .min(1)
        .optional()
        .describe("Optional rename in assets/ (defaults to the source path's basename). " + "Use to disambiguate when two source paths share a basename."),
});

const StatItemSchema = z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    unit: z.string().optional().describe("Unit rendered next to the value (e.g. '%', 'genes', 'kb')."),
});

const SortSpecSchema = z.object({
    column: z.string(),
    order: z.enum(["asc", "desc"]),
});

const ChartTypeSchema = z.enum(["bar", "line", "scatter", "histogram", "box", "heatmap", "pie"]);

const ChartEncodingSchema = z.object({
    x: z.string().optional().describe("Column on the x / category axis."),
    y: z
        .union([z.string(), z.array(z.string()).min(1)])
        .optional()
        .describe("Column on the y axis; an array plots one series per column."),
    group: z.string().optional().describe("Column to split series (and colour) by."),
    value: z.string().optional().describe("Value column for pie / heatmap-shaped charts."),
});

const INLINE_CHART_ROW_CAP = 500;

const ChartInlineDataSchema = z.object({
    columns: z.array(z.string()).min(1).describe("Column names of the inline rows, in render order."),
    rows: z
        .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
        .min(1)
        .max(INLINE_CHART_ROW_CAP)
        .describe("The pre-computed rows. Every value must come from a file you actually read — never fabricate, never estimate."),
    source: z
        .string()
        .min(1)
        .describe(
            "Where the values came from — cite the real files (e.g. 'aggregated " +
                "significant-gene counts from runs/r1/.../sig.csv, runs/r2/.../sig.csv'). " +
                "The builder renders this verbatim as a footnote under the chart.",
        ),
});

/**
 * The editorial-emphasis channel every section carries. A fresh instance per
 * section type — Zod inlines reused schemas rather than sharing a `$defs` ref.
 */
const intentField = () =>
    z
        .string()
        .describe(
            "Why this section exists and what to emphasize (e.g. 'hero — headline " +
                "finding', 'downplay if space is tight'). Emphasis, not layout — the " +
                "builder picks the components, sizing and alternation.",
        );

/** Free-text row transform — the reason to never pre-slice a CSV with `run_ephemeral`. */
const transformField = () =>
    z
        .string()
        .optional()
        .describe(
            "Free-text row transform the builder applies client-side to the loaded " +
                "asset — filter, derive, aggregate, sort (e.g. 'filter padj < 0.05 and " +
                "abs(log2FoldChange) > 1', 'compute -log10(padj) as neg_log_padj', 'group " +
                "by sample and sum count', 'sort by mean_count desc, take top 50'). Use " +
                "this instead of running `run_ephemeral` to pre-slice the file. The text " +
                "is rendered verbatim as a provenance footnote, so the data reads as " +
                "processed, not fabricated.",
        );

const SectionSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("narrative"),
            title: z.string(),
            intent: intentField(),
            content: z.object({
                prose: z.string().min(1).describe("Markdown prose you wrote. The builder never opens your data files to write it."),
            }),
        })
        .describe("Prose you wrote — context, story, interpretation of the results."),
    z
        .object({
            type: z.literal("metrics"),
            title: z.string(),
            intent: intentField(),
            content: z.object({
                stats: z.array(StatItemSchema).min(1).describe("Headline numbers you already derived — the builder does not compute them."),
            }),
        })
        .describe("Labeled numbers you extracted — headline stats, at-a-glance summary."),
    z
        .object({
            type: z.literal("figure"),
            title: z.string(),
            intent: intentField(),
            content: z.object({
                imageAsset: z.string().min(1).describe("Staged asset name, not a path — a `sources[].as`, or the basename of a `sources[].path`."),
                caption: z.string().optional(),
            }),
        })
        .describe(
            "A static image the analysis already produced (PNG/SVG). Prefer `chart` " +
                "whenever the underlying data file exists — a chart is interactive, themed " +
                "and re-encodable on iteration. Reach for `figure` only when the user asks " +
                "for the existing image, the visual is genuinely image-only (e.g. a heatmap " +
                "baked by an R script with no exportable data), or the image carries " +
                "annotations the data does not.",
        ),
    z
        .object({
            type: z.literal("table"),
            title: z.string(),
            intent: intentField(),
            content: z.object({
                dataAsset: z.string().min(1).describe("Staged asset name, not a path — `.csv`, `.tsv`, or `.json` (array of row objects)."),
                columns: z.array(z.string()).optional().describe("Column subset to render, in order. Omit to render every column."),
                topN: z.number().int().positive().optional().describe("Keep only the first N rows, applied after `sortBy` and `transform`."),
                sortBy: SortSpecSchema.optional().describe("Sort applied before `topN`."),
                transform: transformField(),
                caption: z.string().optional(),
            }),
        })
        .describe("A tabular asset rendered as a table. Pick a column subset and `topN` that fit the audience."),
    z
        .object({
            type: z.literal("chart"),
            title: z.string(),
            intent: intentField(),
            content: z
                .object({
                    dataAsset: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "Staged asset name, not a path — `.csv`, `.tsv`, or `.json` (an array " +
                                "of row objects, or a pre-built ECharts option object the builder " +
                                "hands straight to `setOption`).",
                        ),
                    data: ChartInlineDataSchema.optional().describe(
                        "Escape hatch: inline rows for a cross-file aggregate you computed " +
                            "yourself from analysis files you ACTUALLY read (e.g. significant-gene " +
                            "counts pulled from several runs). Prefer `dataAsset`. More than one " +
                            "inline-data chart per report is a smell — the aggregate belongs in a " +
                            "persisted derived CSV.",
                    ),
                    chartType: ChartTypeSchema.describe(
                        "Editorial choice — bar vs scatter changes the story. Always required, " + "including for a pre-built ECharts option asset.",
                    ),
                    encoding: ChartEncodingSchema.describe(
                        "Which column feeds which channel, resolved AFTER `transform` — it may " +
                            "name a column the transform derives. Always required: pass `{}` when " +
                            "`dataAsset` is a pre-built ECharts option object.",
                    ),
                    topN: z.number().int().positive().optional().describe("Keep only the first N rows, applied after `sortBy` and `transform`."),
                    sortBy: SortSpecSchema.optional().describe("Sort applied before `topN`."),
                    transform: transformField(),
                    caption: z.string().optional(),
                })
                .refine((v) => (v.dataAsset !== undefined) !== (v.data !== undefined), { message: "Chart content needs exactly one of `dataAsset` or `data`." })
                .refine((v) => !(v.data !== undefined && v.transform !== undefined), {
                    message: "`transform` is for dataAsset only — inline `data` is already pre-computed.",
                }),
        })
        .describe(
            "A tabular asset (or inline rows) rendered as an interactive ECharts plot. " +
                "Default to this over `figure` whenever the data file exists. To show the " +
                "same data as both a chart and a table, write two sections against the same " +
                "`dataAsset` — the file is staged once.",
        ),
    z
        .object({
            type: z.literal("methods"),
            title: z.string(),
            intent: intentField(),
            content: z.object({
                prose: z.string().min(1).describe("Markdown prose you wrote. The builder never opens your data files to write it."),
            }),
        })
        .describe("Prose you wrote — what was done, how, and with which parameters."),
]);

/**
 * The report brief the conversation agent composes: title/audience + sources +
 * the section union. This is the ~12k-char schema that `plan_report` hands back
 * just-in-time and that `submit_report` validates its `report` field against
 * inside `execute`. Exported for `plan_report`, `submit_report`, and the
 * brief-shape tests.
 */
export const ReportBriefSchema = z.object({
    title: z.string().describe("Report title. Persisted with the preview and reused as the card title on every later version."),
    audience: z
        .string()
        .describe("Who reads this (e.g. 'wet-lab collaborators', 'a computational-biology PI'). The builder tunes tone, density and jargon to it."),
    styleGuidance: z.string().optional().describe("Optional art direction for the builder (e.g. 'dense and print-ready', 'no hero imagery')."),
    sources: z
        .array(SourceSchema)
        .default([])
        .describe(
            "Every file the report renders — CSV/TSV, PNG/SVG, JSON. A section's " +
                "`imageAsset` / `dataAsset` must name one of these staged assets or the " +
                "call fails. Do NOT list markdown or synthesis.json: those are inputs to " +
                "the prose you write, not to the renderer.",
        ),
    sections: z.array(SectionSchema).min(1).describe("The report's sections, in the order they are rendered."),
});

/**
 * `submit_report`'s always-on input surface. The heavy brief rides in `report`
 * as `unknown` — typed that way ON PURPOSE so the ~12k `ReportBriefSchema` does
 * NOT ship on every conversation turn; `execute` validates it against
 * `ReportBriefSchema` and returns issues as data. The iterate-mode + common
 * fields stay fully typed (they are small and guide iteration). Exported for
 * the envelope-validation tests.
 */
export const submitReportInputSchema = z
    .object({
        previewId: z
            .string()
            .regex(/^[a-z0-9-]+$/, "previewId must be lowercase alphanumeric with dashes only")
            .max(64)
            .optional()
            .describe("Preview group ID. Omit for new reports (auto-generated). " + "Required for iterations — must match the existing preview."),
        baseVersion: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Version to branch from (1-based) — use when the user prefers an earlier version. Defaults to the latest."),
        format: z.enum(["html", "pdf"]).default("html").describe("Output format. Defaults to 'html' — only set explicitly for PDF."),
        report: z
            .unknown()
            .optional()
            .describe(
                "CREATION ONLY (v1): the composed report brief. Get its schema + " +
                    "authoring rules from `plan_report` first. Validated on submit — an " +
                    "invalid brief comes back as `{ ok: false, issues }`, not a thrown error. " +
                    "Mutually exclusive with `modifications`.",
            ),
        modifications: z
            .string()
            .optional()
            .describe(
                "ITERATION ONLY (v2+). Natural-language change instructions. The " +
                    "report-builder sees ONLY this text plus the previous version's template " +
                    "— name what changes and leave everything else alone.",
            ),
        sources: z
            .array(SourceSchema)
            .optional()
            .describe(
                "Iteration only — additional assets to stage on top of the existing " + "assets/ dir. For creation, put sources inside the brief's `sources`.",
            ),
    })
    .refine((data) => (data.report !== undefined) !== (data.modifications !== undefined), {
        message: "Exactly one of `report` or `modifications` must be provided.",
    })
    .refine((data) => !(data.report !== undefined && data.sources), {
        message: "Top-level `sources` is for iteration mode. For creation, put sources inside the brief's `sources`.",
    });

type ReportBrief = z.infer<typeof ReportBriefSchema>;
type SectionInput = z.infer<typeof SectionSchema>;

// ── plan_report: the just-in-time authoring contract ────────────────

/**
 * The authoring rules `plan_report` hands back alongside the brief schema.
 * These are the cross-field, when-to-use rules the schema's per-field
 * `.describe()` text cannot carry on its own — pulled from the former
 * `iterate_report` description and `prompts/report-builder.ts`. Guidance for
 * the conversation agent composing the brief, NOT for the builder.
 */
const REPORT_AUTHORING_RULES = `# Composing a report brief

The report-builder agent NEVER sees the analysis tree — it receives only the
brief you compose, so the brief must be complete. You write the prose, the
numbers, and the chart encodings; the builder only does layout and visual
treatment. Pass the composed brief as \`submit_report\`'s \`report\` field.

## Create vs iterate
- CREATE (v1): pass \`report\` (this brief), omit \`previewId\`. Every CSV / image /
  JSON the report renders goes in \`report.sources\` — pre-flight stages each into
  the preview's assets/ dir and parses its columns, first 5 rows, and row count
  into the brief for you.
- ITERATE (v2+): pass \`modifications\` (natural-language change instructions)
  plus the existing \`previewId\`, and NEVER \`report\` — passing \`report\` builds a
  fresh report and discards all prior work. New data files go in the top-level
  \`sources\`. \`baseVersion\` branches from an earlier version instead of the latest.

## Sources
- Every file the report renders — CSV/TSV, PNG/SVG, JSON — must be listed in
  \`sources\`. A section's \`imageAsset\` / \`dataAsset\` must name one of these staged
  assets (its \`as\`, or the basename of its \`path\`) or the call fails.
- Markdown is NOT a source. Keep summary.md / synthesis.json out of \`sources\`;
  their content reaches the report as prose you write into \`narrative\` /
  \`methods\` sections.

## Do NOT reach for run_ephemeral first
- Not to peek at a CSV — pre-flight already parsed its columns and head rows.
- Not to filter, slice, rank, or derive columns from a single CSV about to be
  rendered — \`chart.content.transform\` and \`table.content.transform\` do exactly
  that client-side, and the transform text renders as a provenance footnote.
- run_ephemeral is only for computation no single section transform covers:
  cross-file aggregation, statistics needing a real numerical library, or a
  derived CSV the report then lists as a fresh source.

## Choosing a section type
- narrative — prose you wrote: context, story, interpretation.
- methods — prose you wrote: what was done, how, with which parameters.
- metrics — labeled headline numbers you already derived (the builder does not
  compute them).
- table — a tabular asset rendered as a table; pick a column subset + topN that
  fit the audience.
- chart — a tabular asset (or inline rows) rendered as an interactive ECharts
  plot. PREFER chart over figure whenever the data file exists — a chart is
  interactive, themed, and re-encodable on iteration.
- figure — a static image the analysis already produced (PNG/SVG). Reach for it
  only when the user asks for the existing image, the visual is genuinely
  image-only, or the image carries annotations the data does not.

## Inline chart data
\`chart.content.data\` is an escape hatch for a cross-file aggregate you computed
yourself from files you ACTUALLY read. Prefer \`dataAsset\`. Never fabricate or
estimate values — every inline value must come from a file you read, and cite
the real files in \`data.source\`. More than one inline-data chart per report is a
smell — persist the aggregate as a derived CSV instead.

## Result
\`submit_report\` returns the preview id + version and emits a preview card.
Pre-flight and builder failures come back as an \`error\` string on the result,
not as a thrown error. An invalid brief comes back as \`{ ok: false, issues }\` —
fix the named fields and resubmit.`;

/** Precomputed once at module load — the brief schema `plan_report` returns as data. */
const REPORT_BRIEF_JSON_SCHEMA = z.toJSONSchema(ReportBriefSchema);

/**
 * `plan_report` — the tiny, always-on trigger (no args). Its result delivers
 * the brief schema + authoring rules just-in-time, so the ~12k contract enters
 * context only on a report-building turn (and thereafter rides in the cached
 * history prefix). Compose the brief from what it returns, then call
 * `submit_report`. Pure logic, no deps — hence a module-scope leaf tool.
 */
export const planReportTool: Tool = defineTool({
    id: "plan_report",
    description:
        "Start building or iterating a report. Returns the report-brief schema " +
        "and the authoring rules as its result — the full contract you compose " +
        "against — so it is not carried on every turn. Call this first, compose " +
        "the brief it describes, then call `submit_report` with it. (Iterating an " +
        "existing preview with `modifications` needs no brief — you may go " +
        "straight to `submit_report`.)",
    inputSchema: z.object({}),
    executionMode: "inline",
    execute: async () =>
        ok({
            schema: REPORT_BRIEF_JSON_SCHEMA,
            rules: REPORT_AUTHORING_RULES,
        }),
});

// ── submit_report: the brief-submission tool ────────────────────────

export interface SubmitReportDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly provider: ChatProvider;
    readonly pool: Pool;
    /** Embedder-supplied workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Model id — provenance / metric label; provider owns the wire model. */
    readonly model: string;
    /** Root templates dir; report-runner joins `report-html`. */
    readonly templatesDir: string;
    /** Skills root; report-runner gives the report-builder `report-html` skill tools. */
    readonly skillsDir: string;
    readonly chrome: ChromeConfig;
    /**
     * Builds the preview-publishing seam for this iteration. A managed
     * embedder's realization mints a short-lived access grant + client eagerly
     * at iteration start; the local default returns an "unavailable" publisher.
     * Rejection (e.g. grant-mint failure) surfaces as a failed-preview tool result.
     */
    readonly createPreviewPublisher: (args: {
        session: import("../auth/types.js").AgentSession;
        resourceId: string;
        runId: string;
        previewId: string;
        ttlSeconds: number;
    }) => Promise<PreviewPublisher>;
}

/** The result the model reads back. Iteration outcome, or a brief that failed validation. */
type SubmitReportOutput =
    | {
          previewId: string;
          version: number;
          previewPath: string;
          error?: string;
          notes?: readonly string[];
      }
    | {
          ok: false;
          issues: Array<{ path: string; message: string; hint?: string }>;
          hint: string;
      };

/**
 * `submit_report` — takes the composed brief and drives the report iteration.
 * On a valid brief its behaviour is byte-for-byte the former `iterate_report`:
 * pre-flight staging, previewId/versioning, `runReportIteration`, preview
 * publishing. The brief rides as `unknown` on the wire (keeping its ~12k schema
 * off the always-on surface) and is validated against `ReportBriefSchema` here.
 */
export function createReportSubmitTool(deps: SubmitReportDeps): Tool {
    return defineTool({
        id: "submit_report",
        description:
            "Submit a composed report brief to build or iterate an HTML/PDF report " +
            "(the report-builder renders it; it never sees the analysis tree). Call " +
            "`plan_report` FIRST to get the brief schema + authoring rules, compose " +
            "the brief, then call this. CREATE: pass `report` (the composed brief), " +
            "omit `previewId`. ITERATE: pass `modifications` + the existing " +
            "`previewId`, and NEVER `report`. An invalid brief comes back as " +
            "`{ ok: false, issues }` — fix the named fields and resubmit (see " +
            "`plan_report` for the schema); pre-flight and builder failures come back " +
            "as an `error` string. Returns the preview id + version and emits a " +
            "preview card.",
        inputSchema: submitReportInputSchema,
        execute: async (input, ctx): Promise<Result<SubmitReportOutput, ToolError>> => {
            // The brief rides as `unknown` so its ~12k schema stays off the
            // always-on tool surface. Validate it here and return issues as DATA
            // (the validate_plan trade) — never a thrown error.
            let brief: ReportBrief | undefined;
            if (input.report !== undefined) {
                const parsed = ReportBriefSchema.safeParse(input.report);
                if (!parsed.success) {
                    return ok({
                        ok: false as const,
                        issues: parsed.error.issues.map((i) => ({
                            path: i.path.join(".") || "(root)",
                            message: i.message,
                            hint: hintForZodIssue(i, input.report),
                        })),
                        hint: "The `report` brief did not match the schema. Call `plan_report` for the full schema, fix the fields named in `issues`, and resubmit.",
                    });
                }
                brief = parsed.data;
            }

            const { resourceId } = scopeResource(ctx.session.scope);
            const analysisRoot = deps.resolveWorkspaceRoot(resourceId);

            // Zod fills the default at parse time but the static type keeps it
            // optional — re-apply so the runner sees a concrete value.
            const format: "html" | "pdf" = input.format ?? "html";

            const previewId = input.previewId ?? `prv-${randomUUID().slice(0, 8)}`;
            const previewRootAbs = join(analysisRoot, previewDir(previewId));
            const assetsDirAbs = join(previewRootAbs, "assets");
            const metaPathAbs = join(previewRootAbs, PREVIEW_META_FILE);

            // Iteration mode: recover the title from the creation-time meta file
            // so the data-report-preview part keeps the original title across versions.
            const existingMeta = brief ? null : await readPreviewMeta(metaPathAbs);

            // Build the preview-publishing seam for this iteration. The managed
            // default mints a 1h scoped access grant so preview calls outlive the chat
            // turn; the local default returns an "unavailable" publisher.
            const iterationId = `report-${previewId}`;
            let previews: PreviewPublisher;
            try {
                previews = await deps.createPreviewPublisher({
                    session: ctx.session,
                    resourceId,
                    runId: iterationId,
                    previewId,
                    ttlSeconds: REPORT_TOOL_ACCESS_TTL_SECONDS,
                });
            } catch (err) {
                return ok({
                    previewId,
                    version: 0,
                    previewPath: "",
                    error: `Failed to mint iteration access: ${err instanceof Error ? err.message : String(err)}`,
                });
            }

            // ── Pre-flight: stage declared sources into assets/. ────────
            const sources = brief?.sources ?? input.sources ?? [];
            let staged: StagedAsset[] = [];
            if (sources.length > 0) {
                const result = await stageReportAssets({
                    sources,
                    analysisRoot,
                    assetsDirAbs,
                });
                if (!result.ok) {
                    await ctx.emit({
                        type: "data-report-preview-failed",
                        data: {
                            id: randomUUID(),
                            previewId,
                            version: 0,
                            reason: `pre-flight failed: ${result.reason}`,
                            errorKind: "build",
                        },
                    });
                    return ok({
                        previewId,
                        version: 0,
                        previewPath: "",
                        error: `Pre-flight failed: ${result.reason}`,
                    });
                }
                staged = result.staged;
            }

            // Cross-check creation-mode briefs — every section asset reference
            // must be present in staged[].
            if (brief) {
                const stagedNames = new Set(staged.map((s) => s.name));
                const missing = collectMissingAssetRefs(brief.sections, stagedNames);
                if (missing.length > 0) {
                    const reason = `section asset references not staged: ${missing.join(", ")} (pass them in report.sources)`;
                    await ctx.emit({
                        type: "data-report-preview-failed",
                        data: {
                            id: randomUUID(),
                            previewId,
                            version: 0,
                            reason,
                            errorKind: "build",
                        },
                    });
                    return ok({
                        previewId,
                        version: 0,
                        previewPath: "",
                        error: reason,
                    });
                }
            }

            const prompt = brief ? buildCreationPrompt(brief, format, staged) : buildModificationPrompt(input.modifications!, format, staged);

            const result = await runReportIteration(
                {
                    provider: deps.provider,
                    pool: deps.pool,
                    model: deps.model,
                    templatesDir: deps.templatesDir,
                    skillsDir: deps.skillsDir,
                    chrome: deps.chrome,
                },
                {
                    resourceId,
                    workspaceRoot: analysisRoot,
                    previews,
                    previewId,
                    baseVersion: input.baseVersion,
                    format,
                    prompt,
                    session: ctx.session as Parameters<typeof runReportIteration>[1]["session"],
                    signal: ctx.signal,
                    emit: ctx.emit,
                },
            );

            if (!result.ok) {
                await ctx.emit({
                    type: "data-report-preview-failed",
                    data: {
                        id: randomUUID(),
                        previewId: result.previewId,
                        version: result.version,
                        reason: result.reason,
                        errorKind: result.errorKind,
                    },
                });
                return ok({
                    previewId: result.previewId,
                    version: result.version,
                    previewPath: "",
                    error: `Report generation failed (${result.errorKind}): ${result.reason}`,
                });
            }

            // Persist title on creation so iteration runs can recover it.
            if (brief) {
                try {
                    await mkdir(previewRootAbs, { recursive: true });
                    await writePreviewMeta(metaPathAbs, {
                        title: brief.title,
                        audience: brief.audience,
                        format,
                    });
                } catch (err) {
                    const logger = (deps.logger ?? createNoopLogger()).named("submit-report");
                    logger.warn("failed to persist preview meta", logger.errorFields(err));
                }
            }

            const previewTitle = brief?.title ?? existingMeta?.title ?? "Report";

            await ctx.emit({
                type: "data-report-preview",
                data: {
                    id: randomUUID(),
                    previewId: result.previewId,
                    version: result.version,
                    title: previewTitle,
                    previewPath: result.previewPath,
                    format,
                },
            });

            return ok({
                previewId: result.previewId,
                version: result.version,
                previewPath: result.previewPath,
                ...(result.notes.length > 0 ? { notes: result.notes } : {}),
            });
        },
    });
}

// ── Brief composition ────────────────────────────────────────────────

function collectMissingAssetRefs(sections: SectionInput[], staged: Set<string>): string[] {
    const missing = new Set<string>();
    for (const s of sections) {
        if (s.type === "figure" && !staged.has(s.content.imageAsset)) {
            missing.add(s.content.imageAsset);
        } else if (s.type === "table" && !staged.has(s.content.dataAsset)) {
            missing.add(s.content.dataAsset);
        } else if (s.type === "chart" && s.content.dataAsset && !staged.has(s.content.dataAsset)) {
            missing.add(s.content.dataAsset);
        }
    }
    return [...missing];
}

function buildCreationPrompt(report: ReportBrief, format: "html" | "pdf", staged: StagedAsset[]): string {
    const out: string[] = [];
    out.push(`Build a new ${format.toUpperCase()} report.`);
    out.push("");
    out.push(`**Title:** ${report.title}`);
    out.push(`**Audience:** ${report.audience}`);
    if (report.styleGuidance) out.push(`**Style:** ${report.styleGuidance}`);
    out.push("");
    out.push(stagedAssetsBlock(staged));
    out.push("## Sections");
    out.push("");
    out.push(
        "Each section below carries `intent` (why it exists, what to emphasize) " +
            "and `content` (the data shape to render). You choose the design-system " +
            "components, layout, alternation, and visual treatment. Stay in the " +
            "Inflexa Design Blueprint — base.html.j2, components, theme.css.",
    );
    out.push("");
    for (let i = 0; i < report.sections.length; i++) {
        out.push(`### ${i + 1}. ${report.sections[i].title} — type: \`${report.sections[i].type}\``);
        out.push("");
        out.push(`**Intent:** ${report.sections[i].intent}`);
        out.push("");
        out.push(formatSectionContent(report.sections[i]));
        out.push("");
    }
    out.push("---");
    out.push("");
    out.push(
        "Author `report.html.j2`, then call `build_report` → `preview_snapshot` → " +
            "`submit_report`. The brief is complete — every asset you need is in " +
            "`assets/`, every column is named above. Do not go looking for more.",
    );
    return out.join("\n");
}

function buildModificationPrompt(modifications: string, format: "html" | "pdf", staged: StagedAsset[]): string {
    const out: string[] = [];
    out.push(`Modify the existing ${format.toUpperCase()} report.`);
    out.push("");
    out.push(
        "**IMPORTANT**: This is an iteration. The previous version's template " +
            "(`report.html.j2`) and assets are already in your working directory. " +
            "Read the existing template first and apply only the requested changes. " +
            "Do NOT rewrite from scratch. Preserve the design system, component " +
            "includes, section layout, and all content not mentioned below.",
    );
    out.push("");
    if (staged.length > 0) {
        out.push(stagedAssetsBlock(staged, { newOnly: true }));
    }
    out.push("## Requested Changes");
    out.push("");
    out.push(modifications);
    out.push("");
    out.push("---");
    out.push("");
    out.push("Apply the changes in place, then call `build_report` → `preview_snapshot` " + "→ `submit_report`.");
    return out.join("\n");
}

/** Exported for unit tests — pipe-escape correctness. */
export function stagedAssetsBlock(staged: StagedAsset[], opts: { newOnly?: boolean } = {}): string {
    if (staged.length === 0) {
        return "## Staged Assets\n\n_No file assets — this report uses prose, metrics, and inline chart data only._\n";
    }
    const out: string[] = [];
    out.push(opts.newOnly ? "## Newly Staged Assets" : "## Staged Assets");
    out.push("");
    out.push("Already in your `assets/` dir. Reference them by name in section content. " + "Do NOT call any staging tool — the work is done.");
    out.push("");
    out.push("|name|kind|size|rows|columns|");
    out.push("|-|-|-|-|-|");
    for (const a of staged) {
        const rows = a.rowCount !== undefined ? String(a.rowCount) : "—";
        const cols = a.columns ? a.columns.join(", ") : "—";
        out.push(`|${a.name}|${a.kind}|${formatBytes(a.sizeBytes)}|${rows}|${cols}|`);
    }
    out.push("");
    for (const a of staged) {
        if ((a.kind === "csv" || a.kind === "tsv") && a.headRows && a.headRows.length > 0 && a.columns) {
            out.push(`### Head: ${a.name}`);
            out.push("");
            out.push("|" + a.columns.map(escapePipe).join("|") + "|");
            out.push("|" + a.columns.map(() => "-").join("|") + "|");
            for (const row of a.headRows) {
                out.push("|" + row.map(escapePipe).join("|") + "|");
            }
            out.push("");
        }
    }
    return out.join("\n");
}

function escapePipe(s: string): string {
    // Escape backslashes first so a literal `\` in the cell cannot combine with
    // the escape we add and re-expose an unescaped `|` that breaks the table.
    return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function formatSectionContent(s: SectionInput): string {
    switch (s.type) {
        case "narrative":
        case "methods":
            return `**Prose:**\n\n${s.content.prose}`;
        case "metrics": {
            const lines = s.content.stats.map((st) => `- **${st.label}:** ${st.value}${st.unit ? " " + st.unit : ""}`).join("\n");
            return `**Stats:**\n\n${lines}`;
        }
        case "figure": {
            const cap = s.content.caption ? `\n**Caption:** ${s.content.caption}` : "";
            return `**Image:** \`assets/${s.content.imageAsset}\`${cap}`;
        }
        case "table": {
            const cols = s.content.columns ? `\n**Columns:** ${s.content.columns.join(", ")}` : "";
            const top = s.content.topN ? `\n**Top N:** ${s.content.topN}` : "";
            const sort = s.content.sortBy ? `\n**Sort:** ${s.content.sortBy.column} ${s.content.sortBy.order}` : "";
            const xform = s.content.transform ? `\n**Transform (apply client-side, render verbatim as footnote):** ${s.content.transform}` : "";
            const cap = s.content.caption ? `\n**Caption:** ${s.content.caption}` : "";
            return `**Source:** \`assets/${s.content.dataAsset}\`${cols}${top}${sort}${xform}${cap}`;
        }
        case "chart": {
            const out: string[] = [];
            if (s.content.dataAsset) {
                out.push(`**Source:** \`assets/${s.content.dataAsset}\``);
            } else if (s.content.data) {
                out.push(`**Inline data** (${s.content.data.rows.length} rows, columns: ${s.content.data.columns.join(", ")})`);
                out.push(`**Inline source:** ${s.content.data.source}`);
                out.push("```json");
                out.push(JSON.stringify(s.content.data.rows, null, 2));
                out.push("```");
            }
            out.push(`**Chart type:** ${s.content.chartType}`);
            out.push(`**Encoding:** ${JSON.stringify(s.content.encoding)}`);
            if (s.content.topN) out.push(`**Top N:** ${s.content.topN}`);
            if (s.content.sortBy) {
                out.push(`**Sort:** ${s.content.sortBy.column} ${s.content.sortBy.order}`);
            }
            if (s.content.transform) {
                out.push(`**Transform (apply client-side, render verbatim as footnote):** ${s.content.transform}`);
            }
            if (s.content.caption) out.push(`**Caption:** ${s.content.caption}`);
            return out.join("\n");
        }
    }
}
