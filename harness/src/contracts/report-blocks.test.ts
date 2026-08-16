import { describe, expect, it } from "bun:test";

import { ChartBlockSchema, channelColumn, channelTransform, type ChartComposition } from "./report-blocks.js";

const HASH = `sha256:${"a".repeat(64)}`;

/** The binding of every chart under test. The grammar rules never read the binding. */
const BINDING = { kind: "artifact-table", run: "run-1", path: "runs/run-1/step-a/output/de.csv", hash: HASH };

/** A chart block that carries the given grammar fields. The extra fields ride unchecked, thus a hole is testable. */
function chart(fields: Record<string, unknown>): Record<string, unknown> {
    return { kind: "chart", id: "chart-1", binding: BINDING, ...fields };
}

/** True when the chart block parses. */
function parses(fields: Record<string, unknown>): boolean {
    return ChartBlockSchema.safeParse(chart(fields)).success;
}

/** One composition of one plain scatter series. */
function scatterComposition(): ChartComposition {
    return { series: [{ form: "scatter", encoding: { x: "log2FoldChange", y: "padj" } }] };
}

describe("the chart channel", () => {
    it("takes a plain column name", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "log2FoldChange", y: "padj" } })).toBe(true);
    });

    it("takes a column with a per-row transform", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "log2FoldChange", y: { column: "padj", transform: "neg_log10" } } })).toBe(true);
    });

    it("takes each of the four transforms", () => {
        for (const transform of ["log10", "neg_log10", "abs", "rank"]) {
            expect(parses({ chartType: "scatter", encoding: { x: "gene", y: { column: "padj", transform } } })).toBe(true);
        }
    });

    it("refuses a transform outside the four", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "gene", y: { column: "padj", transform: "sqrt" } } })).toBe(false);
    });

    it("refuses a channel that carries a value beside its column", () => {
        // A channel names a column and a transform, and nothing else. Thus a value can never ride a channel.
        expect(parses({ chartType: "scatter", encoding: { x: "gene", y: { column: "padj", transform: "abs", values: [1, 2, 3] } } })).toBe(false);
    });

    it("gives the column and the transform of either channel form", () => {
        expect(channelColumn("padj")).toBe("padj");
        expect(channelTransform("padj")).toBeUndefined();
        expect(channelColumn({ column: "padj", transform: "neg_log10" })).toBe("padj");
        expect(channelTransform({ column: "padj", transform: "neg_log10" })).toBe("neg_log10");
    });
});

describe("the quick path", () => {
    it("takes a label column", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "log2FoldChange", y: "padj", label: "gene" } })).toBe(true);
    });

    it("takes each preset with the same channels as a base type", () => {
        for (const preset of ["volcano", "manhattan", "ma", "km"]) {
            expect(parses({ chartType: preset, encoding: { x: "log2FoldChange", y: "padj", label: "gene" } })).toBe(true);
        }
    });

    it("refuses a channel that the encoding does not declare", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "gene", y: "padj", size: "baseMean" } })).toBe(false);
    });
});

describe("the bar orientation", () => {
    it("takes a horizontal bar, and the orientation rides the parsed block", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "bar", encoding: { x: "pathway", y: "nes" }, orientation: "horizontal" }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.orientation).toBe("horizontal");
    });

    it("takes a bar with no orientation, thus a stored block keeps parsing", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "bar", encoding: { x: "pathway", y: "nes" } }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.orientation).toBeUndefined();
    });

    it("takes an orientation beside a type that is not a bar, because the render states that fault", () => {
        // The grammar admits it. A silent ignore is what the rule forbids, and the derivation refuses it.
        expect(parses({ chartType: "line", encoding: { x: "time", y: "survival" }, orientation: "horizontal" })).toBe(true);
    });

    it("refuses an orientation outside the two arrangements", () => {
        expect(parses({ chartType: "bar", encoding: { x: "pathway", y: "nes" }, orientation: "sideways" })).toBe(false);
    });

    it("takes the orientation on a bar series of a composition", () => {
        expect(parses({ composition: { series: [{ form: "bar", orientation: "horizontal", encoding: { x: "pathway", y: "nes" } }] } })).toBe(true);
    });

    it("refuses the orientation on a series form that draws no bar", () => {
        for (const form of ["line", "scatter", "area", "step"]) {
            expect(parses({ composition: { series: [{ form, orientation: "horizontal", encoding: { x: "time", y: "survival" } }] } })).toBe(false);
        }
    });

    it("refuses a block-level orientation beside a composition, because the series states the arrangement", () => {
        expect(parses({ composition: scatterComposition(), orientation: "horizontal" })).toBe(false);
    });

    it("refuses an orientation that stands alone, with no chart type and no composition", () => {
        expect(parses({ orientation: "horizontal" })).toBe(false);
    });
});

describe("the composition", () => {
    it("takes one series of each form", () => {
        for (const form of ["line", "scatter", "bar", "area", "step"]) {
            expect(parses({ composition: { series: [{ form, encoding: { x: "time", y: "survival" } }] } })).toBe(true);
        }
    });

    it("refuses a series list that holds no series", () => {
        expect(parses({ composition: { series: [] } })).toBe(false);
    });

    it("refuses a series that names no y channel", () => {
        expect(parses({ composition: { series: [{ form: "line", encoding: { x: "time" } }] } })).toBe(false);
    });

    it("takes a `y0` lower bound on an area series", () => {
        expect(parses({ composition: { series: [{ form: "area", encoding: { x: "time", y: "upper", y0: "lower" } }] } })).toBe(true);
    });

    it("refuses a `y0` lower bound on any other form", () => {
        for (const form of ["line", "scatter", "bar", "step"]) {
            expect(parses({ composition: { series: [{ form, encoding: { x: "time", y: "upper", y0: "lower" } }] } })).toBe(false);
        }
    });

    it("takes a series name and a group channel", () => {
        expect(parses({ composition: { series: [{ form: "step", encoding: { x: "time", y: "survival", group: "arm" }, name: "Overall" }] } })).toBe(true);
    });

    it("takes the three annotation kinds", () => {
        const annotations = [
            { kind: "reference-line", axis: "y", value: 1.3, label: "p 0.05" },
            { kind: "reference-band", axis: "x", from: -1, to: 1, label: "no effect" },
            { kind: "point-labels", column: "padj", order: "asc", n: 10 },
        ];
        expect(parses({ composition: { ...scatterComposition(), annotations } })).toBe(true);
    });

    it("refuses an annotation kind outside the three", () => {
        expect(parses({ composition: { ...scatterComposition(), annotations: [{ kind: "trend-line", axis: "y" }] } })).toBe(false);
    });

    it("bounds the point-label count at 20", () => {
        const withCount = (n: number): boolean =>
            parses({ composition: { ...scatterComposition(), annotations: [{ kind: "point-labels", column: "padj", order: "desc", n }] } });
        expect(withCount(20)).toBe(true);
        expect(withCount(21)).toBe(false);
        expect(withCount(0)).toBe(false);
        expect(withCount(2.5)).toBe(false);
    });

    it("takes an axis title and an axis scale", () => {
        expect(parses({ composition: { ...scatterComposition(), axes: { x: { title: "Fold change" }, y: { title: "-log10 p", scale: "log" } } } })).toBe(true);
    });

    it("refuses an axis scale outside the two", () => {
        expect(parses({ composition: { ...scatterComposition(), axes: { y: { scale: "sqrt" } } } })).toBe(false);
    });
});

describe("the unrepresentable holes", () => {
    it("refuses a series that carries a data literal", () => {
        expect(parses({ composition: { series: [{ form: "line", encoding: { x: "time", y: "survival" }, data: [1, 2, 3] }] } })).toBe(false);
    });

    it("refuses a composition that carries a data literal beside its series", () => {
        expect(parses({ composition: { ...scatterComposition(), dataset: { source: [[1, 2]] } } })).toBe(false);
    });

    it("refuses a block that carries a raw option", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "gene", y: "padj" }, option: { series: [] } })).toBe(false);
    });

    it("refuses a series that carries script text", () => {
        expect(
            parses({ composition: { series: [{ form: "line", encoding: { x: "time", y: "survival" }, formatter: "function (p) { return p.name; }" }] } }),
        ).toBe(false);
    });

    it("refuses an annotation that carries script text", () => {
        expect(
            parses({ composition: { ...scatterComposition(), annotations: [{ kind: "reference-line", axis: "y", value: 1, formatter: "(v) => v" }] } }),
        ).toBe(false);
    });
});

describe("the exclusivity of the two paths", () => {
    it("takes the quick path alone", () => {
        expect(parses({ chartType: "bar", encoding: { x: "pathway", y: "nes" } })).toBe(true);
    });

    it("takes the composition alone", () => {
        expect(parses({ composition: scatterComposition() })).toBe(true);
    });

    it("refuses a chart type with an encoding and a composition together", () => {
        expect(parses({ chartType: "bar", encoding: { x: "pathway", y: "nes" }, composition: scatterComposition() })).toBe(false);
    });

    it("refuses a chart type and a composition together, with no encoding", () => {
        expect(parses({ chartType: "bar", composition: scatterComposition() })).toBe(false);
    });

    it("refuses an encoding and a composition together, with no chart type", () => {
        expect(parses({ encoding: { x: "pathway", y: "nes" }, composition: scatterComposition() })).toBe(false);
    });

    it("refuses a chart type with no encoding", () => {
        expect(parses({ chartType: "bar" })).toBe(false);
    });

    it("refuses an encoding with no chart type", () => {
        expect(parses({ encoding: { x: "pathway", y: "nes" } })).toBe(false);
    });

    it("refuses a block that carries neither path", () => {
        expect(parses({})).toBe(false);
    });
});
