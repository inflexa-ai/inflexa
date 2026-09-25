/**
 * The chart derivation of the report page.
 *
 * A chart block binds one whole-table artifact, and it carries the quick path or the composition.
 * `deriveChartOption` turns that grammar and the resolved rows into one ECharts option object. The chart
 * container markup lives beside this file, and it wraps the option that this derivation gives.
 *
 * A preset draws through its figure module (`figures/`), and each base chart type keeps its own fixed rule.
 * A dense figure builds its points through the composition machinery of this file, thus a figure and a
 * composition read one series path.
 *
 * The renderer computes no aggregate outside the named summaries: the histogram bins, the box quantiles, the
 * violin density, and the shares of a normalized bar. Every other plotted number stays traceable to one
 * cell of the evidence artifact, or to a per-row transform of one cell. A pie, a heatmap, a stacked bar, and
 * a radar arrive one row per category or per pair, thus a repeated category or a repeated pair is a refusal
 * and not a silent sum.
 *
 * The derivation is deterministic. Every object builds in one fixed key order, and the code reads no
 * clock, no random value, and no locale. A string comparison uses the code-unit order (`<`) and never
 * `localeCompare`, thus the same rows give the same bytes on every host.
 *
 * The option rides to the page as inline JSON. Thus no axis label and no tooltip can carry a function
 * formatter, and every formatter here is a static template of the chart runtime or a static text. As a
 * result the derivation bounds the tick precision of the one axis whose unit it declares itself, and every
 * other value axis keeps the tick values that ECharts computes. A custom series names its renderer as a
 * string, and each consumer of the option binds the name (`chart-renderers.ts`).
 */

import { err, ok, type Result } from "neverthrow";

import {
    channelColumn,
    channelOrder,
    channelTransform,
    type ChannelOrder,
    type ChartAnnotation,
    type ChartAxes,
    type ChartBlock,
    type ChartChannel,
    type ChartComposition,
    type ChartEncoding,
    type ChartSeries,
    type ChartTransform,
    type ChartType,
} from "../contracts/report-blocks.js";
import { declaredForColumn } from "../contracts/report-reference.js";
import { normalizeEchartSpec } from "../tools/display/normalize-echart-spec.js";
import { type PresetAxisTitles, type PresetClassification, type PresetRule } from "./chart-presets.js";
import { INTERVAL_RENDERER, OUTLINE_RENDERER, VIOLIN_GRID_POINTS } from "./chart-renderers.js";
import {
    BAR_VALUE_LABEL_LIMIT,
    CHART_BODY_PX,
    CHART_FONT_STACK,
    CHART_INK,
    CHART_INLINE_OPTION_BOUND,
    CHART_PAGE_TEXT_PX,
    CHART_PAGE_WIDTH_PX,
    CHART_SLOT_LIMIT,
    COLOR_SCALE_BAND_PCT,
    FACET_COLUMNS,
    FACET_PANEL_LIMIT,
    FACET_ROW_PX,
    FOCUS_CHART_COLOR,
    MUTED_CHART_COLOR,
    SCATTER_CROWD_OPACITY,
    SCATTER_CROWD_ROWS,
    SCATTER_CROWD_SYMBOL_SIZE,
    SCATTER_HOVER_ROWS,
    SCATTER_HOVER_SYMBOL_SIZE,
    SIZE_CHANNEL_RANGE_PX,
} from "./design.js";
import {
    applyFigureRules,
    axisNameFields,
    categoryAxisTitle,
    categoryName,
    chartProblem as problem,
    colorScale,
    columnPresent,
    compareCell,
    continuousScale,
    FIGURE_BODY_MEMBER,
    firstAppearance,
    guideLine,
    guideMarkLine,
    orderCategories,
    orderQuickCategories,
    statisticText,
    toNumber,
    transformColumn,
    valueAxisTitle as axisTitle,
    withTransformedLabels,
    type ColumnLabels,
    type ColumnMeanings,
    type FigureStatistic,
} from "./figures/common.js";
import {
    FIGURE_MEMBER_READERS,
    FIGURE_MODULES,
    isModuleOnlyType,
    type FigureContext,
    type FigureMember,
    type FigureModule,
    type ModuleOnlyType,
    type FigureRegistry,
    type FigureTrack,
    type FigureTree,
} from "./figures/index.js";
import { SHAPED_SCATTER_FIGURE } from "./figures/pca.js";
import { formatNumberCell, selectNumberKind } from "./number-format.js";
import type { RenderProblem, RenderStatistic, RenderTrack, RenderTrees } from "./types.js";

export { transformColumn };

/** One cell of a resolved row. A cell is one string or one number. */
export type Cell = string | number;

/** One resolved row of the bound table, keyed by column name. */
export type ChartRow = Record<string, Cell>;

/** The derived option object, ready for `normalizeEchartSpec` and the inline JSON. */
export type EchartOption = Record<string, unknown>;

/**
 * The four channels that a base rule reads. Each type demands a subset of them. A wide channel routes the
 * quick path through a composition, thus no base rule reads one.
 */
type Channel = "x" | "y" | "group" | "value";

/** One chart type that carries its own fixed rule. A preset draws through its figure module alone. */
type BaseChartType = Exclude<ChartType, ModuleOnlyType>;

/** The arrangement of a bar. An absent value is the vertical arrangement. */
type ChartOrientation = ChartSeries["orientation"];

/**
 * The category values that carry no finding.
 *
 * A preset draws the significance split itself, and an agent derives the same split into a column of its
 * own. Such a column writes the null group with one of these three forms.
 */
const NULL_CATEGORY_TOKENS: ReadonlySet<string> = new Set(["ns", "n.s.", "not significant"]);

/**
 * True when one category value states no finding.
 *
 * The test reads the prettified form of the value and it folds the case, thus `NS` and `not_significant`
 * both match. `toLowerCase` reads no locale, thus one value gives one answer on every host.
 */
function isNullCategory(value: Cell | undefined): boolean {
    return value !== undefined && NULL_CATEGORY_TOKENS.has(categoryName(value).trim().toLowerCase());
}

/**
 * The item style of one grouped series of a base chart type.
 *
 * A null category states no finding, thus it recedes behind the categories that do. Every other series
 * names no color, and the theme palette assigns one by the series order.
 */
function nullCategoryStyle(name: Cell | undefined): EchartOption {
    return isNullCategory(name) ? { itemStyle: { color: MUTED_CHART_COLOR } } : {};
}

/**
 * The color of one category under a focus, or `undefined` when the chart declares no focus.
 *
 * A focus names the categories of the finding. Each named category takes the one focus color, and every
 * other category takes the muted color. Thus a reader sees the finding first, and the rest reads as its
 * reference.
 */
function focusColor(focus: ReadonlySet<string> | undefined, category: Cell | undefined): string | undefined {
    if (focus === undefined || category === undefined) return undefined;
    return focus.has(String(category)) ? FOCUS_CHART_COLOR : MUTED_CHART_COLOR;
}

/** The item style of one grouped series: the focus color where the chart declares a focus, else the null rule. */
function categoryStyle(name: Cell | undefined, focus: ReadonlySet<string> | undefined): EchartOption {
    const color = focusColor(focus, name);
    return color !== undefined ? { itemStyle: { color } } : nullCategoryStyle(name);
}

/**
 * True when one declared series draws its bars across the plot.
 *
 * The category channel then renders on the y axis and the value channel renders on the x axis. Every other
 * form and every other orientation gives false, thus one test answers for the whole composition path.
 */
function isHorizontalBar(series: ChartSeries): boolean {
    return series.form === "bar" && series.orientation === "horizontal";
}

/**
 * A quick-path block whose channels are resolved to plain column names.
 *
 * A transform channel derives its own column into the rows under a name that carries the transform. Thus
 * each base rule reads one plain column name, and no base rule knows about a transform.
 */
interface ResolvedChartBlock {
    id: string;
    chartType: BaseChartType;
    encoding: Partial<Record<Channel, string>>;
    orders: Partial<Record<"x" | "y", ChannelOrder>>;
    labels: ColumnLabels;
    meanings: ColumnMeanings;
    orientation: ChartOrientation;
    focus?: readonly string[];
    facet?: string;
}

/**
 * The label position of a vertical guide band.
 *
 * A band is a rectangle, and the chart runtime gives it the element positions and not the line positions of
 * a guide line. The inside bottom edge of a vertical band sits at the x axis, thus it is the position that
 * matches the start of a vertical line.
 */
const VERTICAL_BAND_LABEL_POSITION = "insideBottom";

/**
 * The type fields of a category axis that renders on y.
 *
 * The chart runtime draws the first category of a y axis at the origin, thus it stacks the rows upward and
 * a table that is sorted strongest-first reads weakest-on-top. The inverted axis puts the first row at the
 * top, and the page then reads down in the order that the rows hold. The data order itself never moves.
 */
const HORIZONTAL_CATEGORY_AXIS: EchartOption = { type: "category", inverse: true };

/**
 * The grid of a chart whose category names render as axis labels.
 *
 * The theme pins `containLabel: false`, and the normalizer fills a left margin of 10 percent. A long
 * category name then draws past the edge of the canvas. `containLabel` gives the measurement to the chart
 * runtime, which is the one part that can measure the text. A fixed band of pixels would guess a width
 * here, and a guess clips a longer name and wastes the room of a shorter one.
 */
const LABEL_CONTAINING_GRID: EchartOption = { containLabel: true };

/**
 * The y axis of a histogram.
 *
 * The axis counts rows, thus a fractional tick names no count. `minInterval` holds each tick a whole count
 * apart from the next one, and it is the one static field that bounds the tick precision of a value axis.
 */
const COUNT_AXIS: EchartOption = { type: "value", minInterval: 1, ...axisNameFields("y", "Count") };

/**
 * The x name fields of a value axis. The helper names the rule of the page: the name sits under the middle
 * of the axis, where no grid margin can cut it.
 */
function xAxisName(title: string): EchartOption {
    return axisNameFields("x", title);
}

/** The y name fields of a value axis: the title turned 90 degrees, in the middle beside the axis. */
function yAxisName(title: string): EchartOption {
    return axisNameFields("y", title);
}

/**
 * Derive the ECharts option for a chart block, then pass it through `normalizeEchartSpec`.
 *
 * The normalizer owns the bottom legend and the axis-label discipline. Thus the derivation sets no `title`,
 * and it sets a `legend` only where an auxiliary series would show an orphan entry. The theme palette assigns
 * the series colors by their order, and a null category or a focus is the one case that names a color.
 *
 * The axis of a channel names the label that the binding declares for its column. The semantic title of a
 * preset answers next, and the raw column name answers last.
 */
export function deriveChartOption(
    block: ChartBlock,
    rows: readonly ChartRow[],
    columns?: readonly string[],
    inputs: ChartInputs = {},
    opts: ChartOpts = DEFAULT_CHART_OPTS,
): Result<EchartOption, RenderProblem> {
    return deriveRaw(block, rows, columns, undefined, inputs, opts).map((option) => reportLayout(option, block.title));
}

/**
 * The resolved parts of a chart beside the rows of its binding: the value of each statistic, in block order,
 * the rows of the track, and the rows of the tree of each axis. A block that declares none of them takes no
 * input.
 */
export interface ChartInputs {
    readonly statistics?: readonly RenderStatistic[];
    readonly track?: RenderTrack;
    readonly trees?: RenderTrees;
}

/** The options of the chart derivation: the figure modules that the dispatch asks first. */
export interface ChartOpts {
    readonly figures: FigureRegistry;
}

/** The options of every render: the registered figure modules. */
export const DEFAULT_CHART_OPTS: ChartOpts = { figures: FIGURE_MODULES };

/**
 * The layout discipline of a report chart: the rules of `normalizeEchartSpec` with no toolbox, then the
 * figure rules that read the whole option.
 *
 * The chart card carries the export row, thus the save button of the discipline has no place on the page.
 * Every other rule of the discipline stays. The normalizer gives a copy, thus the delete touches no input.
 */
function reportLayout(raw: EchartOption, title: string | undefined): EchartOption {
    const { [FIGURE_BODY_MEMBER]: _body, ...rest } = raw;
    const option = normalizeEchartSpec(rest, { title });
    delete option.toolbox;
    return applyFigureRules(option);
}

/**
 * The height of the page chart body of one derived option, in pixels.
 *
 * A figure that states its body takes that height. A facet lays its panels out three to a row, and each
 * further row of panels adds the height of one row. Every other chart takes the default body.
 *
 * A figure can hold some grids of one figure, for example the count bar and the share bar beside the matrix of
 * an oncoprint. Only a facet panel states the `same` outer bounds, thus the count reads those grids alone.
 */
function bodyPxOf(raw: EchartOption, option: EchartOption): number {
    const stated = raw[FIGURE_BODY_MEMBER];
    if (typeof stated === "number") return Math.max(CHART_BODY_PX, stated);
    const grids = option.grid;
    if (!Array.isArray(grids)) return CHART_BODY_PX;
    const panels = grids.filter((grid) => typeof grid === "object" && grid !== null && (grid as EchartOption).outerBoundsMode === FACET_BOUNDS_MODE).length;
    const rows = panels <= 2 ? 1 : Math.ceil(panels / FACET_COLUMNS);
    return CHART_BODY_PX + (rows - 1) * FACET_ROW_PX;
}

/**
 * The width of the drawn block of an option whose media rules size it, at one body height, or `undefined`
 * for an option that fills its body.
 *
 * A figure of one unit states one rule for each square size, and each rule names the smallest body that holds
 * it. The runtime applies the largest rule that fits, thus at a body of this height and of any width wider than
 * the rule, the block takes the width of that rule. The card then narrows the body to that width and centers
 * it. A rule that names a largest width serves one export size alone, and the page body reads no such rule.
 */
function blockWidthOf(option: EchartOption, bodyPx: number): number | undefined {
    const media = option.media;
    if (!Array.isArray(media)) return undefined;
    let width: number | undefined;
    for (const rule of media) {
        const query = typeof rule === "object" && rule !== null ? ((rule as EchartOption).query as EchartOption | undefined) : undefined;
        if (query === undefined || query.maxWidth !== undefined || typeof query.minWidth !== "number" || typeof query.minHeight !== "number") continue;
        if (query.minHeight <= bodyPx) width = query.minWidth;
    }
    return width;
}

/**
 * Derive the option of one chart, and read the shared payload of its artifact where the inline form grows
 * too large.
 *
 * A chart under the bound keeps its inline data, byte for byte as `deriveChartOption` gives it. Past the
 * bound the series carry no row, and the option states how the page builds each series from the columnar
 * payload of the artifact. Thus one dense chart costs the page one option and no second copy of the rows.
 *
 * A quick path of a type that draws one point for one row takes a second pass past the bound. The base rule
 * of such a type builds a bare pair and it collects no descriptor, and the one-series composition plots the
 * same points with the build beside them. The second pass runs past the bound alone, thus a chart under the
 * bound keeps its bytes.
 *
 * A chart whose series holds a value that no cell gives stays inline whatever its size. A binned count, a
 * five-number summary, an addressed pair, and the upper half of a band are each such a value, thus no
 * descriptor can state one.
 */
export function deriveChartRender(
    block: ChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    target: ChartPayloadTarget,
    inputs: ChartInputs = {},
    opts: ChartOpts = DEFAULT_CHART_OPTS,
): Result<ChartRender, RenderProblem> {
    const first = renderPass(block, target, (collector) => deriveRaw(block, rows, columns, collector, inputs, opts));
    if (first.isErr()) {
        return err(first.error);
    }
    const quick = perRowQuickPath(block, opts);
    if (first.value.readsPayload || !first.value.overBound || quick === undefined) {
        return ok(chartRender(first.value));
    }
    const second = renderPass(block, target, (collector) =>
        deriveAsComposition(block.id, quick.chartType, quick.encoding, rows, columns, block.binding.columnLabels, block.orientation, {
            collector,
            focus: block.focus,
            meanings: block.binding.columnMeanings,
        }),
    );
    if (second.isErr() || !second.value.readsPayload) {
        // The composition refused, or it described no build. The first option is a whole chart, thus the
        // page keeps it and the render reports no problem that the base rule did not raise.
        return ok(chartRender(first.value));
    }
    return ok(chartRender(second.value));
}

/** The render of one pass: the page option, the payload flag, the full-row option, and the body box. */
function chartRender(pass: ChartPass): ChartRender {
    const widthPx = blockWidthOf(pass.inline, pass.bodyPx);
    return {
        option: pass.option,
        readsPayload: pass.readsPayload,
        inline: pass.inline,
        bodyPx: pass.bodyPx,
        ...(widthPx !== undefined ? { widthPx } : {}),
    };
}

/**
 * One derivation pass: the option, the same option with its rows inline, whether it reads the payload,
 * whether the inline form passed the bound, and the height of the page chart body.
 */
interface ChartPass {
    readonly option: EchartOption;
    readonly inline: EchartOption;
    readonly readsPayload: boolean;
    readonly overBound: boolean;
    readonly bodyPx: number;
}

/**
 * Run one derivation, normalize it, and route it onto the payload where the inline form passes the bound.
 *
 * The collector belongs to the pass, thus two passes over one block never mix their descriptors. A pass
 * whose descriptor count differs from its series count describes the option only in part, thus it keeps the
 * inline data.
 */
function renderPass(
    block: ChartBlock,
    target: ChartPayloadTarget,
    derive: (collector: SourceCollector) => Result<EchartOption, RenderProblem>,
): Result<ChartPass, RenderProblem> {
    const collector: SourceCollector = { columns: target.columns, series: [], failed: false };
    return derive(collector).map((raw): ChartPass => {
        const option = reportLayout(raw, block.title);
        const bodyPx = bodyPxOf(raw, option);
        const series = option.series;
        if (!Array.isArray(series) || JSON.stringify(option).length <= CHART_INLINE_OPTION_BOUND) {
            return { option, inline: option, readsPayload: false, overBound: false, bodyPx };
        }
        if (collector.failed || collector.series.length === 0 || !describesLead(series, collector)) {
            return { option, inline: option, readsPayload: false, overBound: true, bodyPx };
        }
        return { option: sourcedOption(option, series, collector, target.key), inline: option, readsPayload: true, overBound: true, bodyPx };
    });
}

/**
 * True when the descriptors of a pass describe the leading series of the option.
 *
 * A descriptor for each series describes the whole option. A figure can add series after the output of its
 * composition, for example the band of a QQ plot. Such a series holds a value that no cell gives, thus it keeps
 * its inline data, and the descriptors then describe the composition output alone. The names of the leading
 * series must match that output, thus a figure that puts a series before it keeps the whole chart inline.
 */
function describesLead(series: readonly unknown[], collector: SourceCollector): boolean {
    const described = collector.series.length;
    if (described === series.length) return true;
    const composed = collector.composed;
    return (
        composed !== undefined &&
        composed.length === described &&
        described < series.length &&
        composed.every((name, index) => (series[index] as EchartOption).name === name)
    );
}

/**
 * The quick path of one block that draws one point for one row, or `undefined` for every other block.
 *
 * A composition, a preset, and a quick path that names a point or a wide channel each derive through the
 * composition already, thus each one states its own build on the first pass. A histogram, a box, a heatmap,
 * a pie, a violin, the stacked forms, and a radar each hold a value that no cell of the table gives, thus
 * none of them takes a second pass.
 */
function perRowQuickPath(block: ChartBlock, opts: ChartOpts): { chartType: BaseChartType; encoding: ChartEncoding } | undefined {
    const chartType = block.chartType;
    const encoding = block.encoding;
    if (block.composition !== undefined || chartType === undefined || encoding === undefined || routesThroughComposition(encoding)) {
        return undefined;
    }
    if (opts.figures[chartType] !== undefined || isModuleOnlyType(chartType) || LABELED_FORMS[chartType] === undefined || encoding.shape !== undefined) {
        return undefined;
    }
    return { chartType, encoding };
}

/**
 * The option of a chart that reads the payload: the derived option with no row, and the data source.
 *
 * Each described series keeps every field that the derivation gave it, and it loses its data alone. Thus
 * the axes, the names, the colors, and the symbol ladder of a dense chart read as they read inline, and the
 * page fills one member of each series. A series past the descriptors keeps its inline data.
 */
function sourcedOption(option: EchartOption, series: readonly unknown[], collector: SourceCollector, key: string): EchartOption {
    const source: ChartDataSource = {
        payload: key,
        ...(collector.rule !== undefined ? { rule: collector.rule } : {}),
        series: collector.series,
    };
    return {
        ...option,
        series: series.map((entry, index) => (index < collector.series.length ? { ...(entry as EchartOption), data: [] } : entry)),
        [CHART_SOURCE_MEMBER]: source,
    };
}

/**
 * Dispatch the grammar of one chart block.
 *
 * A composition derives directly. A chart type with a figure module derives through its module. A preset
 * with no module refuses, because no other path draws it. A quick path that names a point or a wide channel
 * routes through a one-series
 * composition, because a base rule builds a bare pair and only a composition item carries a name, a color, a
 * size, an interval, or a panel. Every other quick path reaches the fixed rule of its base type.
 *
 * The collector rides the composition path and the composition of a figure alone. A base rule collects
 * nothing, thus its chart keeps its inline data whatever its size.
 */
function deriveRaw(
    block: ChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    collector: SourceCollector | undefined,
    inputs: ChartInputs,
    opts: ChartOpts,
): Result<EchartOption, RenderProblem> {
    const labels = block.binding.columnLabels;
    const orientation = block.orientation;
    if (orientation !== undefined && block.composition !== undefined) {
        // The schema refine already makes this pair unrepresentable. The guard states the same rule for a
        // value that reaches the renderer without a parse, because a composition states the arrangement on
        // its own bar series and this one would otherwise drop in silence.
        return err(problem(block.id, "A composition states the arrangement on its own bar series, thus the chart carries no orientation beside it."));
    }
    if (block.thresholds !== undefined && block.composition !== undefined) {
        // A composition draws its own guide lines, thus a declared pair beside one moves nothing.
        return err(problem(block.id, "A composition draws its own guide lines, thus the chart carries no thresholds beside it."));
    }
    const meanings = block.binding.columnMeanings;
    if (block.composition !== undefined) {
        const unread = (["statistics", "track", "trees"] as const).find((member) => declaresMember(block, member));
        if (unread !== undefined) {
            // A composition draws the series of one grid over one table, thus it places no statistic and it
            // draws no second table.
            return err(problem(block.id, `A composition reads no ${unread}. ${readersSentence(unread)}`));
        }
        return deriveComposition(block.id, block.composition, rows, columns, labels, { collector, focus: block.focus, meanings });
    }
    const chartType = block.chartType;
    const encoding = block.encoding;
    if (chartType === undefined || encoding === undefined) {
        // The schema refine already makes this shape unrepresentable. The guard states the same rule for a
        // value that reaches the renderer without a parse.
        return err(problem(block.id, "The chart carries neither a chart type with an encoding, nor a composition."));
    }
    if (orientation !== undefined && !BAR_FORMS.has(chartType)) {
        // A silent ignore would teach the author a field that does nothing, thus the fault is stated.
        return err(problem(block.id, `The ${chartType} chart takes no orientation. An orientation is a rule of the bar forms alone.`));
    }
    if (block.thresholds !== undefined && chartType !== "volcano" && chartType !== "ma") {
        // The pair states a significance cut and an effect cut. The volcano reads both, and the ma reads the
        // significance cut.
        return err(problem(block.id, `The ${chartType} chart takes no thresholds. The thresholds are a rule of the volcano and the ma alone.`));
    }
    // A scatter with a shape draws through the shape draw of the PCA, because no base rule draws a symbol.
    const figure = opts.figures[chartType] ?? (chartType === "scatter" && encoding.shape !== undefined ? SHAPED_SCATTER_FIGURE : undefined);
    if (figure !== undefined) {
        return deriveFigure(block, chartType, figure, rows, columns, collector, inputs);
    }
    if (isModuleOnlyType(chartType)) {
        return err(problem(block.id, `The ${chartType} figure is not available yet. Draw the table with a base chart type or a composition.`));
    }
    const unread = unreadFigureMember(block);
    if (unread !== undefined) {
        return err(problem(block.id, memberFault(chartType, unread)));
    }
    const fault = quickPathFault(chartType, encoding, block.focus);
    if (fault !== undefined) {
        return err(problem(block.id, fault));
    }
    // A stacked form draws its own panels, because a composition series stacks no parts.
    const stackedFacet = STACKED_FORMS.has(chartType) ? encoding.facet : undefined;
    if (routesThroughComposition(stackedFacet === undefined ? encoding : { ...encoding, facet: undefined })) {
        return deriveAsComposition(block.id, chartType, encoding, rows, columns, labels, orientation, { collector, focus: block.focus, meanings });
    }
    if (stackedFacet !== undefined && channelTransform(stackedFacet) !== undefined) {
        return err(problem(block.id, 'The "facet" channel reads categories, thus it takes no transform.'));
    }
    const quick = resolveQuickPath(block.id, chartType, encoding, rows, columns, labels, orientation);
    if (quick.isErr()) return err(quick.error);
    return deriveBase(
        {
            ...quick.value.block,
            meanings,
            ...(block.focus !== undefined ? { focus: block.focus } : {}),
            ...(stackedFacet !== undefined ? { facet: channelColumn(stackedFacet) } : {}),
        },
        quick.value.rows,
        columns,
    );
}

/** The members that the canonical figures add. A chart type with no figure module reads none of them. */
const FIGURE_ONLY_MEMBERS = ["shape", "p", "censor", "risk", "hit", "metric", "tracks", "statistics", "track", "trees"] as const;

/** One member that the canonical figures add. */
type FigureOnlyMember = (typeof FIGURE_ONLY_MEMBERS)[number];

/** The first member of a block that the canonical figures add, or `undefined` when the block declares none. */
function unreadFigureMember(block: ChartBlock): FigureOnlyMember | undefined {
    return FIGURE_ONLY_MEMBERS.find((member) => declaresMember(block, member));
}

/** True when the block declares one member: a channel of its encoding, the statistics, the track, the trees, or the focus. */
function declaresMember(block: ChartBlock, member: FigureMember): boolean {
    switch (member) {
        case "statistics":
            return block.statistics !== undefined;
        case "track":
            return block.track !== undefined;
        case "trees":
            return block.trees !== undefined;
        case "focus":
            return block.focus !== undefined;
        default:
            return block.encoding?.[member] !== undefined;
    }
}

/** Each member that one block declares, in the order of the grammar. */
function declaredMembers(block: ChartBlock): FigureMember[] {
    const members: FigureMember[] = [];
    for (const key of Object.keys(block.encoding ?? {}) as Array<keyof ChartEncoding>) {
        if (block.encoding?.[key] !== undefined) members.push(key);
    }
    for (const member of ["statistics", "track", "trees", "focus"] as const) {
        if (declaresMember(block, member)) members.push(member);
    }
    return members;
}

/** The sentence that names the chart types that read one member that the canonical figures add. */
function readersSentence(member: FigureOnlyMember): string {
    const readers = FIGURE_MEMBER_READERS[member];
    const list = readers.length <= 2 ? readers.join(" and ") : `${readers.slice(0, -1).join(", ")}, and ${readers[readers.length - 1]}`;
    switch (member) {
        case "statistics":
            return `The statistics are legal on the ${list} charts.`;
        case "track":
            return `A track is legal on the ${list} charts.`;
        case "trees":
            return `The trees are legal on the ${list} charts.`;
        default:
            return `The "${member}" channel is legal on the ${list} charts.`;
    }
}

/**
 * The refusal of one member that a chart type does not read. A silent drop would teach the author a member
 * that does nothing, thus the fault is stated, and it names the charts that read the member.
 */
function memberFault(chartType: ChartType, member: FigureMember): string {
    switch (member) {
        case "statistics":
            return `The ${chartType} chart prints no statistics. ${readersSentence(member)}`;
        case "track":
            return `The ${chartType} chart draws no track. ${readersSentence(member)}`;
        case "trees":
            return `The ${chartType} chart draws no tree. ${readersSentence(member)}`;
        case "focus":
            return `The ${chartType} chart takes no focus.`;
        case "shape":
        case "p":
        case "censor":
        case "risk":
        case "hit":
        case "metric":
        case "tracks":
            return `The ${chartType} chart takes no "${member}" channel. ${readersSentence(member)}`;
        default:
            return `The ${chartType} chart takes no "${member}" channel.`;
    }
}

/**
 * Derive a chart type through its figure module.
 *
 * The dispatch refuses each member that the module does not read, and it resolves the statistics and the
 * track that the module reads. The module then gets the block, the rows, and the context. Its composition
 * reads the collector of the pass, thus a dense figure reads the shared payload as a composition does.
 */
function deriveFigure(
    block: ChartBlock,
    chartType: ChartType,
    figure: FigureModule,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    collector: SourceCollector | undefined,
    inputs: ChartInputs,
): Result<EchartOption, RenderProblem> {
    for (const member of declaredMembers(block)) {
        if (!figure.reads.has(member)) {
            return err(problem(block.id, memberFault(chartType, member)));
        }
    }
    const statistics = figureStatistics(block, inputs.statistics);
    if (statistics.isErr()) return err(statistics.error);
    const track = figureTrack(block, inputs.track);
    if (track.isErr()) return err(track.error);
    const trees = figureTrees(block, inputs.trees);
    if (trees.isErr()) return err(trees.error);
    const labels = block.binding.columnLabels;
    const meanings = block.binding.columnMeanings;
    const context: FigureContext = {
        blockId: block.id,
        labels,
        meanings,
        ...(columns !== undefined ? { columns } : {}),
        statistics: statistics.value,
        ...(track.value !== undefined ? { track: track.value } : {}),
        ...(trees.value !== undefined ? { trees: trees.value } : {}),
        textPx: CHART_PAGE_TEXT_PX,
        compose: (composition, { keepsRowsInline, ...extras } = {}) => {
            // A composition with no collector describes no page build, thus the chart keeps its rows inline.
            const described = keepsRowsInline === true ? undefined : collector;
            const option = deriveComposition(block.id, composition, rows, columns, labels, { ...extras, collector: described, focus: block.focus, meanings });
            if (described !== undefined && option.isOk()) {
                // The names of the composition output let the pass tell it apart from a series that the
                // figure adds after it.
                described.composed = Array.isArray(option.value.series) ? option.value.series.map((entry) => String((entry as EchartOption).name)) : [];
            }
            return option;
        },
    };
    return figure.derive(block, rows, context);
}

/** A `missing-value` problem of a chart whose value entry lacks a part that the block declares. */
function missingPart(blockId: string, detail: string): RenderProblem {
    return { blockId, kind: "missing-value", detail };
}

/**
 * The statistics of one block with their resolved values and their shown text, in block order.
 *
 * The label comes from the block, and the value comes from the entry. A value entry whose count differs from
 * the block names no value for some statistic, thus it refuses.
 */
function figureStatistics(block: ChartBlock, values: readonly RenderStatistic[] | undefined): Result<FigureStatistic[], RenderProblem> {
    const declared = block.statistics ?? [];
    if (declared.length === 0) return ok([]);
    if (values === undefined || values.length !== declared.length) {
        return err(missingPart(block.id, `The chart declares ${declared.length} statistics, and its value entry carries ${values?.length ?? 0}.`));
    }
    return ok(
        declared.map((statistic, index) => ({
            label: statistic.label,
            value: values[index].value,
            text: statisticText(values[index].value, statistic.value.locator.column, statistic.value.unit),
        })),
    );
}

/** The resolved track of one block, or `undefined` for a block that declares none. An entry with no track refuses. */
function figureTrack(block: ChartBlock, value: RenderTrack | undefined): Result<FigureTrack | undefined, RenderProblem> {
    const declared = block.track;
    if (declared === undefined) return ok(undefined);
    if (value === undefined) {
        return err(missingPart(block.id, "The chart declares a track, and its value entry carries no track."));
    }
    return ok({
        rows: value.rows,
        ...(value.columns !== undefined ? { columns: value.columns } : {}),
        start: declared.start,
        end: declared.end,
        label: declared.label,
        ...(declared.length !== undefined ? { length: declared.length } : {}),
        labels: declared.binding.columnLabels,
        meanings: declared.binding.columnMeanings,
    });
}

/**
 * The resolved tree of each axis of one block, or `undefined` for a block that declares none. An entry that
 * carries no tree for a declared axis refuses.
 */
function figureTrees(block: ChartBlock, values: RenderTrees | undefined): Result<{ x?: FigureTree; y?: FigureTree } | undefined, RenderProblem> {
    const declared = block.trees;
    if (declared === undefined) return ok(undefined);
    const trees: { x?: FigureTree; y?: FigureTree } = {};
    for (const axis of ["x", "y"] as const) {
        const tree = declared[axis];
        if (tree === undefined) continue;
        const value = values?.[axis];
        if (value === undefined) {
            return err(missingPart(block.id, `The chart declares a tree of ${axis}, and its value entry carries no tree of ${axis}.`));
        }
        trees[axis] = {
            rows: value.rows,
            ...(value.columns !== undefined ? { columns: value.columns } : {}),
            parent: tree.parent,
            child: tree.child,
            height: tree.height,
            labels: tree.binding.columnLabels,
            meanings: tree.binding.columnMeanings,
        };
    }
    return ok(trees);
}

/** The two stacked forms. Each one draws the facet panels of its own rule. */
const STACKED_FORMS: ReadonlySet<ChartType> = new Set(["stacked-bar", "normalized-bar"]);

/** The chart types that draw bars, and thus read an orientation. */
const BAR_FORMS: ReadonlySet<ChartType> = new Set(["bar", "stacked-bar", "normalized-bar"]);

/** The chart types that draw a continuous color, a size, an interval, and a facet. */
const COLOR_TYPES: ReadonlySet<ChartType> = new Set(["scatter", "bar"]);
const SIZE_TYPES: ReadonlySet<ChartType> = new Set(["scatter"]);
const INTERVAL_TYPES: ReadonlySet<ChartType> = new Set(["scatter", "bar"]);
const FACET_TYPES: ReadonlySet<ChartType> = new Set(["scatter", "line", "bar", "stacked-bar", "normalized-bar"]);

/**
 * The chart types whose `x` categories can sort by a column. A line and a scatter sort `x` and `y` where the
 * inferred axis draws categories, and the axis inference refuses the order on a value axis.
 */
const ORDERED_X_TYPES: ReadonlySet<ChartType> = new Set(["bar", "stacked-bar", "normalized-bar", "box", "violin", "line", "scatter"]);
const ORDERED_Y_TYPES: ReadonlySet<ChartType> = new Set(["line", "scatter"]);

/** The chart types that take a focus with or without a group, and the ones that take it over a group alone. */
const FOCUS_TYPES: ReadonlySet<ChartType> = new Set(["bar", "stacked-bar", "normalized-bar", "radar"]);
const GROUPED_FOCUS_TYPES: ReadonlySet<ChartType> = new Set(["scatter", "line", "box", "violin"]);

/** The channels of the quick path that never draw a category axis, thus never take an order. */
const UNORDERED_CHANNELS = ["group", "value", "color", "size", "low", "high", "facet"] as const;

/** The refusal of a color beside a group. One chart colors by one channel. */
const COLOR_BESIDE_GROUP = 'A "color" channel beside a "group" channel is a fault, because one chart colors by one channel.';

/** The refusal of a focus beside a color. One chart colors by one rule. */
const FOCUS_BESIDE_COLOR = 'A focus beside a "color" channel is a fault, because one chart colors by one rule.';

/**
 * The fault of a quick path whose type cannot draw one of its channels, or `undefined` for a sound one.
 *
 * Each rule depends on the chart type, thus the grammar admits the channel and the render states the fault.
 * A silent drop would teach the author a channel that does nothing.
 */
function quickPathFault(chartType: ChartType, encoding: ChartEncoding, focus: readonly string[] | undefined): string | undefined {
    if (encoding.color !== undefined && !COLOR_TYPES.has(chartType)) {
        return `The ${chartType} chart takes no "color" channel. A continuous color is legal on a scatter and a bar.`;
    }
    if (encoding.color !== undefined && encoding.group !== undefined) {
        return COLOR_BESIDE_GROUP;
    }
    if (encoding.size !== undefined && !SIZE_TYPES.has(chartType)) {
        return `The ${chartType} chart takes no "size" channel. A size is legal on a scatter alone.`;
    }
    if ((encoding.low !== undefined || encoding.high !== undefined) && !INTERVAL_TYPES.has(chartType)) {
        return `The ${chartType} chart takes no interval. The "low" and "high" channels are legal on a bar and a scatter.`;
    }
    if (encoding.facet !== undefined && !FACET_TYPES.has(chartType)) {
        return `The ${chartType} chart takes no "facet" channel. A facet is legal on a scatter, a line, a bar, and the two stacked forms.`;
    }
    for (const name of UNORDERED_CHANNELS) {
        const channel = encoding[name];
        if (channel !== undefined && channelOrder(channel) !== undefined) {
            return `The "${name}" channel draws no category axis, thus it takes no "orderBy".`;
        }
    }
    if (encoding.x !== undefined && channelOrder(encoding.x) !== undefined && !ORDERED_X_TYPES.has(chartType)) {
        return `The "x" channel of the ${chartType} chart draws no category axis, thus it takes no "orderBy".`;
    }
    if (encoding.y !== undefined && channelOrder(encoding.y) !== undefined && !ORDERED_Y_TYPES.has(chartType)) {
        return `The "y" channel of the ${chartType} chart draws no category axis, thus it takes no "orderBy".`;
    }
    if (focus === undefined) {
        return undefined;
    }
    if (encoding.color !== undefined) {
        return FOCUS_BESIDE_COLOR;
    }
    if (FOCUS_TYPES.has(chartType)) {
        return undefined;
    }
    if (GROUPED_FOCUS_TYPES.has(chartType)) {
        return encoding.group !== undefined ? undefined : `The ${chartType} chart reads a focus over its "group" categories, and it names no "group" channel.`;
    }
    return `The ${chartType} chart takes no focus. A focus is legal on a bar, the two stacked forms, a radar, and a grouped scatter, line, box, or violin.`;
}

/** True when a quick path names a point or a wide channel, thus it derives through a one-series composition. */
function routesThroughComposition(encoding: ChartEncoding): boolean {
    return (
        encoding.label !== undefined ||
        encoding.color !== undefined ||
        encoding.size !== undefined ||
        encoding.low !== undefined ||
        encoding.high !== undefined ||
        encoding.facet !== undefined
    );
}

/** Dispatch to the per-type derivation. Each type holds one fixed rule. */
function deriveBase(block: ResolvedChartBlock, rows: readonly ChartRow[], columns?: readonly string[]): Result<EchartOption, RenderProblem> {
    switch (block.chartType) {
        case "bar":
            return deriveBar(block, rows, columns, "bar");
        case "line":
            return deriveLine(block, rows, columns);
        case "scatter":
            return deriveScatter(block, rows, columns);
        case "histogram":
            return deriveHistogram(block, rows, columns);
        case "box":
            return deriveBox(block, rows, columns);
        case "pie":
            return derivePie(block, rows, columns);
        case "violin":
            return deriveViolin(block, rows, columns);
        case "stacked-bar":
            return deriveBar(block, rows, columns, "stacked");
        case "normalized-bar":
            return deriveBar(block, rows, columns, "normalized");
        case "radar":
            return deriveRadar(block, rows, columns);
    }
}

/** The quick-path types that map onto one series form. A point of such a chart can carry a name. */
const LABELED_FORMS: Partial<Record<BaseChartType, ChartSeries["form"]>> = { bar: "bar", line: "line", scatter: "scatter" };

/**
 * Derive a quick path that names its points or carries a wide channel, as a composition of one series.
 *
 * A histogram bins its rows, a box summarizes them, and a heatmap and a pie both address a pair or a
 * category. None of the four draws one point for one row, thus none of them can carry a per-row name. The
 * caller refused each wide channel on a type that cannot draw it, thus the three forms here carry them all.
 */
function deriveAsComposition(
    blockId: string,
    chartType: BaseChartType,
    encoding: ChartEncoding,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    labels: ColumnLabels,
    orientation: ChartOrientation,
    extras: CompositionExtras,
): Result<EchartOption, RenderProblem> {
    const form = LABELED_FORMS[chartType];
    if (form === undefined) {
        return err(problem(blockId, `The ${chartType} chart draws no point for one row, thus it takes no "label" channel.`));
    }
    const x = requireChannel(blockId, chartType, encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = requireChannel(blockId, chartType, encoding, "y");
    if (y.isErr()) return err(y.error);
    const composition: ChartComposition = {
        series: [
            {
                form,
                encoding: {
                    x: x.value,
                    y: y.value,
                    ...(encoding.group !== undefined ? { group: encoding.group } : {}),
                    ...(encoding.label !== undefined ? { label: encoding.label } : {}),
                    ...(encoding.color !== undefined ? { color: encoding.color } : {}),
                    ...(encoding.size !== undefined ? { size: encoding.size } : {}),
                    ...(encoding.low !== undefined ? { low: encoding.low } : {}),
                    ...(encoding.high !== undefined ? { high: encoding.high } : {}),
                },
                // The caller refused an orientation on every type but the bar, thus the form here is a bar
                // wherever one arrives. The arrangement crosses onto the series, and no name channel loses it.
                ...(orientation !== undefined ? { orientation } : {}),
            },
        ],
        ...(encoding.facet !== undefined ? { facet: encoding.facet } : {}),
    };
    return deriveComposition(blockId, composition, rows, columns, labels, extras);
}

/**
 * Resolve the quick path of a base chart type: the plain column of each channel, and the rows that the
 * base rules read.
 *
 * A channel with no transform passes through, and the rows pass through by reference. Thus a chart with
 * no transform derives the same bytes as before the grammar grew. A channel with a transform derives one
 * column into a copy of each row, under a name that carries the transform. Thus an axis never names the
 * untransformed column. A row whose transform gives no value drops, the same as a non-numeric cell.
 */
function resolveQuickPath(
    blockId: string,
    chartType: BaseChartType,
    encoding: ChartEncoding,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    labels: ColumnLabels,
    orientation: ChartOrientation,
): Result<{ block: ResolvedChartBlock; rows: readonly ChartRow[] }, RenderProblem> {
    const resolved: Partial<Record<Channel, string>> = {};
    const derived: Array<{ column: string; name: string; transform: ChartTransform }> = [];
    for (const channel of CHANNELS) {
        const declared = encoding[channel];
        if (declared === undefined) continue;
        const column = channelColumn(declared);
        const transform = channelTransform(declared);
        if (transform === undefined) {
            resolved[channel] = column;
            continue;
        }
        if (rows.length > 0 && !columnPresent(column, rows, columns)) {
            return err(problem(blockId, `The column "${column}" is absent from every row.`));
        }
        const name = transformedName(transform, column);
        if (columnPresent(name, rows, columns)) {
            // The derived column goes into a copy of each row. A table that already holds that name would
            // lose its own column under the derived one, and the chart would plot the wrong cells.
            return err(problem(blockId, `The transform of "${column}" derives the column "${name}", which the bound table already holds.`));
        }
        resolved[channel] = name;
        derived.push({ column, name, transform });
    }

    const orders: Partial<Record<"x" | "y", ChannelOrder>> = {};
    for (const axis of ["x", "y"] as const) {
        const declared = encoding[axis];
        const order = declared === undefined ? undefined : channelOrder(declared);
        if (order === undefined) continue;
        if (rows.length > 0 && !columnPresent(order.by, rows, columns)) {
            return err(problem(blockId, `The column "${order.by}" is absent from every row.`));
        }
        orders[axis] = order;
    }
    const block: ResolvedChartBlock = {
        id: blockId,
        chartType,
        encoding: resolved,
        orders,
        labels: withTransformedLabels(labels, derived),
        meanings: undefined,
        orientation,
    };
    return ok({ block, rows: derived.length === 0 ? rows : deriveTransformedRows(rows, derived) });
}

/** The four channels of the quick path, in one fixed order. */
const CHANNELS: readonly Channel[] = ["x", "y", "group", "value"];

/**
 * Copy each row with its derived columns beside the source columns. A row that one transform leaves
 * without a value drops, thus no substitute value ever appears.
 */
function deriveTransformedRows(rows: readonly ChartRow[], derived: ReadonlyArray<{ column: string; name: string; transform: ChartTransform }>): ChartRow[] {
    const values = derived.map((entry) => transformColumn(rows, entry.column, entry.transform));
    const out: ChartRow[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const next: ChartRow = { ...rows[index] };
        let complete = true;
        for (let slot = 0; slot < derived.length; slot += 1) {
            const value = values[slot][index];
            if (value === null) {
                complete = false;
                break;
            }
            next[derived[slot].name] = value;
        }
        if (complete) out.push(next);
    }
    return out;
}

// ── The per-type derivations ────────────────────────────────────────────────

/** The three arrangements of the bar rule: side by side, stacked, and stacked as shares of the category. */
type BarMode = "bar" | "stacked" | "normalized";

/**
 * A category axis, a value axis, and one bar series per group with the pairs of the two channels.
 *
 * The vertical arrangement counts the categories along x and measures up y. The horizontal arrangement
 * swaps the two axes, and the pair of each point swaps with them: the chart runtime reads the first member
 * of a pair on x, thus the value leads there. The channels themselves do not move, and `x` names the
 * category column under both arrangements.
 *
 * The category axis of the horizontal arrangement keeps every label. `normalizeEchartSpec` pins the label
 * interval of each axis, and it turns an x label alone, thus a long name on y reads level and none of them
 * drops. The same arrangement inverts that axis and contains its labels, for the reasons that
 * `HORIZONTAL_CATEGORY_AXIS` and `LABEL_CONTAINING_GRID` give.
 *
 * The two stacked modes read the same axes, and they demand a group channel, because each one draws the
 * parts of a category.
 */
function deriveBar(
    block: ResolvedChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    mode: BarMode,
): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const ordered = orderQuickCategories(block.id, rows, x, block.orders.x);
    if (ordered.isErr()) return err(ordered.error);
    const categories = ordered.value;
    const horizontal = block.orientation === "horizontal";

    let series: EchartOption[];
    if (mode === "bar") {
        const group = block.encoding.group;
        const focused = focusSet(block.id, block.focus, rows.length, group === undefined ? categories : firstAppearance(rows.map((row) => row[group])));
        if (focused.isErr()) return err(focused.error);
        const focus = focused.value;
        const bars = groupedSeries(rows, group, (groupRows, name) => ({
            type: "bar",
            ...(name !== undefined ? { name: categoryName(name) } : {}),
            ...categoryStyle(name, focus),
            barGap: 0,
            barCategoryGap: BAR_CATEGORY_GAP,
            data: groupRows.map((row) => {
                const pair = horizontal ? [row[y], row[x]] : [row[x], row[y]];
                // A bar with no group reads the focus over its own categories, thus each item carries its color.
                const color = group === undefined ? focusColor(focus, row[x]) : undefined;
                return color === undefined ? pair : { value: pair, itemStyle: { color } };
            }),
        }));
        series = withValueLabels(bars, horizontal, (cell) => valueLabelText(y, cell, block.meanings));
    } else {
        if (block.facet !== undefined) {
            return deriveStackedFacets(block, rows, columns, x, y, categories, mode === "normalized", block.facet);
        }
        const stacked = stackedSeries(block, rows, columns, x, y, categories, mode === "normalized");
        if (stacked.isErr()) return err(stacked.error);
        series = stacked.value;
    }
    const valueAxis = { type: "value", ...(mode === "normalized" ? { min: 0, max: 1 } : {}), ...labelRoom(series) };

    if (horizontal) {
        return ok({
            xAxis: { ...valueAxis, ...xAxisName(axisTitle(block.labels, y)) },
            yAxis: { ...HORIZONTAL_CATEGORY_AXIS, data: categories, ...axisNameFields("y", categoryAxisTitle(block.labels, x)) },
            series,
            grid: { ...LABEL_CONTAINING_GRID },
        });
    }
    return ok({
        xAxis: { type: "category", data: categories, ...axisNameFields("x", categoryAxisTitle(block.labels, x)) },
        yAxis: { ...valueAxis, ...yAxisName(axisTitle(block.labels, y)) },
        series,
    });
}

/**
 * The group series of a stacked bar, or of a normalized bar.
 *
 * Each series holds one value for each category, in category order, thus the chart runtime stacks the parts
 * of one category by place. An absent pair holds `null`, and the stack skips it. A repeated pair is a
 * refusal, because a sum of two rows is an aggregate that no cell gives.
 *
 * A normalized bar states the share of each part in the total of its category. The share is a named
 * summary. A negative part has no share, thus it refuses and names its row. A category whose total is zero
 * has no share either, thus it draws no bar.
 *
 * The stacked forms carry no value label, because the label of one part overlaps the next part.
 */
function stackedSeries(
    block: ResolvedChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    x: string,
    y: string,
    categories: readonly Cell[],
    normalized: boolean,
    tableGroups?: readonly Cell[],
): Result<EchartOption[], RenderProblem> {
    const groupResult = requireColumn(block, rows, columns, "group");
    if (groupResult.isErr()) return err(groupResult.error);
    const group = groupResult.value;
    const groups = tableGroups ?? firstAppearance(rows.map((row) => row[group]));
    const bound = slotFault(block.id, categories.length, groups.length);
    if (bound !== undefined) return err(bound);
    const focused = focusSet(block.id, block.focus, rows.length, groups);
    if (focused.isErr()) return err(focused.error);

    const parts = new Map<string, number | null>();
    const totals = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
        const key = pairKey(row[x], row[group]);
        if (parts.has(key)) {
            return err(problem(block.id, `The ${block.chartType} chart holds the pair (${String(row[x])}, ${String(row[group])}) more than one time.`));
        }
        const value = toNumber(row[y]);
        if (normalized && value !== null && value < 0) {
            return err(problem(block.id, `The row ${index + 1} holds the negative part ${value}. A share reads parts that are not negative.`));
        }
        parts.set(key, value);
        const categoryKey = cellKey(row[x]);
        totals.set(categoryKey, (totals.get(categoryKey) ?? 0) + (value ?? 0));
    }

    return ok(
        groups.map((name) => ({
            type: "bar",
            name: categoryName(name),
            ...categoryStyle(name, focused.value),
            stack: STACK_NAME,
            data: categories.map((category) => {
                const part = parts.get(pairKey(category, name)) ?? null;
                if (!normalized || part === null) return part;
                const total = totals.get(cellKey(category)) ?? 0;
                return total === 0 ? null : part / total;
            }),
        })),
    );
}

/** The stack name of the stacked forms. Each group series names the same stack, thus the parts stack. */
const STACK_NAME = "total";

/**
 * The panels of a faceted stacked form: one panel for each value of the facet column, in first-appearance
 * order, laid out as the panels of a faceted composition.
 *
 * Each panel stacks the parts of its own rows, thus a pair of a category and a group repeats across panels and
 * never inside one. Each panel lists every category and every group of the table, in one order, thus a group
 * keeps its color and its place in the stack in each panel. The value axis of every panel reads one range: the
 * shares of a normalized bar run from 0 to 1, and a stacked bar runs over the largest total of each side of
 * zero in any panel. The rows stay inline, because the base rule collects no page-side build.
 */
function deriveStackedFacets(
    block: ResolvedChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    x: string,
    y: string,
    categories: readonly Cell[],
    normalized: boolean,
    facet: string,
): Result<EchartOption, RenderProblem> {
    if (rows.length > 0 && !columnPresent(facet, rows, columns)) {
        return err(problem(block.id, `The column "${facet}" is absent from every row.`));
    }
    const groupResult = requireColumn(block, rows, columns, "group");
    if (groupResult.isErr()) return err(groupResult.error);
    const group = groupResult.value;
    const groups = firstAppearance(rows.map((row) => row[group]));
    const names = firstAppearance(rows.map((row) => row[facet]));
    if (names.length > FACET_PANEL_LIMIT) {
        return err(
            problem(
                block.id,
                `The facet splits the table into ${names.length} panels. A facet holds ${FACET_PANEL_LIMIT} panels at most, thus a table of fewer groups serves the reader.`,
            ),
        );
    }
    const series: EchartOption[] = [];
    let low = 0;
    let high = 0;
    for (const [place, name] of names.entries()) {
        const panelRows = rows.filter((row) => row[facet] === name);
        const panel = stackedSeries(block, panelRows, columns, x, y, categories, normalized, groups);
        if (panel.isErr()) return err(panel.error);
        for (const entry of panel.value) {
            series.push({ ...entry, stack: `${STACK_NAME}-${place}`, xAxisIndex: place, yAxisIndex: place });
        }
        for (const [index] of categories.entries()) {
            let positive = 0;
            let negative = 0;
            for (const entry of panel.value) {
                // `stackedSeries` gives each series one part or null for each category, in category order.
                const part = toNumber((entry.data as (number | null)[])[index]);
                if (part === null) continue;
                if (part > 0) positive += part;
                else negative += part;
            }
            high = Math.max(high, positive);
            low = Math.min(low, negative);
        }
    }
    const [min, max] = normalized ? [0, 1] : roundExtent(low, high);
    const valueAxis: EchartOption = { type: "value", min, max };
    const horizontal = block.orientation === "horizontal";
    const categoryTitle = categoryAxisTitle(block.labels, x);
    const shared: AxisPair = horizontal
        ? {
              xAxis: { ...valueAxis, ...xAxisName(axisTitle(block.labels, y)) },
              yAxis: { ...HORIZONTAL_CATEGORY_AXIS, data: categories, ...axisNameFields("y", categoryTitle) },
          }
        : {
              xAxis: { type: "category", data: categories, ...axisNameFields("x", categoryTitle) },
              yAxis: { ...valueAxis, ...yAxisName(axisTitle(block.labels, y)) },
          };
    // A table with no row still draws one empty panel, thus the chart keeps its container.
    const layout = facetLayout(names.length > 0 ? names : [undefined], shared, legendOf(groups.map((name) => categoryName(name))), 0);
    return ok({ grid: layout.grid, xAxis: layout.xAxis, yAxis: layout.yAxis, series, graphic: layout.graphic, legend: layout.legend });
}

/** Per-column axis inference, and one line series per group whose data sorts by x. */
function deriveLine(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    return derivePointForm(block, rows, columns, "line");
}

/** The same axis inference as a line chart, with no sort and the large-render flags. */
function deriveScatter(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    return derivePointForm(block, rows, columns, "scatter");
}

/**
 * The base rule of a line and of a scatter: two inferred axes, and one series per group.
 *
 * A line sorts its pairs by x, because a line that zigzags states an order that no column holds. A scatter
 * keeps the row order, and it takes the large-render path of the chart runtime.
 */
function derivePointForm(
    block: ResolvedChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    form: "line" | "scatter",
): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;
    const group = block.encoding.group;
    const focused = focusSet(block.id, block.focus, rows.length, group === undefined ? [] : firstAppearance(rows.map((row) => row[group])));
    if (focused.isErr()) return err(focused.error);

    const xAxis = orderedAxis(block.id, rows, x, "x", axisTitles(block.labels, x), block.orders.x);
    if (xAxis.isErr()) return err(xAxis.error);
    const yAxis = orderedAxis(block.id, rows, y, "y", axisTitles(block.labels, y), block.orders.y);
    if (yAxis.isErr()) return err(yAxis.error);
    // A line runs along its x axis. An ordered category axis sets that order, and every other axis reads the cells.
    const places = block.orders.x !== undefined ? categoryPlaces(xAxis.value) : undefined;

    const series = groupedSeries(rows, group, (groupRows, name) => ({
        type: form,
        ...(name !== undefined ? { name: categoryName(name) } : {}),
        ...categoryStyle(name, focused.value),
        ...(form === "line" ? { showSymbol: false } : { large: true, largeThreshold: 2000 }),
        data:
            form === "line"
                ? sortByX(
                      groupRows.map((row) => [row[x], row[y]]),
                      places,
                  )
                : groupRows.map((row) => [row[x], row[y]]),
    }));
    return ok({ xAxis: xAxis.value, yAxis: yAxis.value, series });
}

/**
 * The x axis of a histogram. The axis carries the bin range of the column, and a value axis always names its
 * quantity: the declared label of the column, or the raw column name.
 */
function histogramXAxis(labels: ColumnLabels, column: string): EchartOption {
    return { type: "value", scale: true, ...xAxisName(axisTitle(labels, column)) };
}

/** Equal-width bins over the global range. Each group shares the same edges. */
function deriveHistogram(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const x = xResult.value;
    const groupCol = block.encoding.group;

    if (rows.length === 0) {
        return ok({
            xAxis: histogramXAxis(block.labels, x),
            yAxis: { ...COUNT_AXIS },
            series: [{ type: "bar", barWidth: "99%", data: [] }],
        });
    }

    const values = numericColumn(rows, x);
    if (values.length === 0) {
        return err(problem(block.id, `The histogram column "${x}" holds no numeric value.`));
    }
    const edges = histogramEdges(values);

    let series: EchartOption[];
    if (groupCol === undefined) {
        series = [histogramSeries(values, edges, undefined)];
    } else {
        series = [];
        for (const name of firstAppearance(rows.map((row) => row[groupCol]))) {
            const groupValues = numericColumn(
                rows.filter((row) => row[groupCol] === name),
                x,
            );
            series.push(histogramSeries(groupValues, edges, name));
        }
    }

    return ok({
        xAxis: histogramXAxis(block.labels, x),
        yAxis: { ...COUNT_AXIS },
        series,
    });
}

/**
 * A five-number summary per category, plus a paired scatter series for the outliers.
 *
 * A slot of fewer than five values holds no box, thus it draws its median as a short line, and its points
 * show each value where the chart draws points. A grouped box draws its points on the hidden slot axis, each
 * point inside the slot of its group.
 */
function deriveBox(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const ordered = orderQuickCategories(block.id, rows, x, block.orders.x);
    if (ordered.isErr()) return err(ordered.error);
    const categories = ordered.value;
    const groups = splitGroups(rows, block.encoding.group);
    const focused = focusSet(
        block.id,
        block.focus,
        rows.length,
        groups.flatMap((group) => (group.name === undefined ? [] : [group.name])),
    );
    if (focused.isErr()) return err(focused.error);

    const series: EchartOption[] = [];
    const valuesOf = groups.map((group) =>
        categories.map((category) =>
            numericColumn(
                group.rows.filter((row) => row[x] === category),
                y,
            ),
        ),
    );
    const pointed = drawsDistributionPoints(valuesOf.flat());
    // The axis jitter centers each point on its category and not on its slot, thus a grouped box places its
    // points on the slot axis.
    const grouped = groups.length > 1;
    const points: number[][] = [];
    const slotted: EchartOption[] = [];
    for (const [place, group] of groups.entries()) {
        const color = focusColor(focused.value, group.name);
        const slot = boxSlot(place, groups.length);
        const boxData: (number[] | string)[] = [];
        const outliers: number[][] = [];
        const slotPointList: number[][] = [];
        const medians: EchartOption[][] = [];
        for (let index = 0; index < categories.length; index++) {
            const values = valuesOf[place][index];
            if (pointed && grouped) slotPointList.push(...slotPoints(values, index, slot));
            else if (pointed) {
                for (const value of values) points.push([index, value]);
            }
            if (values.length < BOX_MIN_VALUES) {
                boxData.push("-");
                if (values.length > 0) medians.push(medianLine(values, index, slot));
                continue;
            }
            const summary = boxSummary(values);
            boxData.push(summary.box);
            // The points of a category already draw each outlier.
            if (pointed) continue;
            for (const outlier of summary.outliers) {
                outliers.push([index, outlier]);
            }
        }

        series.push({
            type: "boxplot",
            ...(group.name !== undefined ? { name: categoryName(group.name) } : {}),
            // A box draws its median in the border color, thus a focus colors the border and never the fill.
            ...(color !== undefined ? { itemStyle: { borderColor: color } } : {}),
            data: boxData,
        });
        // The outlier scatter pairs with its box series, thus it only appears when an outlier exists. A box with
        // no group takes no palette slot by name, thus its outliers take the ink of the points.
        if (outliers.length > 0) {
            const outlierColor = color ?? (group.name === undefined ? CHART_INK : undefined);
            series.push({
                type: "scatter",
                ...(group.name !== undefined ? { name: categoryName(group.name) } : {}),
                ...(outlierColor !== undefined ? { itemStyle: { color: outlierColor } } : {}),
                symbolSize: 4,
                data: outliers,
            });
        }
        const onSlots = slotSeries(group.name === undefined ? undefined : categoryName(group.name), slotPointList, medians, grouped ? color : CHART_INK);
        if (onSlots !== undefined) slotted.push(onSlots);
    }

    const pointName = groups[0]?.name;
    if (points.length > 0) series.push(pointSeries(points, pointName === undefined ? undefined : categoryName(pointName)));
    series.push(...slotted);

    const categoryAxis: EchartOption = {
        type: "category",
        data: categories,
        ...axisNameFields("x", categoryAxisTitle(block.labels, x)),
        ...(points.length > 0 ? JITTERED_AXIS : {}),
    };
    return ok({
        xAxis: slotted.length > 0 ? [categoryAxis, slotAxis(categories.length)] : categoryAxis,
        yAxis: { type: "value", ...yAxisName(axisTitle(block.labels, y)) },
        series,
    });
}

/** The fewest values of a slot that draw a box. */
const BOX_MIN_VALUES = 5;

/** The center and the width of one group slot inside a category band, as fractions of the band. */
interface Slot {
    readonly center: number;
    readonly width: number;
}

/** The share of each box slot that the chart runtime leaves as the gap between two boxes. */
const BOX_GAP_SHARE = 0.3;

/**
 * The slot of one box of a grouped box chart, as the chart runtime lays out its boxes: the boxes of one category
 * share 80 percent of the band, and a gap of 30 percent of one share sits between two boxes.
 */
function boxSlot(place: number, count: number): Slot {
    const gap = (GROUP_SPAN / count) * BOX_GAP_SHARE;
    const width = (GROUP_SPAN - gap * (count - 1)) / count;
    return { center: roundFraction(width / 2 - GROUP_SPAN / 2 + place * (gap + width)), width: roundFraction(width) };
}

/** The slot of one violin of a grouped violin chart: the slot of a grouped bar. */
function violinSlot(place: number, count: number): Slot {
    return { center: slotOffset(place, count), width: roundFraction(GROUP_SPAN / count) };
}

/** A fraction of a band, rounded to keep a float residue out of the option. */
function roundFraction(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

/**
 * The hidden value axis over the category bands of a box or a violin. The value `i` sits at the center of the
 * category `i`, as on the category axis, thus a point or a median line states its place inside a slot.
 */
function slotAxis(count: number): EchartOption {
    return { type: "value", min: -0.5, max: count - 0.5, show: false };
}

/** The part of its slot that the points of one slot spread over, and the part that a median line spans. */
const SLOT_POINT_SPREAD = 0.7;
const MEDIAN_LINE_SPAN = 0.5;

/**
 * The step of the spread of the points of one slot: the golden ratio conjugate. The places of the successive
 * points fill the slot evenly and never repeat, and the same values give the same places.
 */
const SPREAD_STEP = 0.6180339887;

/** The stroke width in pixels of the median line of a thin slot. */
const MEDIAN_LINE_WIDTH_PX = 2;

/** The points of one slot as `[band place, value]`, each value at its place across the slot, in row order. */
function slotPoints(values: readonly number[], index: number, slot: Slot): number[][] {
    return values.map((value, place) => {
        const spread = ((((place + 0.5) * SPREAD_STEP) % 1) - 0.5) * SLOT_POINT_SPREAD * slot.width;
        return [roundFraction(index + slot.center + spread), value];
    });
}

/** The median line of one slot that draws no shape: a short line across the middle of the slot at the median. */
function medianLine(values: readonly number[], index: number, slot: Slot): EchartOption[] {
    const median = quantileType7(
        [...values].sort((a, b) => a - b),
        0.5,
    );
    const half = (MEDIAN_LINE_SPAN * slot.width) / 2;
    return [{ coord: [roundFraction(index + slot.center - half), median] }, { coord: [roundFraction(index + slot.center + half), median] }];
}

/**
 * The series of one group on the slot axis: its points, and the median line of each slot that draws no shape.
 * A group with neither gives no series.
 *
 * A group takes the color of its name, as its box or its violin does, thus a thin slot reads as its group. A
 * chart with no group draws in the ink. The median line takes the color of its series.
 */
function slotSeries(
    name: string | undefined,
    points: readonly number[][],
    medians: readonly EchartOption[][],
    color: string | undefined,
): EchartOption | undefined {
    if (points.length === 0 && medians.length === 0) return undefined;
    return {
        ...pointSeries(points, name),
        itemStyle: { ...(color !== undefined ? { color } : {}), opacity: DISTRIBUTION_POINT_OPACITY },
        xAxisIndex: 1,
        ...(medians.length > 0
            ? {
                  markLine: {
                      silent: true,
                      symbol: "none",
                      label: { show: false },
                      lineStyle: { width: MEDIAN_LINE_WIDTH_PX, type: "solid", opacity: 1 },
                      data: medians.map((line) => [...line]),
                  },
              }
            : {}),
    };
}

/**
 * The count of values up to which one category of a box or a violin draws each value as a point. A summary
 * of a few values hides them, and past the count the points paint one band over the shape.
 */
const DISTRIBUTION_POINT_LIMIT = 200;

/**
 * True when a box or a violin draws its points: each category holds `DISTRIBUTION_POINT_LIMIT` values or
 * fewer. One chart draws the points on every category or on none, thus no category reads as a summary alone
 * beside a category that shows each value.
 */
function drawsDistributionPoints(categoryValues: readonly (readonly number[])[]): boolean {
    return categoryValues.every((values) => values.length <= DISTRIBUTION_POINT_LIMIT);
}

/** The symbol size and the opacity of each point over a box or a violin. The shape stays readable under them. */
const DISTRIBUTION_POINT_SIZE = 3;
const DISTRIBUTION_POINT_OPACITY = 0.6;

/**
 * The category axis of a box or a violin with points: the chart runtime spreads the points of each category
 * across its band. `jitterOverlap: false` moves a point aside only where it overlaps an earlier one, thus a
 * point stays at its value and the spread shows the density.
 */
const JITTERED_AXIS: EchartOption = { jitter: 24, jitterOverlap: false, jitterMargin: 0 };

/** The points over a box or a violin: one small point in the ink for each value, as `[category, value]`. */
function pointSeries(points: readonly number[][], name: string | undefined): EchartOption {
    return {
        type: "scatter",
        ...(name !== undefined ? { name } : {}),
        silent: true,
        symbolSize: DISTRIBUTION_POINT_SIZE,
        itemStyle: { color: CHART_INK, opacity: DISTRIBUTION_POINT_OPACITY },
        z: 5,
        data: points,
    };
}

/** One slice per group category, in first-appearance order. A repeated category refuses. */
function derivePie(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    for (const channel of ["group", "value"] as const) {
        if (block.encoding[channel] === undefined) {
            // An author reaches for `x` on a pie as on a bar, thus the refusal names the two channels of a slice.
            return err(
                problem(
                    block.id,
                    `The pie chart reads no "x" and no "y". It names its slices with the "group" column and sizes them with the "value" column. Give a column for the "${channel}" channel.`,
                ),
            );
        }
    }
    const groupResult = requireColumn(block, rows, columns, "group");
    if (groupResult.isErr()) return err(groupResult.error);
    const valueResult = requireColumn(block, rows, columns, "value");
    if (valueResult.isErr()) return err(valueResult.error);
    const groupColumn = groupResult.value;
    const valueColumn = valueResult.value;

    const seen = new Set<string>();
    const data: { name: string; value: Cell }[] = [];
    for (const row of rows) {
        const name = String(row[groupColumn]);
        if (seen.has(name)) {
            return err(problem(block.id, `The pie holds the category "${name}" more than one time.`));
        }
        seen.add(name);
        const numeric = toNumber(row[valueColumn]);
        data.push({ name, value: numeric === null ? row[valueColumn] : numeric });
    }

    return ok({
        series: [{ type: "pie", radius: "55%", data }],
    });
}

/**
 * One violin for each category and group: the Gaussian density of the values, and the inner mark of the
 * quartiles and the median.
 *
 * The outline is a custom series with the `outline` renderer, and the inner mark is a custom series with the
 * `interval` renderer. The half-width at each grid point is the density over the largest density of the
 * chart, times the half of one group slot. Thus the widest violin of the chart fills its slot, and each other
 * violin reads against it. A group channel draws one violin for each group, offset inside the band as the
 * grouped bar is.
 *
 * A category with fewer than five values, or with a bandwidth of zero, holds no density worth a shape, thus
 * it draws its median as a short line, and its points show each value where the chart draws points. A grouped
 * violin draws its points on the hidden slot axis, each point inside the slot of its group.
 */
function deriveViolin(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const ordered = orderQuickCategories(block.id, rows, x, block.orders.x);
    if (ordered.isErr()) return err(ordered.error);
    const categories = ordered.value;
    const groupColumn = block.encoding.group;
    const groups: Array<{ name: Cell | undefined }> =
        groupColumn === undefined ? [{ name: undefined }] : firstAppearance(rows.map((row) => row[groupColumn])).map((name) => ({ name }));
    const bound = slotFault(block.id, categories.length, groups.length);
    if (bound !== undefined) return err(bound);
    const named = groups.flatMap((group) => (group.name === undefined ? [] : [group.name]));
    const focused = focusSet(block.id, block.focus, rows.length, named);
    if (focused.isErr()) return err(focused.error);

    // One pass over the rows puts each numeric value into the bucket of its group and its category.
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
        const value = toNumber(row[y]);
        if (value === null) continue;
        const key = slotKey(groupColumn === undefined ? undefined : row[groupColumn], row[x]);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, [value]);
        else bucket.push(value);
    }
    const shapes: Array<Array<ViolinShape & { category: number }>> = groups.map((group) =>
        categories.flatMap((category, index) => {
            const shape = violinShape(buckets.get(slotKey(group.name, category)) ?? []);
            return shape === undefined ? [] : [{ ...shape, category: index }];
        }),
    );
    let largest = 0;
    for (const shape of shapes.flat()) {
        for (const density of shape.densities) largest = Math.max(largest, density);
    }

    const valuesOf = groups.map((group) => categories.map((category) => buckets.get(slotKey(group.name, category)) ?? []));
    const pointed = drawsDistributionPoints(valuesOf.flat());
    // The axis jitter centers each point on its category and not on its slot, thus a grouped violin places its
    // points on the slot axis.
    const grouped = groups.length > 1;
    const slotted: EchartOption[] = [];

    const series: EchartOption[] = [];
    const legend: string[] = [];
    for (const [place, group] of groups.entries()) {
        const name = group.name !== undefined ? categoryName(group.name) : axisTitle(block.labels, y);
        const offset = slotOffset(place, groups.length);
        const slot = violinSlot(place, groups.length);
        const shaped = new Set(shapes[place].map((shape) => shape.category));
        const medians = valuesOf[place].flatMap((values, index) => (shaped.has(index) || values.length === 0 ? [] : [medianLine(values, index, slot)]));
        const slotPointList = pointed && grouped ? valuesOf[place].flatMap((values, index) => slotPoints(values, index, slot)) : [];
        const color = focusColor(focused.value, group.name);
        const onSlots = slotSeries(name, slotPointList, medians, grouped ? color : CHART_INK);
        if (onSlots !== undefined) slotted.push(onSlots);
        const halfWidth = VIOLIN_HALF_WIDTH / groups.length;
        series.push({
            type: "custom",
            name,
            renderItem: OUTLINE_RENDERER,
            silent: true,
            encode: { x: 0, y: [1, 2] },
            ...(color !== undefined ? { itemStyle: { color } } : nullCategoryStyle(group.name)),
            data: shapes[place].map((shape) => [
                shape.category,
                shape.grid[0],
                shape.grid[shape.grid.length - 1],
                offset,
                ...shape.grid.flatMap((value, point) => [roundWidth(largest > 0 ? (shape.densities[point] / largest) * halfWidth : 0), value]),
            ]),
        });
        series.push({
            type: "custom",
            name,
            renderItem: INTERVAL_RENDERER,
            silent: true,
            encode: { x: 0, y: [1, 2, 3] },
            data: shapes[place].map((shape) => [shape.category, shape.median, shape.q1, shape.q3, 1, offset, 1]),
        });
        legend.push(name);
    }
    const points: number[][] = [];
    if (pointed && !grouped) {
        for (const [index, values] of (valuesOf[0] ?? []).entries()) {
            for (const value of values) points.push([index, value]);
        }
    }
    if (points.length > 0) series.push(pointSeries(points, legend[0]));
    series.push(...slotted);

    const categoryAxis: EchartOption = {
        type: "category",
        data: categories,
        ...axisNameFields("x", categoryAxisTitle(block.labels, x)),
        ...(points.length > 0 ? JITTERED_AXIS : {}),
    };
    return ok({
        xAxis: slotted.length > 0 ? [categoryAxis, slotAxis(categories.length)] : categoryAxis,
        yAxis: { type: "value", scale: true, ...yAxisName(axisTitle(block.labels, y)) },
        series,
        legend: legendOf(legend),
    });
}

/**
 * One polygon for each group over the categories of `x` as the indicators.
 *
 * The indicator bound is the largest `y` value of the table, thus each polygon reads against one scale. A
 * repeated pair is a refusal, because a radar plots one cell for each pair and never a sum. An absent pair
 * holds `null`, and the chart runtime leaves a gap there.
 */
function deriveRadar(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const groupResult = requireColumn(block, rows, columns, "group");
    if (groupResult.isErr()) return err(groupResult.error);
    const x = xResult.value;
    const y = yResult.value;
    const group = groupResult.value;

    const categories = firstAppearance(rows.map((row) => row[x]));
    const groups = firstAppearance(rows.map((row) => row[group]));
    const bound = slotFault(block.id, categories.length, groups.length);
    if (bound !== undefined) return err(bound);
    const focused = focusSet(block.id, block.focus, rows.length, groups);
    if (focused.isErr()) return err(focused.error);

    const cells = new Map<string, number | null>();
    let largest: number | undefined;
    for (const row of rows) {
        const key = pairKey(row[x], row[group]);
        if (cells.has(key)) {
            return err(problem(block.id, `The radar holds the pair (${String(row[x])}, ${String(row[group])}) more than one time.`));
        }
        const value = toNumber(row[y]);
        cells.set(key, value);
        if (value !== null) largest = largest === undefined ? value : Math.max(largest, value);
    }

    if (rows.length > 0 && (largest === undefined || largest <= 0)) {
        // The largest value bounds each indicator. A bound of zero or less draws no polygon that a reader can read.
        return err(problem(block.id, 'The radar holds no positive "y" value, thus its indicators have no bound.'));
    }
    const names = groups.map((name) => categoryName(name));
    return ok({
        radar: {
            indicator: categories.map((category) => ({ name: String(category), max: largest ?? 1 })),
            radius: RADAR_RADIUS,
        },
        series: [
            {
                type: "radar",
                data: groups.map((name, index) => ({
                    name: names[index],
                    value: categories.map((category) => cells.get(pairKey(category, name)) ?? null),
                    ...categoryStyle(name, focused.value),
                })),
            },
        ],
        legend: legendOf(names),
    });
}

/** The key of one slot: a group value and a category value. Each cell keeps its type, as a pair key does. */
function slotKey(group: Cell | undefined, category: Cell | undefined): string {
    return JSON.stringify([group === undefined ? null : cellKey(group), category === undefined ? null : cellKey(category)]);
}

/**
 * The refusal of a chart whose categories and groups give more slots than the bound, or `undefined` for a chart
 * inside the bound.
 *
 * A stacked form, a radar, a violin, and a heatmap each lay out one slot for each pair of a category and a
 * group. A sparse table of many categories and many groups gives a grid that no reader reads and that the
 * memory of the render cannot hold, thus the render refuses it before it builds one slot.
 */
function slotFault(blockId: string, categories: number, groups: number): RenderProblem | undefined {
    const slots = categories * groups;
    if (slots <= CHART_SLOT_LIMIT) return undefined;
    return problem(
        blockId,
        `The chart holds ${categories} categories and ${groups} groups, thus ${slots} slots. A chart holds ${CHART_SLOT_LIMIT} slots at most, thus a table of fewer categories or fewer groups serves the reader.`,
    );
}

/** The radius of a radar. The legend and the indicator names sit outside it. */
const RADAR_RADIUS = "62%";

// ── The composition derivation ──────────────────────────────────────────────

/**
 * The density tier of a scatter, over the row count of the bound table.
 *
 * `hover` keeps each point reachable under the pointer. `crowd` gives that up: a cloud of ten thousand
 * points cannot answer one hover, thus the shape of the cloud is what a reader gets.
 */
type ScatterDensity = "normal" | "hover" | "crowd";

/** The tier of one row count. The two counts are constants of the design source. */
function scatterDensity(rowCount: number): ScatterDensity {
    if (rowCount > SCATTER_CROWD_ROWS) return "crowd";
    if (rowCount > SCATTER_HOVER_ROWS) return "hover";
    return "normal";
}

/** The point count from which the scatter renderer takes its large path. */
const LARGE_SCATTER_THRESHOLD = 2000;

/** The opacity of the band that an `area` series draws between its two bounds. */
const BAND_OPACITY = 0.25;

/** The forms whose data runs along the x axis. A line that zigzags states an order that no column holds. */
const SORTED_FORMS: ReadonlySet<ChartSeries["form"]> = new Set(["line", "area", "step"]);

/**
 * The tooltip of a composition whose points carry no name.
 *
 * `{a}` is the series name, and `{c}` is the value of the item. The text is a static template of the
 * chart runtime, thus the option carries no function and the inline JSON stays a pure value.
 */
const PLAIN_TOOLTIP: EchartOption = { trigger: "item", formatter: "{a}: {c}" };

/** The tooltip of a composition whose points carry a name. `{b}` is the name of the item. */
const NAMED_TOOLTIP: EchartOption = { trigger: "item", formatter: "{b}<br/>{a}: {c}" };

/**
 * The label of one named point. `{b}` is the name of the item, thus the label needs no function.
 *
 * A page-side series build writes the same member onto a flagged point, thus one constant answers for the
 * inline form and the payload form alike.
 */
export const POINT_LABEL: EchartOption = { show: true, formatter: "{b}" };

/**
 * One resolved channel: the name that an axis reads, and the value that each row gives.
 *
 * `column` and `transform` are the source of the channel. The name of a transformed channel carries the
 * transform, thus it names no column of the table and a page-side build needs the two source fields.
 */
interface ResolvedChannel {
    name: string;
    values: readonly (Cell | null)[];
    transformed: boolean;
    column: string;
    transform?: ChartTransform;
    order?: ChannelOrder;
    numeric?: true;
}

/**
 * One resolved series: the declared series, and the channels that it reads. `low` and `high` are both
 * present or both absent, because an interval has two bounds.
 */
interface ResolvedSeries {
    declared: ChartSeries;
    x: ResolvedChannel;
    y: ResolvedChannel;
    y0?: ResolvedChannel;
    group?: ResolvedChannel;
    label?: readonly (Cell | null)[];
    color?: ResolvedChannel;
    size?: ResolvedChannel;
    low?: ResolvedChannel;
    high?: ResolvedChannel;
}

/**
 * One split of one declared series: the category name, the rows that it holds, and the muted flag.
 *
 * `indices` names the rows of the bound table, and never a place inside the split. Thus a per-row flag of
 * the whole table finds its row in whichever split holds it.
 *
 * `muted` is present when the split comes from a preset classification, which states the null category
 * itself. A split that comes from a group channel leaves it absent, and the null-token test answers.
 *
 * `category` is the place of the category in the classification, and it is present under the same
 * condition. A page-side build reads the place and never the name, thus the two sides compare numbers.
 */
interface SeriesSplit {
    name: Cell | undefined;
    indices: readonly number[];
    muted?: boolean;
    category?: number;
}

/**
 * One column that a page-side series build reads: the place of the column in the payload, the per-row
 * transform of the channel, and whether the page reads each cell as its number.
 */
export interface ChartColumnSource {
    readonly column: number;
    readonly transform?: ChartTransform;
    readonly numeric?: true;
}

/**
 * One runtime series, as the page builds it from the columnar payload.
 *
 * `value` is the group value of a split by a group channel, and `category` is the place of a preset
 * category. A series takes one of the two, or neither when it holds every row.
 *
 * `label` names the column that names each point, and `flags` names the rows that carry a point label. The
 * flags are row places of the payload, thus a split carries the flags of its own rows alone.
 *
 * `sort` states that the form draws along the x axis, and `swap` states that the pair leads with the value
 * of a horizontal bar. `rise` states that the points draw in the ascending order of their color, thus the high
 * values draw on top.
 *
 * `color` and `size` name the columns of a continuous color and of a symbol size. Each one adds one member
 * to the item after the pair, in that order, and a row whose cell is not numeric draws no point.
 */
export interface ChartSeriesSource {
    readonly x: ChartColumnSource;
    readonly y: ChartColumnSource;
    readonly color?: ChartColumnSource;
    readonly size?: ChartColumnSource;
    readonly group?: ChartColumnSource;
    readonly value?: Cell;
    readonly category?: number;
    readonly label?: number;
    readonly flags?: readonly number[];
    readonly sort?: boolean;
    readonly rise?: boolean;
    readonly swap?: boolean;
}

/**
 * The data source of one chart: the payload that it reads, the classification rule where a preset splits
 * the rows, and one descriptor for each runtime series in series order.
 */
export interface ChartDataSource {
    readonly payload: string;
    readonly rule?: PresetRule;
    readonly series: readonly ChartSeriesSource[];
}

/**
 * The member of the option that carries the data source.
 *
 * The chart runtime reads no member of this name, and the page bootstrap removes it before it sets the
 * option. The name leads with two underscores, thus no reader mistakes it for a field of the runtime.
 */
export const CHART_SOURCE_MEMBER = "__reportData";

/**
 * The collector of the page-side descriptors of one derivation.
 *
 * The derivation builds the option and the descriptors in one pass. `failed` states that one series
 * describes no page-side build, for example a band that draws two series from one row set. A collector
 * whose entries do not match the series of the option describes nothing, thus the chart stays inline.
 */
interface SourceCollector {
    readonly columns: readonly string[];
    readonly series: ChartSeriesSource[];
    rule?: PresetRule;
    failed: boolean;
    composed?: readonly string[];
}

/** The payload that a dense chart reads: the key of the registry, and the columns of the payload. */
export interface ChartPayloadTarget {
    readonly key: string;
    readonly columns: readonly string[];
}

/**
 * The option of one chart, whether it reads the registered payload of its artifact, the same chart with
 * every row inline, and the box of its page chart body.
 *
 * A dense page option holds no row, thus the export renders the inline option. `bodyPx` is the height of the
 * chart body: a facet grows it one row of height for each row of panels, and a figure of many rows states its
 * own. `widthPx` is the width of a figure that draws a block of a fixed size, for example the square of a PCA.
 * The card narrows the body to that width and centers it, and a chart with no such width fills the card.
 */
export interface ChartRender {
    readonly option: EchartOption;
    readonly readsPayload: boolean;
    readonly inline: EchartOption;
    readonly bodyPx: number;
    readonly widthPx?: number;
}

/**
 * One plotted point. `index` names the row that it came from, thus a rank rule can find it again. The
 * members of the wide channels are numbers, because a row whose cell is not numeric draws no point.
 */
interface Point {
    index: number;
    x: Cell;
    y: Cell;
    y0?: Cell;
    color?: number;
    size?: number;
    low?: number;
    high?: number;
}

/**
 * One runtime series, whether it can carry the mark members of the annotations, whether it draws in the
 * muted color, whether it holds a point, and whether it is an auxiliary series.
 *
 * A muted series states no finding, thus it makes a poor carrier of a guide. A classification emits one
 * series for each of its categories, thus a category that no row reaches emits an empty one.
 *
 * An auxiliary series draws an interval around the points of a series. It carries the name of that series
 * and no legend entry. `entry` names the declared series of a drawn series, thus the visual maps and the
 * value labels find the channels that it reads.
 */
interface EmittedSeries {
    option: EchartOption;
    carriesMarks: boolean;
    muted: boolean;
    empty: boolean;
    auxiliary: boolean;
    entry?: ResolvedSeries;
}

/**
 * Derive one option from a composition.
 *
 * Each declared series gives one runtime series for each value of its group column, over the resolved
 * rows of the one bound table. The annotations ride the first series that draws a column of the table,
 * because a mark member belongs to a series and one carrier states each guide one time.
 *
 * The axes come from the first declared series. A composition plots one pair of axes, thus a later series
 * shares them.
 *
 * `preset` is present when a figure composes the points of a preset, and it carries the semantic axis titles.
 * `classification` is present when that figure splits the rows itself. A series that names a group channel
 * keeps the channel, because the author asked for that split.
 *
 * `collector` is present when the caller can send the rows to the page as a payload. Each series then
 * states its own page-side build beside its option.
 */
interface CompositionExtras {
    readonly preset?: PresetAxisTitles;
    readonly classification?: PresetClassification;
    readonly collector?: SourceCollector;
    readonly focus?: readonly string[];
    readonly meanings?: ColumnMeanings;
    readonly colorOnTop?: boolean;
}

/**
 * What each series of one composition reads beside its own channels: the rows, the declarations of the
 * bound table, the preset parts, the collector, the checked focus, the rows that carry a point label, the
 * density tier, the annotations, and whether the shared x axis sorts its categories.
 */
interface CompositionContext {
    readonly blockId: string;
    readonly rows: readonly ChartRow[];
    readonly labels: ColumnLabels;
    readonly meanings: ColumnMeanings;
    readonly preset?: PresetAxisTitles;
    readonly classification?: PresetClassification;
    readonly collector?: SourceCollector;
    readonly focus?: ReadonlySet<string>;
    readonly labeled: ReadonlySet<number>;
    readonly density: ScatterDensity;
    readonly annotations: readonly ChartAnnotation[];
    readonly orderedX: boolean;
    readonly colorOnTop: boolean;
}

/** The two axes of one grid. */
interface AxisPair {
    readonly xAxis: EchartOption;
    readonly yAxis: EchartOption;
}

function deriveComposition(
    blockId: string,
    composition: ChartComposition,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    labels: ColumnLabels,
    extras: CompositionExtras = {},
): Result<EchartOption, RenderProblem> {
    const { preset, classification, collector } = extras;
    if (composition.series.length > 1 && composition.series.some(isHorizontalBar)) {
        // A horizontal bar reads its categories up the y axis, and every other form reads a value there.
        // The two share no honest axis pair on one grid, thus the mix refuses instead of plotting a lie.
        return err(problem(blockId, "A horizontal bar plots its categories on the y axis, thus it shares no axis pair with another series."));
    }
    const fault = compositionFault(composition, extras.focus);
    if (fault !== undefined) {
        return err(problem(blockId, fault));
    }

    const resolved: ResolvedSeries[] = [];
    for (const declared of composition.series) {
        const series = resolveSeries(blockId, declared, rows, columns, extras.meanings);
        if (series.isErr()) return err(series.error);
        resolved.push(series.value);
    }

    if (resolved.length === 0) {
        // The schema holds a composition to one series at least. The guard states the same rule for a
        // value that reaches the renderer without a parse, because the axes come from the first series.
        return err(problem(blockId, "The composition carries no series."));
    }

    const annotations = composition.annotations ?? [];
    const labeled = pointLabelRows(blockId, annotations, rows, columns, plottedRows(resolved, rows.length));
    if (labeled.isErr()) return err(labeled.error);
    const focused = focusSet(blockId, extras.focus, rows.length, compositionCategories(resolved, rows.length));
    if (focused.isErr()) return err(focused.error);

    if (collector !== undefined && classification !== undefined) {
        // The page splits the rows against the same cuts, thus the rule rides beside the descriptors. A rule
        // that reads a column of its own needs that column in the payload.
        collector.rule = classification.rule;
        if (classification.rule.kind === "ma" && !collector.columns.includes(classification.rule.column)) {
            collector.failed = true;
        }
    }
    // A figure titles the transform that it applies itself with its semantic title, thus only an authored
    // transform takes the label of its column inside the transform.
    const channels = resolved.flatMap((entry) =>
        [entry.x, entry.y, entry.y0, entry.color, entry.size, entry.low, entry.high].flatMap((channel) => channel ?? []),
    );
    const context: CompositionContext = {
        blockId,
        rows,
        labels: preset === undefined ? withTransformedLabels(labels, channels) : labels,
        meanings: extras.meanings,
        preset,
        classification,
        collector,
        focus: focused.value,
        labeled: labeled.value,
        density: scatterDensity(rows.length),
        annotations,
        // The axes come from the first series, thus its order sorts the shared x axis of every series.
        orderedX: resolved[0].x.order !== undefined,
        colorOnTop: extras.colorOnTop === true,
    };

    const first = resolved[0];
    const axes = compositionAxes(context, first, composition.axes);
    if (axes.isErr()) return err(axes.error);
    if (composition.facet !== undefined) {
        return deriveFacets(context, composition.facet, columns, resolved, axes.value);
    }
    const emitted = composePanel(context, resolved, undefined, axes.value, BAND_STACK_PREFIX);
    if (emitted.isErr()) return err(emitted.error);

    const named = resolved.some((entry) => entry.label !== undefined) || labeled.value.size > 0;
    const maps = visualMaps(context, resolved, emitted.value);
    const series = labeledSeries(context, emitted.value, isHorizontalBar(first.declared));
    const room = first.declared.form === "bar" ? labelRoom(series) : {};
    const horizontal = isHorizontalBar(first.declared);
    const colored = emitted.value.some((entry) => entry.entry?.color !== undefined);
    const grid = {
        // A horizontal bar draws its category names as y labels, thus the grid must hold them.
        ...(isHorizontalBar(first.declared) ? LABEL_CONTAINING_GRID : {}),
        // A continuous color draws its scale at the right edge, thus the grid leaves that band free.
        ...(colored ? { right: COLOR_SCALE_GRID_RIGHT } : {}),
    };
    return ok({
        tooltip: named ? { ...NAMED_TOOLTIP } : { ...PLAIN_TOOLTIP },
        xAxis: horizontal ? { ...axes.value.xAxis, ...room } : axes.value.xAxis,
        yAxis: horizontal ? axes.value.yAxis : { ...axes.value.yAxis, ...room },
        series,
        ...(maps.length > 0 ? { visualMap: maps } : {}),
        ...(emitted.value.some((entry) => entry.auxiliary) ? { legend: legendOf(drawnNames(emitted.value)) } : {}),
        ...(Object.keys(grid).length > 0 ? { grid } : {}),
    });
}

/** The stack prefix of a band. A facet panel adds its own place, thus two panels never stack each other. */
const BAND_STACK_PREFIX = "band-";

/** The right margin of a grid beside a continuous color scale. */
const COLOR_SCALE_GRID_RIGHT = `${COLOR_SCALE_BAND_PCT}%`;

/**
 * The fault of a composition whose forms cannot draw one of their channels, or `undefined` for a sound one.
 *
 * Each rule depends on the form, thus the grammar admits the channel and the render states the fault. A
 * silent drop would teach the author a channel that does nothing.
 */
function compositionFault(composition: ChartComposition, focus: readonly string[] | undefined): string | undefined {
    for (const series of composition.series) {
        const form = series.form;
        const encoding = series.encoding;
        if (encoding.color !== undefined && form !== "scatter" && form !== "bar") {
            return `The ${form} series takes no "color" channel. A continuous color is legal on a scatter and a bar.`;
        }
        if (encoding.color !== undefined && encoding.group !== undefined) {
            return COLOR_BESIDE_GROUP;
        }
        if (encoding.size !== undefined && form !== "scatter") {
            return `The ${form} series takes no "size" channel. A size is legal on a scatter alone.`;
        }
        if ((encoding.low === undefined) !== (encoding.high === undefined)) {
            return 'An interval has two bounds, thus a series gives "low" and "high" together.';
        }
        if (encoding.low !== undefined && form !== "scatter" && form !== "bar") {
            return `The ${form} series takes no interval. The "low" and "high" channels are legal on a bar and a scatter.`;
        }
        for (const name of ["y0", "group", "color", "size", "low", "high"] as const) {
            const channel = encoding[name];
            if (channel !== undefined && channelOrder(channel) !== undefined) {
                return `The "${name}" channel draws no category axis, thus it takes no "orderBy".`;
            }
        }
    }
    for (const [place, series] of composition.series.entries()) {
        if (place === 0) continue;
        for (const name of ["x", "y"] as const) {
            if (channelOrder(series.encoding[name]) !== undefined) {
                return `The series ${place + 1} sorts its "${name}" channel with "orderBy", and the axes of a composition read the first series alone. State the order on the first series.`;
            }
        }
    }
    for (const member of ["color", "size"] as const) {
        const keys = new Set(
            composition.series.flatMap((series) => {
                const channel = series.encoding[member];
                return channel === undefined ? [] : [`${channelColumn(channel)}:${channelTransform(channel) ?? ""}`];
            }),
        );
        if (keys.size > 1) {
            return `Two series name two different "${member}" columns. A chart reads one "${member}" channel on one scale, thus each series names the same column.`;
        }
    }
    const facet = composition.facet;
    if (facet !== undefined) {
        if (channelOrder(facet) !== undefined) {
            return 'The "facet" channel draws no category axis, thus it takes no "orderBy".';
        }
        const lead = composition.series[0]?.form;
        if (lead !== undefined && lead !== "scatter" && lead !== "line" && lead !== "bar") {
            return `A facet is legal on a scatter, a line, and a bar, thus the first series of a faceted composition takes one of those forms, and not the ${lead}.`;
        }
    }
    if (focus !== undefined && composition.series.some((series) => series.encoding.color !== undefined)) {
        return FOCUS_BESIDE_COLOR;
    }
    const banded =
        focus === undefined
            ? undefined
            : composition.series.find((series) => (series.form === "area" || series.form === "step") && series.encoding.group !== undefined);
    if (banded !== undefined) {
        return `A focus is legal on a grouped scatter, line, or bar series, and never on the grouped ${banded.form} series.`;
    }
    return undefined;
}

/**
 * The categories that a focus of one composition can name: the values of each group channel, and the `x`
 * values of each bar series that splits by no group.
 */
function compositionCategories(resolved: readonly ResolvedSeries[], rowCount: number): Cell[] {
    const categories: Cell[] = [];
    for (const entry of resolved) {
        const channel = entry.group ?? (entry.declared.form === "bar" ? entry.x : undefined);
        if (channel === undefined) continue;
        for (let index = 0; index < rowCount; index += 1) {
            const value = channel.values[index];
            if (value !== null) categories.push(value);
        }
    }
    return categories;
}

/**
 * The runtime series of one panel: each declared series over each of its splits, restricted to the rows of
 * the panel, with the interval of each series after it and the marks on one carrier.
 *
 * `members` holds the rows of a facet panel, and it is absent for a chart of one panel. The bars of one panel
 * sit side by side, thus each bar split takes its own slot of the category band and its interval takes the
 * offset of that slot.
 */
function composePanel(
    context: CompositionContext,
    resolved: readonly ResolvedSeries[],
    members: ReadonlySet<number> | undefined,
    axes: AxisPair,
    stackPrefix: string,
): Result<EmittedSeries[], RenderProblem> {
    const plan: Array<{ entry: ResolvedSeries; split: SeriesSplit }> = [];
    for (const entry of resolved) {
        for (const split of splitSeries(context.rows, entry, context.classification)) {
            plan.push({ entry, split: members === undefined ? split : { ...split, indices: split.indices.filter((index) => members.has(index)) } });
        }
    }
    const bars = plan.filter((item) => item.entry.declared.form === "bar" && item.entry.y0 === undefined);

    const emitted: EmittedSeries[] = [];
    for (const item of plan) {
        const place = bars.indexOf(item);
        const offset = place >= 0 ? slotOffset(place, bars.length) : 0;
        const built = buildSeries(context, item.entry, item.split, `${stackPrefix}${emitted.length}`, axes, offset);
        if (built.isErr()) return err(built.error);
        emitted.push(...built.value);
    }

    const marks = markMembers(context.annotations);
    const target = markCarrier(emitted);
    if (Object.keys(marks).length > 0 && target >= 0) {
        emitted[target] = { ...emitted[target], option: { ...emitted[target].option, ...marks } };
    }
    return ok(emitted);
}

/** The option of each emitted series, with the value label of each bar of a small bar chart. */
function labeledSeries(context: CompositionContext, emitted: readonly EmittedSeries[], horizontal: boolean): EchartOption[] {
    return withValueLabels(
        emitted.map((entry) => entry.option),
        horizontal,
        (cell, index) => {
            const value = emitted[index].entry?.y;
            return value === undefined ? String(cell) : valueLabelText(value.transformed ? value.name : value.column, cell, context.meanings);
        },
        (index) => emitted[index].entry?.low === undefined,
    );
}

/** The names of the drawn series, in series order. An auxiliary series names no entry of its own. */
function drawnNames(emitted: readonly EmittedSeries[]): string[] {
    return emitted.filter((entry) => !entry.auxiliary).map((entry) => String(entry.option.name));
}

/**
 * The visual maps of one composition: one map over the continuous color, and one map over the symbol size
 * for each place that the size takes in an item.
 *
 * Each map names the series that carry its dimension, thus no map reads an interval item. A color always sits
 * at dimension 2, thus one color map covers every colored series. A size sits at dimension 2 or 3, and the
 * size maps of the two dimensions share one range. Each scale reads the drawn points of its series, thus the
 * panels of a facet share one scale. The size map shows no scale,
 * because the size reads as a relative weight of each point.
 */
function visualMaps(context: CompositionContext, resolved: readonly ResolvedSeries[], emitted: readonly EmittedSeries[]): EchartOption[] {
    const colored: number[] = [];
    const sizedByDimension = new Map<number, number[]>();
    for (const [index, entry] of emitted.entries()) {
        const declared = entry.entry;
        if (entry.auxiliary || declared === undefined) continue;
        if (declared.color !== undefined) colored.push(index);
        if (declared.size !== undefined) {
            const dimension = declared.color !== undefined ? 3 : 2;
            sizedByDimension.set(dimension, [...(sizedByDimension.get(dimension) ?? []), index]);
        }
    }

    const maps: EchartOption[] = [];
    const colorChannel = resolved.find((entry) => entry.color !== undefined)?.color;
    if (colored.length > 0 && colorChannel !== undefined) {
        const scale = continuousScale(drawnMembers(emitted, colored, 2));
        const column = colorChannel.transformed ? colorChannel.name : colorChannel.column;
        maps.push({
            type: "continuous",
            seriesIndex: colored,
            dimension: 2,
            ...colorScale(scale, axisTitle(context.labels, colorChannel.name), column, declaredForColumn(context.meanings, column)),
        });
    }
    // A size column can sit at dimension 2 of one series and at dimension 3 of another. Each map names one
    // dimension, and every map reads one range over the drawn points of every sized series, thus one value
    // draws at one size in each series.
    const sizes = [...sizedByDimension].flatMap(([dimension, seriesIndex]) => drawnMembers(emitted, seriesIndex, dimension));
    for (const [dimension, seriesIndex] of sizedByDimension) {
        maps.push({
            type: "continuous",
            show: false,
            seriesIndex,
            dimension,
            min: sizes.length > 0 ? lowest(sizes) : 0,
            max: sizes.length > 0 ? highest(sizes) : 1,
            inRange: { symbolSize: [...SIZE_CHANNEL_RANGE_PX] },
        });
    }
    return maps;
}

/**
 * The members at one dimension of each item that some series draw. A row whose point drops gives no item,
 * thus a scale reads the drawn points alone and a dropped row never widens it.
 */
function drawnMembers(emitted: readonly EmittedSeries[], seriesIndex: readonly number[], dimension: number): number[] {
    const members: number[] = [];
    for (const index of seriesIndex) {
        const data = emitted[index].option.data;
        if (!Array.isArray(data)) continue;
        for (const item of data) {
            const value = Array.isArray(item) ? item : typeof item === "object" && item !== null ? (item as EchartOption).value : undefined;
            const member = Array.isArray(value) ? toNumber(value[dimension] as Cell | undefined) : null;
            if (member !== null) members.push(member);
        }
    }
    return members;
}

/** The smallest of some values, read in one pass. */
function lowest(values: readonly number[]): number {
    let min = values[0];
    for (const value of values) if (value < min) min = value;
    return min;
}

/** The largest of some values, read in one pass. */
function highest(values: readonly number[]): number {
    let max = values[0];
    for (const value of values) if (value > max) max = value;
    return max;
}

/**
 * True when the interval of one series lies along the x axis.
 *
 * The interval sits on the value axis. For a bar it is the value axis of the orientation. For a scatter it is
 * the axis that draws no category, and the y axis when both axes draw values.
 */
function intervalAlongX(entry: ResolvedSeries, axes: AxisPair): boolean {
    if (entry.declared.form === "bar") {
        return isHorizontalBar(entry.declared);
    }
    return axes.yAxis.type === "category" && axes.xAxis.type !== "category";
}

/** The place of each category of one axis, keyed by the text of the category, or `undefined` for a value axis. */
function categoryPlaces(axis: EchartOption): Map<string, number> | undefined {
    if (axis.type !== "category" || !Array.isArray(axis.data)) return undefined;
    return new Map((axis.data as Cell[]).map((category, place) => [String(category), place]));
}

/**
 * The interval series of one runtime series: one custom series with the `interval` renderer, after the series
 * that it annotates.
 *
 * Each item leads with its anchor and its value, then the two bounds, the axis, the slot offset, and the mark
 * kind. The anchor of a category axis is the place of the category, because the chart runtime rounds a
 * category coordinate. A bound on the wrong side of its value states an interval that the evidence cannot
 * hold, thus it refuses and names the row.
 *
 * The series carries the name of the series that it annotates. Thus it takes the palette slot of that name,
 * and it adds no legend entry of its own.
 */
function intervalSeries(
    blockId: string,
    entry: ResolvedSeries,
    name: string,
    points: readonly Point[],
    axes: AxisPair,
    offset: number,
): Result<EchartOption, RenderProblem> {
    const xCategories = categoryPlaces(axes.xAxis);
    const yCategories = categoryPlaces(axes.yAxis);
    if (entry.declared.form === "scatter" && xCategories !== undefined && yCategories !== undefined) {
        return err(problem(blockId, "An interval lies along the value axis, and both axes of this scatter draw categories."));
    }
    const alongX = intervalAlongX(entry, axes);
    const horizontal = isHorizontalBar(entry.declared);
    const items: number[][] = [];
    for (const point of points) {
        const renderedX = horizontal ? point.y : point.x;
        const renderedY = horizontal ? point.x : point.y;
        const value = toNumber(alongX ? renderedX : renderedY);
        const across = alongX ? renderedY : renderedX;
        const places = alongX ? yCategories : xCategories;
        const anchor = places !== undefined ? places.get(String(across)) : toNumber(across);
        const low = point.low;
        const high = point.high;
        if (value === null || anchor === undefined || anchor === null || low === undefined || high === undefined) continue;
        if (low > value || high < value) {
            const detail =
                `The row ${point.index + 1} holds the interval from ${low} to ${high} around the plotted value ${value}. ` +
                'The "low" bound sits at or under the value, and the "high" bound sits at or over it.';
            return err(problem(blockId, detail));
        }
        items.push(alongX ? [value, anchor, low, high, 0, offset, 0] : [anchor, value, low, high, 1, offset, 0]);
    }
    return ok({
        type: "custom",
        name,
        renderItem: INTERVAL_RENDERER,
        silent: true,
        // A bar draws at the level 2 of the runtime. The interval draws over it, thus the bar hides no whisker.
        z: INTERVAL_Z,
        encode: alongX ? { x: [0, 2, 3], y: 1 } : { x: 0, y: [1, 2, 3] },
        data: items,
    });
}

/** The drawing level of an interval series, over the level of a bar. */
const INTERVAL_Z = 3;

/**
 * Derive a faceted composition: one panel for each value of the facet column, in first-appearance order.
 *
 * Each panel holds one grid, one axis pair, and its own runtime series. The panels share one axis range on
 * each axis, computed from every row, thus the panels compare. `facetLayout` places the panels.
 *
 * The facet keeps its rows inline: a page-side build reads no panel, thus the collector fails.
 */
function deriveFacets(
    context: CompositionContext,
    facet: ChartChannel,
    columns: readonly string[] | undefined,
    resolved: readonly ResolvedSeries[],
    axes: AxisPair,
): Result<EchartOption, RenderProblem> {
    const channel = resolveChannel(context.blockId, facet, context.rows, columns);
    if (channel.isErr()) return err(channel.error);
    if (context.collector !== undefined) {
        context.collector.failed = true;
    }
    const split = splitByChannel(context.rows, channel.value);
    if (split.length > FACET_PANEL_LIMIT) {
        return err(
            problem(
                context.blockId,
                `The facet splits the table into ${split.length} panels. A facet holds ${FACET_PANEL_LIMIT} panels at most, thus a table of fewer groups serves the reader.`,
            ),
        );
    }
    // A table with no row still draws one empty panel, thus the chart keeps its container.
    const panels: SeriesSplit[] = split.length > 0 ? split : [{ name: undefined, indices: [] }];
    // A panel reads the category places and the axis types alone, thus it composes before the shared ranges.
    const emitted: EmittedSeries[] = [];
    for (const [place, panel] of panels.entries()) {
        const series = composePanel(context, resolved, new Set(panel.indices), axes, `${BAND_STACK_PREFIX}${place}-`);
        if (series.isErr()) return err(series.error);
        for (const entry of series.value) {
            emitted.push({ ...entry, option: { ...entry.option, xAxisIndex: place, yAxisIndex: place } });
        }
    }
    const labeledPanels = labeledSeries(context, emitted, isHorizontalBar(resolved[0].declared));
    const labeled = resolved[0].declared.form === "bar" && Object.keys(labelRoom(labeledPanels)).length > 0;
    const shared = sharedAxes(context, resolved, axes, labeled);

    // A continuous color draws its scale at the right edge, thus the panels leave that band free.
    const scaleBand = emitted.some((entry) => entry.entry?.color !== undefined) ? COLOR_SCALE_BAND_PCT : 0;
    const layout = facetLayout(
        panels.map((panel) => panel.name),
        shared,
        legendOf(drawnNames(emitted)),
        scaleBand,
    );

    const named = resolved.some((entry) => entry.label !== undefined) || context.labeled.size > 0;
    const maps = visualMaps(context, resolved, emitted);
    return ok({
        tooltip: named ? { ...NAMED_TOOLTIP } : { ...PLAIN_TOOLTIP },
        grid: layout.grid,
        xAxis: layout.xAxis,
        yAxis: layout.yAxis,
        series: labeledPanels,
        graphic: layout.graphic,
        ...(maps.length > 0 ? { visualMap: maps } : {}),
        legend: layout.legend,
    });
}

/** The layout members of a facet: one grid and one axis pair for each panel, the panel labels and the axis titles, and the legend. */
interface FacetLayout {
    readonly grid: EchartOption[];
    readonly xAxis: EchartOption[];
    readonly yAxis: EchartOption[];
    readonly graphic: EchartOption[];
    readonly legend: EchartOption;
}

/**
 * The layout of the panels of a facet, one panel for each name in order.
 *
 * One panel takes the full width, two panels take half each, and three or more lay out three to a row. The
 * label of each panel is a text element at the top left of its cell, because the layout discipline strips a
 * `title`. Each grid holds its labels and its names inside its own box, thus two panels never paint over each
 * other. `shared` gives the axes with the one range of every panel, and `scaleBand` is the band at the right
 * edge that a continuous color scale takes.
 */
function facetLayout(names: readonly (Cell | undefined)[], shared: AxisPair, legend: EchartOption, scaleBand: number): FacetLayout {
    const columnCount = names.length === 1 ? 1 : names.length === 2 ? 2 : FACET_COLUMNS;
    const rowCount = Math.ceil(names.length / columnCount);
    const legendBand = legend.show === false ? 0 : FACET_LEGEND_BAND / rowCount;
    const titleBand = FACET_TITLE_BAND / rowCount;
    const rowBand = (100 - legendBand - titleBand) / rowCount;
    const panelWidth = (100 - FACET_Y_TITLE_BAND - scaleBand - (columnCount - 1) * FACET_GUTTER) / columnCount;
    // A panel draws no axis name, because a name narrows its panel alone. A narrow panel draws fewer ticks, and a
    // tick label that overlaps its neighbor hides.
    const xAxis = panelAxis(shared.xAxis, (CHART_PAGE_WIDTH_PX * panelWidth) / 100);
    const yAxis = panelAxis(shared.yAxis);

    const grids: EchartOption[] = [];
    const xAxes: EchartOption[] = [];
    const yAxes: EchartOption[] = [];
    const graphic: EchartOption[] = [];
    for (const [place, name] of names.entries()) {
        const left = FACET_Y_TITLE_BAND + (place % columnCount) * (panelWidth + FACET_GUTTER);
        const top = Math.floor(place / columnCount) * rowBand;
        grids.push({
            left: percent(left),
            top: percent(top + rowBand * FACET_LABEL_BAND),
            width: percent(panelWidth),
            height: percent(rowBand * (1 - FACET_LABEL_BAND)),
            outerBoundsMode: FACET_BOUNDS_MODE,
            outerBoundsContain: "all",
        });
        xAxes.push({ ...xAxis, gridIndex: place });
        yAxes.push({ ...yAxis, gridIndex: place });
        if (name !== undefined) {
            graphic.push({
                type: "text",
                left: percent(left),
                top: percent(top + rowBand * FACET_LABEL_GAP),
                style: { text: categoryName(name), fill: CHART_INK, fontFamily: CHART_FONT_STACK, fontSize: CHART_PAGE_TEXT_PX, fontWeight: "bold" },
            });
        }
    }
    // Each shared axis takes one title for the whole chart: the x title under the panels, and the y title
    // turned upright in the band at the left.
    const titleStyle = { fill: CHART_INK, fontFamily: CHART_FONT_STACK, fontSize: CHART_PAGE_TEXT_PX };
    if (typeof shared.xAxis.name === "string") {
        graphic.push({ type: "text", left: "center", bottom: percent(legendBand), style: { text: shared.xAxis.name, ...titleStyle } });
    }
    if (typeof shared.yAxis.name === "string") {
        graphic.push({ type: "text", left: 0, top: "middle", rotation: Math.PI / 2, style: { text: shared.yAxis.name, ...titleStyle } });
    }

    return { grid: grids, xAxis: xAxes, yAxis: yAxes, graphic, legend };
}

/**
 * One shared axis as each panel draws it: no name and three ticks.
 *
 * A value label that overlaps its neighbor hides, because the next tick states the scale. A category label
 * names its bar, thus each one prints. A category label that does not fit its share of the panel width turns
 * 45 degrees, and 90 degrees where a turned label still covers its neighbor. `widthPx` is the panel width on
 * the page, and an x axis alone states it.
 */
function panelAxis(axis: EchartOption, widthPx?: number): EchartOption {
    const label = typeof axis.axisLabel === "object" && axis.axisLabel !== null ? (axis.axisLabel as EchartOption) : {};
    const base = { ...withoutName(axis), splitNumber: FACET_SPLIT_NUMBER };
    if (axis.type !== "category" || !Array.isArray(axis.data)) return { ...base, axisLabel: { ...label, hideOverlap: true } };
    const turn = widthPx === undefined || label.rotate !== undefined ? undefined : categoryTurn(axis.data as readonly Cell[], widthPx);
    return { ...base, axisLabel: { ...label, interval: 0, ...(turn !== undefined ? { rotate: turn } : {}) } };
}

/** The width of one character, and the height of one line, of the chart text, as a share of the text size. */
const LABEL_CHARACTER_SHARE = 0.6;
const LABEL_LINE_SHARE = 1.3;

/**
 * The turn of the category labels of one axis at one width, or `undefined` for labels that fit level.
 *
 * A level label fits where its longest name fits the band of one category. A label turned 45 degrees clears
 * its neighbor where the band, measured across the turned text, holds one line of text.
 */
function categoryTurn(categories: readonly Cell[], widthPx: number): 45 | 90 | undefined {
    if (categories.length === 0) return undefined;
    let longest = 0;
    for (const category of categories) longest = Math.max(longest, categoryName(category).length);
    const band = widthPx / categories.length;
    if (longest * CHART_PAGE_TEXT_PX * LABEL_CHARACTER_SHARE <= band) return undefined;
    return band * Math.SQRT1_2 >= CHART_PAGE_TEXT_PX * LABEL_LINE_SHARE ? 45 : 90;
}

/** The outer bounds mode of each facet panel: each grid holds its labels and its names inside its own box. */
const FACET_BOUNDS_MODE = "same";

/** The part of one panel row that the panel label takes, over the grid, and the gap over the label. */
const FACET_LABEL_BAND = 0.12;
const FACET_LABEL_GAP = 0.03;

/** The gap between two panels of one row, and the band at the left of the chart that holds the y title, in percent of the width. */
const FACET_GUTTER = 3;
const FACET_Y_TITLE_BAND = 5;

/** The part of the chart height, in percent of one panel row, that the x title of a faceted chart takes. */
const FACET_TITLE_BAND = 7;

/** The count of ticks that a panel axis aims at. */
const FACET_SPLIT_NUMBER = 3;

/** The part of the chart height, in percent of one panel row, that the legend of a faceted chart takes. */
const FACET_LEGEND_BAND = 8;

/** One layout percentage, rounded, thus a float residue of the layout never reaches the option. */
function percent(value: number): string {
    return `${Math.round(value * 1e4) / 1e4}%`;
}

/** One axis with no name. The shared range of a facet makes the name of each inner panel a repeat. */
function withoutName(axis: EchartOption): EchartOption {
    const { name: _name, nameLocation: _location, nameGap: _gap, nameRotate: _rotate, ...rest } = axis;
    return rest;
}

/**
 * The shared axes of a facet: the axes of the whole table, with one range on each value axis.
 *
 * The range reads every plotted value of every row, the two bounds of an interval, the lower bound of a
 * band, and the zero of a bar. A bar chart with value labels adds the label room. It widens to round numbers, thus the ticks of each panel land on the same
 * values. A category axis already lists the categories of every row, and a log axis keeps the range of the
 * chart runtime.
 */
function sharedAxes(context: CompositionContext, resolved: readonly ResolvedSeries[], axes: AxisPair, labeled: boolean): AxisPair {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const entry of resolved) {
        const horizontal = isHorizontalBar(entry.declared);
        const alongX = intervalAlongX(entry, axes);
        for (let index = 0; index < context.rows.length; index += 1) {
            const x = toNumber((horizontal ? entry.y : entry.x).values[index]);
            const y = toNumber((horizontal ? entry.x : entry.y).values[index]);
            if (x !== null) xs.push(x);
            if (y !== null) ys.push(y);
            const y0 = entry.y0 === undefined ? null : toNumber(entry.y0.values[index]);
            if (y0 !== null) ys.push(y0);
            for (const bound of [entry.low, entry.high]) {
                const value = bound === undefined ? null : toNumber(bound.values[index]);
                if (value !== null) (alongX ? xs : ys).push(value);
            }
        }
        if (entry.declared.form === "bar") (horizontal ? xs : ys).push(0);
    }
    // The value labels of a bar sit past the bar ends, thus the value axis of the bar takes the label room.
    const horizontal = isHorizontalBar(resolved[0].declared);
    return { xAxis: sharedRange(axes.xAxis, xs, labeled && horizontal), yAxis: sharedRange(axes.yAxis, ys, labeled && !horizontal) };
}

/**
 * One value axis with the round range of some values. Any other axis passes through.
 *
 * `room` widens the range by the label room on each side that holds a value away from zero, as the value axis
 * of a bar chart with labels does on one panel. The zero of a bar stays the end of its side.
 */
function sharedRange(axis: EchartOption, values: readonly number[], room: boolean): EchartOption {
    if (axis.type !== "value" || values.length === 0) {
        return axis;
    }
    let low = lowest(values);
    let high = highest(values);
    if (room) {
        const span = high - low;
        if (high > 0) high += span * LABEL_ROOM_SHARE;
        if (low < 0) low -= span * LABEL_ROOM_SHARE;
    }
    const [min, max] = roundExtent(low, high);
    return { ...axis, min, max };
}

/**
 * The range of some values, widened to multiples of a round step.
 *
 * The step is one, two, two and a half, five, or ten times a power of ten, near one fifth of the range. A
 * range of one value widens by a tenth of that value on each side. The ends round to twelve significant
 * digits, thus a float residue never reaches an axis label.
 */
function roundExtent(low: number, high: number): [number, number] {
    let min = low;
    let max = high;
    if (min === max) {
        const pad = min === 0 ? 1 : Math.abs(min) / 10;
        min -= pad;
        max += pad;
    }
    const raw = (max - min) / 5;
    const base = Math.pow(10, Math.floor(Math.log10(raw)));
    const fraction = raw / base;
    const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * base;
    return [Number((Math.floor(min / step) * step).toPrecision(12)), Number((Math.ceil(max / step) * step).toPrecision(12))];
}

/** Resolve each channel of one declared series against the rows. An absent column is a refusal. */
function resolveSeries(
    blockId: string,
    declared: ChartSeries,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    meanings: ColumnMeanings,
): Result<ResolvedSeries, RenderProblem> {
    const x = resolveChannel(blockId, declared.encoding.x, rows, columns).map((channel) => plottedChannel(channel, meanings));
    if (x.isErr()) return err(x.error);
    const y = resolveChannel(blockId, declared.encoding.y, rows, columns).map((channel) => plottedChannel(channel, meanings));
    if (y.isErr()) return err(y.error);
    const resolved: ResolvedSeries = { declared, x: x.value, y: y.value };

    const declaredY0 = declared.encoding.y0;
    if (declaredY0 !== undefined) {
        const y0 = resolveChannel(blockId, declaredY0, rows, columns).map((channel) => plottedChannel(channel, meanings));
        if (y0.isErr()) return err(y0.error);
        resolved.y0 = y0.value;
    }
    const declaredGroup = declared.encoding.group;
    if (declaredGroup !== undefined) {
        const group = resolveChannel(blockId, declaredGroup, rows, columns);
        if (group.isErr()) return err(group.error);
        resolved.group = group.value;
    }
    const labelColumn = declared.encoding.label;
    if (labelColumn !== undefined) {
        const absent = requirePresent(blockId, labelColumn, rows, columns);
        if (absent !== undefined) return err(absent);
        resolved.label = rows.map((row) => row[labelColumn] ?? null);
    }
    for (const member of ["color", "size", "low", "high"] as const) {
        const declaredChannel = declared.encoding[member];
        if (declaredChannel === undefined) continue;
        const channel = resolveChannel(blockId, declaredChannel, rows, columns);
        if (channel.isErr()) return err(channel.error);
        resolved[member] = channel.value;
    }
    return ok(resolved);
}

/**
 * One plotted channel with its cells as numbers, where its column holds magnitudes.
 *
 * A table that arrives as text gives each cell as a string. A column where each cell parses as a number draws
 * a value axis, thus each coordinate on it is the number of its cell. A column that holds a name keeps its
 * cells as they are: a column with a cell that is not numeric, and a column that declares the meaning of a
 * category or of an identifier, for example the cluster `01`. A transformed channel gives numbers already.
 */
function plottedChannel(channel: ResolvedChannel, meanings: ColumnMeanings): ResolvedChannel {
    if (channel.transformed || channel.values.some((cell) => cell !== null && isNonNumericString(cell))) return channel;
    const meaning = declaredForColumn(meanings, channel.column);
    if (meaning === "category" || meaning === "identifier") return channel;
    return { ...channel, values: channel.values.map((cell) => (cell === null ? null : toNumber(cell))), numeric: true };
}

/** Resolve one channel: its effective name, and the value that each row gives for it. */
function resolveChannel(
    blockId: string,
    channel: ChartChannel,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
): Result<ResolvedChannel, RenderProblem> {
    const column = channelColumn(channel);
    const absent = requirePresent(blockId, column, rows, columns);
    if (absent !== undefined) return err(absent);
    const order = channelOrder(channel);
    if (order !== undefined) {
        const absentOrder = requirePresent(blockId, order.by, rows, columns);
        if (absentOrder !== undefined) return err(absentOrder);
    }
    const ordered = order !== undefined ? { order } : {};

    const transform = channelTransform(channel);
    if (transform === undefined) {
        return ok({ name: column, values: rows.map((row) => row[column] ?? null), transformed: false, column, ...ordered });
    }
    return ok({ name: transformedName(transform, column), values: transformColumn(rows, column, transform), transformed: true, column, transform, ...ordered });
}

/** The refusal for a column that no row holds, or `undefined` when the column is present. */
function requirePresent(blockId: string, column: string, rows: readonly ChartRow[], columns: readonly string[] | undefined): RenderProblem | undefined {
    if (rows.length > 0 && !columnPresent(column, rows, columns)) {
        return problem(blockId, `The column "${column}" is absent from every row.`);
    }
    return undefined;
}

/**
 * The splits of one declared series.
 *
 * A declared group channel splits the rows, because the author asked for that split. A preset that carries
 * a classification splits them where no channel does. A series with neither takes every row.
 */
function splitSeries(rows: readonly ChartRow[], entry: ResolvedSeries, classification: PresetClassification | undefined): SeriesSplit[] {
    if (entry.group === undefined && classification !== undefined) {
        return splitByClassification(rows, entry, classification);
    }
    return splitByChannel(rows, entry.group);
}

/**
 * Split the row indices by the classification of a preset, one row at a time.
 *
 * Each category takes one split, in the order that the preset declares. Thus an empty category still emits
 * a series, and the legend of one preset reads the same on every table. The classification reads the
 * plotted pair of the row, thus it computes no aggregate and it compares against the drawn guides.
 */
function splitByClassification(rows: readonly ChartRow[], entry: ResolvedSeries, classification: PresetClassification): SeriesSplit[] {
    const splits: Array<{ name: Cell; indices: number[]; muted: boolean; category: number }> = classification.categories.map((category, place) => ({
        name: category.name,
        indices: [],
        muted: category.muted,
        category: place,
    }));
    const byName = new Map(splits.map((split) => [String(split.name), split]));
    for (let index = 0; index < rows.length; index += 1) {
        const category = classification.categoryOf(toNumber(entry.x.values[index]), toNumber(entry.y.values[index]), index);
        if (category === undefined) continue;
        byName.get(category)?.indices.push(index);
    }
    return splits;
}

/**
 * Split the row indices by the group channel, in first-appearance order.
 *
 * A row whose group cell gives no value belongs to no series, thus it drops. A series with no group
 * channel takes every row.
 */
function splitByChannel(rows: readonly ChartRow[], group: ResolvedChannel | undefined): SeriesSplit[] {
    if (group === undefined) {
        return [{ name: undefined, indices: rows.map((_row, index) => index) }];
    }
    const buckets: Array<{ name: Cell; indices: number[] }> = [];
    const byKey = new Map<string, { name: Cell; indices: number[] }>();
    for (let index = 0; index < rows.length; index += 1) {
        const value = group.values[index];
        if (value === null) continue;
        // The key carries the type of the cell, thus the number `1` and the string `"1"` are two groups.
        const key = `${typeof value}:${String(value)}`;
        let bucket = byKey.get(key);
        if (bucket === undefined) {
            bucket = { name: value, indices: [] };
            byKey.set(key, bucket);
            buckets.push(bucket);
        }
        bucket.indices.push(index);
    }
    return buckets;
}

/**
 * Build the runtime series of one declared series over one split of rows.
 *
 * A series of the null category takes the muted chart color, thus it recedes behind the categories that
 * carry a finding. A preset classification states its null category itself, and a group channel of an
 * agent-derived column answers through the null-token test. A focus replaces both rules: the named group
 * takes the focus color, and every other group takes the muted color. A bar with no group reads the focus
 * over its own categories, one item at a time. Every other series takes no color of its own, and the theme
 * palette assigns one by the series order.
 *
 * A band draws two stacked line series, and no preset emits a band. Thus the null-category color never
 * reaches one, and neither half of a band reports as muted.
 *
 * A series with an interval gives its interval series after it, at the slot offset of the series.
 */
function buildSeries(
    context: CompositionContext,
    entry: ResolvedSeries,
    split: SeriesSplit,
    stack: string,
    axes: AxisPair,
    offset: number,
): Result<EmittedSeries[], RenderProblem> {
    const form = entry.declared.form;
    const collector = context.collector;
    const points = collectPoints(entry, split.indices);
    // A line runs along its x axis. An ordered category axis sets that order, and every other axis reads the cells.
    const places = context.orderedX ? categoryPlaces(axes.xAxis) : undefined;
    const rises = context.colorOnTop && entry.color !== undefined && !SORTED_FORMS.has(form);
    if (SORTED_FORMS.has(form)) {
        points.sort((a, b) => compareAlong(a.x, b.x, places));
    } else if (rises) {
        points.sort((a, b) => (a.color ?? 0) - (b.color ?? 0));
    }
    const name = seriesName(entry, split.name, context.labels, context.preset?.y);

    if (entry.y0 !== undefined) {
        if (collector !== undefined) {
            // A band draws two stacked series over one row set, and the upper one holds a difference that no
            // cell of the table gives. Thus no descriptor states it, and the chart keeps its inline data.
            collector.failed = true;
        }
        const band = bandSeries(context.blockId, entry, name, points, stack);
        if (band.isErr()) return err(band.error);
        return ok([
            { option: band.value[0], carriesMarks: false, muted: false, empty: points.length === 0, auxiliary: false, entry },
            { option: band.value[1], carriesMarks: true, muted: false, empty: points.length === 0, auxiliary: false, entry },
        ]);
    }

    const focus = context.focus;
    const seriesFocus = entry.group !== undefined ? focusColor(focus, split.name) : undefined;
    const itemFocus = focus !== undefined && entry.group === undefined && form === "bar" ? (point: Point) => focusColor(focus, point.x) : undefined;
    const color = seriesFocus ?? ((split.muted ?? isNullCategory(split.name)) ? MUTED_CHART_COLOR : undefined);
    const { data, itemObjects } = seriesData(entry, points, context.labeled, isHorizontalBar(entry.declared), itemFocus);
    // A color or a size reads one member of each item, and the large path of the runtime draws one fill.
    const perPoint = itemObjects || entry.color !== undefined || entry.size !== undefined;
    const option = { type: runtimeType(form), name, ...seriesItemStyle(color, form, context.density), ...formOptions(form, context.density, perPoint), data };
    if (collector !== undefined) {
        collectSource(collector, entry, split, context.labeled, form, rises);
        if (itemFocus !== undefined || (places !== undefined && SORTED_FORMS.has(form))) {
            // A page-side build writes no per-item color, and it sorts a line by the cells and never by an axis
            // order. Thus such a series keeps its rows inline.
            collector.failed = true;
        }
    }
    const drawn: EmittedSeries = { option, carriesMarks: true, muted: color === MUTED_CHART_COLOR, empty: data.length === 0, auxiliary: false, entry };
    if (entry.low === undefined || entry.high === undefined) {
        return ok([drawn]);
    }
    if (collector !== undefined) {
        // A page-side build draws no interval, thus a chart with one keeps its inline data.
        collector.failed = true;
    }
    const interval = intervalSeries(context.blockId, entry, name, points, axes, offset);
    if (interval.isErr()) return err(interval.error);
    return ok([drawn, { option: interval.value, carriesMarks: false, muted: false, empty: points.length === 0, auxiliary: true }]);
}

/**
 * Collect the page-side build of one runtime series.
 *
 * The descriptor names each column by its place in the payload. A column that the payload does not hold
 * describes nothing, thus such a series marks the whole collection as failed and the chart stays inline.
 *
 * The flags name the rows of this split alone. Thus a page-side build tests one small list for each series,
 * and a split by a group channel or by a classification carries the labels of the rows that it holds.
 */
function collectSource(
    collector: SourceCollector,
    entry: ResolvedSeries,
    split: SeriesSplit,
    labeled: ReadonlySet<number>,
    form: ChartSeries["form"],
    rises: boolean,
): void {
    const x = columnSource(collector, entry.x);
    const y = columnSource(collector, entry.y);
    const group = entry.group === undefined ? undefined : columnSource(collector, entry.group);
    const labelColumn = entry.declared.encoding.label;
    const label = labelColumn === undefined ? undefined : collector.columns.indexOf(labelColumn);
    if (x === undefined || y === undefined || (entry.group !== undefined && group === undefined) || label === -1) {
        collector.failed = true;
        return;
    }
    const color = entry.color === undefined ? undefined : columnSource(collector, entry.color);
    const size = entry.size === undefined ? undefined : columnSource(collector, entry.size);
    if ((entry.color !== undefined && color === undefined) || (entry.size !== undefined && size === undefined)) {
        collector.failed = true;
        return;
    }
    const flags = split.indices.filter((index) => labeled.has(index));
    collector.series.push({
        x,
        y,
        ...(color !== undefined ? { color } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(split.category === undefined && split.name !== undefined ? { value: split.name } : {}),
        ...(split.category !== undefined ? { category: split.category } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(flags.length > 0 ? { flags } : {}),
        ...(SORTED_FORMS.has(form) ? { sort: true } : {}),
        ...(rises ? { rise: true } : {}),
        ...(isHorizontalBar(entry.declared) ? { swap: true } : {}),
    });
}

/** The payload column of one resolved channel, or `undefined` when the payload holds no such column. */
function columnSource(collector: SourceCollector, channel: ResolvedChannel): ChartColumnSource | undefined {
    const column = collector.columns.indexOf(channel.column);
    if (column < 0) {
        return undefined;
    }
    if (channel.transform !== undefined) return { column, transform: channel.transform };
    return channel.numeric === true ? { column, numeric: true } : { column };
}

/**
 * The item style of one runtime series: its own color, and the opacity of a crowd.
 *
 * One member owns the item style, thus a muted crowd keeps both fields. A series that states neither emits
 * no item style, and the theme answers for it.
 */
function seriesItemStyle(color: string | undefined, form: ChartSeries["form"], density: ScatterDensity): EchartOption {
    const fields = {
        ...(color !== undefined ? { color } : {}),
        ...(form === "scatter" && density === "crowd" ? { opacity: SCATTER_CROWD_OPACITY } : {}),
    };
    return Object.keys(fields).length > 0 ? { itemStyle: fields } : {};
}

/**
 * The index of the series that carries the mark members, or `-1` when no series can carry them.
 *
 * The chart runtime takes the stroke of a guide from the item color of its carrier, wherever the mark states
 * no color of its own. A muted carrier would thus paint each guide in the null-category color, and a carrier
 * that holds no point risks a guide that the runtime never lays out.
 *
 * Thus the ladder reads: a carrier with points and a palette color, then any carrier with a palette color,
 * then any carrier at all. Each guide reaches the page under every one of the three.
 */
function markCarrier(emitted: readonly EmittedSeries[]): number {
    const drawn = emitted.findIndex((entry) => entry.carriesMarks && !entry.muted && !entry.empty);
    if (drawn >= 0) return drawn;
    const colored = emitted.findIndex((entry) => entry.carriesMarks && !entry.muted);
    return colored >= 0 ? colored : emitted.findIndex((entry) => entry.carriesMarks);
}

/**
 * The points of one group. A row whose channel gives no value drops, and no substitute value appears. A wide
 * channel reads a number, thus a row whose color, size, or bound is not numeric drops too.
 */
function collectPoints(entry: ResolvedSeries, indices: readonly number[]): Point[] {
    const points: Point[] = [];
    for (const index of indices) {
        const x = entry.x.values[index];
        const y = entry.y.values[index];
        if (x === null || y === null) continue;
        const point: Point = { index, x, y };
        if (entry.y0 !== undefined) {
            const y0 = entry.y0.values[index];
            if (y0 === null) continue;
            point.y0 = y0;
        }
        let complete = true;
        for (const member of WIDE_MEMBERS) {
            const channel = entry[member];
            if (channel === undefined) continue;
            const value = toNumber(channel.values[index]);
            if (value === null) {
                complete = false;
                break;
            }
            point[member] = value;
        }
        if (complete) points.push(point);
    }
    return points;
}

/** The numeric channels of a point, in the order that an item holds them. */
const WIDE_MEMBERS = ["color", "size", "low", "high"] as const;

/**
 * The name of one runtime series.
 *
 * Each series carries a name, thus the `{a}` of the tooltip template always names something. A series with
 * no declared name and no group takes the name of its y channel. That name resolves the same chain as the y
 * axis, the declared label over the preset title over the raw name, thus one chart names one column one way
 * and the tooltip of a group-less preset reads no machine text.
 *
 * The category value of a group prettifies, and the declared name of a series and the label of a column
 * both stay as the author wrote them. The tooltip reads this same name, thus the legend and the hover agree.
 */
function seriesName(entry: ResolvedSeries, group: Cell | undefined, labels: ColumnLabels, preset: string | undefined): string {
    const declared = entry.declared.name;
    if (declared !== undefined && group !== undefined) return `${declared} (${categoryName(group)})`;
    if (declared !== undefined) return declared;
    if (group !== undefined) return categoryName(group);
    return axisTitle(labels, entry.y.name, preset);
}

/**
 * The data of one runtime series.
 *
 * A bare pair is the smallest item that states one point. A point that carries a name, or that the rank
 * rule marks, takes the object form, because only an object item holds a name and a label.
 *
 * The chart runtime reads the first member of a pair on the x axis. Thus a horizontal bar leads with its
 * value, and the category follows. The name of a point still reads the category channel, because the name
 * of a bar is what it counts and not how much it counts.
 */
function seriesData(
    entry: ResolvedSeries,
    points: readonly Point[],
    labeled: ReadonlySet<number>,
    horizontal: boolean,
    itemColor?: (point: Point) => string | undefined,
): { data: unknown[]; itemObjects: boolean } {
    const data: unknown[] = [];
    let itemObjects = false;
    for (const point of points) {
        const pair: Cell[] = horizontal ? [point.y, point.x] : [point.x, point.y];
        // A continuous color and a size each read one member after the pair, thus a visual map names it.
        if (point.color !== undefined) pair.push(point.color);
        if (point.size !== undefined) pair.push(point.size);
        const label = entry.label?.[point.index];
        const named = label !== undefined && label !== null;
        const marked = labeled.has(point.index);
        const color = itemColor?.(point);
        if (!named && !marked && color === undefined) {
            data.push(pair);
            continue;
        }
        itemObjects = true;
        data.push({
            value: pair,
            // A marked point of a series with no label channel takes the x cell as its name. Thus the
            // `{b}` of the label template and of the tooltip names a cell of the row, and never nothing.
            ...(named || marked ? { name: named ? String(label) : String(point.x) } : {}),
            ...(color !== undefined ? { itemStyle: { color } } : {}),
            ...(marked ? { label: { ...POINT_LABEL } } : {}),
        });
    }
    return { data, itemObjects };
}

/**
 * The two runtime series of a band.
 *
 * The chart runtime stacks a band. Thus the lower series carries the `y0` column, the upper series carries
 * the difference between the two columns, and the stack puts the upper line back on the `y` column. The
 * two series show no tooltip, because the difference is no cell of the table.
 *
 * A stack takes a difference that is not negative. A row where `y` is under `y0` names the lower bound as
 * the upper one, thus the band would draw from the axis and state a bound that no cell holds. The two
 * columns are in the wrong order, and the refusal names the row.
 */
function bandSeries(blockId: string, entry: ResolvedSeries, name: string, points: readonly Point[], stack: string): Result<EchartOption[], RenderProblem> {
    const lower: unknown[] = [];
    const upper: unknown[] = [];
    for (const point of points) {
        const base = toNumber(point.y0);
        const top = toNumber(point.y);
        if (base === null || top === null) continue;
        if (top < base) {
            const detail =
                `The band of the series "${name}" holds a row where the "${entry.y.name}" value ${top} ` +
                `is under the "${entry.y0?.name ?? ""}" value ${base}. The upper bound belongs on "y".`;
            return err(problem(blockId, detail));
        }
        lower.push([point.x, base]);
        upper.push([point.x, top - base]);
    }
    return ok([
        { type: "line", name, stack, showSymbol: false, silent: true, lineStyle: { opacity: 0 }, tooltip: { show: false }, data: lower },
        { type: "line", name, stack, showSymbol: false, areaStyle: { opacity: BAND_OPACITY }, tooltip: { show: false }, data: upper },
    ]);
}

/** The runtime type of one form. A step and an area are both a line with one more field. */
function runtimeType(form: ChartSeries["form"]): string {
    switch (form) {
        case "bar":
            return "bar";
        case "scatter":
            return "scatter";
        case "line":
        case "area":
        case "step":
            return "line";
    }
}

/**
 * The fields that one form adds to its runtime series. A scatter reads the density ladder here.
 *
 * `perPoint` states that an item carries a style of its own: a name, a label, a color, or a size.
 */
function formOptions(form: ChartSeries["form"], density: ScatterDensity, perPoint: boolean): EchartOption {
    switch (form) {
        case "bar":
            // The base bar rule puts the bars of one category side by side with no gap between them. A bar
            // of either path then reads the same.
            return { barGap: 0, barCategoryGap: BAR_CATEGORY_GAP };
        case "line":
            return { showSymbol: false };
        case "step":
            return { step: "end", showSymbol: false };
        case "area":
            return { showSymbol: false, areaStyle: {} };
        case "scatter":
            return {
                ...(density === "normal" ? {} : { symbolSize: density === "crowd" ? SCATTER_CROWD_SYMBOL_SIZE : SCATTER_HOVER_SYMBOL_SIZE }),
                // The large path draws a simplified point in one fill, and it drops a per-item style. Thus a
                // series whose items carry a name, a label, a color, or a size keeps the normal path.
                ...(perPoint ? {} : { large: true, largeThreshold: LARGE_SCATTER_THRESHOLD }),
            };
    }
}

/**
 * The row indices that one series at least can draw.
 *
 * A channel gives no value for a cell that it cannot read, and the point of such a row drops. Thus a rank
 * rule that marked such a row would spend a place on a point that the plot never shows.
 */
function plottedRows(resolved: readonly ResolvedSeries[], rowCount: number): ReadonlySet<number> {
    const plotted = new Set<number>();
    for (let index = 0; index < rowCount; index += 1) {
        for (const entry of resolved) {
            if (entry.x.values[index] === null || entry.y.values[index] === null) continue;
            if (entry.y0 !== undefined && entry.y0.values[index] === null) continue;
            if (entry.group !== undefined && entry.group.values[index] === null) continue;
            // A wide channel reads a number, and a row whose cell is not numeric draws no point.
            if (WIDE_MEMBERS.some((member) => entry[member] !== undefined && toNumber(entry[member].values[index]) === null)) continue;
            plotted.add(index);
            break;
        }
    }
    return plotted;
}

/**
 * The row indices that the point-label annotations mark. An absent rank column is a refusal.
 *
 * The marks name rows of the bound table, and every split reads them under the same numbers. Thus a split
 * by a group channel or by a preset classification carries each flag into the series that holds its row.
 */
function pointLabelRows(
    blockId: string,
    annotations: readonly ChartAnnotation[],
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    plotted: ReadonlySet<number>,
): Result<ReadonlySet<number>, RenderProblem> {
    const marked = new Set<number>();
    for (const annotation of annotations) {
        if (annotation.kind !== "point-labels") continue;
        const absent = requirePresent(blockId, annotation.column, rows, columns);
        if (absent !== undefined) return err(absent);
        for (const index of topRows(rows, annotation.column, annotation.order, annotation.n, plotted)) {
            marked.add(index);
        }
    }
    return ok(marked);
}

/**
 * The indices of the first `n` rows under the order of one column.
 *
 * A row whose cell is absent takes no place, and a row that no series draws takes no place either. Thus the
 * count of shown labels reaches the declared count wherever the table holds enough drawn rows. The sort is
 * stable, thus two equal cells keep the row order and the subset is the same on every host.
 */
function topRows(rows: readonly ChartRow[], column: string, order: "asc" | "desc", n: number, plotted: ReadonlySet<number>): number[] {
    const ranked: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        if (plotted.has(index) && rows[index][column] !== undefined) ranked.push(index);
    }
    ranked.sort((a, b) => {
        const compared = compareCell(rows[a][column], rows[b][column]);
        return order === "asc" ? compared : -compared;
    });
    return ranked.slice(0, n);
}

/**
 * The mark members of the annotations.
 *
 * A reference line and a reference band both carry a declared constant, thus each one rides as static
 * data of a mark member and nothing here reads a cell. Each line takes the guide style of the figure rules:
 * a thin gray dash, with its label inside the plot at the far end of the line.
 */
function markMembers(annotations: readonly ChartAnnotation[]): EchartOption {
    const lines: EchartOption[] = [];
    const areas: EchartOption[][] = [];
    for (const annotation of annotations) {
        if (annotation.kind === "reference-line") {
            lines.push(guideLine(annotation.axis, annotation.value, annotation.label));
            continue;
        }
        if (annotation.kind === "reference-band") {
            const position = annotation.axis === "x" ? VERTICAL_BAND_LABEL_POSITION : undefined;
            areas.push([
                { [axisKey(annotation.axis)]: annotation.from, ...markLabel(annotation.label, position) },
                { [axisKey(annotation.axis)]: annotation.to },
            ]);
        }
    }
    return {
        ...(lines.length > 0 ? { markLine: guideMarkLine(lines) } : {}),
        ...(areas.length > 0 ? { markArea: { silent: true, data: areas } } : {}),
    };
}

/**
 * The label of one mark member. The text is a constant of the annotation, and never a template.
 *
 * A member that carries neither a text nor a position emits no label member. Thus the chart runtime keeps
 * its own default, and a member of either kind that states nothing gives the same bytes as before.
 */
function markLabel(label: string | undefined, position?: string): EchartOption {
    const fields = {
        ...(label !== undefined ? { formatter: label } : {}),
        ...(position !== undefined ? { position } : {}),
    };
    return Object.keys(fields).length > 0 ? { label: fields } : {};
}

/** The mark key of one axis. A mark member names `xAxis` or `yAxis`, and the constant that sits on it. */
function axisKey(axis: "x" | "y"): "xAxis" | "yAxis" {
    return axis === "x" ? "xAxis" : "yAxis";
}

/**
 * The two axes of a composition.
 *
 * A vertical bar counts its categories on x, and every other form reads the inferred axis there. A
 * horizontal bar swaps the two: the category channel renders on y, and the value channel renders on x.
 *
 * A declared axis names the axis that it renders on, exactly as an annotation does. Thus `axes.x` titles
 * the value axis of a horizontal bar. A declared column label and a preset title both follow their own
 * column, thus each one lands on whichever axis draws that column.
 */
function compositionAxes(context: CompositionContext, first: ResolvedSeries, axes: ChartComposition["axes"]): Result<AxisPair, RenderProblem> {
    const preset = context.preset;
    const horizontal = isHorizontalBar(first.declared);
    const xAxis = horizontal ? compositionAxis(context, first.y, "x", axes?.x, preset?.y) : compositionXAxis(context, first, axes?.x, preset?.x);
    if (xAxis.isErr()) return err(xAxis.error);
    const yAxis = horizontal ? barCategoryAxis(context, first.x, "y", axes?.y, preset?.x) : compositionAxis(context, first.y, "y", axes?.y, preset?.y);
    if (yAxis.isErr()) return err(yAxis.error);
    if (first.declared.form !== "bar") {
        return ok({ xAxis: xAxis.value, yAxis: yAxis.value });
    }
    // A bar measures from zero. A fitted value axis would cut the zero off, and a bar would draw a height that
    // no cell holds. Thus the value axis of a bar keeps zero in its range.
    return ok(horizontal ? { xAxis: unscaled(xAxis.value), yAxis: yAxis.value } : { xAxis: xAxis.value, yAxis: unscaled(yAxis.value) });
}

/** One axis with no fitted range. A value axis then holds zero, as the chart runtime draws it by default. */
function unscaled(axis: EchartOption): EchartOption {
    const { scale: _scale, ...rest } = axis;
    return rest;
}

/**
 * The x axis of a composition whose bars stand up, or of any other form.
 *
 * A bar takes a category axis, and every other form takes the inferred axis. A declared scale is the one
 * exception, because the author asked for a numeric axis and a category axis has no scale.
 */
function compositionXAxis(
    context: CompositionContext,
    first: ResolvedSeries,
    declared: ChartAxes["x"],
    preset: string | undefined,
): Result<EchartOption, RenderProblem> {
    if (first.declared.form !== "bar" || declared?.scale !== undefined) {
        return compositionAxis(context, first.x, "x", declared, preset);
    }
    return barCategoryAxis(context, first.x, "x", declared, preset);
}

/**
 * The category axis of a composition bar, on whichever axis it renders.
 *
 * A bar counts its categories. The base bar rule lists the values of the category channel in
 * first-appearance order, thus a bar of either path draws the same axis. A channel that declares an order
 * sorts the list. A declared scale asks for a numeric axis, and a category axis has no scale, thus such an
 * axis falls to the inferred one.
 *
 * A category axis on y inverts, thus the first row of the table reads at the top of the plot.
 */
function barCategoryAxis(
    context: CompositionContext,
    channel: ResolvedChannel,
    axis: "x" | "y",
    declared: ChartAxes["x"],
    preset: string | undefined,
): Result<EchartOption, RenderProblem> {
    if (declared?.scale !== undefined) {
        return compositionAxis(context, channel, axis, declared, preset);
    }
    const ordered = orderChannel(context, channel, firstAppearance(channel.values.filter((value): value is Cell => value !== null)));
    if (ordered.isErr()) return err(ordered.error);
    const typeFields = axis === "x" ? { type: "category" } : { ...HORIZONTAL_CATEGORY_AXIS };
    return ok({ ...typeFields, data: ordered.value, ...axisNameFields(axis, categoryAxisTitle(context.labels, channel.name, declared?.title)) });
}

/**
 * The axis of one composition channel.
 *
 * A declared axis title wins, because it names this one axis. The declared label of the column comes next,
 * then the semantic title of the preset, and the raw column name answers last. A declared `log` scale maps
 * onto the logarithmic axis type. A transformed channel gives a number for each point that survives it,
 * thus its axis is a value axis and the cells of the untransformed column decide nothing.
 *
 * A channel that declares an order sorts the categories of an inferred category axis. On a value axis the
 * order sorts nothing, thus it refuses.
 */
function compositionAxis(
    context: CompositionContext,
    channel: ResolvedChannel,
    axis: "x" | "y",
    declared: ChartAxes["x"],
    preset: string | undefined,
): Result<EchartOption, RenderProblem> {
    const titles: AxisTitles = {
        value: declared?.title ?? axisTitle(context.labels, channel.name, preset),
        category: categoryAxisTitle(context.labels, channel.name, declared?.title),
    };
    const base =
        declared?.scale === "log"
            ? { type: "log", ...axisNameFields(axis, titles.value) }
            : channel.transformed
              ? { type: "value", scale: true, ...axisNameFields(axis, titles.value) }
              : inferAxis(context.rows, channel.name, axis, titles);
    if (channel.order === undefined) {
        return ok(base);
    }
    if (base.type !== "category") {
        return err(problem(context.blockId, valueAxisOrderFault(channel.column)));
    }
    const ordered = orderChannel(context, channel, base.data as string[]);
    return ordered.map((data) => ({ ...base, data }));
}

/** Sort the categories of one composition channel by its order, or keep them where it declares none. */
function orderChannel<T extends Cell>(context: CompositionContext, channel: ResolvedChannel, categories: readonly T[]): Result<T[], RenderProblem> {
    const order = channel.order;
    return orderCategories(
        context.blockId,
        context.rows.length,
        (index) => channel.values[index],
        categories,
        order,
        (index) => (order === undefined ? undefined : context.rows[index][order.by]),
    );
}

// ── The shared building blocks ──────────────────────────────────────────────

/**
 * Resolve one demanded channel to its column name.
 *
 * A channel that the encoding omits is a refusal. A named column that no row holds is a refusal too.
 * A zero-row chart skips the row check, thus it renders an empty container.
 */
function requireColumn(
    block: ResolvedChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    channel: Channel,
): Result<string, RenderProblem> {
    const column = block.encoding[channel];
    if (column === undefined) {
        return err(problem(block.id, `The ${block.chartType} chart needs a column for the "${channel}" channel.`));
    }
    if (rows.length > 0 && !columnPresent(column, rows, columns)) {
        return err(problem(block.id, `The column "${column}" is absent from every row.`));
    }
    return ok(column);
}

/**
 * Resolve one demanded channel of a quick-path encoding to the channel itself.
 *
 * The composition derivation matches the column against the rows, thus this check answers for the
 * presence of the channel alone and it names the channel that the chart type demands.
 */
function requireChannel(blockId: string, chartType: ChartType, encoding: ChartEncoding, channel: Channel): Result<ChartChannel, RenderProblem> {
    const declared = encoding[channel];
    if (declared === undefined) {
        return err(problem(blockId, `The ${chartType} chart needs a column for the "${channel}" channel.`));
    }
    return ok(declared);
}

/**
 * The name of a derived column, for example `neg_log10(padj)`.
 *
 * The name carries the transform, thus an axis that takes its name from the column never states the
 * untransformed quantity.
 */
function transformedName(transform: ChartTransform, column: string): string {
    return `${transform}(${column})`;
}

/** True when the cell is a string that does not represent a finite number. */
function isNonNumericString(cell: Cell | undefined): boolean {
    return typeof cell === "string" && toNumber(cell) === null;
}

/** The numeric cells of one column, in row order. A non-numeric cell drops. */
function numericColumn(rows: readonly ChartRow[], column: string): number[] {
    const values: number[] = [];
    for (const row of rows) {
        const value = toNumber(row[column]);
        if (value !== null) values.push(value);
    }
    return values;
}

/**
 * The axis of a line or a scatter column under the order of its channel.
 *
 * A category axis sorts its categories where the channel declares an order. A value axis draws no category,
 * thus an order on it is a refusal and never a silent drop.
 */
function orderedAxis(
    blockId: string,
    rows: readonly ChartRow[],
    column: string,
    axis: "x" | "y",
    titles: AxisTitles,
    order: ChannelOrder | undefined,
): Result<EchartOption, RenderProblem> {
    const inferred = inferAxis(rows, column, axis, titles);
    if (order === undefined) {
        return ok(inferred);
    }
    if (inferred.type !== "category") {
        return err(problem(blockId, valueAxisOrderFault(column)));
    }
    const sorted = orderCategories(
        blockId,
        rows.length,
        (index) => String(rows[index][column]),
        inferred.data as string[],
        order,
        (index) => rows[index][order.by],
    );
    return sorted.map((data) => ({ ...inferred, data }));
}

/** The refusal of an order on a channel whose axis draws values. */
function valueAxisOrderFault(column: string): string {
    return `The column "${column}" draws a value axis, thus its channel takes no "orderBy". An order sorts the categories of a category axis.`;
}

/**
 * The set of the focus values, checked against the categories of the chart, or `undefined` for a chart that
 * declares no focus.
 *
 * A focus value that no category holds names a finding that the chart does not draw, thus it refuses. A
 * chart with no row draws no category at all, and its empty container stands as every empty chart does.
 */
function focusSet(
    blockId: string,
    focus: readonly string[] | undefined,
    rowCount: number,
    categories: readonly (Cell | null | undefined)[],
): Result<ReadonlySet<string> | undefined, RenderProblem> {
    if (focus === undefined) {
        return ok(undefined);
    }
    if (rowCount > 0) {
        const held = new Set(categories.flatMap((category) => (category === null || category === undefined ? [] : [String(category)])));
        for (const value of focus) {
            if (!held.has(value)) {
                return err(problem(blockId, `The focus names "${value}", which no category of the chart holds.`));
            }
        }
    }
    return ok(new Set(focus));
}

/**
 * Give each bar of a small bar chart a value label.
 *
 * The count of bars reads across the series, and a chart past the bound labels nothing. A stacked part
 * carries no label, because its label overlaps the next part. A series that `labelable` refuses carries none
 * either: the whisker of an interval stands where the label would stand. An item that already carries a
 * label keeps it, thus the point name of an annotation wins. The label text is a static string, thus the option carries
 * no function and the plotted value stays the cell.
 */
function withValueLabels(
    series: readonly EchartOption[],
    horizontal: boolean,
    textOf: (cell: Cell, index: number) => string,
    labelable: (index: number) => boolean = () => true,
): EchartOption[] {
    const labeled = (entry: EchartOption): boolean => entry.type === "bar" && entry.stack === undefined && Array.isArray(entry.data);
    let count = 0;
    for (const entry of series) {
        if (labeled(entry)) count += (entry.data as unknown[]).length;
    }
    if (count === 0 || count > BAR_VALUE_LABEL_LIMIT) {
        return [...series];
    }
    return series.map((entry, index) => {
        if (!labeled(entry) || !labelable(index)) return entry;
        const data = (entry.data as unknown[]).map((item) => {
            // A bar item is a pair or an object whose value is the pair, thus the two forms read one field.
            const fields: EchartOption = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as EchartOption) : { value: item };
            if (fields.label !== undefined || !Array.isArray(fields.value)) return item;
            const cell = (fields.value as Cell[])[horizontal ? 0 : 1];
            return { ...fields, label: { show: true, position: labelPosition(cell, horizontal), formatter: textOf(cell, index) } };
        });
        return { ...entry, data };
    });
}

/** The part of the value range that a labeled bar chart adds at each end of its value axis. */
const LABEL_ROOM_PCT = 15;
const LABEL_ROOM_SHARE = LABEL_ROOM_PCT / 100;
const LABEL_AXIS_ROOM = `${LABEL_ROOM_PCT}%`;

/**
 * The room of a value axis whose bars carry value labels, or no field for any other axis.
 *
 * A label sits past the end of its bar. The end of the longest bar lies at the end of the axis, thus without
 * room its label would stand over the category labels or past the plot.
 */
function labelRoom(series: readonly EchartOption[]): EchartOption {
    const labeled = series.some(
        (entry) =>
            entry.type === "bar" &&
            Array.isArray(entry.data) &&
            entry.data.some((item: unknown) => typeof item === "object" && item !== null && !Array.isArray(item) && (item as EchartOption).label !== undefined),
    );
    return labeled ? { boundaryGap: [LABEL_AXIS_ROOM, LABEL_AXIS_ROOM] } : {};
}

/**
 * The place of the value label of one bar: past the end of the bar, away from the zero line. A negative bar
 * grows down or to the left, thus its label sits under it or at its left.
 */
function labelPosition(cell: Cell, horizontal: boolean): string {
    const negative = (toNumber(cell) ?? 0) < 0;
    if (horizontal) return negative ? "left" : "right";
    return negative ? "bottom" : "top";
}

/**
 * The value label of one bar: the shown form of the number helper, for the column and the meaning that the
 * bound table declares. A card and a label of one page then read one number one way.
 */
function valueLabelText(column: string, cell: Cell, meanings: ColumnMeanings): string {
    return formatNumberCell(cell, selectNumberKind(column, cell, declaredForColumn(meanings, column))).text;
}

/**
 * The legend of a chart that states its own entries: the names of the drawn series, shown at the bottom
 * where two or more of them exist, and hidden where one exists.
 *
 * An auxiliary series carries the name of the series that it annotates, thus it adds no entry of its own.
 */
function legendOf(names: readonly string[]): EchartOption {
    const unique = firstAppearance(names);
    return unique.length >= 2 ? { bottom: 0, data: unique } : { show: false };
}

/**
 * The offset of one group slot inside a category band, as a fraction of the band.
 *
 * The chart runtime draws the bars of one category over 80 percent of the band, one equal slot for each
 * group. The offset is the center of the slot of `place`. The rounding keeps a float residue out of the
 * option, thus two slots of one chart read as two clean fractions.
 */
function slotOffset(place: number, count: number): number {
    if (count <= 1) return 0;
    return Math.round((((place + 0.5) * GROUP_SPAN) / count - GROUP_SPAN / 2) * 1e6) / 1e6;
}

/** The part of one category band that the group slots cover. Each bar series states the matching gap. */
const GROUP_SPAN = 0.8;

/**
 * The category gap of each bar series: the part of one band that the bars leave free.
 *
 * The chart runtime computes a gap from the count of the bar series when a series states none, and the slot
 * offset of an interval reads a fixed span. Thus each bar states the gap that matches `GROUP_SPAN`, and an
 * interval sits over the center of its own bar.
 */
const BAR_CATEGORY_GAP = "20%";

/**
 * The two titles of one axis: the title that a value axis shows, and the title that a category axis shows
 * where the block declares one.
 */
interface AxisTitles {
    readonly value: string;
    readonly category?: string;
}

/** The two titles of the axis of one quick-path column: its value title, and its declared label alone. */
function axisTitles(labels: ColumnLabels, column: string): AxisTitles {
    return { value: axisTitle(labels, column), category: categoryAxisTitle(labels, column) };
}

/**
 * The axis for a line or a scatter column. A column with any non-numeric string cell is a category axis
 * with its distinct values as strings. Any other column is a value axis with `scale: true`.
 *
 * The `axis` argument names the channel that the column feeds, and the helper of the figure rules places the
 * name. The column decides the axis type, and the type decides the title: a value axis always names its
 * quantity, and a category axis names a declared title alone.
 */
function inferAxis(rows: readonly ChartRow[], column: string, axis: "x" | "y", titles: AxisTitles): EchartOption {
    if (rows.some((row) => isNonNumericString(row[column]))) {
        return { type: "category", data: firstAppearance(rows.map((row) => row[column])).map(String), ...axisNameFields(axis, titles.category) };
    }
    return { type: "value", scale: true, ...axisNameFields(axis, titles.value) };
}

/**
 * Build one series per group, in first-appearance order of the group values. A chart with no group
 * column gets one series over every row.
 */
function groupedSeries(
    rows: readonly ChartRow[],
    groupCol: string | undefined,
    make: (groupRows: readonly ChartRow[], name: Cell | undefined) => EchartOption,
): EchartOption[] {
    if (groupCol === undefined) {
        return [make(rows, undefined)];
    }
    const series: EchartOption[] = [];
    for (const name of firstAppearance(rows.map((row) => row[groupCol]))) {
        series.push(
            make(
                rows.filter((row) => row[groupCol] === name),
                name,
            ),
        );
    }
    return series;
}

/** The row groups in first-appearance order, or one unnamed group when there is no group column. */
function splitGroups(rows: readonly ChartRow[], groupCol: string | undefined): Array<{ name: Cell | undefined; rows: readonly ChartRow[] }> {
    if (groupCol === undefined) {
        return [{ name: undefined, rows }];
    }
    return firstAppearance(rows.map((row) => row[groupCol])).map((name) => ({
        name,
        rows: rows.filter((row) => row[groupCol] === name),
    }));
}

/**
 * Sort `[x, y]` pairs by x. Two numbers compare numerically, and any other pair compares as text. Where an
 * ordered category axis gives the place of each category, the pairs follow those places.
 */
function sortByX(pairs: Cell[][], places?: ReadonlyMap<string, number>): Cell[][] {
    return [...pairs].sort((a, b) => compareAlong(a[0], b[0], places));
}

/** Compare two x cells along an ordered category axis, or by the compare of a sort where no axis order applies. */
function compareAlong(a: Cell, b: Cell, places: ReadonlyMap<string, number> | undefined): number {
    if (places === undefined) return compareCell(a, b);
    return (places.get(String(a)) ?? 0) - (places.get(String(b)) ?? 0);
}

/**
 * A stable key for one `(x, y)` pair. The key carries the type of each cell, thus the number `1` and the
 * string `"1"` are different pairs and a false collision is impossible.
 */
function pairKey(xCell: Cell, yCell: Cell): string {
    return `${typeof xCell}:${String(xCell)} ${typeof yCell}:${String(yCell)}`;
}

/** A stable key for one cell. The key carries the type of the cell, exactly as a pair key does. */
function cellKey(cell: Cell): string {
    return `${typeof cell}:${String(cell)}`;
}

// ── The histogram math ──────────────────────────────────────────────────────

/**
 * The bin edges over the global range. The bin count is the larger of the Sturges count and the
 * Freedman-Diaconis count. One bin applies when the range is zero.
 */
function histogramEdges(values: readonly number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (max === min) {
        return [min, max];
    }
    const count = autoBinCount(sorted, min, max);
    const width = (max - min) / count;
    const edges: number[] = [];
    for (let i = 0; i <= count; i++) {
        edges.push(min + i * width);
    }
    // Pin the last edge to the exact max, thus a float drift cannot drop the top value out of the range.
    edges[count] = max;
    return edges;
}

/**
 * The automatic bin count: `max(Sturges, Freedman-Diaconis)`. Sturges is `ceil(log2(n)) + 1`.
 * Freedman-Diaconis derives the width `2 * IQR / n^(1/3)` and the count `ceil((max - min) / width)`. When
 * the IQR is zero, the Sturges count applies alone.
 */
function autoBinCount(sorted: readonly number[], min: number, max: number): number {
    const n = sorted.length;
    const sturges = Math.ceil(Math.log2(n)) + 1;
    const iqr = quantileType7(sorted, 0.75) - quantileType7(sorted, 0.25);
    if (iqr === 0) {
        return Math.max(1, sturges);
    }
    const width = (2 * iqr) / Math.cbrt(n);
    const fd = Math.ceil((max - min) / width);
    return Math.max(1, sturges, fd);
}

/** The bin counts for the values against the edges. The max value falls in the last bin. */
function binCounts(values: readonly number[], edges: readonly number[]): number[] {
    const bins = edges.length - 1;
    const counts = new Array<number>(bins).fill(0);
    const min = edges[0];
    const width = (edges[bins] - min) / bins;
    for (const value of values) {
        let index = width === 0 ? 0 : Math.floor((value - min) / width);
        if (index < 0) index = 0;
        if (index >= bins) index = bins - 1;
        counts[index] += 1;
    }
    return counts;
}

/** One histogram series. Each bar sits at the bin midpoint. A grouped series overlaps its siblings. */
function histogramSeries(values: readonly number[], edges: readonly number[], name: Cell | undefined): EchartOption {
    const counts = binCounts(values, edges);
    const data: number[][] = [];
    for (let i = 0; i < counts.length; i++) {
        data.push([(edges[i] + edges[i + 1]) / 2, counts[i]]);
    }
    if (name === undefined) {
        return { type: "bar", barWidth: "99%", data };
    }
    return {
        type: "bar",
        name: categoryName(name),
        barWidth: "99%",
        barGap: "-100%",
        itemStyle: { opacity: 0.7 },
        data,
    };
}

// ── The box math ────────────────────────────────────────────────────────────

/**
 * The five-number summary of one category.
 *
 * The quartiles are type-7 quantiles. The whiskers are the Tukey fences at `1.5 * IQR`, clamped to the
 * nearest data value inside each fence. A value outside a fence is an outlier.
 */
function boxSummary(values: readonly number[]): { box: number[]; outliers: number[] } {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantileType7(sorted, 0.25);
    const median = quantileType7(sorted, 0.5);
    const q3 = quantileType7(sorted, 0.75);
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;

    let whiskerLow = q1;
    let whiskerHigh = q3;
    let lowSet = false;
    const outliers: number[] = [];
    for (const value of sorted) {
        if (value < lowerFence || value > upperFence) {
            outliers.push(value);
            continue;
        }
        // The values arrive in ascending order. Thus the first in-fence value is the low whisker, and the
        // last in-fence value is the high whisker.
        if (!lowSet) {
            whiskerLow = value;
            lowSet = true;
        }
        whiskerHigh = value;
    }

    return { box: [whiskerLow, q1, median, q3, whiskerHigh], outliers };
}

// ── The violin math ─────────────────────────────────────────────────────────

/** The half-width of the widest violin of a chart, as a fraction of one category band. */
const VIOLIN_HALF_WIDTH = 0.4;

/** The count of values under which a category draws no violin, exactly as it draws no box. */
const VIOLIN_MIN_VALUES = 5;

/** The shape of one violin: the grid, the density at each grid point, and the three quartiles. */
interface ViolinShape {
    readonly grid: readonly number[];
    readonly densities: readonly number[];
    readonly q1: number;
    readonly median: number;
    readonly q3: number;
}

/**
 * The Gaussian kernel density of one category on the fixed grid, or `undefined` for a category that draws
 * nothing.
 *
 * The bandwidth is the Silverman rule, `0.9 * min(sd, IQR / 1.34) * n^(-1/5)`, with the sample standard
 * deviation and the type-7 quartiles of the box rule. A category whose quartiles are equal reads the
 * standard deviation alone, thus a tied middle with spread tails still draws. The grid holds 64 points
 * from the minimum to the maximum, and the last point pins to the maximum, thus a float drift cannot move
 * the end of the outline.
 */
function violinShape(values: readonly number[]): ViolinShape | undefined {
    const n = values.length;
    if (n < VIOLIN_MIN_VALUES) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantileType7(sorted, 0.25);
    const median = quantileType7(sorted, 0.5);
    const q3 = quantileType7(sorted, 0.75);
    let sum = 0;
    for (const value of sorted) sum += value;
    const mean = sum / n;
    let squares = 0;
    for (const value of sorted) squares += (value - mean) * (value - mean);
    const sd = Math.sqrt(squares / (n - 1));
    const iqr = q3 - q1;
    const spread = iqr > 0 ? Math.min(sd, iqr / 1.34) : sd;
    const bandwidth = 0.9 * spread * Math.pow(n, -1 / 5);
    if (!(bandwidth > 0)) return undefined;

    const min = sorted[0];
    const max = sorted[n - 1];
    const grid: number[] = [];
    for (let point = 0; point < VIOLIN_GRID_POINTS; point += 1) {
        grid.push(min + (point * (max - min)) / (VIOLIN_GRID_POINTS - 1));
    }
    grid[VIOLIN_GRID_POINTS - 1] = max;
    const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
    const densities = grid.map((at) => {
        let total = 0;
        for (const value of sorted) {
            const z = (at - value) / bandwidth;
            total += Math.exp(-0.5 * z * z);
        }
        return total * norm;
    });
    return { grid, densities, q1, median, q3 };
}

/**
 * Round one half-width of an outline to four decimals of a band.
 *
 * The density reads `Math.exp`, whose last bit can differ between two engines. Four decimals of a band lies
 * far under one pixel, thus the rounding costs no shape and one table gives one option on every host.
 */
function roundWidth(width: number): number {
    return Math.round(width * 1e4) / 1e4;
}

/**
 * The type-7 quantile of a sorted array. The index is `p * (n - 1)`, and the value interpolates
 * linearly between the `floor` and the `ceil` of that index.
 */
function quantileType7(sorted: readonly number[], p: number): number {
    const n = sorted.length;
    if (n === 1) return sorted[0];
    const index = p * (n - 1);
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low];
    return sorted[low] + (index - low) * (sorted[high] - sorted[low]);
}
