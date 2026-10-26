import { describe, expect, it } from "bun:test";

import { isUnknownArray } from "../../../lib/unknown-array.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { categoryCount, kebabFilename, normalizeEchartSpec } from "../normalize-echart-spec.js";

/** The record the spec field holds, or a failed test. */
function recordOf(value: unknown): Record<string, unknown> {
    const parsed = parseUnknownRecord(value);
    if (parsed === undefined) throw new Error("the spec field holds no record");
    return parsed;
}

/** The record array the spec field holds, or a failed test. */
function recordsOf(value: unknown): Record<string, unknown>[] {
    if (!isUnknownArray(value)) throw new Error("the spec field holds no array");
    return value.map((entry) => recordOf(entry));
}

/** A cartesian bar spec with `n` inline categories and `series` series. */
function barSpec(n: number, series = 1): Record<string, unknown> {
    return {
        xAxis: { type: "category", data: Array.from({ length: n }, (_, i) => `cat-${i}`) },
        yAxis: { type: "value" },
        series: Array.from({ length: series }, (_, i) => ({ name: `s${i}`, type: "bar", data: [] })),
    };
}

/** The normalized x-axis label options. */
function axisLabel(spec: Record<string, unknown>): Record<string, unknown> {
    const xAxis = recordOf(spec.xAxis);
    const label = xAxis.axisLabel;
    if (label === undefined) throw new Error("the spec holds no x-axis label");
    return recordOf(label);
}

/** The normalized grid. */
function grid(spec: Record<string, unknown>): Record<string, unknown> {
    return recordOf(spec.grid);
}

/** The normalized `saveAsImage` feature. */
function saveAsImage(spec: Record<string, unknown>): Record<string, unknown> {
    const toolbox = recordOf(spec.toolbox);
    const feature = recordOf(toolbox.feature);
    return recordOf(feature.saveAsImage);
}

describe("normalizeEchartSpec — title", () => {
    it("strips an in-spec title (the show_user title param is the card heading)", () => {
        const out = normalizeEchartSpec({ ...barSpec(3), title: { text: "Gene Expression", subtext: "padj < 0.05" } }, { title: "Gene Expression" });
        expect(out.title).toBeUndefined();
        expect("title" in out).toBe(false);
    });

    it("does not mutate the input spec", () => {
        const input = { ...barSpec(3), title: { text: "Keep me" } };
        const snapshot = structuredClone(input);
        normalizeEchartSpec(input, { title: "Card" });
        expect(input).toEqual(snapshot);
    });
});

describe("normalizeEchartSpec — legend", () => {
    it("hides the legend for a single-series chart", () => {
        const out = normalizeEchartSpec(barSpec(5, 1), {});
        expect(out.legend).toEqual({ show: false });
    });

    it("puts the legend at the bottom for a multi-series chart", () => {
        const out = normalizeEchartSpec(barSpec(5, 3), {});
        expect(out.legend).toEqual({ bottom: 0 });
    });

    it("adds no legend when the spec declares no series", () => {
        const out = normalizeEchartSpec({ xAxis: { type: "category", data: ["a"] }, yAxis: {} }, {});
        expect("legend" in out).toBe(false);
    });

    it("respects an explicit author legend", () => {
        const out = normalizeEchartSpec({ ...barSpec(5, 3), legend: { top: 10, orient: "vertical" } }, {});
        expect(out.legend).toEqual({ top: 10, orient: "vertical" });
    });
});

describe("normalizeEchartSpec — grid", () => {
    it("defaults the grid to 8%/20%/10%/5% for horizontal labels", () => {
        expect(grid(normalizeEchartSpec(barSpec(6), {}))).toEqual({ top: "8%", bottom: "20%", left: "10%", right: "5%" });
    });

    it("raises grid.top to 12% when a graphic annotation shares the canvas", () => {
        const out = normalizeEchartSpec({ ...barSpec(6), graphic: [{ type: "text" }] }, {});
        expect(grid(out).top).toBe("12%");
    });

    it("keeps grid.top at 8% when the graphic list is empty", () => {
        const out = normalizeEchartSpec({ ...barSpec(6), graphic: [] }, {});
        expect(grid(out).top).toBe("8%");
    });

    it("raises grid.bottom to 25% for rotated labels (single series, no bottom legend)", () => {
        expect(grid(normalizeEchartSpec(barSpec(14, 1), {})).bottom).toBe("25%");
    });

    it("raises grid.bottom to 30% for rotated labels above a bottom legend", () => {
        const out = normalizeEchartSpec(barSpec(14, 2), {});
        expect(out.legend).toEqual({ bottom: 0 });
        expect(grid(out).bottom).toBe("30%");
    });

    it("respects an explicit author grid and fills only the keys left unset", () => {
        const out = normalizeEchartSpec({ ...barSpec(30), grid: { bottom: "45%", left: "2%" } }, {});
        expect(grid(out)).toEqual({ bottom: "45%", left: "2%", top: "8%", right: "5%" });
    });

    it("leaves a grid the author sized with width/height alone (a margin could over-constrain it)", () => {
        const out = normalizeEchartSpec({ ...barSpec(6), grid: { width: 400, height: 300 } }, {});
        expect(grid(out)).toEqual({ width: 400, height: 300 });
    });

    it("injects no grid for a non-cartesian chart (a pie has no axes to lay out)", () => {
        const out = normalizeEchartSpec({ series: [{ type: "pie", data: [] }] }, {});
        expect("grid" in out).toBe(false);
    });
});

describe("normalizeEchartSpec — axis labels", () => {
    it("pins axisLabel.interval to 0 on both axes, overriding ECharts' silent label-skipping default", () => {
        const out = normalizeEchartSpec({ ...barSpec(6), xAxis: { type: "category", data: ["a"], axisLabel: { interval: "auto", color: "#333" } } }, {});
        expect(axisLabel(out)).toEqual({ interval: 0, color: "#333" });
        expect(recordOf(out.yAxis).axisLabel).toEqual({ interval: 0 });
    });

    it("leaves <=10 categories horizontal", () => {
        expect(axisLabel(normalizeEchartSpec(barSpec(10), {})).rotate).toBeUndefined();
    });

    it("rotates 11-20 categories by 45 degrees", () => {
        expect(axisLabel(normalizeEchartSpec(barSpec(11), {})).rotate).toBe(45);
        expect(axisLabel(normalizeEchartSpec(barSpec(20), {})).rotate).toBe(45);
    });

    it("rotates >20 categories by 90 degrees", () => {
        expect(axisLabel(normalizeEchartSpec(barSpec(21), {})).rotate).toBe(90);
    });

    it("respects an author-chosen rotation", () => {
        const out = normalizeEchartSpec({ ...barSpec(30), xAxis: { type: "category", data: Array(30).fill("x"), axisLabel: { rotate: 30 } } }, {});
        expect(axisLabel(out).rotate).toBe(30);
        // The authored rotation still drives the grid margin.
        expect(grid(out).bottom).toBe("25%");
    });

    it("normalizes every entry of an array-valued xAxis", () => {
        const out = normalizeEchartSpec({ xAxis: [{ type: "category", data: ["a"] }, { type: "value" }], series: [{ type: "line" }] }, {});
        const axes = recordsOf(out.xAxis);
        expect(axes).toHaveLength(2);
        expect(axes.every((a) => recordOf(a.axisLabel).interval === 0)).toBe(true);
    });

    it("does not rotate y-axis labels (a horizontal bar chart's categories read left-to-right)", () => {
        const out = normalizeEchartSpec({ xAxis: { type: "value" }, yAxis: { type: "category", data: Array(30).fill("g") }, series: [{ type: "bar" }] }, {});
        const y = recordOf(out.yAxis).axisLabel;
        expect(y).toEqual({ interval: 0 });
    });
});

describe("normalizeEchartSpec — category count derivation", () => {
    it("counts inline xAxis.data", () => {
        expect(categoryCount(barSpec(7))).toBe(7);
    });

    it("counts dataset.source rows, discounting an auto-detected header row", () => {
        const spec = {
            dataset: {
                source: [
                    ["gene", "count"],
                    ["TP53", 5],
                    ["EGFR", 3],
                ],
            },
            xAxis: { type: "category" },
            series: [{ type: "bar" }],
        };
        expect(categoryCount(spec)).toBe(2);
    });

    it("counts object-shaped dataset rows without discounting a header", () => {
        const spec = {
            dataset: {
                source: [
                    { gene: "TP53", count: 5 },
                    { gene: "EGFR", count: 3 },
                ],
            },
            xAxis: { type: "category" },
        };
        expect(categoryCount(spec)).toBe(2);
    });

    it("honours an explicit sourceHeader over the auto-detection", () => {
        const spec = {
            dataset: {
                sourceHeader: false,
                source: [
                    ["a", "b"],
                    ["c", "d"],
                ],
            },
            xAxis: { type: "category" },
        };
        expect(categoryCount(spec)).toBe(2);
    });

    it("declines to guess when the series lays the dataset out by row", () => {
        const spec = {
            dataset: {
                source: [
                    ["gene", "TP53", "EGFR"],
                    ["count", 5, 3],
                ],
            },
            xAxis: { type: "category" },
            series: [{ type: "bar", seriesLayoutBy: "row" }],
        };
        expect(categoryCount(spec)).toBeNull();
    });

    it("declines to guess for a CSV-backed spec (rows are not in the spec)", () => {
        expect(categoryCount({ xAxis: { type: "category" }, yAxis: { type: "value" }, series: [{ type: "bar" }] })).toBeNull();
    });
});

describe("normalizeEchartSpec — dataPath-backed spec (no inline rows)", () => {
    // `show_user(dataPath: ...)` charts a CSV the host loads at render time: the spec carries no
    // rows, so the category count is unknowable. The safe layout is the unrotated one.
    const csvBacked = {
        xAxis: { type: "category" },
        yAxis: { type: "value" },
        series: [{ type: "bar", encode: { x: "gene", y: "log2FC" } }],
    };

    it("normalizes safely: no guessed rotation, horizontal-label grid, every other rule applied", () => {
        const out = normalizeEchartSpec(csvBacked, { title: "DE genes" });

        expect(axisLabel(out)).toEqual({ interval: 0 });
        expect(grid(out)).toEqual({ top: "8%", bottom: "20%", left: "10%", right: "5%" });
        expect(out.legend).toEqual({ show: false });
        expect(saveAsImage(out)).toEqual({ type: "png", name: "de-genes" });
    });
});

describe("normalizeEchartSpec — toolbox", () => {
    it("injects a saveAsImage toolbox with a filename derived from the show_user title", () => {
        const out = normalizeEchartSpec(barSpec(4), { title: "HMGCR — VST Expression" });
        expect(out.toolbox).toEqual({
            right: 0,
            top: 0,
            feature: { saveAsImage: { type: "png", name: "hmgcr-vst-expression" } },
        });
    });

    it("falls back to the stripped in-spec title, then to a generic filename", () => {
        const fromSpec = normalizeEchartSpec({ ...barSpec(4), title: { text: "Volcano Plot" } }, {});
        expect(saveAsImage(fromSpec).name).toBe("volcano-plot");

        const fallback = normalizeEchartSpec(barSpec(4), {});
        expect(saveAsImage(fallback).name).toBe("chart");
    });

    it("respects an author-chosen filename and toolbox placement, filling only what is missing", () => {
        const out = normalizeEchartSpec(
            { ...barSpec(4), toolbox: { left: 0, feature: { saveAsImage: { name: "keep-me" }, dataZoom: {} } } },
            { title: "Ignored" },
        );
        const toolbox = recordOf(out.toolbox);
        expect(toolbox.left).toBe(0);
        expect(toolbox.right).toBeUndefined();
        expect(recordOf(toolbox.feature).dataZoom).toEqual({});
        expect(saveAsImage(out)).toEqual({ name: "keep-me", type: "png" });
    });
});

describe("kebabFilename", () => {
    it("folds diacritics, collapses punctuation, and never returns an empty name", () => {
        expect(kebabFilename("Résumé of  Runs!")).toBe("resume-of-runs");
        expect(kebabFilename("...")).toBe("chart");
        expect(kebabFilename(undefined)).toBe("chart");
        expect(kebabFilename("x".repeat(200)).length).toBeLessThanOrEqual(64);
    });

    it("caps the length when a separator sits at the cutoff", () => {
        expect(kebabFilename("a".repeat(63) + " b")).toBe("a".repeat(63));
        expect(kebabFilename("a".repeat(63) + "-b").endsWith("-")).toBe(false);
    });
});

describe("normalizeEchartSpec — invariants", () => {
    const cases: Record<string, Record<string, unknown>> = {
        empty: {},
        pie: { series: [{ type: "pie", data: [{ value: 1, name: "a" }] }] },
        "single-series bar": barSpec(8),
        "dense multi-series": { ...barSpec(30, 3), title: { text: "Dense" }, graphic: [{ type: "text" }] },
        "csv-backed": { xAxis: { type: "category" }, yAxis: {}, series: [{ type: "line" }] },
        "author-configured": {
            ...barSpec(12, 2),
            grid: { bottom: "40%" },
            legend: { top: 0 },
            toolbox: { feature: { saveAsImage: { name: "mine", type: "svg" } } },
        },
        "array axes": { xAxis: [{ type: "category", data: ["a", "b"] }], yAxis: [{ type: "value" }], series: [{ type: "bar" }] },
    };

    for (const [name, spec] of Object.entries(cases)) {
        it(`is idempotent: ${name}`, () => {
            const once = normalizeEchartSpec(spec, { title: "T" });
            const twice = normalizeEchartSpec(once, { title: "T" });
            expect(twice).toEqual(once);
        });

        it(`leaves the input untouched: ${name}`, () => {
            const snapshot = structuredClone(spec);
            normalizeEchartSpec(spec, { title: "T" });
            expect(spec).toEqual(snapshot);
        });
    }
});
