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

/**
 * The chart vocabulary. The first seven values name one plot form each. The last four are presets of a
 * scientific plot, and the renderer expands a preset into a composition.
 */
const ChartTypeSchema = z.enum(["bar", "line", "scatter", "histogram", "box", "heatmap", "pie", "volcano", "manhattan", "ma", "km"]);

/** The per-row transforms of a channel. Each derived value comes from one cell. */
const ChartTransformSchema = z.enum(["log10", "neg_log10", "abs", "rank"]);

/**
 * The arrangement of a bar. The channels keep their data meaning under both values, thus one encoding
 * serves both and the author flips this one field.
 */
const ChartOrientationSchema = z.enum(["vertical", "horizontal"]);

/** The teaching text of the orientation. The quick path and the bar series form both carry it. */
const ORIENTATION_DESCRIPTION =
    "The arrangement of the bars. `vertical` is the default, and it draws the categories along the bottom. `horizontal` draws them up the left side, and it is the form to reach for when a category name is long, for example a gene-set name: a long name reads on the y axis, and it is unreadable slanted under a vertical bar. The channels do not move with the orientation. `x` names the category column and `y` names the value column in both.";

/**
 * One visual channel: a column name, or a column with a per-row transform.
 *
 * The object form carries a column and a transform, and it carries no value. Thus a channel can never
 * bring a data literal into the chart option.
 */
export const ChartChannelSchema = z.union([
    z.string().describe("The column that feeds the channel."),
    z.strictObject({
        column: z.string().describe("The column that feeds the channel."),
        transform: ChartTransformSchema.describe(
            "The per-row transform. `log10` and `neg_log10` drop a cell that is not positive. `rank` gives the place of the cell in the ascending order of the column, and a tie shares its place.",
        ),
    }),
]);

/** The mapping from a data column to a visual channel. Each channel is optional. */
const ChartEncodingSchema = z.strictObject({
    x: ChartChannelSchema.optional().describe("The channel on the x axis."),
    y: ChartChannelSchema.optional().describe("The channel on the y axis."),
    group: ChartChannelSchema.optional().describe("The column that splits and colors the series."),
    value: ChartChannelSchema.optional().describe("The value column for a pie or heatmap."),
    label: z.string().optional().describe("The column that names each point. The name rides the tooltip of a bar, a line, and a scatter."),
});

/** The channels of one series. A series plots two channels, thus `x` and `y` are both present. */
const ChartSeriesEncodingSchema = z.strictObject({
    x: ChartChannelSchema.describe("The channel on the x axis."),
    y: ChartChannelSchema.describe("The channel on the y axis."),
    y0: ChartChannelSchema.optional().describe("The lower bound of a band. It is legal on an `area` series only."),
    group: ChartChannelSchema.optional().describe("The column that splits the series, one series for each value."),
    label: z.string().optional().describe("The column that names each point of the series."),
});

/**
 * One series of a composition: a plot form, its own channels, and an optional legend name.
 *
 * A `step` series is a line with the step flag. An `area` series can name a `y0` lower bound, thus a band
 * between two columns of one row is expressible. The refine holds `y0` to the one form that draws a band,
 * and the second refine holds the orientation to the one form that carries an arrangement.
 */
export const ChartSeriesSchema = z
    .strictObject({
        form: z.enum(["line", "scatter", "bar", "area", "step"]).describe("The plot form of the series."),
        encoding: ChartSeriesEncodingSchema.describe("The columns that feed the series."),
        name: z.string().optional().describe("The legend name of the series."),
        orientation: ChartOrientationSchema.optional().describe(ORIENTATION_DESCRIPTION),
    })
    .refine((series) => series.form === "area" || series.encoding.y0 === undefined, {
        message: "`y0` is legal on an `area` series only.",
        path: ["encoding", "y0"],
    })
    .refine((series) => series.form === "bar" || series.orientation === undefined, {
        message: "`orientation` is legal on a `bar` series only.",
        path: ["orientation"],
    });

/** A guide line at one constant on one axis. */
const ReferenceLineAnnotationSchema = z.strictObject({
    kind: z.literal("reference-line"),
    axis: z.enum(["x", "y"]).describe("The axis that the constant sits on."),
    value: z.number().describe("The constant of the guide line."),
    label: z.string().optional().describe("The text beside the line."),
});

/** A guide band between two constants on one axis. */
const ReferenceBandAnnotationSchema = z.strictObject({
    kind: z.literal("reference-band"),
    axis: z.enum(["x", "y"]).describe("The axis that the two constants sit on."),
    from: z.number().describe("The lower bound of the band."),
    to: z.number().describe("The upper bound of the band."),
    label: z.string().optional().describe("The text on the band."),
});

/** A name beside each point of a declared top-N subset. The subset comes from a rank over one column. */
const PointLabelsAnnotationSchema = z.strictObject({
    kind: z.literal("point-labels"),
    column: z.string().describe("The column that ranks the rows."),
    order: z.enum(["asc", "desc"]).describe("The direction of the rank."),
    n: z.number().int().min(1).max(20).describe("How many points carry a name. The maximum is 20."),
});

/**
 * One annotation of a composition.
 *
 * A reference line and a reference band both carry a declared constant. Such a constant is a guide, and it
 * is never a plotted value.
 */
export const ChartAnnotationSchema = z.discriminatedUnion("kind", [ReferenceLineAnnotationSchema, ReferenceBandAnnotationSchema, PointLabelsAnnotationSchema]);

/** The title and the scale of one axis. */
const ChartAxisSchema = z.strictObject({
    title: z.string().optional().describe("The axis title. It replaces the column name."),
    scale: z.enum(["linear", "log"]).optional().describe("The axis scale."),
});

/** The two axes of a composition. */
export const ChartAxesSchema = z.strictObject({
    x: ChartAxisSchema.optional().describe("The x axis."),
    y: ChartAxisSchema.optional().describe("The y axis."),
});

/** The full chart grammar: the series, the annotations, and the axes. Each series reads the one bound table. */
export const ChartCompositionSchema = z.strictObject({
    series: z.array(ChartSeriesSchema).min(1).describe("One series at least. Each one reads the bound table."),
    annotations: z.array(ChartAnnotationSchema).optional().describe("The guide lines, the guide bands, and the point names."),
    axes: ChartAxesSchema.optional().describe("The axis titles and the axis scales."),
});

/**
 * One typed list of a text block: the flag that selects the form, and the items.
 *
 * An item is one inline line, and the renderer escapes it as it escapes a paragraph. No item carries
 * markup, and no item carries a list of its own. A deeper structure composes as a section with blocks.
 */
export const TextListSchema = z.strictObject({
    ordered: z.boolean().describe("True for a numbered list, for example a ranked set or a sequence of steps. False for a bulleted list of parallel points."),
    items: z
        .array(z.string().min(1).describe("One item as one inline line. It carries no markup and no list of its own."))
        .min(1)
        .describe("One item at least. Each item is one point."),
});

/** Prose with no binding. The absence of a binding field is the rule for this kind. */
export const TextBlockSchema = z.strictObject({
    kind: z.literal("text"),
    id: z.string().min(1).describe("The stable identity of the block."),
    content: z.strictObject({
        prose: z.string(),
        list: TextListSchema.optional().describe(
            "The enumeration of the block, as a list. Three or more parallel points compose here, and never inline in the prose as " +
                '"(1) ... (6)". The prose above the list carries the lead sentences that introduce it, and it can be empty.',
        ),
    }),
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

/**
 * A whole-table artifact rendered as a chart.
 *
 * The block carries the quick path or the composition, and never both. The quick path is one chart type
 * with one encoding. The composition holds the series, the annotations, and the axes. The refine makes the
 * exactly-one rule a parse failure.
 *
 * No member of either path carries a data literal, and no member carries script text. Thus every plotted
 * value comes from the resolved rows of the bound table.
 */
export const ChartBlockSchema = z
    .strictObject({
        kind: z.literal("chart"),
        id: z.string().min(1).describe("The stable identity of the block."),
        title: z.string().optional(),
        binding: ArtifactTableReferenceSchema.describe("The whole-table artifact to plot."),
        chartType: ChartTypeSchema.optional().describe(
            "The quick path. Give `encoding` with it, and omit `composition`. A preset (`volcano`, `manhattan`, `ma`, `km`) reads the same channels, and it applies its own transform and its own guide lines.",
        ),
        encoding: ChartEncodingSchema.optional().describe("The channels of the quick path."),
        orientation: ChartOrientationSchema.optional().describe(
            `${ORIENTATION_DESCRIPTION} The field belongs to the \`bar\` chart type, and every other type refuses it.`,
        ),
        composition: ChartCompositionSchema.optional().describe("The full grammar. Omit `chartType` and `encoding` with it."),
        caption: z.string().optional(),
    })
    .refine(
        (block) => {
            const quickPath = block.chartType !== undefined && block.encoding !== undefined;
            // The orientation is a quick-path field. A composition states the arrangement on its own bar
            // series, thus a block-level orientation beside one names an arrangement that nothing reads.
            const partialQuickPath = block.chartType !== undefined || block.encoding !== undefined || block.orientation !== undefined;
            return block.composition !== undefined ? !partialQuickPath : quickPath;
        },
        { message: "A chart carries either `chartType` with `encoding`, or `composition`. The `orientation` belongs to the quick path." },
    );

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

/**
 * The column that one channel names.
 *
 * A transform rides beside the column and never in place of it, thus the two channel forms name their
 * column the same way. The walk, the preset expansion, and the derivation all read the name through this
 * one function.
 */
export function channelColumn(channel: ChartChannel): string {
    return typeof channel === "string" ? channel : channel.column;
}

/** The transform of one channel, or `undefined` when the channel names a plain column. */
export function channelTransform(channel: ChartChannel): ChartTransform | undefined {
    return typeof channel === "string" ? undefined : channel.transform;
}

export type ChartChannel = z.infer<typeof ChartChannelSchema>;
export type ChartTransform = z.infer<typeof ChartTransformSchema>;
export type ChartEncoding = z.infer<typeof ChartEncodingSchema>;
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;
export type ChartAnnotation = z.infer<typeof ChartAnnotationSchema>;
export type ChartAxes = z.infer<typeof ChartAxesSchema>;
export type ChartComposition = z.infer<typeof ChartCompositionSchema>;
export type ChartType = z.infer<typeof ChartTypeSchema>;
export type TextList = z.infer<typeof TextListSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ClaimBlock = z.infer<typeof ClaimBlockSchema>;
export type MetricBlock = z.infer<typeof MetricBlockSchema>;
export type TableBlock = z.infer<typeof TableBlockSchema>;
export type ChartBlock = z.infer<typeof ChartBlockSchema>;
export type FigureBlock = z.infer<typeof FigureBlockSchema>;
export type CitationBlock = z.infer<typeof CitationBlockSchema>;
export type ReportDocument = z.infer<typeof ReportDocumentSchema>;
