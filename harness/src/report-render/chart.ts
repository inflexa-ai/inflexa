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
import { normalizeEchartSpec } from "../tools/display/normalize-echart-spec.js";
import { expandPreset, isPresetChartType, type PresetChartType } from "./chart-presets.js";
import type { RenderProblem } from "./types.js";

/** One cell of a resolved row. A cell is one string or one number. */
type Cell = string | number;

/** One resolved row of the bound table, keyed by column name. */
export type ChartRow = Record<string, Cell>;

/** The derived option object, ready for `normalizeEchartSpec` and the inline JSON. */
export type EchartOption = Record<string, unknown>;

/** The four channels of a chart encoding. Each type demands a subset of them. */
type Channel = "x" | "y" | "group" | "value";

/** One chart type that carries its own fixed rule. A preset carries no rule, because it expands first. */
type BaseChartType = Exclude<ChartType, PresetChartType>;

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
function xAxisName(column: string): EchartOption {
    return { name: column, nameLocation: "middle", nameGap: X_AXIS_NAME_GAP };
}

/**
 * Derive the ECharts option for a chart block, then pass it through `normalizeEchartSpec`.
 *
 * The normalizer owns the bottom legend, the save action, and the axis-label discipline. Thus the
 * derivation sets no `title`, no `legend`, no `toolbox`, and no explicit series color. The theme palette
 * assigns the series colors by their order.
 */
export function deriveChartOption(block: ChartBlock, rows: readonly ChartRow[], columns?: readonly string[]): Result<EchartOption, RenderProblem> {
    return deriveRaw(block, rows, columns).map((option) => normalizeEchartSpec(option, { title: block.title }));
}

/**
 * Dispatch the grammar of one chart block.
 *
 * A composition derives directly. A preset expands into a composition first. A quick path that names a
 * point routes through a one-series composition, because a base rule builds a bare pair and only a
 * composition item carries a name. Every other quick path reaches the fixed rule of its base type.
 */
function deriveRaw(block: ChartBlock, rows: readonly ChartRow[], columns?: readonly string[]): Result<EchartOption, RenderProblem> {
    if (block.composition !== undefined) {
        return deriveComposition(block.id, block.composition, rows, columns);
    }
    const chartType = block.chartType;
    const encoding = block.encoding;
    if (chartType === undefined || encoding === undefined) {
        // The schema refine already makes this shape unrepresentable. The guard states the same rule for a
        // value that reaches the renderer without a parse.
        return err(problem(block.id, "The chart carries neither a chart type with an encoding, nor a composition."));
    }
    if (isPresetChartType(chartType)) {
        return derivePreset(block.id, chartType, encoding, rows, columns);
    }
    if (encoding.label !== undefined) {
        return deriveLabeled(block.id, chartType, encoding, rows, columns);
    }
    const quick = resolveQuickPath(block.id, chartType, encoding, rows, columns);
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
): Result<EchartOption, RenderProblem> {
    const x = requireChannel(blockId, preset, encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = requireChannel(blockId, preset, encoding, "y");
    if (y.isErr()) return err(y.error);
    return deriveComposition(blockId, expandPreset(preset, x.value, y.value, encoding), rows, columns);
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
            },
        ],
    };
    return deriveComposition(blockId, composition, rows, columns);
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

    const block: ResolvedChartBlock = { id: blockId, chartType, encoding: resolved };
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

/** A category x axis, a value y axis, and one bar series per group with the `[x, y]` pairs. */
function deriveBar(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const yResult = requireColumn(block, rows, columns, "y");
    if (yResult.isErr()) return err(yResult.error);
    const x = xResult.value;
    const y = yResult.value;

    const categories = firstAppearance(rows.map((row) => row[x]));
    const series = groupedSeries(rows, block.encoding.group, (groupRows, name) => ({
        type: "bar",
        ...(name !== undefined ? { name: String(name) } : {}),
        barGap: 0,
        data: groupRows.map((row) => [row[x], row[y]]),
    }));

    return ok({
        xAxis: { type: "category", data: categories, ...xAxisName(x) },
        yAxis: { type: "value", name: y },
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
        ...(name !== undefined ? { name: String(name) } : {}),
        showSymbol: false,
        data: sortByX(groupRows.map((row) => [row[x], row[y]])),
    }));

    return ok({
        xAxis: inferAxis(rows, x, "x"),
        yAxis: inferAxis(rows, y, "y"),
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
        ...(name !== undefined ? { name: String(name) } : {}),
        large: true,
        largeThreshold: 2000,
        data: groupRows.map((row) => [row[x], row[y]]),
    }));

    return ok({
        xAxis: inferAxis(rows, x, "x"),
        yAxis: inferAxis(rows, y, "y"),
        series,
    });
}

/** Equal-width bins over the global range. Each group shares the same edges. */
function deriveHistogram(block: ResolvedChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const x = xResult.value;
    const groupCol = block.encoding.group;

    if (rows.length === 0) {
        return ok({
            xAxis: { type: "value", scale: true },
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
        xAxis: { type: "value", scale: true },
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
            ...(group.name !== undefined ? { name: String(group.name) } : {}),
            data: boxData,
        });
        // The outlier scatter pairs with its box series, thus it only appears when an outlier exists.
        if (outliers.length > 0) {
            series.push({
                type: "scatter",
                ...(group.name !== undefined ? { name: String(group.name) } : {}),
                symbolSize: 4,
                data: outliers,
            });
        }
    }

    return ok({
        xAxis: { type: "category", data: categories, ...xAxisName(x) },
        yAxis: { type: "value", name: y },
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
        xAxis: { type: "category", data: xCategories.map(String), ...xAxisName(x), splitArea: { show: true } },
        yAxis: { type: "category", data: yCategories.map(String), name: y, splitArea: { show: true } },
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

/** The row count from which a scatter takes the larger hit radius. */
const DENSE_SCATTER_ROWS = 2000;

/** The symbol size of a dense scatter. The ECharts default is 10, thus a dense point takes one step up. */
const DENSE_SCATTER_SYMBOL_SIZE = 12;

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

/** The label of one named point. `{b}` is the name of the item, thus the label needs no function. */
const POINT_LABEL: EchartOption = { show: true, formatter: "{b}" };

/** One resolved channel: the name that an axis reads, and the value that each row gives. */
interface ResolvedChannel {
    name: string;
    values: readonly (Cell | null)[];
    transformed: boolean;
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

/** One plotted point. `index` names the row that it came from, thus a rank rule can find it again. */
interface Point {
    index: number;
    x: Cell;
    y: Cell;
    y0?: Cell;
}

/** One runtime series, and whether it can carry the mark members of the annotations. */
interface EmittedSeries {
    option: EchartOption;
    carriesMarks: boolean;
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
 */
function deriveComposition(
    blockId: string,
    composition: ChartComposition,
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
): Result<EchartOption, RenderProblem> {
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
    const labeled = pointLabelRows(blockId, annotations, rows, columns);
    if (labeled.isErr()) return err(labeled.error);

    const dense = rows.length > DENSE_SCATTER_ROWS;
    const emitted: EmittedSeries[] = [];
    for (const entry of resolved) {
        for (const group of splitByChannel(rows, entry.group)) {
            const built = buildSeries(blockId, entry, group, labeled.value, dense, emitted.length);
            if (built.isErr()) return err(built.error);
            emitted.push(...built.value);
        }
    }

    const marks = markMembers(annotations);
    const target = emitted.findIndex((entry) => entry.carriesMarks);
    if (Object.keys(marks).length > 0 && target >= 0) {
        emitted[target] = { ...emitted[target], option: { ...emitted[target].option, ...marks } };
    }

    const first = resolved[0];
    const named = resolved.some((entry) => entry.label !== undefined) || labeled.value.size > 0;
    return ok({
        tooltip: named ? { ...NAMED_TOOLTIP } : { ...PLAIN_TOOLTIP },
        xAxis: compositionXAxis(rows, first, composition.axes?.x),
        yAxis: compositionAxis(rows, first.y, "y", composition.axes?.y),
        series: emitted.map((entry) => entry.option),
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
        return ok({ name: column, values: rows.map((row) => row[column] ?? null), transformed: false });
    }
    return ok({ name: transformedName(transform, column), values: transformColumn(rows, column, transform), transformed: true });
}

/** The refusal for a column that no row holds, or `undefined` when the column is present. */
function requirePresent(blockId: string, column: string, rows: readonly ChartRow[], columns: readonly string[] | undefined): RenderProblem | undefined {
    if (rows.length > 0 && !columnPresent(column, rows, columns)) {
        return problem(blockId, `The column "${column}" is absent from every row.`);
    }
    return undefined;
}

/**
 * Split the row indices by the group channel, in first-appearance order.
 *
 * A row whose group cell gives no value belongs to no series, thus it drops. A series with no group
 * channel takes every row.
 */
function splitByChannel(rows: readonly ChartRow[], group: ResolvedChannel | undefined): Array<{ name: Cell | undefined; indices: readonly number[] }> {
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

/** Build the runtime series of one declared series over one group of rows. */
function buildSeries(
    blockId: string,
    entry: ResolvedSeries,
    group: { name: Cell | undefined; indices: readonly number[] },
    labeled: ReadonlySet<number>,
    dense: boolean,
    emittedCount: number,
): Result<EmittedSeries[], RenderProblem> {
    const form = entry.declared.form;
    const points = collectPoints(entry, group.indices);
    if (SORTED_FORMS.has(form)) {
        points.sort((a, b) => compareCell(a.x, b.x));
    }
    const name = seriesName(entry, group.name);

    if (entry.y0 !== undefined) {
        const band = bandSeries(blockId, entry, name, points, `band-${emittedCount}`);
        if (band.isErr()) return err(band.error);
        return ok([
            { option: band.value[0], carriesMarks: false },
            { option: band.value[1], carriesMarks: true },
        ]);
    }

    const { data, itemObjects } = seriesData(entry, points, labeled);
    return ok([{ option: { type: runtimeType(form), name, ...formOptions(form, dense, itemObjects), data }, carriesMarks: true }]);
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
 * no declared name and no group takes the name of its y channel.
 */
function seriesName(entry: ResolvedSeries, group: Cell | undefined): string {
    const declared = entry.declared.name;
    if (declared !== undefined && group !== undefined) return `${declared} (${String(group)})`;
    if (declared !== undefined) return declared;
    if (group !== undefined) return String(group);
    return entry.y.name;
}

/**
 * The data of one runtime series.
 *
 * A bare pair is the smallest item that states one point. A point that carries a name, or that the rank
 * rule marks, takes the object form, because only an object item holds a name and a label.
 */
function seriesData(entry: ResolvedSeries, points: readonly Point[], labeled: ReadonlySet<number>): { data: unknown[]; itemObjects: boolean } {
    const data: unknown[] = [];
    let itemObjects = false;
    for (const point of points) {
        const label = entry.label?.[point.index];
        const named = label !== undefined && label !== null;
        const marked = labeled.has(point.index);
        if (!named && !marked) {
            data.push([point.x, point.y]);
            continue;
        }
        itemObjects = true;
        data.push({
            value: [point.x, point.y],
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

/** The fields that one form adds to its runtime series. */
function formOptions(form: ChartSeries["form"], dense: boolean, itemObjects: boolean): EchartOption {
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
                ...(dense ? { symbolSize: DENSE_SCATTER_SYMBOL_SIZE } : {}),
                // The large path draws a simplified point, and it drops a per-item style. Thus a series
                // whose items carry a name or a label keeps the normal path.
                ...(itemObjects ? {} : { large: true, largeThreshold: LARGE_SCATTER_THRESHOLD }),
            };
    }
}

/** The row indices that the point-label annotations mark. An absent rank column is a refusal. */
function pointLabelRows(
    blockId: string,
    annotations: readonly ChartAnnotation[],
    rows: readonly ChartRow[],
    columns: readonly string[] | undefined,
): Result<ReadonlySet<number>, RenderProblem> {
    const marked = new Set<number>();
    for (const annotation of annotations) {
        if (annotation.kind !== "point-labels") continue;
        const absent = requirePresent(blockId, annotation.column, rows, columns);
        if (absent !== undefined) return err(absent);
        for (const index of topRows(rows, annotation.column, annotation.order, annotation.n)) {
            marked.add(index);
        }
    }
    return ok(marked);
}

/**
 * The indices of the first `n` rows under the order of one column.
 *
 * A row whose cell is absent takes no place. The sort is stable, thus two equal cells keep the row order
 * and the subset is the same on every host.
 */
function topRows(rows: readonly ChartRow[], column: string, order: "asc" | "desc", n: number): number[] {
    const ranked: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        if (rows[index][column] !== undefined) ranked.push(index);
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
 */
function markMembers(annotations: readonly ChartAnnotation[]): EchartOption {
    const lines: EchartOption[] = [];
    const areas: EchartOption[][] = [];
    for (const annotation of annotations) {
        if (annotation.kind === "reference-line") {
            lines.push({ [axisKey(annotation.axis)]: annotation.value, ...markLabel(annotation.label) });
            continue;
        }
        if (annotation.kind === "reference-band") {
            areas.push([{ [axisKey(annotation.axis)]: annotation.from, ...markLabel(annotation.label) }, { [axisKey(annotation.axis)]: annotation.to }]);
        }
    }
    return {
        ...(lines.length > 0 ? { markLine: { silent: true, symbol: "none", data: lines } } : {}),
        ...(areas.length > 0 ? { markArea: { silent: true, data: areas } } : {}),
    };
}

/** The label of one mark member. The text is a constant of the annotation, and never a template. */
function markLabel(label: string | undefined): EchartOption {
    return label !== undefined ? { label: { formatter: label } } : {};
}

/** The mark key of one axis. A mark member names `xAxis` or `yAxis`, and the constant that sits on it. */
function axisKey(axis: "x" | "y"): "xAxis" | "yAxis" {
    return axis === "x" ? "xAxis" : "yAxis";
}

/**
 * The x axis of a composition.
 *
 * A bar takes a category axis, and every other form takes the inferred axis. A declared scale is the one
 * exception, because the author asked for a numeric axis and a category axis has no scale.
 */
function compositionXAxis(rows: readonly ChartRow[], first: ResolvedSeries, declared: ChartAxes["x"]): EchartOption {
    if (first.declared.form !== "bar" || declared?.scale !== undefined) {
        return compositionAxis(rows, first.x, "x", declared);
    }
    // A bar counts its categories. The base bar rule lists the x values in first-appearance order, thus a
    // bar of either path draws the same axis.
    const categories = firstAppearance(first.x.values.filter((value): value is Cell => value !== null));
    return { type: "category", data: categories, ...xAxisName(declared?.title ?? first.x.name) };
}

/**
 * The axis of one composition channel.
 *
 * A declared title replaces the column name. A declared `log` scale maps onto the logarithmic axis type. A
 * transformed channel gives a number for each point that survives it, thus its axis is a value axis and
 * the cells of the untransformed column decide nothing.
 */
function compositionAxis(rows: readonly ChartRow[], channel: ResolvedChannel, axis: "x" | "y", declared: ChartAxes["x"]): EchartOption {
    const title = declared?.title ?? channel.name;
    const nameFields = axis === "x" ? xAxisName(title) : { name: title };
    if (declared?.scale === "log") {
        return { type: "log", ...nameFields };
    }
    const base = channel.transformed ? { type: "value", scale: true } : inferAxis(rows, channel.name, axis);
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

/** The transformed value of one column, one entry for each row. A row with no usable cell gives `null`. */
function transformColumn(rows: readonly ChartRow[], column: string, transform: ChartTransform): (number | null)[] {
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

/** Convert one cell to a finite number, or `null` when it is not numeric. */
function toNumber(cell: Cell | undefined): number | null {
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
 * y column keeps the default name placement.
 */
function inferAxis(rows: readonly ChartRow[], column: string, axis: "x" | "y"): EchartOption {
    const nameFields = axis === "x" ? xAxisName(column) : { name: column };
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
        name: String(name),
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
