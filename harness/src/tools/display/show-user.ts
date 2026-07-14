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
 * An `echart` spec's layout is normalized (`normalize-echart-spec.ts`) inside
 * `buildPresentationCardData`, the one construction site both this tool and the
 * reconstruct-on-read path share — the model authors the data, the renderer owns
 * the layout.
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
    title: z
        .string()
        .optional()
        .describe("Card heading rendered above the content. For an echart it is the chart's only title, and it seeds the PNG download filename."),
    spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
            "Full ECharts option JSON (kind=echart). Author the data, series, `encode`, and tooltip — and OMIT `title`: the card heading is the `title` param, so an in-spec title is stripped (put stats in `tooltip.formatter`, never in `title.subtext`). Layout is normalized for you at render time (legend placement, grid margins, `axisLabel.interval`/rotation, and a PNG `saveAsImage` toolbox), so do not hand-tune it.",
        ),
    dataPath: z
        .string()
        .optional()
        .describe(
            "echart only: analysis-rooted CSV artifact path (e.g. 'runs/run-abc/step-2/output/de-summary.csv') the host loads as the ECharts `dataset.source` at render time. Author `encode`/dimensions against the CSV's column names (read only its header) and omit `dataset.source` from the spec — the rows are never pulled through the context window. If the data is not chart-ready (needs aggregation, filtering, reshaping), do that in a sandbox step that writes a chart-ready CSV. Inline `dataset.source` is only for a handful of numbers you just computed in conversation that exist nowhere as an artifact.",
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
        "Display content you are INVENTING — a chart you composed, a code snippet you are proposing, a markdown " +
        "synthesis, an SVG diagram, a table you built. The content is inlined on the wire. " +
        "Pick this tool by what you are referencing, not by how the output looks: " +
        "NOT for an existing analysis file — never read an artifact and paste its bytes here, reference it with `show_file` " +
        "(images, CSVs, PDFs, notebooks). NOT for a stored plan — use `show_plan`. " +
        "NEVER put markdown image syntax pointing at a workspace file in a `markdown` body: `![](runs/.../volcano.png)` " +
        "renders as a broken image, because the chat UI cannot resolve workspace-relative paths. To interleave figures " +
        "with prose (a write-up, a narrative summary), emit a SEQUENCE of cards in display order — `show_user(markdown)` " +
        "for a prose section, then `show_file` for the figures that follow it, and so on — instead of one monolithic card. " +
        "One card per call, rendered in call order; an identical repeat call resolves to the same card, so compose the " +
        "finished content before calling rather than re-rendering a draft.",
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
