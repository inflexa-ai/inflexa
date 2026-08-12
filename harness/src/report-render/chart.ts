/**
 * The chart derivation of the report page.
 *
 * A chart block binds one whole-table artifact and a channel mapping. `deriveChartOption` turns the
 * chart type, the encoding, and the resolved rows into one ECharts option object. The chart container
 * markup lives beside this file, and it wraps the option that this derivation gives.
 *
 * The renderer computes no aggregate. Each plotted number stays traceable to one cell of the evidence
 * artifact. A pie or a heatmap arrives one row per category or per cell, thus a repeated category or a
 * repeated pair is a refusal and not a silent sum.
 *
 * The derivation is deterministic. Every object builds in one fixed key order, and the code reads no
 * clock, no random value, and no locale. A string comparison uses the code-unit order (`<`) and never
 * `localeCompare`, thus the same rows give the same bytes on every host.
 */

import { err, ok, type Result } from "neverthrow";

import type { ChartBlock } from "../contracts/report-blocks.js";
import { normalizeEchartSpec } from "../tools/display/normalize-echart-spec.js";
import type { RenderProblem } from "./types.js";

/** One cell of a resolved row. A cell is one string or one number. */
type Cell = string | number;

/** One resolved row of the bound table, keyed by column name. */
export type ChartRow = Record<string, Cell>;

/** The derived option object, ready for `normalizeEchartSpec` and the inline JSON. */
export type EchartOption = Record<string, unknown>;

/** The four channels of a chart encoding. Each type demands a subset of them. */
type Channel = "x" | "y" | "group" | "value";

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

/** Dispatch to the per-type derivation. Each type holds one fixed rule. */
function deriveRaw(block: ChartBlock, rows: readonly ChartRow[], columns?: readonly string[]): Result<EchartOption, RenderProblem> {
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

// ── The per-type derivations ────────────────────────────────────────────────

/** A category x axis, a value y axis, and one bar series per group with the `[x, y]` pairs. */
function deriveBar(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
function deriveLine(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
function deriveScatter(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
function deriveHistogram(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
    const xResult = requireColumn(block, rows, columns, "x");
    if (xResult.isErr()) return err(xResult.error);
    const x = xResult.value;
    const groupCol = block.encoding.group;

    if (rows.length === 0) {
        return ok({
            xAxis: { type: "value", scale: true },
            yAxis: { type: "value", name: "Count" },
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
        yAxis: { type: "value", name: "Count" },
        series,
    });
}

/** A five-number summary per category, plus a paired scatter series for the outliers. */
function deriveBox(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
function deriveHeatmap(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
function derivePie(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined): Result<EchartOption, RenderProblem> {
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
function requireColumn(block: ChartBlock, rows: readonly ChartRow[], columns: readonly string[] | undefined, channel: Channel): Result<string, RenderProblem> {
    const column = block.encoding[channel];
    if (column === undefined) {
        return err(problem(block.id, `The ${block.chartType} chart needs a column for the "${channel}" channel.`));
    }
    if (rows.length > 0 && !columnPresent(column, rows, columns)) {
        return err(problem(block.id, `The column "${column}" is absent from every row.`));
    }
    return ok(column);
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
 * Compare two cells for a sort by x. Two numbers compare by their difference. Any other pair compares
 * by the code-unit order of the string form. The comparison never calls `localeCompare`, thus the order
 * stays the same on every host.
 */
function compareCell(a: Cell, b: Cell): number {
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
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
