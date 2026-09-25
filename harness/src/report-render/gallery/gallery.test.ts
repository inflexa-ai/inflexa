/**
 * The gate of the figure gallery: the tables and their manifest, the document and its resolution, the render,
 * and the canonical elements of each preset on real data.
 *
 * The gallery is the visual proof and the regression set of the canonical figures. Thus the gate holds one
 * chart of each chart type that the contract declares, and a new chart type fails it until the gallery draws
 * the type from a real table.
 *
 * The repository does not carry the tables, and `bun run gallery:data` rebuilds them. Each group that reads
 * the tables skips when they are absent, and its name gives that command. The groups that read only the
 * manifest and the document run in each case.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { appendFile, cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { ChartBlockSchema, type Block, type ChartBlock } from "../../contracts/report-blocks.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import { parseDelimited } from "../../report-model/production-resolver.js";
import { walkBlocks } from "../../report-model/block-walk.js";
import { validateReport } from "../../report-model/validate.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_INLINE_OPTION_BOUND } from "../design.js";
import { categoricalPalette, statisticText } from "../figures/common.js";
import { FIGURE_MODULES, isFigurePresetType } from "../figures/index.js";
import { GENE_NAMES, LD_BINS, LD_MISSING_COLOR, LD_MISSING_NAME, LEAD_VARIANT_COLOR, LEAD_VARIANT_NAME, RECOMBINATION_NAME } from "../figures/locuszoom.js";
import { SANKEY_LINK_OPACITY } from "../figures/sankey.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import { renderReportPage } from "../render.js";
import type { RenderTrees } from "../types.js";
import { GALLERY_DATA_HINT, GALLERY_DIR, GALLERY_DOCUMENT, hasGalleryData, loadGallery, type GalleryLoad } from "./gallery.js";

/** The suffix of the name of each group that reads the tables. It names the command that rebuilds absent tables. */
const NEEDS_DATA = hasGalleryData() ? "" : ` (skipped: ${GALLERY_DATA_HINT})`;
const NO_DATA = NEEDS_DATA !== "";

/** The bound on the bytes of the gallery tables. */
const DATA_BOUND_BYTES = 4 * 1024 * 1024;

/** One entry of the gallery manifest. */
interface ManifestEntry {
    field: string;
    table: string;
    path: string;
    rows: number;
    bytes: number;
    sha256: string;
    dataset: { name: string; citation: string };
    license: { name: string; url: string; quote: string };
    source_urls: string[];
    script: string;
    derivation: string;
    thinning: string;
}

/** Every block of a tree, in document order. A section contributes itself and then its children. */
function everyBlock(blocks: readonly Block[]): Block[] {
    return blocks.flatMap((block) => (block.kind === "section" ? [block, ...everyBlock(block.blocks)] : [block]));
}

/** Each chart block of the gallery. */
const CHARTS = everyBlock(GALLERY_DOCUMENT.sections).filter((block): block is ChartBlock => block.kind === "chart");

/** Each file under a directory, as a path relative to the gallery directory. */
async function filesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => relative(GALLERY_DIR, join(entry.parentPath, entry.name)));
}

let gallery: GalleryLoad;
let manifest: ManifestEntry[];

beforeAll(async () => {
    manifest = JSON.parse(await readFile(join(GALLERY_DIR, "manifest.json"), "utf8")) as ManifestEntry[];
    if (!NO_DATA) gallery = (await loadGallery())._unsafeUnwrap();
});

/** The render value of one gallery chart. */
function valueOf(id: string): {
    rows: ChartRow[];
    columns?: string[];
    statistics?: { label: string; value: string | number }[];
    track?: { rows: ChartRow[] };
    trees?: RenderTrees;
} {
    const value = gallery.values[id];
    if (value?.type !== "table") throw new Error(`The gallery chart ${id} holds no table.`);
    return value;
}

/** The inline option of one gallery chart, with its statistics, its track, and its trees. */
function optionOf(id: string): EchartOption {
    const block = CHARTS.find((chart) => chart.id === id);
    if (block === undefined) throw new Error(`The gallery holds no chart ${id}.`);
    const value = valueOf(id);
    return deriveChartOption(block, value.rows, value.columns, { statistics: value.statistics, track: value.track, trees: value.trees })._unsafeUnwrap();
}

/** The resolved value of one statistic of a gallery chart, by its label. */
function statisticOf(id: string, label: string): string | number {
    const statistic = valueOf(id).statistics?.find((entry) => entry.label === label);
    if (statistic === undefined) throw new Error(`The gallery chart ${id} holds no statistic ${label}.`);
    return statistic.value;
}

/** The series of an option, each as a plain record. */
function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

/** One axis of an option: the only axis, or the axis at an index of a list. */
function axisOf(option: EchartOption, key: "xAxis" | "yAxis", index = 0): EchartOption {
    const axis = option[key];
    return (Array.isArray(axis) ? axis[index] : axis) as EchartOption;
}

/** The text of each `text` element of the graphic of an option, children included. */
function graphicTexts(option: EchartOption): string[] {
    const walk = (elements: unknown): string[] =>
        (Array.isArray(elements) ? elements : []).flatMap((element: EchartOption) => [
            ...(element.type === "text" ? [String((element.style as EchartOption).text)] : []),
            ...walk(element.children),
        ]);
    return walk(option.graphic);
}

/** The number of one cell, or `NaN` for an empty cell. Each cell is text, as a CSV gives it. */
function numberOf(cell: ChartRow[string] | undefined): number {
    return cell === undefined || cell === "" ? Number.NaN : Number(cell);
}

/** The count of rows where a predicate over the numeric cells holds. */
function countRows(id: string, predicate: (row: ChartRow) => boolean): number {
    return valueOf(id).rows.filter(predicate).length;
}

/** The distinct values of one column, in the order of another numeric column of the same rows. */
function orderedBy(id: string, column: string, order: string): string[] {
    return [...valueOf(id).rows]
        .sort((a, b) => Number(a[order]) - Number(b[order]))
        .map((row) => String(row[column]))
        .filter((name, index, all) => all.indexOf(name) === index);
}

/** The dendrogram of one axis: the `lines` series whose grid holds the tree of that axis. */
function treeSeries(option: EchartOption, axis: "x" | "y"): EchartOption {
    const trees = seriesOf(option).filter((entry) => entry.type === "lines" && entry.polyline === true);
    // The tree of x runs its leaves along a hidden x axis, and the tree of y runs them along a hidden y axis.
    const found = trees.find((entry) => axisOf(option, axis === "x" ? "xAxis" : "yAxis", entry.xAxisIndex as number).min === -0.5);
    if (found === undefined) throw new Error(`The option holds no tree of ${axis}.`);
    return found;
}

/**
 * The leaf places of one dendrogram, in the order of the tree table: the place along the axis of each elbow
 * that starts at height zero. The tree of y draws the height on x.
 */
function leafPlaces(tree: EchartOption, axis: "x" | "y"): number[] {
    const starts = (tree.data as EchartOption[]).map((edge) => (edge.coords as number[][])[0]);
    return starts.flatMap(([a, b]) => ((axis === "x" ? b : a) === 0 ? [axis === "x" ? a : b] : []));
}

/** The leaf names of one tree table, in the depth-first order from its root, with the children in table order. */
function depthFirstLeaves(rows: readonly ChartRow[]): string[] {
    const children = new Map<string, string[]>();
    const childSet = new Set<string>();
    for (const row of rows) {
        children.set(String(row.parent), [...(children.get(String(row.parent)) ?? []), String(row.child)]);
        childSet.add(String(row.child));
    }
    const root = [...children.keys()].find((node) => !childSet.has(node));
    const walk = (node: string): string[] => (children.has(node) ? (children.get(node) ?? []).flatMap(walk) : [node]);
    return root === undefined ? [] : walk(root);
}

/**
 * The license forms that a caption can name, in the words that the caption uses. The manifest states each license
 * in full, often with a note or a second license of the loader code. The first form in the text of the name is
 * the license of the data. A name that holds no form fails the gate, thus a new license joins this list.
 */
const LICENSE_FORMS: readonly { readonly pattern: RegExp; readonly caption: string }[] = [
    { pattern: /\bLGPL\b/, caption: "LGPL" },
    { pattern: /\bGPL\b/, caption: "GPL" },
    { pattern: /\bCC BY 4\.0\b|Creative Commons Attribution 4\.0/, caption: "CC BY 4.0" },
    { pattern: /\bMIT\b/, caption: "MIT" },
    { pattern: /EBI Terms of Use/, caption: "EBI Terms of Use" },
    { pattern: /public[- ]domain/i, caption: "public domain" },
];

/** The caption form of the license of one table: the form that the name of the license states first. */
function licenseForm(name: string): string | undefined {
    const found = LICENSE_FORMS.flatMap((form) => {
        const at = name.search(form.pattern);
        return at < 0 ? [] : [{ at, caption: form.caption }];
    }).sort((left, right) => left.at - right.at);
    return found[0]?.caption;
}

/** The license of each table that one chart binds and that its caption does not name, as `path: license`. */
function missingLicenses(chart: ChartBlock): string[] {
    const paths = new Set(
        walkBlocks([chart]).references.flatMap(({ reference }) =>
            reference.kind === "artifact-table" || reference.kind === "artifact-value" ? [reference.path] : [],
        ),
    );
    return [...paths].flatMap((path) => {
        const license = manifest.find((entry) => entry.path === path)?.license.name ?? "(no manifest entry)";
        const form = licenseForm(license);
        return form !== undefined && (chart.caption ?? "").includes(form) ? [] : [`${path}: ${license}`];
    });
}

describe("the gallery manifest", () => {
    it("keeps the tables under the size bound", () => {
        const total = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
        expect(total).toBeLessThan(DATA_BOUND_BYTES);
    });

    it("gives each table its dataset, its license with a quote, its sources, its script, its derivation, and its thinning", async () => {
        const scripts = new Set(await filesUnder(join(GALLERY_DIR, "derive")));
        for (const entry of manifest) {
            expect(entry.dataset.citation.length).toBeGreaterThan(0);
            expect(entry.license.name.length).toBeGreaterThan(0);
            expect(entry.license.url).toStartWith("https://");
            expect(entry.license.quote.length).toBeGreaterThan(0);
            expect(entry.source_urls.length).toBeGreaterThan(0);
            expect(entry.derivation.length).toBeGreaterThan(0);
            expect(entry.thinning.length).toBeGreaterThan(0);
            expect(scripts.has(entry.script)).toBe(true);
        }
    });

    it("states the thinning rule of each dense table", () => {
        const thinned = Object.fromEntries(manifest.map((entry) => [entry.table, entry.thinning]));
        expect(thinned.cells_by_condition_umap).toContain("balanced by condition");
        expect(thinned.manhattan).toContain("Keep every variant with p < 0.001");
        expect(thinned.qq).toContain("largest observed -log10 p");
        expect(thinned.gsea_running_score).toContain("every hit rank");
        expect(thinned.de_results).toBe("None. The copy is the whole derived table.");
    });

    it("states the SHA-256 of each table that the document pins, as the pin states it", () => {
        const pins = new Map(
            walkBlocks(GALLERY_DOCUMENT.sections).references.flatMap(({ reference }) =>
                reference.kind === "artifact-table" || reference.kind === "artifact-value" ? [[reference.path, reference.hash] as const] : [],
            ),
        );
        expect(pins.size).toBeGreaterThan(0);
        for (const [path, hash] of pins) {
            expect({ path, hash: `sha256:${manifest.find((entry) => entry.path === path)?.sha256}` }).toEqual({ path, hash });
        }
    });
});

describe.skipIf(NO_DATA)(`the gallery data${NEEDS_DATA}`, () => {
    it("names each table one time, and no other file", async () => {
        const written = (await filesUnder(join(GALLERY_DIR, "data"))).sort();
        expect(manifest.map((entry) => entry.path).sort()).toEqual(written);
    });

    it("states the rows, the bytes, and the SHA-256 of each table as the file holds them", async () => {
        for (const entry of manifest) {
            const bytes = await readFile(join(GALLERY_DIR, entry.path));
            expect({ path: entry.path, bytes: (await stat(join(GALLERY_DIR, entry.path))).size }).toEqual({ path: entry.path, bytes: entry.bytes });
            expect({ path: entry.path, rows: parseDelimited(bytes.toString("utf8"), ",")?.length }).toEqual({ path: entry.path, rows: entry.rows });
            expect({ path: entry.path, sha256: computeSha256(bytes) }).toEqual({ path: entry.path, sha256: `sha256:${entry.sha256}` });
        }
    });

    it("pins each table that the document binds to the bytes of its file", () => {
        // A statistic binds a cell of a small table, and each binding reads the same snapshot, thus a stale pin
        // fails the load with a hash mismatch and never reaches this point.
        const bound = Object.keys(gallery.snapshot.artifacts).sort();
        expect(bound.length).toBeGreaterThan(0);
        for (const path of bound) expect(manifest.some((entry) => entry.path === path)).toBe(true);
    });
});

describe.skipIf(NO_DATA)(`the gallery document on the data${NEEDS_DATA}`, () => {
    it("validates, resolves each reference, and carries no prose warning", async () => {
        expect(await validateReport(GALLERY_DOCUMENT, gallery.snapshot, createFixtureResolver())).toEqual({ valid: true, warnings: [] });
    });

    it("fails the load when a table no longer matches its pin, and names the block and the slot", async () => {
        const dir = await mkdtemp(join(tmpdir(), "gallery-pin-"));
        try {
            await cp(join(GALLERY_DIR, "data"), join(dir, "data"), { recursive: true });
            await appendFile(join(dir, "data/survival/logrank.csv"), "\n");
            const faults = (await loadGallery(dir))._unsafeUnwrapErr();
            expect(
                faults.map((fault) => (fault.kind === "unresolved" ? [fault.failure.blockId, fault.failure.slot, fault.failure.failure.reason] : fault.kind)),
            ).toEqual([["clinical-km", "statistic:0", "hash-mismatch"]]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("the gallery document", () => {
    it("holds one chart of each chart type that the contract declares and the renderer draws", () => {
        // The type list reads the contract, thus a new chart form fails this gate until the gallery draws it. A
        // figure preset draws through its module alone, thus it joins the gate when its module registers.
        const declared = [...ChartBlockSchema.shape.chartType.unwrap().options]
            .filter((chartType) => !isFigurePresetType(chartType) || FIGURE_MODULES[chartType] !== undefined)
            .sort();
        const covered = [...new Set(CHARTS.flatMap((chart) => (chart.chartType !== undefined ? [chart.chartType] : [])))].sort();
        expect(covered).toEqual(declared);
    });

    it("holds an interval, a facet, a focus, a continuous color, a statistic, a track, and a tree", () => {
        const encodings = CHARTS.flatMap((chart) => (chart.encoding !== undefined ? [chart.encoding] : []));
        expect(encodings.some((encoding) => encoding.low !== undefined && encoding.high !== undefined)).toBe(true);
        expect(encodings.some((encoding) => encoding.facet !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.focus !== undefined)).toBe(true);
        expect(encodings.some((encoding) => encoding.color !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.statistics !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.track !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.trees !== undefined)).toBe(true);
    });

    it("names the dataset in the caption of each chart", () => {
        for (const chart of CHARTS) expect({ id: chart.id, caption: chart.caption?.startsWith("Data: ") }).toEqual({ id: chart.id, caption: true });
    });

    it("names in the caption of each chart the license of each table that the chart binds", () => {
        for (const chart of CHARTS) expect({ id: chart.id, missing: missingLicenses(chart) }).toEqual({ id: chart.id, missing: [] });
        // The gate bites: a caption with no license fails it.
        const [first] = CHARTS;
        expect(missingLicenses({ ...first, caption: "Data: a table." }).length).toBeGreaterThan(0);
    });
});

describe.skipIf(NO_DATA)(`the gallery render${NEEDS_DATA}`, () => {
    it("renders each chart with no problem, and two renders give the same bytes", () => {
        const first = renderReportPage(GALLERY_DOCUMENT, gallery.values);
        expect(first.isOk() ? [] : first.error).toEqual([]);
        const second = renderReportPage(GALLERY_DOCUMENT, gallery.values)._unsafeUnwrap();
        const page = first._unsafeUnwrap();
        expect(second.html).toBe(page.html);
        expect(second.dataAssets).toEqual(page.dataAssets);
        for (const chart of CHARTS) expect(page.html).toContain(`data-echarts-id="${chart.id}"`);
    });
});

describe.skipIf(NO_DATA)(`the page build of each dense chart${NEEDS_DATA}`, () => {
    const seriesDataOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
        payload: { columns: readonly string[]; rows: readonly ChartRow[] },
        source: ChartDataSource["series"][number],
        rule: unknown,
    ) => unknown[];

    /** The largest count of copies of a table that the dense form of a small chart reads. */
    const COPY_LIMIT = 400;

    it("builds on the page the series of the inline option, where a chart reads the payload", () => {
        const built: string[] = [];
        for (const block of CHARTS) {
            const value = valueOf(block.id);
            const columns = value.columns ?? Object.keys(value.rows[0] ?? {});
            const inputs = { statistics: value.statistics, track: value.track, trees: value.trees };
            const target = { key: block.id, columns };
            const first = deriveChartRender(block, value.rows, value.columns, target, inputs)._unsafeUnwrap();
            // A small table repeats its rows until the inline option passes the bound, thus each figure meets
            // the payload path. A figure that refuses a repeated row has no dense form.
            const size = JSON.stringify(first.inline).length;
            const copies = size > CHART_INLINE_OPTION_BOUND ? 1 : Math.min(COPY_LIMIT, Math.ceil((2 * CHART_INLINE_OPTION_BOUND) / Math.max(size, 1)));
            const rows = Array.from({ length: copies }, () => value.rows).flat();
            const render = deriveChartRender(block, rows, value.columns, target, inputs);
            if (render.isErr() || !render.value.readsPayload) continue;
            built.push(block.id);
            const source = render.value.option[CHART_SOURCE_MEMBER] as ChartDataSource;
            const inline = seriesOf(render.value.inline);
            for (const [index, entry] of source.series.entries()) {
                const page = seriesDataOnThePage({ columns, rows }, entry, source.rule);
                expect({ chart: block.id, series: index, data: JSON.stringify(page) }).toEqual({
                    chart: block.id,
                    series: index,
                    data: JSON.stringify(inline[index].data),
                });
            }
        }
        expect(built).toContain("bulk-volcano");
    });
});

describe.skipIf(NO_DATA)(`the canonical elements of each preset on the gallery data${NEEDS_DATA}`, () => {
    it("volcano: names each side with its count and holds a symmetric effect axis", () => {
        const option = optionOf("bulk-volcano");
        // A gene with no adjusted p drops, thus an empty cell is never significant.
        const significant = (row: ChartRow): boolean => numberOf(row.padj) < 0.05 && Math.abs(numberOf(row.log2FoldChange)) > 1;
        const down = countRows("bulk-volcano", (row) => significant(row) && Number(row.log2FoldChange) < 0);
        const up = countRows("bulk-volcano", (row) => significant(row) && Number(row.log2FoldChange) > 0);
        const names = seriesOf(option).map((series) => series.name);
        expect(names.slice(0, 2)).toEqual([`Down (${down})`, `Up (${up})`]);
        expect(String(names[2])).toMatch(/^Not significant \([\d,]+\)$/);
        expect(axisOf(option, "xAxis").min).toBe(-(axisOf(option, "xAxis").max as number));
    });

    it("ma: draws the mean on a log axis, the significant genes apart, and a line at zero", () => {
        const option = optionOf("bulk-ma");
        expect(axisOf(option, "xAxis").type).toBe("log");
        const significant = seriesOf(option)[0];
        expect(significant.name).toBe("Adjusted p-value < 0.05");
        expect((significant.data as unknown[]).length).toBe(countRows("bulk-ma", (row) => numberOf(row.padj) < 0.05));
        expect(((significant.markLine as EchartOption).data as EchartOption[])[0].yAxis).toBe(0);
        expect(axisOf(option, "yAxis").min).toBe(-(axisOf(option, "yAxis").max as number));
    });

    it("pca: sets the symbol by the shape channel, labels each sample, and shares one range on both axes", () => {
        const option = optionOf("bulk-pca");
        const legend = (option.legend as EchartOption).data as EchartOption[];
        expect(legend.find((entry) => entry.name === "paired-end")?.icon).toBe("triangle");
        const labeled = seriesOf(option).flatMap((series) =>
            (series.label as EchartOption | undefined)?.show === true ? (series.data as EchartOption[]) : [],
        );
        expect(labeled.map((point) => point.name).sort()).toEqual(
            valueOf("bulk-pca")
                .rows.map((row) => String(row.sample))
                .sort(),
        );
        expect([axisOf(option, "xAxis").min, axisOf(option, "xAxis").max]).toEqual([axisOf(option, "yAxis").min, axisOf(option, "yAxis").max]);
    });

    it("heatmap: draws a strip for each track and a dendrogram on each axis, in the leaf order of the clustering", () => {
        const option = optionOf("bulk-top-genes");
        const trees = valueOf("bulk-top-genes").trees;
        expect(seriesOf(option).map((series) => [series.type, series.name])).toEqual([
            ["heatmap", undefined],
            ["heatmap", "Condition"],
            ["heatmap", "Library type"],
            ["lines", undefined],
            ["lines", undefined],
        ]);
        // The run wrote the leaf order of its clustering beside the matrix, and the trees give the same order.
        const samples = orderedBy("bulk-top-genes", "sample", "sample_order");
        const genes = orderedBy("bulk-top-genes", "gene_symbol", "gene_order");
        expect(axisOf(option, "xAxis").data).toEqual(samples);
        expect(axisOf(option, "yAxis").data).toEqual(genes);
        expect(depthFirstLeaves(trees?.x?.rows ?? [])).toEqual(samples);
        expect(depthFirstLeaves(trees?.y?.rows ?? [])).toEqual(genes);
        // Each edge draws one elbow, and each leaf sits at its own place under its column or beside its row.
        const xTree = treeSeries(option, "x");
        const yTree = treeSeries(option, "y");
        expect((xTree.data as unknown[]).length).toBe(trees?.x?.rows.length);
        expect((yTree.data as unknown[]).length).toBe(trees?.y?.rows.length);
        expect(leafPlaces(xTree, "x").sort((a, b) => a - b)).toEqual(samples.map((_name, place) => place));
        expect(leafPlaces(yTree, "y").sort((a, b) => a - b)).toEqual(genes.map((_name, place) => place));
    });

    it("heatmap: draws one sample tree on both axes of the distance matrix, in the order of the clustering", () => {
        const option = optionOf("bulk-distances");
        const trees = valueOf("bulk-distances").trees;
        const rows = orderedBy("bulk-distances", "sample_a", "row_order");
        expect(orderedBy("bulk-distances", "sample_b", "col_order")).toEqual(rows);
        expect(axisOf(option, "xAxis").data).toEqual(rows);
        expect(axisOf(option, "yAxis").data).toEqual(rows);
        expect(trees?.x?.rows).toEqual(trees?.y?.rows);
        expect(depthFirstLeaves(trees?.x?.rows ?? [])).toEqual(rows);
        for (const axis of ["x", "y"] as const) {
            const tree = treeSeries(option, axis);
            expect((tree.data as unknown[]).length).toBe(trees?.[axis]?.rows.length);
            expect(leafPlaces(tree, axis).sort((a, b) => a - b)).toEqual(rows.map((_name, place) => place));
        }
    });

    it("embedding: hides the axes, names each cluster on the data, and draws no legend", () => {
        const option = optionOf("single-cell-clusters");
        expect((axisOf(option, "xAxis").axisLabel as EchartOption).show).toBe(false);
        expect(axisOf(option, "xAxis").name).toBe("UMAP 1 →");
        expect((option.legend as EchartOption).show).toBe(false);
        const names = seriesOf(option).find((series) => series.name === "Category names");
        expect(((names?.data ?? []) as EchartOption[]).map((point) => point.name).sort()).toEqual(
            [...new Set(valueOf("single-cell-clusters").rows.map((row) => String(row.cluster)))].sort(),
        );
    });

    it("embedding: draws one panel for each condition under one continuous color scale", () => {
        const option = optionOf("single-cell-isg15");
        expect((option.grid as EchartOption[]).length).toBe(2);
        expect(seriesOf(option).map((series) => (series.data as unknown[]).length)).toEqual([3000, 3000]);
        expect(option.visualMap).toBeDefined();
    });

    it("dotplot: draws a size legend of three reference circles and orders the sets by the gene ratio", () => {
        const option = optionOf("enrichment-ora");
        const texts = graphicTexts(option);
        expect(texts[0]).toBe("Genes in the set");
        expect(texts.length).toBe(4);
        const rows = valueOf("enrichment-ora").rows;
        const largest = rows.reduce((best, row) => (Number(row.gene_ratio) > Number(best.gene_ratio) ? row : best));
        // A long term wraps to two lines and ends with an ellipsis, thus the first category reads the head of the term.
        const first = String((axisOf(option, "yAxis").data as unknown[])[0]);
        expect(String(largest.term).startsWith(first.replaceAll("\n", " ").replace(/…$/, ""))).toBe(true);
        expect(option.visualMap).toBeDefined();
    });

    it("km: draws step curves, a censor mark at each censored row, the number at risk, the median, and the log-rank p", () => {
        const option = optionOf("clinical-km");
        const series = seriesOf(option);
        expect(series.filter((entry) => entry.type === "line" && entry.name !== undefined).every((entry) => entry.step === "end")).toBe(true);
        for (const group of ["Female", "Male"]) {
            const marks = series.find((entry) => entry.type === "scatter" && entry.name === group);
            expect((marks?.data as unknown[]).length).toBe(countRows("clinical-km", (row) => row.strata === group && Number(row.n_censor) > 0));
        }
        const risk = series.filter((entry) => entry.xAxisIndex === 1).map((entry) => (entry.data as EchartOption[]).map((cell) => cell.name));
        expect(risk).toEqual([
            ["90", "53", "21", "3", "0"],
            ["138", "62", "20", "7", "2"],
        ]);
        expect(JSON.stringify(series.find((entry) => entry.markLine !== undefined)?.markLine)).toContain('"coord":[0,0.5]');
        const logrank = statisticOf("clinical-km", "Log-rank p");
        expect(graphicTexts(option)).toEqual([`Log-rank p = ${statisticText(logrank, "pvalue")}`, "Number at risk"]);
        expect(Number(logrank)).toBeCloseTo(0.00131116, 8);
    });

    it("forest: draws the ratio on a log axis around a solid line at one, with the estimate and the p columns", () => {
        const option = optionOf("clinical-forest");
        expect(axisOf(option, "xAxis").type).toBe("log");
        expect((seriesOf(option)[0].markLine as EchartOption).data).toEqual([{ xAxis: 1 }]);
        expect(axisOf(option, "yAxis", 1).data).toContain("0.53 (0.38–0.75)");
        const sex = valueOf("clinical-forest").rows.find((row) => row.term === "Female vs male");
        expect(axisOf(option, "yAxis", 2).data).toContain(statisticText(sex?.pvalue ?? "", "pvalue"));
    });

    it("roc: draws the chance diagonal on two unit axes and prints one AUC for each model", () => {
        const option = optionOf("clinical-roc");
        expect([axisOf(option, "xAxis").min, axisOf(option, "xAxis").max, axisOf(option, "yAxis").min, axisOf(option, "yAxis").max]).toEqual([0, 1, 0, 1]);
        expect(JSON.stringify(seriesOf(option).find((entry) => entry.markLine !== undefined)?.markLine)).toContain('[{"coord":[0,0]},{"coord":[1,1]}]');
        const names = seriesOf(option).flatMap((entry) => ((entry.data as EchartOption[] | undefined) ?? []).map((item) => item?.name));
        expect(names).toContain("AUC, ECOG + Karnofsky + age = 0.627\nAUC, ECOG alone = 0.619");
        expect(valueOf("clinical-roc").statistics?.map((statistic) => statistic.value)).toEqual(["0.626761473820297", "0.619166666666667"]);
    });

    it("manhattan: alternates the chromosomes, names them under the points, and marks the two thresholds", () => {
        const option = optionOf("gwas-manhattan");
        const series = seriesOf(option);
        const chromosomes = [...new Set(valueOf("gwas-manhattan").rows.map((row) => String(row.chrom)))];
        expect(series.slice(0, chromosomes.length).map((entry) => entry.name)).toEqual(chromosomes);
        const lines = (series[0].markLine as EchartOption).data as EchartOption[];
        expect(lines.map((line) => line.yAxis)).toEqual([-Math.log10(5e-8), 5]);
        expect(series.some((entry) => entry.name === "Chromosome names")).toBe(true);
    });

    it("qq: draws the null band, the identity line to the largest expected value, and the inflation factor", () => {
        const option = optionOf("gwas-qq");
        const series = seriesOf(option);
        expect(series.filter((entry) => entry.name === "Null band").length).toBe(2);
        const largest = Math.max(...valueOf("gwas-qq").rows.map((row) => Number(row.expected_neg_log10_p)));
        expect(JSON.stringify(series[0].markLine)).toContain(`[{"coord":[0,0]},{"coord":[${largest},${largest}]}]`);
        expect(graphicTexts(option)).toEqual(["λ = 1.11"]);
        expect(statisticOf("gwas-qq", "λ")).toBe("1.11162");
    });

    it("gsea: prints the enrichment statistics over the running score, the hit ticks, and the ranked metric", () => {
        const option = optionOf("enrichment-gsea");
        expect((option.grid as unknown[]).length).toBe(3);
        const hits = countRows("enrichment-gsea", (row) => row.hit === "1");
        const names = seriesOf(option).map((entry) => entry.name);
        expect(names.at(-1)).toBe("Wald statistic");
        expect(graphicTexts(option)[0]).toContain("NES, cell-cell junction assembly = 2.22");
        expect(graphicTexts(option)[0]).toContain(
            `FDR, apical junction assembly = ${statisticText(statisticOf("enrichment-gsea", "FDR, apical junction assembly"), "fdr")}`,
        );
        expect(hits).toBeGreaterThan(0);
    });

    it("oncoprint: draws a glyph in each cell of the matrix, the count bar, and the share of each gene", () => {
        const option = optionOf("mutations-oncoprint");
        const series = seriesOf(option);
        const genes = new Set(valueOf("mutations-oncoprint").rows.map((row) => row.gene)).size;
        const samples = new Set(valueOf("mutations-oncoprint").rows.map((row) => row.sample)).size;
        expect(series[0].renderItem).toBe("cell-glyph");
        expect((series[0].data as unknown[]).length).toBe(genes * samples);
        expect(series.some((entry) => entry.type === "bar" && entry.name === "Missense Mutation")).toBe(true);
        const share = series.at(-1) as EchartOption;
        expect(((share.data as EchartOption[])[0].label as EchartOption).formatter).toBe("27%");
    });

    it("lollipop: draws each mutation as a stem, ends the axis at the protein length, and labels the hotspot", () => {
        const option = optionOf("mutations-dnmt3a");
        const series = seriesOf(option);
        expect(series.filter((entry) => entry.type === "custom").every((entry) => entry.renderItem === "stem")).toBe(true);
        expect(axisOf(option, "xAxis").max).toBe(912);
        const labels = series.find((entry) => entry.type === "scatter" && (entry.label as EchartOption | undefined)?.show === true);
        expect(((labels?.data ?? []) as EchartOption[]).map((point) => point.name)).toEqual(["p.R882H", "p.R882C", "p.R736H"]);
    });

    it("upset: counts each exact combination of the mutated genes one time, and sorts the intersections and the sets by size", () => {
        const option = optionOf("mutations-upset");
        const rows = valueOf("mutations-upset").rows;
        const genesOf = new Map<string, string[]>();
        for (const row of rows) genesOf.set(String(row.sample), [...(genesOf.get(String(row.sample)) ?? []), String(row.gene)]);
        const setSizes = new Map<string, number>();
        for (const row of rows) setSizes.set(String(row.gene), (setSizes.get(String(row.gene)) ?? 0) + 1);
        const sets = [...setSizes.entries()].sort((a, b) => b[1] - a[1]).map(([gene]) => gene);
        const combinations = new Map<string, number>();
        for (const genes of genesOf.values()) {
            const key = [...genes].sort((a, b) => sets.indexOf(a) - sets.indexOf(b)).join(" & ");
            combinations.set(key, (combinations.get(key) ?? 0) + 1);
        }
        const series = seriesOf(option);
        const bars = series.find((entry) => entry.id === "intersections") as EchartOption;
        const sizes = bars.data as number[];
        const names = axisOf(option, "xAxis", bars.xAxisIndex as number).data as string[];
        // Each tumor counts in one intersection alone, thus the bars sum to the tumors of the table.
        expect(sizes.length).toBe(combinations.size);
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(genesOf.size);
        expect(names.map((name) => combinations.get(name))).toEqual(sizes);
        // The intersections sort by size, then by degree.
        for (let place = 1; place < sizes.length; place += 1) {
            const degree = (name: string): number => name.split(" & ").length;
            expect(sizes[place] < sizes[place - 1] || (sizes[place] === sizes[place - 1] && degree(names[place]) >= degree(names[place - 1]))).toBe(true);
        }
        expect(names.slice(0, 5)).toEqual(["FLT3", "IDH2", "DNMT3A", "TET2", "FLT3 & NPM1"]);
        expect(sizes.slice(0, 5)).toEqual([22, 13, 9, 9, 8]);
        // The sets sort by size, the largest at the top of the matrix.
        const setBars = series.find((entry) => entry.id === "sets") as EchartOption;
        expect(axisOf(option, "yAxis", setBars.yAxisIndex as number).data).toEqual(sets);
        expect(setBars.data).toEqual(sets.map((gene) => setSizes.get(gene)));
        // Each intersection draws, thus the matrix states no hidden count.
        expect(axisOf(option, "xAxis", (series.find((entry) => entry.id === "members") as EchartOption).xAxisIndex as number).name).toBeUndefined();
    });

    it("sankey: keeps the node order of the table in three stages, and colors each stage from the start of the palette", () => {
        const option = optionOf("mutations-sankey");
        const [sankey] = seriesOf(option);
        const rows = valueOf("mutations-sankey").rows;
        const nodes = sankey.data as EchartOption[];
        expect(nodes.map((node) => node.name)).toEqual(
            rows.flatMap((row) => [String(row.source), String(row.target)]).filter((name, index, all) => all.indexOf(name) === index),
        );
        expect(sankey.layoutIterations).toBe(0);
        const stages = [
            ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "FAB unknown"],
            ["FLT3 mutated", "FLT3 wild type"],
            ["Alive", "Deceased"],
        ];
        for (const [depth, members] of stages.entries()) {
            const palette = categoricalPalette(members.length);
            const drawn = nodes.filter((node) => node.depth === depth);
            expect(drawn.map((node) => node.name)).toEqual(members);
            expect(drawn.map((node) => (node.itemStyle as EchartOption).color)).toEqual(members.map((_name, place) => palette[place % palette.length]));
        }
        // Each flow takes the color of its source, and the last stage puts its labels at the left of its nodes.
        expect(sankey.lineStyle).toEqual({ color: "source", opacity: SANKEY_LINK_OPACITY });
        expect((sankey.links as EchartOption[]).map((link) => [link.source, link.target, link.value])).toEqual(
            rows.map((row) => [String(row.source), String(row.target), Number(row.value)]),
        );
        expect(nodes.filter((node) => (node.label as EchartOption).position === "left").map((node) => node.name)).toEqual(["Alive", "Deceased"]);
        expect(sankey.name).toBe("Patients");
    });

    it("locuszoom: bins the r², marks the lead variant, draws the recombination axis, and lays the genes in lanes", () => {
        const option = optionOf("gwas-locuszoom");
        const series = seriesOf(option);
        const rows = valueOf("gwas-locuszoom").rows;
        // The legend states the five LocusZoom bins, highest first, and the gray of a missing r².
        const pieces = ((option.visualMap as EchartOption[])[0].pieces as EchartOption[]).map((piece) => [piece.label, piece.color]);
        expect(pieces).toEqual([...[...LD_BINS].reverse().map((bin) => [`${bin.low}–${bin.high}`, bin.color]), [LD_MISSING_NAME, LD_MISSING_COLOR]]);
        const missing = series.find((entry) => entry.name === LD_MISSING_NAME);
        expect((missing?.data as unknown[]).length).toBe(rows.filter((row) => row.r2 === "").length);
        // The lead variant is the row of the smallest p, a purple diamond with its name.
        const lead = rows.reduce((best, row) => (Number(row.pvalue) < Number(best.pvalue) ? row : best));
        const diamond = series.find((entry) => entry.name === LEAD_VARIANT_NAME) as EchartOption;
        expect([diamond.symbol, (diamond.itemStyle as EchartOption).color]).toEqual(["diamond", LEAD_VARIANT_COLOR]);
        expect((diamond.data as EchartOption[]).map((point) => point.name)).toEqual([String(lead.variant)]);
        expect(lead.variant).toBe("rs1421085");
        // The recombination rate draws on a right axis in cM/Mb, and the position axis reads in megabases.
        const rate = series.find((entry) => entry.name === RECOMBINATION_NAME) as EchartOption;
        const rateAxis = axisOf(option, "yAxis", rate.yAxisIndex as number);
        expect([rateAxis.position, rateAxis.name]).toEqual(["right", "Recombination rate (cM/Mb)"]);
        expect(axisOf(option, "xAxis").name).toBe("Position on chr16 (Mb)");
        // The genes draw in the order of their starts, and two genes of one lane never overlap.
        const genes = series.find((entry) => entry.name === GENE_NAMES) as EchartOption;
        const placed = (genes.data as EchartOption[]).map((gene) => ({ name: String(gene.name), lane: (gene.value as number[])[1] }));
        expect(placed.map((gene) => gene.name)).toEqual(["RBL2", "AKTIP", "RPGRIP1L", "FTO"]);
        const spans = new Map((valueOf("gwas-locuszoom").track?.rows ?? []).map((row) => [String(row.gene), [Number(row.start), Number(row.end)]]));
        for (const [place, gene] of placed.entries()) {
            for (const other of placed.slice(place + 1).filter((entry) => entry.lane === gene.lane)) {
                const [start, end] = spans.get(gene.name) ?? [0, 0];
                const [otherStart, otherEnd] = spans.get(other.name) ?? [0, 0];
                expect({ genes: [gene.name, other.name], overlap: start < otherEnd && otherStart < end }).toEqual({
                    genes: [gene.name, other.name],
                    overlap: false,
                });
            }
        }
        // AKTIP starts inside RBL2, and FTO starts at the end of RPGRIP1L, thus each of them takes the second lane.
        expect(placed.map((gene) => gene.lane)).toEqual([0.25, 1.25, 0.25, 1.25]);
    });

    it("violin: draws each outline and each interval through the registered renderers", () => {
        const option = optionOf("single-cell-qc-mito");
        expect(seriesOf(option).map((entry) => entry.renderItem)).toEqual(["outline", "interval"]);
    });

    it("stacked forms: draw one panel for each condition", () => {
        for (const id of ["single-cell-composition", "single-cell-counts"]) {
            const option = optionOf(id);
            expect(graphicTexts(option).slice(0, 2)).toEqual(["control", "stimulated"]);
            expect((option.xAxis as unknown[]).length).toBe(2);
        }
    });
});
