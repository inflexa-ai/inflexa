/**
 * The dispatch of the figure registry: a registered chart type takes its module, an unregistered one keeps its
 * path, and each member that a chart type does not read refuses.
 */

import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, deriveChartRender, type ChartInputs, type ChartOpts, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_INLINE_OPTION_BOUND } from "../design.js";
import { FIGURE_PRESET_TYPES, type FigureContext, type FigureMember, type FigureModule } from "./index.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;
type ChartType = NonNullable<ChartBlock["chartType"]>;

const HASH = `sha256:${"a".repeat(64)}`;

/** Build a quick-path chart block with the given extra members. */
function block(chartType: ChartType, encoding: Encoding, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "f1", binding: { kind: "artifact-table", path: "table.csv", hash: HASH }, chartType, encoding, ...extra };
}

/** One statistic of a block, bound to a cell of the given column. */
function statistic(label: string, column: string): NonNullable<ChartBlock["statistics"]>[number] {
    return { label, value: { kind: "artifact-value", path: "stats.csv", hash: HASH, locator: { column, row: 0 } } };
}

/**
 * A figure module of a test: it reads the given members, and it draws one scatter series whose name states the
 * module. It keeps the context it receives, thus a test reads what the dispatch handed over.
 */
function echoModule(reads: readonly FigureMember[]): { module: FigureModule; seen: FigureContext[] } {
    const seen: FigureContext[] = [];
    return {
        seen,
        module: {
            reads: new Set(reads),
            derive: (_block, rows, context) => {
                seen.push(context);
                return ok({
                    xAxis: { type: "value" },
                    yAxis: { type: "value" },
                    series: [{ type: "scatter", name: "from the module", data: rows.map((row) => [row.x, row.y]) }],
                });
            },
        },
    };
}

/** The options of a derivation with one registered module. */
function withFigure(chartType: ChartType, module: FigureModule): ChartOpts {
    return { figures: { [chartType]: module } };
}

/** The names of the series of one option. */
function seriesNames(option: EchartOption): unknown[] {
    return (option.series as EchartOption[]).map((entry) => entry.name);
}

const ROWS: ChartRow[] = [
    { x: 1, y: 0.01, g: "a" },
    { x: -2, y: 0.5, g: "b" },
];

describe("the figure registry", () => {
    it("derives a registered preset through its module", () => {
        const { module } = echoModule(["x", "y"]);
        const option = deriveChartOption(block("volcano", { x: "x", y: "y" }), ROWS, undefined, {}, withFigure("volcano", module))._unsafeUnwrap();
        expect(seriesNames(option)).toEqual(["from the module"]);
    });

    it("refuses each preset of the first grammar that has no module, and names the preset", () => {
        for (const chartType of ["volcano", "ma", "manhattan", "km"] as const) {
            expect(deriveChartOption(block(chartType, { x: "x", y: "y" }), ROWS, undefined, {}, { figures: {} })._unsafeUnwrapErr().detail).toBe(
                `The ${chartType} figure is not available yet. Draw the table with a base chart type or a composition.`,
            );
        }
    });

    it("derives a registered base type through its module, and keeps the fixed rule of every other base type", () => {
        const { module } = echoModule(["x", "y"]);
        const registered = deriveChartOption(block("scatter", { x: "x", y: "y" }), ROWS, undefined, {}, withFigure("scatter", module))._unsafeUnwrap();
        expect(seriesNames(registered)).toEqual(["from the module"]);
        const kept = deriveChartOption(block("line", { x: "x", y: "y" }), ROWS, undefined, {}, withFigure("scatter", module))._unsafeUnwrap();
        expect((kept.series as EchartOption[])[0].type).toBe("line");
    });

    it("runs the layout discipline and the figure rules over the option of a module", () => {
        const { module } = echoModule(["x", "y"]);
        const option = deriveChartOption(block("volcano", { x: "x", y: "y" }), ROWS, undefined, {}, withFigure("volcano", module))._unsafeUnwrap();
        expect(option.toolbox).toBeUndefined();
        expect(option.legend).toEqual({ show: false });
        expect((option.xAxis as EchartOption).axisLabel).toEqual({ interval: 0 });
    });

    it("refuses each figure preset that has no module, and names the preset", () => {
        for (const chartType of FIGURE_PRESET_TYPES) {
            const problem = deriveChartOption(block(chartType, { x: "x", y: "y" }), ROWS, undefined, {}, { figures: {} })._unsafeUnwrapErr();
            expect(problem).toEqual({
                blockId: "f1",
                kind: "invalid-chart-input",
                detail: `The ${chartType} figure is not available yet. Draw the table with a base chart type or a composition.`,
            });
        }
    });
});

describe("the members that a module reads", () => {
    it("refuses a channel, the statistics, the track, and the focus that the module does not read", () => {
        const { module } = echoModule(["x", "y"]);
        const opts = withFigure("volcano", module);
        const refusal = (extra: Partial<ChartBlock>, encoding: Encoding = { x: "x", y: "y" }): string =>
            deriveChartOption(block("volcano", encoding, extra), ROWS, undefined, {}, opts)._unsafeUnwrapErr().detail;
        expect(refusal({}, { x: "x", y: "y", group: "g" })).toBe('The volcano chart takes no "group" channel.');
        expect(refusal({}, { x: "x", y: "y", p: "y" })).toBe('The volcano chart takes no "p" channel. The "p" channel is legal on the ma and forest charts.');
        expect(refusal({ statistics: [statistic("p", "pvalue")] })).toBe(
            "The volcano chart prints no statistics. The statistics are legal on the km, roc, qq, and gsea charts.",
        );
        expect(refusal({ focus: ["a"] })).toBe("The volcano chart takes no focus.");
    });

    it("hands the statistics with their shown text, and the track with its columns, to a module that reads them", () => {
        const { module, seen } = echoModule(["x", "y", "statistics", "track"]);
        const track = {
            binding: { kind: "artifact-table" as const, path: "domains.csv", hash: HASH, columnLabels: { domain: "Domain" } },
            start: "start",
            end: "end",
            label: "domain",
        };
        const inputs: ChartInputs = {
            statistics: [
                { label: "Log-rank p", value: 0.00123 },
                { label: "Log-rank p (stored zero)", value: 0 },
                { label: "HR", value: "0.534" },
            ],
            track: { rows: [{ start: 1, end: 90, domain: "PWWP" }], columns: ["start", "end", "domain"] },
        };
        const chart = block(
            "lollipop",
            { x: "x", y: "y" },
            { statistics: [statistic("Log-rank p", "pvalue"), statistic("Log-rank p (stored zero)", "pvalue"), statistic("HR", "hr")], track },
        );
        deriveChartOption(chart, ROWS, undefined, inputs, withFigure("lollipop", module))._unsafeUnwrap();
        const context = seen[0];
        // The number helper formats each value in the kind of its locator column, thus a stored zero of a p
        // column prints the below-resolution form and never a bare zero.
        expect(context.statistics.map((entry) => [entry.label, entry.value, entry.text])).toEqual([
            ["Log-rank p", 0.00123, "1.2 × 10⁻³"],
            ["Log-rank p (stored zero)", 0, "≈0"],
            ["HR", "0.534", "0.534"],
        ]);
        expect(context.track).toEqual({
            rows: [{ start: 1, end: 90, domain: "PWWP" }],
            columns: ["start", "end", "domain"],
            start: "start",
            end: "end",
            label: "domain",
            labels: { domain: "Domain" },
            meanings: undefined,
        });
    });

    it("prints the unit of a statistic after its value where the reference carries one", () => {
        const { module, seen } = echoModule(["x", "y", "statistics"]);
        const withUnit = (label: string, column: string, unit: string): NonNullable<ChartBlock["statistics"]>[number] => {
            const base = statistic(label, column);
            return { ...base, value: { ...base.value, unit } };
        };
        const chart = block(
            "km",
            { x: "x", y: "y" },
            { statistics: [withUnit("Median", "median", "days"), withUnit("Censored", "share", "%"), statistic("HR", "hr")] },
        );
        const inputs: ChartInputs = {
            statistics: [
                { label: "Median", value: 426 },
                { label: "Censored", value: 27.5 },
                { label: "HR", value: 0.59 },
            ],
        };
        deriveChartOption(chart, ROWS, undefined, inputs, withFigure("km", module))._unsafeUnwrap();
        // A percent sign joins its value, and every other unit follows a space.
        expect(seen[0].statistics.map((entry) => entry.text)).toEqual(["426 days", "27.5%", "0.59"]);
    });

    it("refuses a block whose statistics or track the value entry does not carry", () => {
        const { module } = echoModule(["x", "y", "statistics", "track"]);
        const opts = withFigure("km", module);
        const missingStatistic = deriveChartOption(
            block("km", { x: "x", y: "y" }, { statistics: [statistic("p", "pvalue")] }),
            ROWS,
            undefined,
            {},
            opts,
        )._unsafeUnwrapErr();
        expect(missingStatistic).toEqual({ blockId: "f1", kind: "missing-value", detail: "The chart declares 1 statistics, and its value entry carries 0." });
        const track = { binding: { kind: "artifact-table" as const, path: "domains.csv", hash: HASH }, start: "s", end: "e", label: "l" };
        const missingTrack = deriveChartOption(block("km", { x: "x", y: "y" }, { track }), ROWS, undefined, {}, opts)._unsafeUnwrapErr();
        expect(missingTrack).toEqual({ blockId: "f1", kind: "missing-value", detail: "The chart declares a track, and its value entry carries no track." });
    });

    it("hands the tree of each axis with its columns to a module that reads the trees, and refuses a tree that the entry does not carry", () => {
        const { module, seen } = echoModule(["x", "y", "trees"]);
        const tree = (path: string) => ({
            binding: { kind: "artifact-table" as const, path, hash: HASH, columnLabels: { height: "Distance" } },
            parent: "parent",
            child: "child",
            height: "height",
        });
        const chart = block("heatmap", { x: "x", y: "y" }, { trees: { x: tree("sample_tree.csv"), y: tree("gene_tree.csv") } });
        const edges = [{ parent: "n1", child: "a", height: 1 }];
        const inputs: ChartInputs = { trees: { x: { rows: edges, columns: ["parent", "child", "height"] }, y: { rows: edges } } };
        deriveChartOption(chart, ROWS, undefined, inputs, withFigure("heatmap", module))._unsafeUnwrap();
        expect(seen[0].trees).toEqual({
            x: {
                rows: edges,
                columns: ["parent", "child", "height"],
                parent: "parent",
                child: "child",
                height: "height",
                labels: { height: "Distance" },
                meanings: undefined,
            },
            y: { rows: edges, parent: "parent", child: "child", height: "height", labels: { height: "Distance" }, meanings: undefined },
        });
        const missing = deriveChartOption(chart, ROWS, undefined, { trees: { x: { rows: edges } } }, withFigure("heatmap", module))._unsafeUnwrapErr();
        expect(missing).toEqual({ blockId: "f1", kind: "missing-value", detail: "The chart declares a tree of y, and its value entry carries no tree of y." });
    });

    it("gives a module the composition machinery, which reads the shared payload past the inline bound", () => {
        const dense: ChartRow[] = [];
        for (let index = 0; index < 6000; index += 1) dense.push({ x: index * 0.001, y: 1 / (index + 2) });
        const module: FigureModule = {
            reads: new Set<FigureMember>(["x", "y"]),
            derive: (_block, _rows, context) =>
                context.compose({ series: [{ form: "scatter", encoding: { x: "x", y: { column: "y", transform: "neg_log10" } } }] }),
        };
        const render = deriveChartRender(
            block("qq", { x: "x", y: "y" }),
            dense,
            ["x", "y"],
            { key: "f1", columns: ["x", "y"] },
            {},
            withFigure("qq", module),
        )._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
    });
});

describe("the members of the canonical figures on a chart type with no module", () => {
    it("refuses each new channel, and names the charts that read it", () => {
        const cases: Array<[ChartType, Encoding, string]> = [
            ["line", { x: "x", y: "y", shape: "g" }, 'The line chart takes no "shape" channel. The "shape" channel is legal on the pca and scatter charts.'],
            ["bar", { x: "g", y: "y", censor: "x" }, 'The bar chart takes no "censor" channel. The "censor" channel is legal on the km charts.'],
            ["line", { x: "x", y: "y", risk: "x" }, 'The line chart takes no "risk" channel. The "risk" channel is legal on the km charts.'],
            ["volcano", { x: "x", y: "y", hit: "x" }, 'The volcano chart takes no "hit" channel. The "hit" channel is legal on the gsea charts.'],
            [
                "manhattan",
                { x: "x", y: "y", metric: "x" },
                'The manhattan chart takes no "metric" channel. The "metric" channel is legal on the gsea and locuszoom charts.',
            ],
            [
                "box",
                { x: "g", y: "y", tracks: ["g"] },
                'The box chart takes no "tracks" channel. The "tracks" channel is legal on the heatmap and oncoprint charts.',
            ],
        ];
        for (const [chartType, encoding, detail] of cases) {
            expect(deriveChartOption(block(chartType, encoding), ROWS)._unsafeUnwrapErr()).toEqual({ blockId: "f1", kind: "invalid-chart-input", detail });
        }
    });

    it("refuses the statistics and the track on a base type and a preset that reads neither", () => {
        const track = { binding: { kind: "artifact-table" as const, path: "domains.csv", hash: HASH }, start: "s", end: "e", label: "l" };
        expect(deriveChartOption(block("scatter", { x: "x", y: "y" }, { statistics: [statistic("AUC", "auc")] }), ROWS)._unsafeUnwrapErr().detail).toBe(
            "The scatter chart prints no statistics. The statistics are legal on the km, roc, qq, and gsea charts.",
        );
        expect(deriveChartOption(block("volcano", { x: "x", y: "y" }, { track }), ROWS)._unsafeUnwrapErr().detail).toBe(
            "The volcano chart draws no track. A track is legal on the lollipop and locuszoom charts.",
        );
    });

    it("keeps no base rule for the heatmap, thus a heatmap with no module refuses", () => {
        expect(deriveChartOption(block("heatmap", { x: "g", y: "g", value: "y" }), ROWS, undefined, {}, { figures: {} })._unsafeUnwrapErr().detail).toBe(
            "The heatmap figure is not available yet. Draw the table with a base chart type or a composition.",
        );
    });

    it("refuses the statistics and the track beside a composition", () => {
        const composition: ChartBlock["composition"] = { series: [{ form: "scatter", encoding: { x: "x", y: "y" } }] };
        const base = { kind: "chart" as const, id: "f1", binding: { kind: "artifact-table" as const, path: "table.csv", hash: HASH }, composition };
        expect(deriveChartOption({ ...base, statistics: [statistic("p", "pvalue")] }, ROWS)._unsafeUnwrapErr().detail).toBe(
            "A composition reads no statistics. The statistics are legal on the km, roc, qq, and gsea charts.",
        );
        const track = { binding: { kind: "artifact-table" as const, path: "domains.csv", hash: HASH }, start: "s", end: "e", label: "l" };
        expect(deriveChartOption({ ...base, track }, ROWS)._unsafeUnwrapErr().detail).toBe(
            "A composition reads no track. A track is legal on the lollipop and locuszoom charts.",
        );
        const trees = { y: { binding: { kind: "artifact-table" as const, path: "tree.csv", hash: HASH }, parent: "p", child: "c", height: "h" } };
        expect(deriveChartOption({ ...base, trees }, ROWS)._unsafeUnwrapErr().detail).toBe(
            "A composition reads no trees. The trees are legal on the heatmap charts.",
        );
    });

    it("refuses the trees on a chart type that draws no dendrogram, and names the charts that read them", () => {
        const trees = { x: { binding: { kind: "artifact-table" as const, path: "tree.csv", hash: HASH }, parent: "p", child: "c", height: "h" } };
        expect(deriveChartOption(block("bar", { x: "g", y: "y" }, { trees }), ROWS)._unsafeUnwrapErr().detail).toBe(
            "The bar chart draws no tree. The trees are legal on the heatmap charts.",
        );
        expect(deriveChartOption(block("volcano", { x: "x", y: "y" }, { trees }), ROWS)._unsafeUnwrapErr().detail).toBe(
            "The volcano chart draws no tree. The trees are legal on the heatmap charts.",
        );
    });

    it("refuses each preset of the figure extensions until its module registers", () => {
        for (const chartType of ["upset", "sankey", "locuszoom"] as const) {
            expect(deriveChartOption(block(chartType, { x: "x", y: "y" }), ROWS, undefined, {}, { figures: {} })._unsafeUnwrapErr().detail).toBe(
                `The ${chartType} figure is not available yet. Draw the table with a base chart type or a composition.`,
            );
        }
    });
});
