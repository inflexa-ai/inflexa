/**
 * iterate_report — creates or iterates on a report.
 *
 * Two modes:
 *  - Creation (v1): pass `report` with title/audience/sources/sections.
 *    Pre-flight stages every source into the preview's assets/ dir,
 *    enriches the brief with kind/size/columns/headRows/rowCount, and
 *    hands the report-builder agent a complete brief — no discovery, no
 *    staging in the LLM loop.
 *  - Iteration (v2+): pass `modifications` (natural language) with the
 *    existing `previewId`. Optional top-level `sources` adds new assets
 *    on top of the existing assets/ dir.
 *
 * Emits a `data-report-preview` chat data part on success or `data-report-preview-failed`
 * on pre-flight or builder failure. The hosted preview surface is reached
 * through an injected `PreviewPublisher` seam (managed default mints a
 * short-lived run-authorization grant; local default returns "unavailable").
 *
 * The 4 custom report tools the builder drives are constructed inside
 * `runReportIteration` — see design.md Decision #9.
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

const ReportSchema = z.object({
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

/** Exported for schema-validation tests — the underlying Zod schema. */
export const iterateReportInputSchema = z
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
        report: ReportSchema.optional().describe(
            "CREATION ONLY (v1). Mutually exclusive with `modifications` — passing it " +
                "on an existing preview builds a fresh report and discards prior work.",
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
                "Iteration only — additional assets to stage on top of the existing " + "assets/ dir. For creation, put sources inside `report.sources`.",
            ),
    })
    .refine((data) => (data.report !== undefined) !== (data.modifications !== undefined), {
        message: "Exactly one of `report` or `modifications` must be provided.",
    })
    .refine((data) => !(data.report && data.sources), {
        message: "Top-level `sources` is for iteration mode. For creation, put sources inside `report.sources`.",
    });

type ReportInput = z.input<typeof ReportSchema>;
type SectionInput = z.infer<typeof SectionSchema>;

// ── Tool factory ───────────────────────────────────────────────────

export interface IterateReportDeps {
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

interface IterateReportOutput {
    previewId: string;
    version: number;
    previewPath: string;
    error?: string;
    notes?: readonly string[];
}

export function createIterateReportTool(deps: IterateReportDeps): Tool {
    return defineTool({
        id: "iterate_report",
        description:
            "Create or iterate on an HTML/PDF report. The report-builder agent NEVER " +
            "sees the analysis tree — it receives only the brief you pass here, so the " +
            "brief must be complete. You compose the prose, the numbers and the chart " +
            "encodings; the builder only does layout and visual treatment.\n" +
            "CREATE (v1): pass `report`, omit `previewId`. Every CSV / image / JSON the " +
            "report renders goes in `report.sources` — pre-flight stages each one into " +
            "the preview's assets/ dir and parses its columns, first 5 rows and row " +
            "count into the brief for you.\n" +
            "ITERATE (v2+): pass `modifications` plus the existing `previewId`, and " +
            "NEVER `report` — passing `report` builds a fresh report and discards all " +
            "prior work. New data files go in the top-level `sources`; `baseVersion` " +
            "branches from an earlier version instead of the latest.\n" +
            "Do NOT reach for `run_ephemeral` first — not to peek at a CSV (pre-flight " +
            "already parsed it), and not to filter, slice, rank or derive columns from a " +
            "single CSV that is about to be rendered (`chart.content.transform` and " +
            "`table.content.transform` do exactly that, and the transform text is " +
            "rendered as a provenance footnote). `run_ephemeral` is only for computation " +
            "no single section's transform covers: cross-file aggregation, statistics " +
            "needing a real numerical library, or a derived CSV the report then lists as " +
            "a fresh source.\n" +
            "Markdown is not a source — keep summary.md / synthesis.json out of " +
            "`sources`; their content reaches the report as prose you write into " +
            "`narrative` / `methods` sections.\n" +
            "Returns the preview id + version and emits a preview chat data part. " +
            "Pre-flight and builder failures come back as an `error` string on the " +
            "result, not as a thrown error.",
        inputSchema: iterateReportInputSchema,
        execute: async (input, ctx): Promise<Result<IterateReportOutput, ToolError>> => {
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
            const existingMeta = input.report ? null : await readPreviewMeta(metaPathAbs);

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
            const sources = input.report?.sources ?? input.sources ?? [];
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
            if (input.report) {
                const stagedNames = new Set(staged.map((s) => s.name));
                const missing = collectMissingAssetRefs(input.report.sections, stagedNames);
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

            const prompt = input.report ? buildCreationPrompt(input.report, format, staged) : buildModificationPrompt(input.modifications!, format, staged);

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
            if (input.report) {
                try {
                    await mkdir(previewRootAbs, { recursive: true });
                    await writePreviewMeta(metaPathAbs, {
                        title: input.report.title,
                        audience: input.report.audience,
                        format,
                    });
                } catch (err) {
                    console.warn(`[iterate-report] failed to persist preview meta: ${err instanceof Error ? err.message : err}`);
                }
            }

            const previewTitle = input.report?.title ?? existingMeta?.title ?? "Report";

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

function buildCreationPrompt(report: ReportInput, format: "html" | "pdf", staged: StagedAsset[]): string {
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
    return s.replace(/\|/g, "\\|");
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
