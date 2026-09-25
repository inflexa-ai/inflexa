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
    ArtifactValueReferenceSchema,
    CitationReferenceSchema,
    ReferenceSchema,
    ScalarReferenceSchema,
} from "./report-reference.js";

/**
 * The chart vocabulary. The first eleven values name one plot form each. Each value after them is a preset:
 * the canonical figure of one plot of a field, which the renderer derives from its own figure module.
 */
const ChartTypeSchema = z.enum([
    "bar",
    "line",
    "scatter",
    "histogram",
    "box",
    "heatmap",
    "pie",
    "violin",
    "stacked-bar",
    "normalized-bar",
    "radar",
    "volcano",
    "manhattan",
    "ma",
    "km",
    "pca",
    "embedding",
    "dotplot",
    "forest",
    "roc",
    "qq",
    "gsea",
    "oncoprint",
    "lollipop",
]);

/** The per-row transforms of a channel. Each derived value comes from one cell. */
const ChartTransformSchema = z.enum(["log10", "neg_log10", "abs", "rank"]);

/**
 * The arrangement of a bar. The channels keep their data meaning under both values, thus one encoding
 * serves both and the author flips this one field.
 */
const ChartOrientationSchema = z.enum(["vertical", "horizontal"]);

/**
 * The thresholds of a preset that classifies its rows.
 *
 * One declaration moves the guide lines and the color split together. Thus the split always lands on the
 * drawn lines, and no second declaration can disagree with the first one. A volcano reads the pair. An MA
 * reads the significance cut against its `p` column alone, thus the chart block holds the effect cut to the
 * volcano.
 */
const ChartThresholdsSchema = z.strictObject({
    significance: z
        .number()
        .positive()
        .describe(
            "The significance cut of the p column, for example `0.05`. On a `volcano` the guide line sits at the transformed value of it, and a point past the line reads as significant. On an `ma` a point whose `p` is under the cut draws in the signal color.",
        ),
    effect: z
        .number()
        .positive()
        .optional()
        .describe(
            "The effect cut of a `volcano`, for example `1`. One guide line sits at each side of zero, and a point past a line reads as a signal on that side. A `volcano` needs it beside the significance cut, and an `ma` refuses it.",
        ),
});

/** The teaching text of the orientation. The quick path and the bar series form both carry it. */
const ORIENTATION_DESCRIPTION =
    "The arrangement of the bars. `vertical` is the default, and it draws the categories along the bottom. `horizontal` draws them up the left side, and it is the form to reach for when a category name is long, for example a gene-set name: a long name reads on the y axis, and it is unreadable slanted under a vertical bar. The channels do not move with the orientation. `x` names the category column and `y` names the value column in both.";

/**
 * One visual channel: a column name, or a column with a per-row transform and a category order.
 *
 * The object form carries column names and closed enum members, and it carries no value. Thus a channel can
 * never bring a data literal into the chart option. The refine holds the order direction to a declared sort
 * column, because a direction with nothing to sort by names a rule that nothing reads.
 */
export const ChartChannelSchema = z.union([
    z.string().describe("The column that feeds the channel."),
    z
        .strictObject({
            column: z.string().describe("The column that feeds the channel."),
            transform: ChartTransformSchema.optional().describe(
                "The per-row transform. `log10` and `neg_log10` drop a cell that is not positive. `rank` gives the place of the cell in the ascending order of the column, and a tie shares its place.",
            ),
            orderBy: z
                .string()
                .optional()
                .describe(
                    "The column that sorts the categories of this channel, for example the leaf order of a clustered heatmap or the score of a ranked bar. Each category must hold one value in this column. A tie keeps the order of the rows. It is legal on a channel that draws a category axis alone.",
                ),
            order: z
                .enum(["asc", "desc"])
                .optional()
                .describe(
                    "The direction of the `orderBy` sort. `asc` is the default, and `desc` puts the largest value first. It is legal beside `orderBy` alone.",
                ),
        })
        .refine((channel) => channel.order === undefined || channel.orderBy !== undefined, {
            message: "`order` is legal beside `orderBy` alone. Name the column that sorts the categories.",
            path: ["order"],
        }),
]);

/** The teaching text of the continuous color channel. The quick path and a series both carry it. */
const COLOR_DESCRIPTION =
    "A numeric column that colors each point or bar on a continuous scale, for example the expression of a gene over an embedding or the adjusted p of an enriched set. A column that holds values on both sides of zero takes a diverging scale centered on zero, and every other column takes a sequential scale. It is legal on a `scatter`, a `bar`, an `embedding`, and a `dotplot`, and never beside a `group` channel. On an `embedding` a zero draws in a light gray ground, the scale clips at the 99th percentile, and the high values draw on top. On a `dotplot` the scale is sequential. A row whose cell is not numeric draws no point.";

/** The teaching text of the size channel. The quick path and a series both carry it. */
const SIZE_DESCRIPTION =
    "A numeric column that sizes each point, for example the gene count of an enrichment dot plot. It is legal on a `scatter`, a `forest`, and a `dotplot`. On a `forest` it sets the area of each square, for example the weight of a study. On a `dotplot` a size legend of three reference circles names it. A row whose cell is not numeric draws no point.";

/** The teaching text of the lower interval bound. The quick path and a series both carry it. */
const LOW_DESCRIPTION =
    "The column of the lower bound of an interval around each plotted value, for example the lower confidence limit of a forest plot or of an error bar. Give `high` with it. The bound sits on the value axis, and a lower bound above its value is a fault. It is legal on a `bar`, a `scatter`, a `km`, a `forest`, and a `qq`. On a `km` the two bounds draw the confidence band of each curve as a step band. On a `qq` the two bounds draw the band of the null expectation under the points.";

/** The teaching text of the upper interval bound. The quick path and a series both carry it. */
const HIGH_DESCRIPTION =
    "The column of the upper bound of an interval around each plotted value. Give `low` with it. An upper bound under its value is a fault. It is legal on a `bar`, a `scatter`, a `km`, a `forest`, and a `qq`. On a `km` the two bounds draw the confidence band of each curve as a step band. On a `qq` the two bounds draw the band of the null expectation under the points.";

/** The teaching text of the facet channel. The quick path and a composition both carry it. */
const FACET_DESCRIPTION =
    "A category column that splits one table into small multiples: one panel for each value, in the order of the rows, with one shared axis range. At most 12 panels. It is legal on a `scatter`, a `line`, a `bar`, a `stacked-bar`, a `normalized-bar`, and an `embedding`. Each panel of an `embedding` keeps one unit on x and y. Each panel of a stacked form stacks the parts of its own rows, for example the cell-type shares of each donor under each condition.";

/** The teaching text of the shape channel. */
const SHAPE_DESCRIPTION =
    "A category column that sets the symbol of each point beside the color of `group`, for example the batch of each sample on a PCA plot. At most 6 categories. It is legal on a `pca` and a `scatter`. A `scatter` with a shape reads `x`, `y`, `group`, and `label` beside it, and no other channel.";

/** The teaching text of the p channel. */
const P_DESCRIPTION =
    "The p-value column that a figure reads beside its two axes. On an `ma` a point under the significance cut draws in the signal color, and every other point draws gray. On a `forest` the column prints as a text column beside the estimate column. It is legal on an `ma` and a `forest`.";

/** The teaching text of the censor channel. */
const CENSOR_DESCRIPTION =
    "The count of subjects censored at the time of the row. A row with a count above zero carries a small tick on its curve. It is legal on a `km`.";

/** The teaching text of the risk channel. */
const RISK_DESCRIPTION =
    "The number of subjects at risk at the time of the row. The number-at-risk table under the plot reads it at each tick of the time axis. It is legal on a `km`.";

/** The teaching text of the hit channel. */
const HIT_DESCRIPTION =
    "1 where the gene at the rank of the row is a member of the set, else 0. The middle panel draws one tick at each hit. It is legal on a `gsea`.";

/** The teaching text of the metric channel. */
const METRIC_DESCRIPTION =
    "The ranking metric at the rank of the row, for example the signed statistic of a differential test. The bottom panel draws it as an area. It is legal on a `gsea`.";

/** The teaching text of the tracks channel. */
const TRACKS_DESCRIPTION =
    "One to four category columns that draw as annotation strips along the x axis, for example the condition and the batch of each sample. Each column must hold one value for each x category. It is legal on a `heatmap` and an `oncoprint`.";

/** The one refine rule of an interval: the two bounds arrive together. */
function holdsBothBounds(encoding: { low?: unknown; high?: unknown }): boolean {
    return (encoding.low === undefined) === (encoding.high === undefined);
}

/** The refusal of a lone interval bound. */
const LONE_BOUND = { message: "An interval has two bounds. Give `low` and `high` together.", path: ["low"] };

/** The mapping from a data column to a visual channel. Each channel is optional. */
const ChartEncodingSchema = z
    .strictObject({
        x: ChartChannelSchema.optional().describe("The channel on the x axis."),
        y: ChartChannelSchema.optional().describe("The channel on the y axis."),
        group: ChartChannelSchema.optional().describe(
            "The column that splits and colors the series. On a `pie` it names the slices. On a `lollipop` it names the mutation class of each row, and a common class of the MAF standard takes its fixed color.",
        ),
        value: ChartChannelSchema.optional().describe(
            "The value column of a `pie` and a `heatmap`. On a `pie` it sizes each slice, and `group` names the slices. On a `heatmap` it colors each cell. On an `oncoprint` it names the alteration class of each gene and sample, for example `Missense_Mutation`. A row with an empty class names a sample with no alteration.",
        ),
        label: z
            .string()
            .optional()
            .describe(
                "The column that names each point. The name rides the tooltip of a bar, a line, and a scatter. On a `lollipop` the three largest counts carry it as text, for example the protein change. On a `volcano` the ten most significant signal points show it, and on a `manhattan` the lead variant of each chromosome shows it.",
            ),
        color: ChartChannelSchema.optional().describe(COLOR_DESCRIPTION),
        size: ChartChannelSchema.optional().describe(SIZE_DESCRIPTION),
        low: ChartChannelSchema.optional().describe(LOW_DESCRIPTION),
        high: ChartChannelSchema.optional().describe(HIGH_DESCRIPTION),
        facet: ChartChannelSchema.optional().describe(FACET_DESCRIPTION),
        shape: ChartChannelSchema.optional().describe(SHAPE_DESCRIPTION),
        p: ChartChannelSchema.optional().describe(P_DESCRIPTION),
        censor: ChartChannelSchema.optional().describe(CENSOR_DESCRIPTION),
        risk: ChartChannelSchema.optional().describe(RISK_DESCRIPTION),
        hit: ChartChannelSchema.optional().describe(HIT_DESCRIPTION),
        metric: ChartChannelSchema.optional().describe(METRIC_DESCRIPTION),
        tracks: z.array(z.string().min(1)).min(1).max(4).optional().describe(TRACKS_DESCRIPTION),
    })
    .refine(holdsBothBounds, LONE_BOUND);

/**
 * One statistic of a figure: a short name, and the one cell that gives its value.
 *
 * The value is an artifact reference and never a literal, thus a printed statistic is grounded exactly as a
 * metric is.
 */
export const ChartStatisticSchema = z.strictObject({
    label: z.string().min(1).describe("The short name of the statistic, for example `Log-rank p`, `AUC`, or `λ`."),
    value: ArtifactValueReferenceSchema.describe("The one cell that gives the value of the statistic."),
});

/**
 * The second table of a figure, and the four columns of it that the figure reads.
 *
 * The track binds a whole table exactly as the chart binding does, thus it resolves and it grounds the same
 * way.
 */
export const ChartTrackSchema = z.strictObject({
    binding: ArtifactTableReferenceSchema.describe("The whole-table artifact of the track, for example the protein domains of a gene."),
    start: z.string().min(1).describe("The column of the track table that holds the start position of each feature."),
    end: z.string().min(1).describe("The column of the track table that holds the end position of each feature."),
    label: z.string().min(1).describe("The column of the track table that names each feature, for example the domain name."),
    length: z
        .string()
        .min(1)
        .optional()
        .describe("The column of the track table that holds the full length, for example the length of the protein. The x axis then ends at that length."),
});

/** The channels of one series. A series plots two channels, thus `x` and `y` are both present. */
const ChartSeriesEncodingSchema = z
    .strictObject({
        x: ChartChannelSchema.describe("The channel on the x axis."),
        y: ChartChannelSchema.describe("The channel on the y axis."),
        y0: ChartChannelSchema.optional().describe("The lower bound of a band. It is legal on an `area` series only."),
        group: ChartChannelSchema.optional().describe("The column that splits the series, one series for each value."),
        label: z.string().optional().describe("The column that names each point of the series."),
        color: ChartChannelSchema.optional().describe(COLOR_DESCRIPTION),
        size: ChartChannelSchema.optional().describe(SIZE_DESCRIPTION),
        low: ChartChannelSchema.optional().describe(LOW_DESCRIPTION),
        high: ChartChannelSchema.optional().describe(HIGH_DESCRIPTION),
    })
    .refine(holdsBothBounds, LONE_BOUND);

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

/**
 * The full chart grammar: the series, the annotations, the axes, and the facet. Each series reads the one
 * bound table.
 */
export const ChartCompositionSchema = z.strictObject({
    series: z.array(ChartSeriesSchema).min(1).describe("One series at least. Each one reads the bound table."),
    annotations: z.array(ChartAnnotationSchema).optional().describe("The guide lines, the guide bands, and the point names."),
    axes: ChartAxesSchema.optional().describe("The axis titles and the axis scales."),
    facet: ChartChannelSchema.optional().describe(`${FACET_DESCRIPTION} On a composition, the first series has one of those forms.`),
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
            "The quick path. Give `encoding` with it, and omit `composition`. Each base type reads these channels. " +
                "A `bar` draws the `y` value of each category of `x`. A `line` and a `scatter` draw `y` against `x`. A `histogram` counts the values of `x` alone in bins. " +
                "A `box` draws the spread of `y` in each category of `x`, and a `violin` draws the density of `y` in each category of `x`. A `box` and a `violin` with no `group` draw each value as a point over the shape where a category holds 200 values or fewer. " +
                "A `stacked-bar` stacks the `y` values of the `group` parts in each category of `x`, a `normalized-bar` stacks their shares, and a `radar` draws one polygon of `y` values for each `group` over the categories of `x`. These three need a `group` channel. " +
                "A `heatmap` draws `value` over each pair of `x` and `y`, and its `tracks` draw annotation strips over the matrix. " +
                "A `pie` reads no `x` and no `y`. Its `group` column names the slices, and its `value` column sizes them. " +
                "A preset draws the canonical figure of one plot of a field from one table, and it reads its own channels: " +
                "`volcano` (x effect, y p), `manhattan` (x cumulative position, y p, group chromosome), `ma` (x mean, y effect, p), `km` (x time, y survival, group arm, low, high, censor, risk), " +
                "`pca` (x and y components, group, shape, label), `embedding` (x and y of a UMAP or a t-SNE, group or color, facet), `dotplot` (y category, x category or value, size, color), " +
                "`forest` (y term, x estimate, low, high, p, size), `roc` (x false positive rate, y true positive rate, group), `qq` (x expected, y observed, low, high), " +
                "`gsea` (x rank, y running score, group set, hit, metric), `oncoprint` (x sample, y gene, value alteration class, tracks), and `lollipop` (x amino-acid position, y count, group class, label, and the track of the protein domains). " +
                "A preset applies its own transform and its own guide lines.",
        ),
        encoding: ChartEncodingSchema.optional().describe("The channels of the quick path."),
        orientation: ChartOrientationSchema.optional().describe(
            `${ORIENTATION_DESCRIPTION} The field belongs to the \`bar\`, the \`stacked-bar\`, and the \`normalized-bar\` chart types, and every other type refuses it.`,
        ),
        thresholds: ChartThresholdsSchema.optional().describe(
            "The thresholds of a `volcano` and of an `ma`. On a `volcano` give the pair: it replaces the preset defaults of `0.05` and `1`, and it moves the guide lines and the color split together. On an `ma` give the significance cut alone: it replaces the default of `0.1`, and it moves the color split of the `p` column. Every other chart type reads no threshold, thus every other type refuses the field.",
        ),
        composition: ChartCompositionSchema.optional().describe("The full grammar. Omit `chartType` and `encoding` with it."),
        focus: z
            .array(z.string())
            .min(1)
            .optional()
            .describe(
                "The category values of the finding. Each named category takes the one focus color, and every other category is muted. On a bar with no `group` channel a category is a value of `x`, and on every other chart it is a value of `group`. It is legal on a bar and the two stacked forms, and on a grouped scatter, line, box, violin, and radar. It is never legal beside a `color` channel.",
            ),
        statistics: z
            .array(ChartStatisticSchema)
            .min(1)
            .max(4)
            .optional()
            .describe(
                "One to four statistics that the figure prints inside the plot, at the place that its field uses, for example a log-rank p, an AUC, or the genomic inflation λ. Each value binds one cell of a pinned artifact, and the page prints it in the number format of its column. It is legal on a `km`, a `roc`, a `qq`, and a `gsea`.",
            ),
        track: ChartTrackSchema.optional().describe(
            "A second table that the figure draws beside the bound table, for example the protein domains under the axis of a lollipop. It is legal on a `lollipop`.",
        ),
        caption: z.string().optional(),
    })
    .refine(
        (block) => {
            const quickPath = block.chartType !== undefined && block.encoding !== undefined;
            // The orientation and the thresholds are quick-path fields. A composition states the arrangement
            // on its own bar series, and it draws its own guide lines. Thus either field beside a composition
            // names a rule that nothing reads.
            const partialQuickPath =
                block.chartType !== undefined || block.encoding !== undefined || block.orientation !== undefined || block.thresholds !== undefined;
            return block.composition !== undefined ? !partialQuickPath : quickPath;
        },
        { message: "A chart carries either `chartType` with `encoding`, or `composition`. The `orientation` and the `thresholds` belong to the quick path." },
    )
    .refine((block) => block.thresholds === undefined || block.chartType === "volcano" || block.chartType === "ma", {
        // A silent ignore would teach the author a field that does nothing, thus the parse states the fault.
        message: "`thresholds` is legal beside the `volcano` and the `ma` chart types alone. Every other type reads no threshold.",
        path: ["thresholds"],
    })
    .refine((block) => block.chartType !== "volcano" || block.thresholds === undefined || block.thresholds.effect !== undefined, {
        // The member moves the guide lines and the split of both axes, thus a volcano states both cuts.
        message: "The thresholds of a `volcano` are a pair. Give the `effect` cut beside the `significance` cut.",
        path: ["thresholds", "effect"],
    })
    .refine((block) => block.chartType !== "ma" || block.thresholds?.effect === undefined, {
        // An MA splits its rows by the p column alone, thus an effect cut would move nothing.
        message: "An `ma` reads the `significance` cut alone. Omit the `effect` cut.",
        path: ["thresholds", "effect"],
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

/** The category order of one channel: the column that sorts the categories, and the direction of the sort. */
export interface ChannelOrder {
    readonly by: string;
    readonly order: "asc" | "desc";
}

/** The category order of one channel, or `undefined` when the channel declares none. */
export function channelOrder(channel: ChartChannel): ChannelOrder | undefined {
    if (typeof channel === "string" || channel.orderBy === undefined) {
        return undefined;
    }
    return { by: channel.orderBy, order: channel.order ?? "asc" };
}

export type ChartChannel = z.infer<typeof ChartChannelSchema>;
export type ChartTransform = z.infer<typeof ChartTransformSchema>;
export type ChartEncoding = z.infer<typeof ChartEncodingSchema>;
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;
export type ChartAnnotation = z.infer<typeof ChartAnnotationSchema>;
export type ChartAxes = z.infer<typeof ChartAxesSchema>;
export type ChartThresholds = z.infer<typeof ChartThresholdsSchema>;
export type ChartComposition = z.infer<typeof ChartCompositionSchema>;
export type ChartStatistic = z.infer<typeof ChartStatisticSchema>;
export type ChartTrack = z.infer<typeof ChartTrackSchema>;
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
