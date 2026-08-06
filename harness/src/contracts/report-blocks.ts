/**
 * The composable block tree of a report.
 *
 * A block is one of eight kinds. The shape of each kind carries its grammar. A `text` block has no
 * binding field, thus an unbound claim is unrepresentable. A `metric` value slot admits one scalar
 * reference only, thus a numeric literal cannot sit there. No atom holds a child-block array, thus a
 * chart inside a metric is unrepresentable. The grammar is the shape, and not a separate pass.
 *
 * The tree is recursive: a `section` holds child blocks, and a child can be another section.
 *
 * Every object schema here and in the reference module is strict. A strict object makes an extra field
 * a parse failure, and not a field that the parser strips in silence. Thus a forbidden field, such as a
 * binding on a `text` block or a child-block array on an atom, is rejected. The absence of a field is a
 * rule only when an extra field fails the parse.
 */

import { z } from "zod";
import {
    ArtifactFileReferenceSchema,
    ArtifactTableReferenceSchema,
    CitationReferenceSchema,
    ReferenceSchema,
    ScalarReferenceSchema,
} from "./report-reference.js";

/** The chart vocabulary. Each value names one plot form. */
const ChartTypeSchema = z.enum(["bar", "line", "scatter", "histogram", "box", "heatmap", "pie"]);

/** The mapping from a data column to a visual channel. Each channel is optional. */
const ChartEncodingSchema = z.strictObject({
    x: z.string().optional().describe("The column on the x axis."),
    y: z.string().optional().describe("The column on the y axis."),
    group: z.string().optional().describe("The column that splits and colors the series."),
    value: z.string().optional().describe("The value column for a pie or heatmap."),
});

/** Prose with no binding. The absence of a binding field is the rule for this kind. */
export const TextBlockSchema = z.strictObject({
    kind: z.literal("text"),
    id: z.string().min(1).describe("The stable identity of the block."),
    content: z.strictObject({ prose: z.string() }),
});

/** Prose with at least one reference that justifies it. */
export const ClaimBlockSchema = z.strictObject({
    kind: z.literal("claim"),
    id: z.string().min(1).describe("The stable identity of the block."),
    content: z.strictObject({ prose: z.string() }),
    bindings: z.array(ReferenceSchema).min(1).describe("The evidence that justifies the claim."),
});

/** A labeled number whose value comes from one scalar reference. */
export const MetricBlockSchema = z.strictObject({
    kind: z.literal("metric"),
    id: z.string().min(1).describe("The stable identity of the block."),
    label: z.string(),
    value: ScalarReferenceSchema.describe("The one scalar reference that gives the metric value."),
});

/** A whole-table artifact rendered as a table. */
export const TableBlockSchema = z.strictObject({
    kind: z.literal("table"),
    id: z.string().min(1).describe("The stable identity of the block."),
    title: z.string().optional(),
    binding: ArtifactTableReferenceSchema.describe("The whole-table artifact to render."),
    caption: z.string().optional(),
});

/** A whole-table artifact rendered as a chart, with the plot form and the channel mapping. */
export const ChartBlockSchema = z.strictObject({
    kind: z.literal("chart"),
    id: z.string().min(1).describe("The stable identity of the block."),
    title: z.string().optional(),
    binding: ArtifactTableReferenceSchema.describe("The whole-table artifact to plot."),
    chartType: ChartTypeSchema,
    encoding: ChartEncodingSchema,
    caption: z.string().optional(),
});

/** A static image artifact. An image has no per-cell address, thus it is pinned whole-file. */
export const FigureBlockSchema = z.strictObject({
    kind: z.literal("figure"),
    id: z.string().min(1).describe("The stable identity of the block."),
    binding: ArtifactFileReferenceSchema.describe("The image artifact, pinned whole-file by path and hash."),
    caption: z.string().optional(),
});

/** An external source, rendered from a citation reference. */
export const CitationBlockSchema = z.strictObject({
    kind: z.literal("citation"),
    id: z.string().min(1).describe("The stable identity of the block."),
    binding: CitationReferenceSchema,
    note: z.string().optional(),
});

/**
 * The seven atoms, as one tuple.
 *
 * A section is the only kind whose rules differ between a finished report and a draft. Thus the atoms are
 * the shared part, and every union of block kinds spreads this tuple beside its own section member. A
 * ninth kind lands here one time, and each union gets it.
 */
export const ATOM_BLOCK_SCHEMAS = [
    TextBlockSchema,
    ClaimBlockSchema,
    MetricBlockSchema,
    TableBlockSchema,
    ChartBlockSchema,
    FigureBlockSchema,
    CitationBlockSchema,
] as const;

/** One block of any kind except a section. */
export type AtomBlock = z.infer<(typeof ATOM_BLOCK_SCHEMAS)[number]>;

/**
 * The section shape as a plain type. TypeScript cannot infer the block tree through the union cycle,
 * thus the recursive members carry an explicit type. `SectionBlock` and `Block` break the cycle.
 */
export interface SectionBlock {
    kind: "section";
    id: string;
    title: string;
    blocks: Block[];
}

/** One block of any of the eight kinds. An unknown kind fails validation by construction. */
export type Block = AtomBlock | SectionBlock;

/**
 * A section holds at least one child block, thus an empty section is invalid. The `blocks` field is a
 * `z.lazy` and not a getter, so the discriminated union reads the `kind` discriminator at construction
 * time without a reference to `BlockSchema` before it exists.
 */
export const SectionBlockSchema = z.strictObject({
    kind: z.literal("section"),
    id: z.string().min(1),
    title: z.string(),
    blocks: z.lazy(() => z.array(BlockSchema).min(1)),
});

/** The block union. A `z.ZodType<Block>` annotation gives the recursive members a stable type. */
export const BlockSchema: z.ZodType<Block> = z.discriminatedUnion("kind", [SectionBlockSchema, ...ATOM_BLOCK_SCHEMAS]);

/**
 * The root of a report. It holds at least one section, thus an empty report is invalid.
 *
 * The title carries `min(1)`, because an untitled report is incomplete in the same way that an empty
 * section is. A draft relaxes it, and this schema gates it one time, at the finish.
 */
export const ReportDocumentSchema = z.strictObject({
    title: z.string().min(1),
    sections: z.array(SectionBlockSchema).min(1).describe("The top-level sections, each with at least one block."),
});

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ClaimBlock = z.infer<typeof ClaimBlockSchema>;
export type MetricBlock = z.infer<typeof MetricBlockSchema>;
export type TableBlock = z.infer<typeof TableBlockSchema>;
export type ChartBlock = z.infer<typeof ChartBlockSchema>;
export type FigureBlock = z.infer<typeof FigureBlockSchema>;
export type CitationBlock = z.infer<typeof CitationBlockSchema>;
export type ReportDocument = z.infer<typeof ReportDocumentSchema>;
