import { describe, expect, it } from "bun:test";

import { ChartBlockSchema, ClaimBlockSchema, TextBlockSchema, channelColumn, channelOrder, channelTransform, type ChartComposition } from "./report-blocks.js";

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
        expect(parses({ chartType: "scatter", encoding: { x: "gene", y: "padj", hue: "baseMean" } })).toBe(false);
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

describe("the preset thresholds", () => {
    it("takes a pair beside the volcano, and the pair rides the parsed block", () => {
        const parsed = ChartBlockSchema.safeParse(
            chart({ chartType: "volcano", encoding: { x: "log2FoldChange", y: "padj" }, thresholds: { significance: 0.1, effect: 1 } }),
        );
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.thresholds).toEqual({ significance: 0.1, effect: 1 });
    });

    it("takes a volcano with no pair, thus a stored block keeps parsing", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "volcano", encoding: { x: "log2FoldChange", y: "padj" } }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.thresholds).toBeUndefined();
    });

    it("refuses a pair beside a type that reads none", () => {
        // The pair states a significance cut and an effect cut. Every type but the volcano and the ma reads neither.
        for (const chartType of ["bar", "scatter", "manhattan", "km"]) {
            expect(parses({ chartType, encoding: { x: "pathway", y: "nes" }, thresholds: { significance: 0.05, effect: 1 } })).toBe(false);
        }
    });

    it("refuses a value that is not positive", () => {
        expect(parses({ chartType: "volcano", encoding: { x: "log2FoldChange", y: "padj" }, thresholds: { significance: 0, effect: 1 } })).toBe(false);
        expect(parses({ chartType: "volcano", encoding: { x: "log2FoldChange", y: "padj" }, thresholds: { significance: 0.05, effect: -1 } })).toBe(false);
    });

    it("refuses a volcano pair that names one value alone, because the member moves both surfaces", () => {
        const parsed = ChartBlockSchema.safeParse(
            chart({ chartType: "volcano", encoding: { x: "log2FoldChange", y: "padj" }, thresholds: { significance: 0.1 } }),
        );
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
            "The thresholds of a `volcano` are a pair. Give the `effect` cut beside the `significance` cut.",
        ]);
    });

    it("takes the significance cut alone beside an ma", () => {
        const parsed = ChartBlockSchema.safeParse(
            chart({ chartType: "ma", encoding: { x: "baseMean", y: "log2FoldChange", p: "padj" }, thresholds: { significance: 0.05 } }),
        );
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.thresholds).toEqual({ significance: 0.05 });
    });

    it("refuses an effect cut beside an ma, because an ma splits its rows by the p column alone", () => {
        const parsed = ChartBlockSchema.safeParse(
            chart({ chartType: "ma", encoding: { x: "baseMean", y: "log2FoldChange", p: "padj" }, thresholds: { significance: 0.05, effect: 1 } }),
        );
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(["An `ma` reads the `significance` cut alone. Omit the `effect` cut."]);
    });

    it("refuses a pair beside a composition, because a composition draws its own guides", () => {
        expect(parses({ composition: scatterComposition(), thresholds: { significance: 0.05, effect: 1 } })).toBe(false);
    });

    it("refuses a pair that stands alone, with no chart type and no composition", () => {
        expect(parses({ thresholds: { significance: 0.05, effect: 1 } })).toBe(false);
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

describe("the text list", () => {
    /** A text block that carries the given content. The extra fields ride unchecked, thus a hole is testable. */
    function text(content: Record<string, unknown>): Record<string, unknown> {
        return { kind: "text", id: "text-1", content };
    }

    /** The six limitation items of the case that the list serves. */
    const LIMITATIONS = [
        "The cohort holds 48 biopsies, thus a subgroup is small.",
        "The batch and the tissue site are confounded.",
        "No independent cohort validates the signature.",
        "The bulk profile hides the cell of origin.",
        "The survival follow-up is short.",
        "The pathway result rests on one database.",
    ];

    it("takes a lead sentence with six ordered items", () => {
        const parsed = TextBlockSchema.safeParse(text({ prose: "Six limits bound the reading.", list: { ordered: true, items: LIMITATIONS } }));

        expect(parsed.success).toBe(true);
        if (parsed.success) {
            // The list rides the parsed block, thus the stored document keeps each item.
            expect(parsed.data.content.list?.items).toEqual(LIMITATIONS);
            expect(parsed.data.content.list?.ordered).toBe(true);
        }
    });

    it("takes a list with an empty prose, because the lead sentences are optional", () => {
        expect(TextBlockSchema.safeParse(text({ prose: "", list: { ordered: false, items: ["One point."] } })).success).toBe(true);
    });

    it("takes a block with no list, thus a stored block keeps parsing", () => {
        const parsed = TextBlockSchema.safeParse(text({ prose: "Body text." }));

        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.content.list).toBeUndefined();
        }
    });

    it("refuses a list that holds no item", () => {
        expect(TextBlockSchema.safeParse(text({ prose: "Lead.", list: { ordered: true, items: [] } })).success).toBe(false);
    });

    it("refuses an item that holds no text", () => {
        expect(TextBlockSchema.safeParse(text({ prose: "Lead.", list: { ordered: true, items: ["One point.", ""] } })).success).toBe(false);
    });

    it("refuses a list that names no form", () => {
        expect(TextBlockSchema.safeParse(text({ prose: "Lead.", list: { items: ["One point."] } })).success).toBe(false);
    });

    it("refuses a field that the list grammar does not declare", () => {
        expect(TextBlockSchema.safeParse(text({ prose: "Lead.", list: { ordered: true, items: ["One point."], nested: [] } })).success).toBe(false);
    });

    it("refuses a list on a claim block, because the enumeration is a text block", () => {
        const claim = {
            kind: "claim",
            id: "claim-1",
            content: { prose: "A claim.", list: { ordered: true, items: ["One point."] } },
            bindings: [{ kind: "artifact-table", path: "runs/run-1/step-a/output/de.csv", hash: HASH }],
        };

        expect(ClaimBlockSchema.safeParse(claim).success).toBe(false);
    });
});

describe("the wide grammar", () => {
    it("takes an enrichment dot plot, and the size and the color channels ride the parsed block", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "scatter", encoding: { x: "ratio", y: "pathway", size: "count", color: "padj" } }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.encoding?.size).toBe("count");
        expect(parsed.success && parsed.data.encoding?.color).toBe("padj");
    });

    it("takes an interval pair and a facet on the quick path", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "hr", y: "study", low: "hr_low", high: "hr_high", facet: "cohort" } })).toBe(true);
    });

    it("refuses a lone interval bound, because an interval has two bounds", () => {
        expect(parses({ chartType: "scatter", encoding: { x: "hr", y: "study", low: "hr_low" } })).toBe(false);
        expect(parses({ chartType: "bar", encoding: { x: "arm", y: "mean", high: "mean_high" } })).toBe(false);
    });

    it("takes the color, the size, and the interval on a composition series", () => {
        const series = { form: "scatter", encoding: { x: "umap1", y: "umap2", color: "expr", size: "depth", low: "lo", high: "hi" } };
        expect(parses({ composition: { series: [series] } })).toBe(true);
    });

    it("refuses a lone interval bound on a composition series", () => {
        expect(parses({ composition: { series: [{ form: "bar", encoding: { x: "arm", y: "mean", low: "lo" } }] } })).toBe(false);
    });

    it("takes a facet beside the series of a composition", () => {
        expect(parses({ composition: { ...scatterComposition(), facet: "cohort" } })).toBe(true);
    });

    it("takes an ordered channel with no transform, and the order rides the parsed block", () => {
        const parsed = ChartBlockSchema.safeParse(
            chart({
                chartType: "heatmap",
                encoding: { x: { column: "sample", orderBy: "leaf_x" }, y: { column: "gene", orderBy: "leaf_y", order: "desc" }, value: "z" },
            }),
        );
        expect(parsed.success).toBe(true);
        const x = parsed.success ? parsed.data.encoding?.x : undefined;
        const y = parsed.success ? parsed.data.encoding?.y : undefined;
        expect(x !== undefined && channelOrder(x)).toEqual({ by: "leaf_x", order: "asc" });
        expect(y !== undefined && channelOrder(y)).toEqual({ by: "leaf_y", order: "desc" });
        expect(channelOrder("gene")).toBeUndefined();
    });

    it("takes a transform and an order on one channel", () => {
        expect(parses({ chartType: "bar", encoding: { x: { column: "pathway", orderBy: "nes" }, y: { column: "padj", transform: "neg_log10" } } })).toBe(true);
    });

    it("refuses an order that names no column to sort by", () => {
        expect(parses({ chartType: "bar", encoding: { x: { column: "pathway", order: "desc" }, y: "nes" } })).toBe(false);
    });

    it("refuses an order outside the two directions", () => {
        expect(parses({ chartType: "bar", encoding: { x: { column: "pathway", orderBy: "nes", order: "up" }, y: "nes" } })).toBe(false);
    });

    it("takes a focus list, and the list rides the parsed block", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "bar", encoding: { x: "pathway", y: "nes" }, focus: ["Hypoxia", "Glycolysis"] }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.focus).toEqual(["Hypoxia", "Glycolysis"]);
    });

    it("refuses an empty focus list", () => {
        expect(parses({ chartType: "bar", encoding: { x: "pathway", y: "nes" }, focus: [] })).toBe(false);
    });

    it("takes a focus beside a composition", () => {
        expect(parses({ composition: { series: [{ form: "line", encoding: { x: "day", y: "size", group: "arm" } }] }, focus: ["treated"] })).toBe(true);
    });

    it("takes each of the four new chart types", () => {
        for (const chartType of ["violin", "stacked-bar", "normalized-bar", "radar"]) {
            expect(parses({ chartType, encoding: { x: "cluster", y: "score", group: "sample" } })).toBe(true);
        }
    });

    it("takes the orientation beside a stacked form", () => {
        for (const chartType of ["stacked-bar", "normalized-bar"]) {
            expect(parses({ chartType, encoding: { x: "cluster", y: "count", group: "sample" }, orientation: "horizontal" })).toBe(true);
        }
    });

    it("keeps the fabrication holes closed on the new members", () => {
        // A focus names a category, and never a styled item. A channel names a column, and never a value.
        expect(parses({ chartType: "bar", encoding: { x: "pathway", y: "nes" }, focus: [{ name: "Hypoxia", color: "#ff0000" }] })).toBe(false);
        expect(parses({ chartType: "scatter", encoding: { x: "a", y: "b", color: { column: "c", values: [1, 2] } } })).toBe(false);
        expect(parses({ chartType: "scatter", encoding: { x: "a", y: "b", color: { column: "c", formatter: "function () {}" } } })).toBe(false);
        expect(parses({ chartType: "scatter", encoding: { x: "a", y: "b" }, renderItem: "outline" })).toBe(false);
    });
});

describe("the teaching text of the wide grammar", () => {
    /** The description of one member of an object schema. An optional wrapper carries the text. */
    function describedMember(shape: Record<string, { description?: string }>, member: string): string | undefined {
        return shape[member]?.description;
    }

    const quickPath = ChartBlockSchema.shape.encoding.unwrap().shape;
    const series = ChartBlockSchema.shape.composition.unwrap().shape.series.element.shape.encoding.shape;
    const composition = ChartBlockSchema.shape.composition.unwrap().shape;

    it("describes each new channel of the quick path by what it plots", () => {
        for (const member of ["color", "size", "low", "high", "facet"]) {
            expect(describedMember(quickPath, member)?.length ?? 0).toBeGreaterThan(40);
        }
        expect(describedMember(quickPath, "color")).toContain("diverging");
        expect(describedMember(quickPath, "size")).toContain("scatter");
        expect(describedMember(quickPath, "low")).toContain("high");
        expect(describedMember(quickPath, "facet")).toContain("12");
    });

    it("describes each new channel of a series and the facet of a composition", () => {
        for (const member of ["color", "size", "low", "high"]) {
            expect(describedMember(series, member)?.length ?? 0).toBeGreaterThan(40);
        }
        expect(describedMember(composition, "facet")?.length ?? 0).toBeGreaterThan(40);
    });

    it("names the channels of each base chart type, and the pie slices by group and value", () => {
        const text = ChartBlockSchema.shape.chartType.description ?? "";
        for (const chartType of ["bar", "line", "scatter", "histogram", "box", "heatmap", "pie", "violin", "stacked-bar", "normalized-bar", "radar"]) {
            expect(text).toContain(`\`${chartType}\``);
        }
        expect(text).toContain("A `pie` reads no `x` and no `y`. Its `group` column names the slices, and its `value` column sizes them.");
        expect(describedMember(quickPath, "group")).toContain("On a `pie` it names the slices.");
        expect(describedMember(quickPath, "value")).toContain("On a `pie` it sizes each slice");
    });

    it("describes the focus, the order members, and the new chart types", () => {
        expect(ChartBlockSchema.shape.focus.description).toContain("category");
        expect(ChartBlockSchema.shape.chartType.description).toContain("violin");
        expect(ChartBlockSchema.shape.chartType.description).toContain("radar");
        const objectForm = ChartBlockSchema.shape.encoding.unwrap().shape.x.unwrap().options[1];
        expect(objectForm.shape.orderBy.description).toContain("column");
        expect(objectForm.shape.order.description).toContain("desc");
    });
});

/** One statistic that binds one cell of the pinned artifact. */
function statistic(label: string, column = "pvalue"): Record<string, unknown> {
    return { label, value: { kind: "artifact-value", path: "runs/run-1/step-a/output/logrank.csv", hash: HASH, locator: { column, row: 0 } } };
}

/** The track of a lollipop: the protein domains of the gene. */
const TRACK = {
    binding: { kind: "artifact-table", path: "runs/run-1/step-a/output/domains.csv", hash: HASH },
    start: "start",
    end: "end",
    label: "domain",
    length: "protein_length",
};

describe("the canonical figures", () => {
    it("takes each of the nine figure presets", () => {
        for (const chartType of ["pca", "embedding", "dotplot", "forest", "roc", "qq", "gsea", "oncoprint", "lollipop"]) {
            expect(parses({ chartType, encoding: { x: "a", y: "b" } })).toBe(true);
        }
    });

    it("takes each of the six new column channels, in either channel form", () => {
        for (const member of ["shape", "p", "censor", "risk", "hit", "metric"]) {
            expect(parses({ chartType: "scatter", encoding: { x: "a", y: "b", [member]: "c" } })).toBe(true);
            expect(parses({ chartType: "scatter", encoding: { x: "a", y: "b", [member]: { column: "c", transform: "neg_log10" } } })).toBe(true);
        }
    });

    it("takes one to four track columns, and refuses an empty list, a fifth column, and an empty name", () => {
        expect(parses({ chartType: "heatmap", encoding: { x: "sample", y: "gene", value: "z", tracks: ["condition"] } })).toBe(true);
        expect(parses({ chartType: "heatmap", encoding: { x: "sample", y: "gene", value: "z", tracks: ["a", "b", "c", "d"] } })).toBe(true);
        expect(parses({ chartType: "heatmap", encoding: { x: "sample", y: "gene", value: "z", tracks: [] } })).toBe(false);
        expect(parses({ chartType: "heatmap", encoding: { x: "sample", y: "gene", value: "z", tracks: ["a", "b", "c", "d", "e"] } })).toBe(false);
        expect(parses({ chartType: "heatmap", encoding: { x: "sample", y: "gene", value: "z", tracks: [""] } })).toBe(false);
    });

    it("takes one to four statistics, and the statistics ride the parsed block", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "km", encoding: { x: "time", y: "survival" }, statistics: [statistic("Log-rank p")] }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.statistics?.[0].label).toBe("Log-rank p");
        const four = [statistic("A"), statistic("B"), statistic("C"), statistic("D")];
        expect(parses({ chartType: "roc", encoding: { x: "fpr", y: "tpr" }, statistics: four })).toBe(true);
    });

    it("refuses five statistics, and an empty list", () => {
        const five = [statistic("A"), statistic("B"), statistic("C"), statistic("D"), statistic("E")];
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "roc", encoding: { x: "fpr", y: "tpr" }, statistics: five }));
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]).toEqual(expect.objectContaining({ code: "too_big", path: ["statistics"] }));
        expect(parses({ chartType: "roc", encoding: { x: "fpr", y: "tpr" }, statistics: [] })).toBe(false);
    });

    it("refuses a statistic that carries a literal value in place of a reference, or no label", () => {
        expect(parses({ chartType: "km", encoding: { x: "t", y: "s" }, statistics: [{ label: "Log-rank p", value: 0.003 }] })).toBe(false);
        expect(parses({ chartType: "km", encoding: { x: "t", y: "s" }, statistics: [{ ...statistic(""), label: "" }] })).toBe(false);
        // A statistic binds one cell, thus a whole table is no statistic.
        expect(parses({ chartType: "km", encoding: { x: "t", y: "s" }, statistics: [{ label: "p", value: BINDING }] })).toBe(false);
    });

    it("takes a track that binds a second table, with or without a length column", () => {
        const parsed = ChartBlockSchema.safeParse(chart({ chartType: "lollipop", encoding: { x: "position", y: "count" }, track: TRACK }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.track?.label).toBe("domain");
        const { length: _length, ...short } = TRACK;
        expect(parses({ chartType: "lollipop", encoding: { x: "position", y: "count" }, track: short })).toBe(true);
    });

    it("refuses a track that names no end column, or that carries a field the grammar does not declare", () => {
        const { end: _end, ...open } = TRACK;
        expect(parses({ chartType: "lollipop", encoding: { x: "position", y: "count" }, track: open })).toBe(false);
        expect(parses({ chartType: "lollipop", encoding: { x: "position", y: "count" }, track: { ...TRACK, rows: [[1, 2]] } })).toBe(false);
    });

    it("names the charts that read each new member in its teaching text", () => {
        const quickPath = ChartBlockSchema.shape.encoding.unwrap().shape;
        const readers: Record<string, string[]> = {
            shape: ["`pca`"],
            p: ["`ma`", "`forest`"],
            censor: ["`km`"],
            risk: ["`km`"],
            hit: ["`gsea`"],
            metric: ["`gsea`"],
            tracks: ["`heatmap`", "`oncoprint`"],
        };
        for (const [member, names] of Object.entries(readers)) {
            const text = (quickPath as Record<string, { description?: string }>)[member]?.description ?? "";
            for (const name of names) expect(text).toContain(name);
        }
        for (const name of ["`km`", "`roc`", "`qq`", "`gsea`"]) expect(ChartBlockSchema.shape.statistics.description).toContain(name);
        expect(ChartBlockSchema.shape.track.description).toContain("`lollipop`");
        for (const preset of ["pca", "embedding", "dotplot", "forest", "roc", "qq", "gsea", "oncoprint", "lollipop"]) {
            expect(ChartBlockSchema.shape.chartType.description).toContain(`\`${preset}\``);
        }
    });
});
