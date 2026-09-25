/**
 * The gate of the figure gallery: the committed tables and their manifest, the document and its resolution,
 * the render, and the canonical elements of each preset on real data.
 *
 * The gallery is the visual proof and the regression set of the canonical figures. Thus the gate holds one
 * chart of each chart type that the contract declares, and a new chart type fails it until the gallery draws
 * the type from a real table.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { appendFile, cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { ChartBlockSchema, type Block, type ChartBlock } from "../../contracts/report-blocks.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import { parseDelimited } from "../../report-model/production-resolver.js";
import { validateReport } from "../../report-model/validate.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_INLINE_OPTION_BOUND } from "../design.js";
import { statisticText } from "../figures/common.js";
import { FIGURE_MODULES, isFigurePresetType } from "../figures/index.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import { renderReportPage } from "../render.js";
import { GALLERY_DIR, GALLERY_DOCUMENT, loadGallery, type GalleryLoad } from "./gallery.js";

/** The bound on the committed bytes of the gallery tables. */
const DATA_BOUND_BYTES = 4 * 1024 * 1024;

/** One entry of the gallery manifest. */
interface ManifestEntry {
    field: string;
    table: string;
    path: string;
    rows: number;
    bytes: number;
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

beforeAll(async () => {
    gallery = (await loadGallery())._unsafeUnwrap();
});

/** The render value of one gallery chart. */
function valueOf(id: string): { rows: ChartRow[]; columns?: string[]; statistics?: { label: string; value: string | number }[]; track?: { rows: ChartRow[] } } {
    const value = gallery.values[id];
    if (value?.type !== "table") throw new Error(`The gallery chart ${id} holds no table.`);
    return value;
}

/** The inline option of one gallery chart, with its statistics and its track. */
function optionOf(id: string): EchartOption {
    const block = CHARTS.find((chart) => chart.id === id);
    if (block === undefined) throw new Error(`The gallery holds no chart ${id}.`);
    const value = valueOf(id);
    return deriveChartOption(block, value.rows, value.columns, { statistics: value.statistics, track: value.track })._unsafeUnwrap();
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

describe("the gallery data", () => {
    let manifest: ManifestEntry[];

    beforeAll(async () => {
        manifest = JSON.parse(await readFile(join(GALLERY_DIR, "manifest.json"), "utf8")) as ManifestEntry[];
    });

    it("names each committed table one time, and no other file", async () => {
        const committed = (await filesUnder(join(GALLERY_DIR, "data"))).sort();
        expect(manifest.map((entry) => entry.path).sort()).toEqual(committed);
    });

    it("states the rows and the bytes of each table as the file holds them", async () => {
        for (const entry of manifest) {
            const bytes = await readFile(join(GALLERY_DIR, entry.path));
            expect({ path: entry.path, bytes: (await stat(join(GALLERY_DIR, entry.path))).size }).toEqual({ path: entry.path, bytes: entry.bytes });
            expect({ path: entry.path, rows: parseDelimited(bytes.toString("utf8"), ",")?.length }).toEqual({ path: entry.path, rows: entry.rows });
        }
    });

    it("keeps the committed tables under the size bound", () => {
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

    it("pins each table that the document binds to the bytes of its file", () => {
        // A statistic binds a cell of a small table, and each binding reads the same snapshot, thus a stale pin
        // fails the load with a hash mismatch and never reaches this point.
        const bound = Object.keys(gallery.snapshot.artifacts).sort();
        expect(bound.length).toBeGreaterThan(0);
        for (const path of bound) expect(manifest.some((entry) => entry.path === path)).toBe(true);
    });
});

describe("the gallery document", () => {
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

    it("holds one chart of each chart type that the contract declares and the renderer draws", () => {
        // The type list reads the contract, thus a new chart form fails this gate until the gallery draws it. A
        // figure preset draws through its module alone, thus it joins the gate when its module registers.
        const declared = [...ChartBlockSchema.shape.chartType.unwrap().options]
            .filter((chartType) => !isFigurePresetType(chartType) || FIGURE_MODULES[chartType] !== undefined)
            .sort();
        const covered = [...new Set(CHARTS.flatMap((chart) => (chart.chartType !== undefined ? [chart.chartType] : [])))].sort();
        expect(covered).toEqual(declared);
    });

    it("holds an interval, a facet, a focus, a continuous color, a statistic, and a track", () => {
        const encodings = CHARTS.flatMap((chart) => (chart.encoding !== undefined ? [chart.encoding] : []));
        expect(encodings.some((encoding) => encoding.low !== undefined && encoding.high !== undefined)).toBe(true);
        expect(encodings.some((encoding) => encoding.facet !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.focus !== undefined)).toBe(true);
        expect(encodings.some((encoding) => encoding.color !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.statistics !== undefined)).toBe(true);
        expect(CHARTS.some((chart) => chart.track !== undefined)).toBe(true);
    });

    it("names the dataset in the caption of each chart", () => {
        for (const chart of CHARTS) expect({ id: chart.id, caption: chart.caption?.startsWith("Data: ") }).toEqual({ id: chart.id, caption: true });
    });
});

describe("the gallery render", () => {
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

describe("the page build of each dense chart", () => {
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
            const inputs = { statistics: value.statistics, track: value.track };
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

describe("the canonical elements of each preset on the gallery data", () => {
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

    it("heatmap: draws a strip for each track over the matrix, in the clustered sample order", () => {
        const option = optionOf("bulk-top-genes");
        expect(seriesOf(option).map((series) => series.name)).toEqual([undefined, "Condition", "Library type"]);
        const order = [...valueOf("bulk-top-genes").rows]
            .sort((a, b) => Number(a.sample_order) - Number(b.sample_order))
            .map((row) => row.sample)
            .filter((sample, index, all) => all.indexOf(sample) === index);
        expect(axisOf(option, "xAxis").data).toEqual(order);
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
        expect(largest.term.startsWith(first.replaceAll("\n", " ").replace(/…$/, ""))).toBe(true);
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
