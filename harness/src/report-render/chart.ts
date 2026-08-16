/**
 * The chart derivation of the report page.
 *
 * A chart block binds one whole-table artifact, and it carries the quick path or the composition.
 * `deriveChartOption` turns that grammar and the resolved rows into one ECharts option object. The chart
 * container markup lives beside this file, and it wraps the option that this derivation gives.
 *
 * The derivation reads one shape. A preset expands into a composition before the derivation
 * (`chart-presets.ts`), and each base chart type keeps its own fixed rule. Thus the two paths cannot
 * drift.
 *
 * The renderer computes no aggregate. Each plotted number stays traceable to one cell of the evidence
 * artifact, or to a per-row transform of one cell. A pie or a heatmap arrives one row per category or per
 * cell, thus a repeated category or a repeated pair is a refusal and not a silent sum.
 *
 * The derivation is deterministic. Every object builds in one fixed key order, and the code reads no
 * clock, no random value, and no locale. A string comparison uses the code-unit order (`<`) and never
 * `localeCompare`, thus the same rows give the same bytes on every host.
 *
 * The option rides to the page as inline JSON. Thus no axis label and no tooltip can carry a function
 * formatter, and every formatter here is a static template of the chart runtime. As a result the
 * derivation bounds the tick precision of the one axis whose unit it declares itself, and every other
 * value axis keeps the tick values that ECharts computes.
 */

import { err, ok, type Result } from "neverthrow";

import {
    channelColumn,
    channelTransform,
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
import { declaredForColumn, type ArtifactTableReference } from "../contracts/report-reference.js";
import { normalizeEchartSpec } from "../tools/display/normalize-echart-spec.js";
import {
    expandPreset,
    isPresetChartType,
    presetAxisTitles,
    type PresetAxisTitles,
    type PresetChartType,
    type PresetClassification,
    type PresetRule,
} from "./chart-presets.js";
import {
    CHART_INLINE_OPTION_BOUND,
    MUTED_CHART_COLOR,
    SCATTER_CROWD_OPACITY,
    SCATTER_CROWD_ROWS,
    SCATTER_CROWD_SYMBOL_SIZE,
    SCATTER_HOVER_ROWS,
    SCATTER_HOVER_SYMBOL_SIZE,
} from "./design.js";
import type { RenderProblem } from "./types.js";

/** One cell of a resolved row. A cell is one string or one number. */
export type Cell = string | number;

/** One resolved row of the bound table, keyed by column name. */
export type ChartRow = Record<string, Cell>;

/** The derived option object, ready for `normalizeEchartSpec` and the inline JSON. */
export type EchartOption = Record<string, unknown>;

/** The four channels of a chart encoding. Each type demands a subset of them. */
type Channel = "x" | "y" | "group" | "value";

/** One chart type that carries its own fixed rule. A preset carries no rule, because it expands first. */
type BaseChartType = Exclude<ChartType, PresetChartType>;

/** The display labels that the bound table declares, keyed by the raw column name. */
type ColumnLabels = ArtifactTableReference["columnLabels"];

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
    labels: ColumnLabels;
    orientation: ChartOrientation;
}

/**
 * The ten-stop viridis ramp for a heatmap `visualMap`. The stops run dark to light, thus a continuous
 * scale maps the low value to `#440154` and the high value to `#fde725`.
 */
const VIRIDIS = ["#440154", "#482777", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];

/**
 * The distance in pixels between the x axis line and its name.
 *
 * The name sits under the middle of the axis, thus the gap must clear the axis labels below the line. The
 * value is a fixed constant, thus the derivation stays deterministic.
 */
const X_AXIS_NAME_GAP = 34;

/**
 * The label position of a vertical guide line.
 *
 * The start of such a line sits at the x axis, and its end sits at the top of the plot. The top is the band
 * of the y-axis title, thus a label there reads over the title.
 */
const VERTICAL_LABEL_POSITION = "start";

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
const COUNT_AXIS: EchartOption = { type: "value", name: "Count", minInterval: 1 };

/**
 * The name fields of an x axis.
 *
 * `normalizeEchartSpec` holds the grid to a right margin of 5 percent. The ECharts default `nameLocation`
 * of `"end"` puts the name at the right end of the axis, thus the name runs past that margin and the panel
 * clips it. A centered name sits under the middle of the axis, and no margin can cut it.
 */
function xAxisName(title: string): EchartOption {
    return { name: title, nameLocation: "middle", nameGap: X_AXIS_NAME_GAP };
}

/**
 * The title of the axis that reads one column, most specific first: the declared label of the column, the
 * semantic title of the preset, then the raw column name.
 *
 * A declared label answers for this one column of this one artifact, and a preset title answers for every
 * chart of its kind. Thus the label outranks the preset. The caller resolves an agent axes title over this
 * whole chain, because that title names this one axis of this one block.
 *
 * A transformed channel reads a derived name such as `neg_log10(padj)`, which no declaration keys. Thus the
 * axis of a transform keeps the name that states the transform, and it never states the raw quantity.
 */
function axisTitle(labels: ColumnLabels, column: string, preset?: string): string {
    return declaredForColumn(labels, column) ?? preset ?? column;
}

/**
 * The legend text of one category value: the value with each underscore as a space.
 *
 * An analysis column carries a machine category such as `up_in_nonresponders`, and a legend reads for a
 * person. The replacement reads no locale, thus the same value gives the same text on every host. The raw
 * value stays in the data rows, thus the provenance loses nothing. No hover carries the raw text, because a
 * legend formatter is a function and the option rides as inline JSON.
 */
function categoryName(value: Cell): string {
    return String(value).replaceAll("_", " ");
}

/**
 * Derive the ECharts option for a chart block, then pass it through `normalizeEchartSpec`.
 *
 * The normalizer owns the bottom legend, the save action, and the axis-label discipline. Thus the
 * derivation sets no `title`, no `legend`, and no `toolbox`. The theme palette assigns the series colors by
 * their order, and the null category of a preset is the one series that names a color of its own.
 *
 * The axis of a channel names the label that the binding declares for its column. The semantic title of a
 * preset answers next, and the raw column name answers last.
 */
export function deriveChartOption(block: ChartBlock, rows: readonly ChartRow[], columns?: readonly string[]): Result<EchartOption, RenderProblem> {
    return deriveRaw(block, rows, columns).map((option) => normalizeEchartSpec(option, { title: block.title }));
}

/**
 * Derive the option of one chart, and read the shared payload of its artifact where the inline form grows
 * too large.
 *
 * A chart under the bound keeps its inline data, byte for byte as `deriveChartOption` gives it. Past the
 * bound the series carry no row, and the option states how the page builds each series from the columnar
 * payload of the artifact. Thus one dense chart costs the page one option and no second copy of the rows.
 *
 * A chart whose series describes no page-side build stays inline. A base chart type bins, summarizes, or
 * addresses a pair, thus no descriptor states its data and the whole option rides the page.
 */
export function deriveChartRender(
    block: ChartBlock,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    target: ChartPayloadTarget,
): Result<ChartRender, RenderProblem> {
    const collector: SourceCollector = { columns: target.columns, series: [], failed: false };
    return deriveRaw(block, rows, columns, collector).map((raw) => {
        const option = normalizeEchartSpec(raw, { title: block.title });
        const series = option.series;
        if (!Array.isArray(series) || JSON.stringify(option).length <= CHART_INLINE_OPTION_BOUND) {
            return { option, readsPayload: false };
        }
        if (collector.failed || collector.series.length === 0 || collector.series.length !== series.length) {
            return { option, readsPayload: false };
        }
        return { option: sourcedOption(option, series, collector, target.key), readsPayload: true };
    });
}

/**
 * The option of a chart that reads the payload: the derived option with no row, and the data source.
 *
 * Each series keeps every field that the derivation gave it, and it loses its data alone. Thus the axes,
 * the names, the colors, and the symbol ladder of a dense chart read as they read inline, and the page
 * fills one member of each series.
 */
function sourcedOption(option: EchartOption, series: readonly unknown[], collector: SourceCollector, key: string): EchartOption {
    const source: ChartDataSource = {
        payload: key,
        ...(collector.rule !== undefined ? { rule: collector.rule } : {}),
        series: collector.series,
    };
    return {
        ...option,
        series: series.map((entry) => ({ ...(entry as EchartOption), data: [] })),
        [CHART_SOURCE_MEMBER]: source,
    };
}

/**
 * Dispatch the grammar of one chart block.
 *
 * A composition derives directly. A preset expands into a composition first. A quick path that names a
 * point routes through a one-series composition, because a base rule builds a bare pair and only a
 * composition item carries a name. Every other quick path reaches the fixed rule of its base type.
 *
 * The collector rides the composition path alone. A base rule collects nothing, thus its chart keeps its
 * inline data whatever its size.
 */
function deriveRaw(
    block: ChartBlock,
    rows: readonly ChartRow[],
    columns?: readonly string[],
    collector?: SourceCollector,
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
    if (block.composition !== undefined) {
        return deriveComposition(block.id, block.composition, rows, columns, labels, { collector });
    }
    const chartType = block.chartType;
    const encoding = block.encoding;
    if (chartType === undefined || encoding === undefined) {
        // The schema refine already makes this shape unrepresentable. The guard states the same rule for a
        // value that reaches the renderer without a parse.
        return err(problem(block.id, "The chart carries neither a chart type with an encoding, nor a composition."));
    }
    if (orientation !== undefined && chartType !== "bar") {
        // A silent ignore would teach the author a field that does nothing, thus the fault is stated.
        return err(problem(block.id, `The ${chartType} chart takes no orientation. An orientation is a rule of the bar alone.`));
    }
    if (block.thresholds !== undefined && chartType !== "volcano") {
        // The pair states a significance cut and an effect cut. The volcano is the one type that reads both.
        return err(problem(block.id, `The ${chartType} chart takes no thresholds. A threshold pair is a rule of the volcano alone.`));
    }
    if (isPresetChartType(chartType)) {
        return derivePreset(block.id, chartType, encoding, rows, columns, labels, block.thresholds, collector);
    }
    if (encoding.label !== undefined) {
        return deriveLabeled(block.id, chartType, encoding, rows, columns, labels, orientation, collector);
    }
    const quick = resolveQuickPath(block.id, chartType, encoding, rows, columns, labels, orientation);
    if (quick.isErr()) return err(quick.error);
    return deriveBase(quick.value.block, quick.value.rows, columns);
}

/** Dispatch to the per-type derivation. Each type holds one fixed rule. */
function deriveBase(block: ResolvedChartBlock, rows: readonly ChartRow[], columns?: readonly string[]): Result<EchartOption, RenderProblem> {
    switch (block.chartType) {
        case "bar":
            return deriveBar(block, rows, columns);
        case "line":
            return deriveLine(block, rows, columns);
        case "scatter":
            return deriveScatter(block, rows, columns);
        case "histogram":
            return deriveHistogram(block, rows, columns);
        case "box":
            return deriveBox(block, rows, columns);
        case "heatmap":
            return deriveHeatmap(block, rows, columns);
        case "pie":
            return derivePie(block, rows, columns);
    }
}

/** Expand one preset over its two demanded channels, then derive the composition that it gives. */
function derivePreset(
    blockId: string,
    preset: PresetChartType,
    encoding: ChartEncoding,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    labels: ColumnLabels,
    thresholds: ChartBlock["thresholds"],
    collector: SourceCollector | undefined,
): Result<EchartOption, RenderProblem> {
    const x = requireChannel(blockId, preset, encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = requireChannel(blockId, preset, encoding, "y");
    if (y.isErr()) return err(y.error);
    const expansion = expandPreset(preset, x.value, y.value, encoding, thresholds);
    return deriveComposition(blockId, expansion.composition, rows, columns, labels, {
        preset: presetAxisTitles(preset, x.value),
        classification: expansion.classification,
        collector,
    });
}

/** The quick-path types that map onto one series form. A point of such a chart can carry a name. */
const LABELED_FORMS: Partial<Record<BaseChartType, ChartSeries["form"]>> = { bar: "bar", line: "line", scatter: "scatter" };

/**
 * Derive a quick path that names its points, as a composition of one series.
 *
 * A histogram bins its rows, a box summarizes them, and a heatmap and a pie both address a pair or a
 * category. None of the four draws one point for one row, thus none of them can carry a per-row name.
 */
function deriveLabeled(
    blockId: string,
    chartType: BaseChartType,
    encoding: ChartEncoding,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
    labels: ColumnLabels,
    orientation: ChartOrientation,
    collector: SourceCollector | undefined,
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
                },
                // The caller refused an orientation on every type but the bar, thus the form here is a bar
                // wherever one arrives. The arrangement crosses onto the series, and no name channel loses it.
                ...(orientation !== undefined ? { orientation } : {}),
            },
        ],
    };
    return deriveComposition(blockId, composition, rows, columns, labels, { collector });
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

    const block: ResolvedChartBlock = { id: blockId, chartType, encoding: resolved, labels, orientation };
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
 */
function deriveBar(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const horizontal = block.orientation === "horizontal";
    const categories = firstAppearance(rows.map((row) => row[x]));
    const series = groupedSeries(rows, block.encoding.group, (groupRows, name) => ({
        type: "bar",
        ...(name !== undefined ? { name: categoryName(name) } : {}),
        ...nullCategoryStyle(name),
        barGap: 0,
        data: groupRows.map((row) => (horizontal ? [row[y], row[x]] : [row[x], row[y]])),
    }));

    if (horizontal) {
        return ok({
            xAxis: { type: "value", ...xAxisName(axisTitle(block.labels, y)) },
            yAxis: { ...HORIZONTAL_CATEGORY_AXIS, data: categories, name: axisTitle(block.labels, x) },
            series,
            grid: { ...LABEL_CONTAINING_GRID },
        });
    }
    return ok({
        xAxis: { type: "category", data: categories, ...xAxisName(axisTitle(block.labels, x)) },
        yAxis: { type: "value", name: axisTitle(block.labels, y) },
        series,
    });
}

/** Per-column axis inference, and one line series per group whose data sorts by x. */
function deriveLine(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const series = groupedSeries(rows, block.encoding.group, (groupRows, name) => ({
        type: "line",
        ...(name !== undefined ? { name: categoryName(name) } : {}),
        ...nullCategoryStyle(name),
        showSymbol: false,
        data: sortByX(groupRows.map((row) => [row[x], row[y]])),
    }));

    return ok({
        xAxis: inferAxis(rows, x, "x", axisTitle(block.labels, x)),
        yAxis: inferAxis(rows, y, "y", axisTitle(block.labels, y)),
        series,
    });
}

/** The same axis inference as a line chart, with no sort and the large-render flags. */
function deriveScatter(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const series = groupedSeries(rows, block.encoding.group, (groupRows, name) => ({
        type: "scatter",
        ...(name !== undefined ? { name: categoryName(name) } : {}),
        ...nullCategoryStyle(name),
        large: true,
        largeThreshold: 2000,
        data: groupRows.map((row) => [row[x], row[y]]),
    }));

    return ok({
        xAxis: inferAxis(rows, x, "x", axisTitle(block.labels, x)),
        yAxis: inferAxis(rows, y, "y", axisTitle(block.labels, y)),
        series,
    });
}

/**
 * The x axis of a histogram.
 *
 * The axis carries a bin range and not the cells of the column, thus it stays bare where the author names
 * nothing. A declared label names the quantity that the bins measure, and the axis then carries it.
 */
function histogramXAxis(labels: ColumnLabels, column: string): EchartOption {
    const label = declaredForColumn(labels, column);
    return { type: "value", scale: true, ...(label !== undefined ? xAxisName(label) : {}) };
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

/** A five-number summary per category, plus a paired scatter series for the outliers. */
function deriveBox(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const categories = firstAppearance(rows.map((row) => row[x]));
    const groups = splitGroups(rows, block.encoding.group);

    const series: EchartOption[] = [];
    for (const group of groups) {
        const boxData: (number[] | string)[] = [];
        const outliers: number[][] = [];
        for (let index = 0; index < categories.length; index++) {
            const values = numericColumn(
                group.rows.filter((row) => row[x] === categories[index]),
                y,
            );
            // A category with fewer than five values renders as an empty box.
            if (values.length < 5) {
                boxData.push("-");
                continue;
            }
            const summary = boxSummary(values);
            boxData.push(summary.box);
            for (const outlier of summary.outliers) {
                outliers.push([index, outlier]);
            }
        }

        series.push({
            type: "boxplot",
            ...(group.name !== undefined ? { name: categoryName(group.name) } : {}),
            data: boxData,
        });
        // The outlier scatter pairs with its box series, thus it only appears when an outlier exists.
        if (outliers.length > 0) {
            series.push({
                type: "scatter",
                ...(group.name !== undefined ? { name: categoryName(group.name) } : {}),
                symbolSize: 4,
                data: outliers,
            });
        }
    }

    return ok({
        xAxis: { type: "category", data: categories, ...xAxisName(axisTitle(block.labels, x)) },
        yAxis: { type: "value", name: axisTitle(block.labels, y) },
        series,
    });
}

/** A dense grid over every pair of x and y categories, with a viridis `visualMap`. */
function deriveHeatmap(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const valueResult = requireColumn(block, rows, columns, "value");
    if (valueResult.isErr()) return err(valueResult.error);
    const x = xResult.value;
    const y = yResult.value;
    const valueColumn = valueResult.value;

    const xCategories = firstAppearance(rows.map((row) => row[x]));
    const yCategories = firstAppearance(rows.map((row) => row[y]));

    const cells = new Map<string, number | null>();
    for (const row of rows) {
        const key = pairKey(row[x], row[y]);
        if (cells.has(key)) {
            return err(problem(block.id, `The heatmap holds the pair (${String(row[x])}, ${String(row[y])}) more than one time.`));
        }
        cells.set(key, toNumber(row[valueColumn]));
    }

    const data: (number | null)[][] = [];
    const finite: number[] = [];
    for (let xi = 0; xi < xCategories.length; xi++) {
        for (let yi = 0; yi < yCategories.length; yi++) {
            const stored = cells.get(pairKey(xCategories[xi], yCategories[yi]));
            const value = stored === undefined ? null : stored;
            data.push([xi, yi, value]);
            if (value !== null) finite.push(value);
        }
    }
    const min = finite.length > 0 ? Math.min(...finite) : 0;
    const max = finite.length > 0 ? Math.max(...finite) : 1;

    return ok({
        xAxis: { type: "category", data: xCategories.map(String), ...xAxisName(axisTitle(block.labels, x)), splitArea: { show: true } },
        yAxis: { type: "category", data: yCategories.map(String), name: axisTitle(block.labels, y), splitArea: { show: true } },
        visualMap: {
            type: "continuous",
            min,
            max,
            calculable: true,
            orient: "horizontal",
            left: "center",
            bottom: 0,
            inRange: { color: [...VIRIDIS] },
        },
        series: [{ type: "heatmap", data }],
    });
}

/** One slice per group category, in first-appearance order. A repeated category refuses. */
function derivePie(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
}

/** One resolved series: the declared series, and the channels that it reads. */
interface ResolvedSeries {
    declared: ChartSeries;
    x: ResolvedChannel;
    y: ResolvedChannel;
    y0?: ResolvedChannel;
    group?: ResolvedChannel;
    label?: readonly (Cell | null)[];
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
 * One column that a page-side series build reads: the place of the column in the payload, and the per-row
 * transform of the channel.
 */
export interface ChartColumnSource {
    readonly column: number;
    readonly transform?: ChartTransform;
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
 * of a horizontal bar.
 */
export interface ChartSeriesSource {
    readonly x: ChartColumnSource;
    readonly y: ChartColumnSource;
    readonly group?: ChartColumnSource;
    readonly value?: Cell;
    readonly category?: number;
    readonly label?: number;
    readonly flags?: readonly number[];
    readonly sort?: boolean;
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
}

/** The payload that a dense chart reads: the key of the registry, and the columns of the payload. */
export interface ChartPayloadTarget {
    readonly key: string;
    readonly columns: readonly string[];
}

/** The option of one chart, and whether it reads the registered payload of its artifact. */
export interface ChartRender {
    readonly option: EchartOption;
    readonly readsPayload: boolean;
}

/** One plotted point. `index` names the row that it came from, thus a rank rule can find it again. */
interface Point {
    index: number;
    x: Cell;
    y: Cell;
    y0?: Cell;
}

/**
 * One runtime series, whether it can carry the mark members of the annotations, whether it draws in the
 * muted color, and whether it holds a point.
 *
 * A muted series states no finding, thus it makes a poor carrier of a guide. A classification emits one
 * series for each of its categories, thus a category that no row reaches emits an empty one.
 */
interface EmittedSeries {
    option: EchartOption;
    carriesMarks: boolean;
    muted: boolean;
    empty: boolean;
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
 * `preset` is present when a preset expanded this composition, and it carries the semantic axis titles.
 * `classification` is present when that preset splits the rows itself. A series that names a group channel
 * keeps the channel, because the author asked for that split.
 *
 * `collector` is present when the caller can send the rows to the page as a payload. Each series then
 * states its own page-side build beside its option.
 */
interface CompositionExtras {
    readonly preset?: PresetAxisTitles;
    readonly classification?: PresetClassification;
    readonly collector?: SourceCollector;
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

    const resolved: ResolvedSeries[] = [];
    for (const declared of composition.series) {
        const series = resolveSeries(blockId, declared, rows, columns);
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

    if (collector !== undefined && classification !== undefined) {
        // The page splits the rows against the same two cuts, thus the rule rides beside the descriptors.
        collector.rule = classification.rule;
    }
    const density = scatterDensity(rows.length);
    const emitted: EmittedSeries[] = [];
    for (const entry of resolved) {
        for (const split of splitSeries(rows, entry, classification)) {
            const built = buildSeries(blockId, entry, split, labeled.value, density, emitted.length, labels, preset, collector);
            if (built.isErr()) return err(built.error);
            emitted.push(...built.value);
        }
    }

    const marks = markMembers(annotations);
    const target = markCarrier(emitted);
    if (Object.keys(marks).length > 0 && target >= 0) {
        emitted[target] = { ...emitted[target], option: { ...emitted[target].option, ...marks } };
    }

    const first = resolved[0];
    const named = resolved.some((entry) => entry.label !== undefined) || labeled.value.size > 0;
    const axes = compositionAxes(rows, first, composition.axes, labels, preset);
    return ok({
        tooltip: named ? { ...NAMED_TOOLTIP } : { ...PLAIN_TOOLTIP },
        xAxis: axes.xAxis,
        yAxis: axes.yAxis,
        series: emitted.map((entry) => entry.option),
        // A horizontal bar draws its category names as y labels, thus the grid must hold them.
        ...(isHorizontalBar(first.declared) ? { grid: { ...LABEL_CONTAINING_GRID } } : {}),
    });
}

/** Resolve each channel of one declared series against the rows. An absent column is a refusal. */
function resolveSeries(
    blockId: string,
    declared: ChartSeries,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
): Result<ResolvedSeries, RenderProblem> {
    const x = resolveChannel(blockId, declared.encoding.x, rows, columns);
    if (x.isErr()) return err(x.error);
    const y = resolveChannel(blockId, declared.encoding.y, rows, columns);
    if (y.isErr()) return err(y.error);
    const resolved: ResolvedSeries = { declared, x: x.value, y: y.value };

    const declaredY0 = declared.encoding.y0;
    if (declaredY0 !== undefined) {
        const y0 = resolveChannel(blockId, declaredY0, rows, columns);
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
    return ok(resolved);
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

    const transform = channelTransform(channel);
    if (transform === undefined) {
        return ok({ name: column, values: rows.map((row) => row[column] ?? null), transformed: false, column });
    }
    return ok({ name: transformedName(transform, column), values: transformColumn(rows, column, transform), transformed: true, column, transform });
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
        const category = classification.categoryOf(toNumber(entry.x.values[index]), toNumber(entry.y.values[index]));
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
 * agent-derived column answers through the null-token test. Every other series takes no color of its own,
 * and the theme palette assigns one by the series order.
 *
 * A band draws two stacked line series, and no preset emits a band. Thus the null-category color never
 * reaches one, and neither half of a band reports as muted.
 */
function buildSeries(
    blockId: string,
    entry: ResolvedSeries,
    split: SeriesSplit,
    labeled: ReadonlySet<number>,
    density: ScatterDensity,
    emittedCount: number,
    labels: ColumnLabels,
    preset: PresetAxisTitles | undefined,
    collector: SourceCollector | undefined,
): Result<EmittedSeries[], RenderProblem> {
    const form = entry.declared.form;
    const points = collectPoints(entry, split.indices);
    if (SORTED_FORMS.has(form)) {
        points.sort((a, b) => compareCell(a.x, b.x));
    }
    const name = seriesName(entry, split.name, labels, preset?.y);

    if (entry.y0 !== undefined) {
        if (collector !== undefined) {
            // A band draws two stacked series over one row set, and the upper one holds a difference that no
            // cell of the table gives. Thus no descriptor states it, and the chart keeps its inline data.
            collector.failed = true;
        }
        const band = bandSeries(blockId, entry, name, points, `band-${emittedCount}`);
        if (band.isErr()) return err(band.error);
        return ok([
            { option: band.value[0], carriesMarks: false, muted: false, empty: points.length === 0 },
            { option: band.value[1], carriesMarks: true, muted: false, empty: points.length === 0 },
        ]);
    }

    const muted = split.muted ?? isNullCategory(split.name);
    const { data, itemObjects } = seriesData(entry, points, labeled, isHorizontalBar(entry.declared));
    const option = { type: runtimeType(form), name, ...seriesItemStyle(muted, form, density), ...formOptions(form, density, itemObjects), data };
    if (collector !== undefined) {
        collectSource(collector, entry, split, labeled, form);
    }
    return ok([{ option, carriesMarks: true, muted, empty: data.length === 0 }]);
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
function collectSource(collector: SourceCollector, entry: ResolvedSeries, split: SeriesSplit, labeled: ReadonlySet<number>, form: ChartSeries["form"]): void {
    const x = columnSource(collector, entry.x);
    const y = columnSource(collector, entry.y);
    const group = entry.group === undefined ? undefined : columnSource(collector, entry.group);
    const labelColumn = entry.declared.encoding.label;
    const label = labelColumn === undefined ? undefined : collector.columns.indexOf(labelColumn);
    if (x === undefined || y === undefined || (entry.group !== undefined && group === undefined) || label === -1) {
        collector.failed = true;
        return;
    }
    const flags = split.indices.filter((index) => labeled.has(index));
    collector.series.push({
        x,
        y,
        ...(group !== undefined ? { group } : {}),
        ...(split.category === undefined && split.name !== undefined ? { value: split.name } : {}),
        ...(split.category !== undefined ? { category: split.category } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(flags.length > 0 ? { flags } : {}),
        ...(SORTED_FORMS.has(form) ? { sort: true } : {}),
        ...(isHorizontalBar(entry.declared) ? { swap: true } : {}),
    });
}

/** The payload column of one resolved channel, or `undefined` when the payload holds no such column. */
function columnSource(collector: SourceCollector, channel: ResolvedChannel): ChartColumnSource | undefined {
    const column = collector.columns.indexOf(channel.column);
    if (column < 0) {
        return undefined;
    }
    return channel.transform === undefined ? { column } : { column, transform: channel.transform };
}

/**
 * The item style of one runtime series: the muted color, and the opacity of a crowd.
 *
 * One member owns the item style, thus a muted crowd keeps both fields. A series that states neither emits
 * no item style, and the theme answers for it.
 */
function seriesItemStyle(muted: boolean, form: ChartSeries["form"], density: ScatterDensity): EchartOption {
    const fields = {
        ...(muted ? { color: MUTED_CHART_COLOR } : {}),
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

/** The points of one group. A row whose channel gives no value drops, and no substitute value appears. */
function collectPoints(entry: ResolvedSeries, indices: readonly number[]): Point[] {
    const points: Point[] = [];
    for (const index of indices) {
        const x = entry.x.values[index];
        const y = entry.y.values[index];
        if (x === null || y === null) continue;
        if (entry.y0 === undefined) {
            points.push({ index, x, y });
            continue;
        }
        const y0 = entry.y0.values[index];
        if (y0 === null) continue;
        points.push({ index, x, y, y0 });
    }
    return points;
}

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
): { data: unknown[]; itemObjects: boolean } {
    const data: unknown[] = [];
    let itemObjects = false;
    for (const point of points) {
        const pair = horizontal ? [point.y, point.x] : [point.x, point.y];
        const label = entry.label?.[point.index];
        const named = label !== undefined && label !== null;
        const marked = labeled.has(point.index);
        if (!named && !marked) {
            data.push(pair);
            continue;
        }
        itemObjects = true;
        data.push({
            value: pair,
            // A marked point of a series with no label channel takes the x cell as its name. Thus the
            // `{b}` of the label template and of the tooltip names a cell of the row, and never nothing.
            name: named ? String(label) : String(point.x),
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

/** The fields that one form adds to its runtime series. A scatter reads the density ladder here. */
function formOptions(form: ChartSeries["form"], density: ScatterDensity, itemObjects: boolean): EchartOption {
    switch (form) {
        case "bar":
            // The base bar rule puts the bars of one category side by side with no gap between them. A bar
            // of either path then reads the same.
            return { barGap: 0 };
        case "line":
            return { showSymbol: false };
        case "step":
            return { step: "end", showSymbol: false };
        case "area":
            return { showSymbol: false, areaStyle: {} };
        case "scatter":
            return {
                ...(density === "normal" ? {} : { symbolSize: density === "crowd" ? SCATTER_CROWD_SYMBOL_SIZE : SCATTER_HOVER_SYMBOL_SIZE }),
                // The large path draws a simplified point, and it drops a per-item style. Thus a series
                // whose items carry a name or a label keeps the normal path.
                ...(itemObjects ? {} : { large: true, largeThreshold: LARGE_SCATTER_THRESHOLD }),
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
 * data of a mark member and nothing here reads a cell.
 *
 * A guide on the x axis runs up the plot. Its end sits at the top, inside the band of the y-axis title, thus
 * its label takes the position at the axis. A guide on the y axis runs across, and its end sits at the right
 * edge, where the label already reads clear.
 */
function markMembers(annotations: readonly ChartAnnotation[]): EchartOption {
    const lines: EchartOption[] = [];
    const areas: EchartOption[][] = [];
    for (const annotation of annotations) {
        if (annotation.kind === "reference-line") {
            const position = annotation.axis === "x" ? VERTICAL_LABEL_POSITION : undefined;
            lines.push({ [axisKey(annotation.axis)]: annotation.value, ...markLabel(annotation.label, position) });
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
        ...(lines.length > 0 ? { markLine: { silent: true, symbol: "none", data: lines } } : {}),
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
function compositionAxes(
    rows: readonly ChartRow[],
    first: ResolvedSeries,
    axes: ChartComposition["axes"],
    labels: ColumnLabels,
    preset: PresetAxisTitles | undefined,
): { xAxis: EchartOption; yAxis: EchartOption } {
    if (isHorizontalBar(first.declared)) {
        return {
            xAxis: compositionAxis(rows, first.y, "x", axes?.x, labels, preset?.y),
            yAxis: barCategoryAxis(rows, first.x, "y", axes?.y, labels, preset?.x),
        };
    }
    return {
        xAxis: compositionXAxis(rows, first, axes?.x, labels, preset?.x),
        yAxis: compositionAxis(rows, first.y, "y", axes?.y, labels, preset?.y),
    };
}

/**
 * The x axis of a composition whose bars stand up, or of any other form.
 *
 * A bar takes a category axis, and every other form takes the inferred axis. A declared scale is the one
 * exception, because the author asked for a numeric axis and a category axis has no scale.
 */
function compositionXAxis(
    rows: readonly ChartRow[],
    first: ResolvedSeries,
    declared: ChartAxes["x"],
    labels: ColumnLabels,
    preset: string | undefined,
): EchartOption {
    if (first.declared.form !== "bar" || declared?.scale !== undefined) {
        return compositionAxis(rows, first.x, "x", declared, labels, preset);
    }
    return barCategoryAxis(rows, first.x, "x", declared, labels, preset);
}

/**
 * The category axis of a composition bar, on whichever axis it renders.
 *
 * A bar counts its categories. The base bar rule lists the values of the category channel in
 * first-appearance order, thus a bar of either path draws the same axis. A declared scale asks for a
 * numeric axis, and a category axis has no scale, thus such an axis falls to the inferred one.
 *
 * A category axis on y inverts, thus the first row of the table reads at the top of the plot.
 */
function barCategoryAxis(
    rows: readonly ChartRow[],
    channel: ResolvedChannel,
    axis: "x" | "y",
    declared: ChartAxes["x"],
    labels: ColumnLabels,
    preset: string | undefined,
): EchartOption {
    if (declared?.scale !== undefined) {
        return compositionAxis(rows, channel, axis, declared, labels, preset);
    }
    const categories = firstAppearance(channel.values.filter((value): value is Cell => value !== null));
    const title = declared?.title ?? axisTitle(labels, channel.name, preset);
    const typeFields = axis === "x" ? { type: "category" } : { ...HORIZONTAL_CATEGORY_AXIS };
    const nameFields = axis === "x" ? xAxisName(title) : { name: title };
    return { ...typeFields, data: categories, ...nameFields };
}

/**
 * The axis of one composition channel.
 *
 * A declared axis title wins, because it names this one axis. The declared label of the column comes next,
 * then the semantic title of the preset, and the raw column name answers last. A declared `log` scale maps
 * onto the logarithmic axis type. A transformed channel gives a number for each point that survives it,
 * thus its axis is a value axis and the cells of the untransformed column decide nothing.
 */
function compositionAxis(
    rows: readonly ChartRow[],
    channel: ResolvedChannel,
    axis: "x" | "y",
    declared: ChartAxes["x"],
    labels: ColumnLabels,
    preset: string | undefined,
): EchartOption {
    const title = declared?.title ?? axisTitle(labels, channel.name, preset);
    const nameFields = axis === "x" ? xAxisName(title) : { name: title };
    if (declared?.scale === "log") {
        return { type: "log", ...nameFields };
    }
    const base = channel.transformed ? { type: "value", scale: true } : inferAxis(rows, channel.name, axis, title);
    return { ...base, ...nameFields };
}

// ── The shared building blocks ──────────────────────────────────────────────

/** A typed `invalid-chart-input` problem that names the block and the cause. */
function problem(blockId: string, detail: string): RenderProblem {
    return { blockId, kind: "invalid-chart-input", detail };
}

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

/**
 * The transformed value of one column, one entry for each row. A row with no usable cell gives `null`.
 *
 * The page-side series build holds the twin of this function, because a chart that reads the payload
 * transforms its columns in the browser. A shared test vector runs the two over one set of cells, thus the
 * two cannot give different numbers in silence.
 */
export function transformColumn(rows: readonly ChartRow[], column: string, transform: ChartTransform): (number | null)[] {
    if (transform === "rank") {
        return rankColumn(rows, column);
    }
    return rows.map((row) => applyTransform(toNumber(row[column]), transform));
}

/**
 * One per-row transform.
 *
 * `log10` and `neg_log10` give no value for a cell that is not positive, thus the point drops. No
 * substitute value ever appears in its place.
 */
function applyTransform(value: number | null, transform: Exclude<ChartTransform, "rank">): number | null {
    if (value === null) return null;
    switch (transform) {
        case "log10":
            return value > 0 ? Math.log10(value) : null;
        case "neg_log10":
            return value > 0 ? -Math.log10(value) : null;
        case "abs":
            return Math.abs(value);
    }
}

/**
 * The competition rank of each cell of one column, over the ascending order of the column.
 *
 * The smallest value takes the place 1, and a tie shares its place. Thus the place after a tie of two
 * skips one number, which is what a competition rank states. A cell with no number takes no place, and
 * its point drops. The rank reads the column alone, thus the same rows give the same places.
 */
function rankColumn(rows: readonly ChartRow[], column: string): (number | null)[] {
    const values = rows.map((row) => toNumber(row[column]));
    const counts = new Map<number, number>();
    for (const value of values) {
        if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const places = new Map<number, number>();
    let place = 1;
    for (const value of [...counts.keys()].sort((a, b) => a - b)) {
        places.set(value, place);
        place += counts.get(value) ?? 0;
    }
    return values.map((value) => (value === null ? null : (places.get(value) ?? null)));
}

/** True when the column exists in the declared header, or in one row at least. */
function columnPresent(column: string, rows: readonly ChartRow[], columns: readonly string[] | undefined): boolean {
    if (columns !== undefined && columns.includes(column)) return true;
    for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(row, column)) return true;
    }
    return false;
}

/** Convert one cell to a finite number, or `null` when it is absent or not numeric. */
function toNumber(cell: Cell | null | undefined): number | null {
    if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
    if (typeof cell === "string") {
        const trimmed = cell.trim();
        if (trimmed === "") return null;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** True when the cell is a string that does not represent a finite number. */
function isNonNumericString(cell: Cell | undefined): boolean {
    return typeof cell === "string" && toNumber(cell) === null;
}

/** The distinct values in first-appearance order. */
function firstAppearance<T>(values: readonly T[]): T[] {
    const seen = new Set<T>();
    const order: T[] = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            order.push(value);
        }
    }
    return order;
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
 * The axis for a line or a scatter column. A column with any non-numeric string cell is a category axis
 * with its distinct values as strings. Any other column is a value axis with `scale: true`.
 *
 * The `axis` argument names the channel that the column feeds. An x column takes the centered name, and a
 * y column keeps the default name placement. The `title` argument names the axis, thus the column decides
 * the axis type and the title decides the text.
 */
function inferAxis(rows: readonly ChartRow[], column: string, axis: "x" | "y", title: string): EchartOption {
    const nameFields = axis === "x" ? xAxisName(title) : { name: title };
    if (rows.some((row) => isNonNumericString(row[column]))) {
        return { type: "category", data: firstAppearance(rows.map((row) => row[column])).map(String), ...nameFields };
    }
    return { type: "value", scale: true, ...nameFields };
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

/** Sort `[x, y]` pairs by x. Two numbers compare numerically, and any other pair compares as text. */
function sortByX(pairs: Cell[][]): Cell[][] {
    return [...pairs].sort((a, b) => compareCell(a[0], b[0]));
}

/**
 * Compare two cells for a sort by x, and for a rank rule.
 *
 * A pair that both hold a finite number compares by that number. A text-backed table gives each cell as a
 * string, thus a code-unit order would put `"10"` between `"1"` and `"2"` and a time axis would run out of
 * order. Any other pair compares by the code-unit order of the string form.
 *
 * The comparison never calls `localeCompare`, thus the order stays the same on every host.
 */
function compareCell(a: Cell, b: Cell): number {
    const leftNumber = toNumber(a);
    const rightNumber = toNumber(b);
    if (leftNumber !== null && rightNumber !== null) {
        return leftNumber - rightNumber;
    }
    const left = String(a);
    const right = String(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * A stable key for one `(x, y)` pair. The key carries the type of each cell, thus the number `1` and the
 * string `"1"` are different pairs and a false collision is impossible.
 */
function pairKey(xCell: Cell, yCell: Cell): string {
    return `${typeof xCell}:${String(xCell)} ${typeof yCell}:${String(yCell)}`;
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
