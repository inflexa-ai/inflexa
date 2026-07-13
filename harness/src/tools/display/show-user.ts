/**
 * showUser tool — emits agent-synthesized content as a UI stream event.
 *
 * For content the agent is INVENTING — charts, markdown, code snippets,
 * SVG diagrams, tables. Content is serialized inline (bytes on the wire).
 *
 * The presentation `id` is derived deterministically from the content, so
 * an identical re-emission carries the same id — duplicate suppression is a
 * downstream reconciliation concern of the emit pipeline (change 3), not a
 * per-request `Set` smuggled through an ambient context bag.
 *
 * For stored plans, use `show_plan`. For existing files, use `show_file`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { buildPresentationCardData } from "../../memory/card-builders.js";
import { defineTool, type ToolError } from "../define-tool.js";
import { validatePath } from "../lib/path-validation.js";

type ShowUserOutput = { shown: false; reason: "invalid_path" } | { id: string };

// Flat object schema — Anthropic requires top-level "type": "object" in tool
// input_schema. A z.discriminatedUnion produces a top-level "oneOf" without
// "type", which the API rejects. Variant-specific fields are optional; the
// LLM picks the right ones based on `kind`.
const ShowUserInputSchema = z.object({
    kind: z.enum(["echart", "markdown", "code", "svg", "table"]).describe("The type of agent-synthesized content to display"),
    title: z.string().optional().describe("Title shown above the content"),
    spec: z.record(z.string(), z.unknown()).optional().describe("Full ECharts option spec as JSON (kind=echart)"),
    dataPath: z
        .string()
        .optional()
        .describe(
            "echart only: analysis-rooted CSV artifact path (e.g. 'runs/run-abc/step-2/output/de-summary.csv') the host loads as the ECharts `dataset.source` at render time. Author `encode`/dimensions against the CSV's column names and omit `dataset.source` from the spec — the data is never pulled through the context window.",
        ),
    body: z.string().optional().describe("Markdown content to render (kind=markdown)"),
    code: z.string().optional().describe("Code content (kind=code)"),
    language: z.string().optional().describe("Language identifier, e.g. r, python, bash (kind=code)"),
    markup: z.string().optional().describe("SVG markup string (kind=svg)"),
    headers: z.array(z.string()).optional().describe("Column headers (kind=table)"),
    rows: z.array(z.array(z.string())).optional().describe("Row data as array of string arrays (kind=table)"),
    caption: z.string().optional().describe("Caption (kind=table)"),
});

export const showUserTool = defineTool({
    id: "show_user",
    description:
        "Display agent-synthesized content to the user: ECharts visualizations, " +
        "markdown, code blocks, SVG diagrams, or tables. " +
        "Use for content you are INVENTING (a chart you just built, a code snippet you are proposing, " +
        "a markdown synthesis, a table you constructed). " +
        "For an echart backed by a chart-ready CSV artifact a step already wrote, pass `dataPath` (analysis-rooted) " +
        "and author `encode`/dimensions by column name with no `dataset.source` — the host loads the CSV as the " +
        "dataset at render time, so you never inline the rows. " +
        "For stored plans, use `show_plan`. For existing analysis files (images, CSVs, etc.), use `show_file`. " +
        "Call once per distinct content item; an identical repeat call resolves to the same card.",
    inputSchema: ShowUserInputSchema,
    execute: async (input, ctx): Promise<Result<ShowUserOutput, ToolError>> => {
        // `dataPath` is a reference the host resolves at render time; validate its
        // shape only (existence is a render-time host concern), and treat a
        // malformed path as an expected outcome the model can self-correct.
        if (typeof input.dataPath === "string" && validatePath(input.dataPath) !== null) {
            return ok({ shown: false as const, reason: "invalid_path" as const });
        }

        // Non-null: the input passed Zod validation, so `kind` is present.
        const card = buildPresentationCardData(input)!;

        await ctx.emit({
            type: "data-presentation",
            source: ctx.session.provenance,
            data: card,
        });

        return ok({ id: card.id });
    },
});
