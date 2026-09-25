/**
 * The embedding of cells over excerpts of the PBMC 3k and the Kang 2018 tables.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_INLINE_OPTION_BOUND, CHART_WIDE_PALETTE, SEQUENTIAL_RAMP } from "../design.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import { EMBEDDING_GROUND, EMBEDDING_OPACITY, embeddingPointPx } from "./embedding.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"c".repeat(64)}`;

function block(encoding: Encoding, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "e1", binding: { kind: "artifact-table", path: "cells.csv", hash: HASH }, chartType: "embedding", encoding, ...extra };
}

function asObj(value: unknown): EchartOption {
    return value as EchartOption;
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

/** PBMC 3k cells of three clusters, from the gallery table: the embedding and the LYZ expression. */
const PBMC: ChartRow[] = [
    { cell_id: "AAACATACAACCAC-1", UMAP_1: 1.35285573560809, UMAP_2: 2.26612718696679, cluster: "CD4 T", LYZ: 0.6931472 },
    { cell_id: "AAACATTGATCAGC-1", UMAP_1: 2.165888749165179, UMAP_2: -0.2448122627872643, cluster: "CD4 T", LYZ: 1.0986123 },
    { cell_id: "AAACGCACTGGTAC-1", UMAP_1: 1.9, UMAP_2: 1.1, cluster: "CD4 T", LYZ: 0 },
    { cell_id: "AAACATTGAGCTAC-1", UMAP_1: -0.47802448287846216, UMAP_2: 7.877304234882818, cluster: "B", LYZ: 1.3862944 },
    { cell_id: "AAACTTGAAAAACG-1", UMAP_1: -0.2, UMAP_2: 8.4, cluster: "B", LYZ: 0 },
    { cell_id: "AAACCGTGCTTCCG-1", UMAP_1: -8.69549315663449, UMAP_2: 4.516540904583949, cluster: "CD14 Monocytes", LYZ: 3.218876 },
    { cell_id: "AAAGAGACGGACTT-1", UMAP_1: -8.1, UMAP_2: 3.9, cluster: "CD14 Monocytes", LYZ: 4.1 },
];

describe("the embedding figure", () => {
    const option = deriveChartOption(block({ x: "UMAP_1", y: "UMAP_2", group: "cluster" }), PBMC)._unsafeUnwrap();

    it("hides each axis part, and names the two dimensions in a key at the bottom left corner", () => {
        const xAxis = (option.xAxis as EchartOption[])[0];
        const yAxis = (option.yAxis as EchartOption[])[0];
        for (const axis of [xAxis, yAxis]) {
            expect([asObj(axis.axisLine).show, asObj(axis.axisTick).show, asObj(axis.axisLabel).show, asObj(axis.splitLine).show]).toEqual([
                false,
                false,
                false,
                false,
            ]);
            expect(axis.nameLocation).toBe("start");
        }
        expect([xAxis.name, yAxis.name, yAxis.nameRotate]).toEqual(["UMAP_1 →", "UMAP_2 →", 90]);
    });

    it("gives the two axes one length of data on a square grid", () => {
        const xAxis = (option.xAxis as EchartOption[])[0];
        const yAxis = (option.yAxis as EchartOption[])[0];
        expect((xAxis.max as number) - (xAxis.min as number)).toBeCloseTo((yAxis.max as number) - (yAxis.min as number), 9);
        const grid = (option.grid as EchartOption[])[0];
        expect(grid.width).toBe(grid.height);
    });

    it("sizes each point by the scanpy rule, bounded to 1 to 6 px, with a light opacity", () => {
        expect(embeddingPointPx(2638)).toBe(6);
        expect(embeddingPointPx(20000)).toBe(3.7);
        expect(embeddingPointPx(2_000_000)).toBe(1);
        const cells = seriesOf(option).filter((entry) => entry.silent !== true);
        expect(cells.every((entry) => entry.symbolSize === 6 && asObj(entry.itemStyle).opacity === EMBEDDING_OPACITY)).toBe(true);
    });

    it("names each category on the data at the median of its cells, and draws no legend", () => {
        const names = seriesOf(option).find((entry) => entry.silent === true);
        expect(names?.data).toEqual([
            { value: [1.9, 1.1], name: "CD4 T" },
            { value: [-0.339012241439, 8.13865211744], name: "B" },
            { value: [-8.39774657832, 4.20827045229], name: "CD14 Monocytes" },
        ]);
        expect(asObj(names?.label).formatter).toBe("{b}");
        expect(option.legend).toEqual({ show: false });
    });

    it("takes the wide palette past eight categories", () => {
        const rows: ChartRow[] = Array.from({ length: 9 }, (_row, index) => ({ UMAP_1: index, UMAP_2: index, cluster: `c${index}` }));
        expect(deriveChartOption(block({ x: "UMAP_1", y: "UMAP_2", group: "cluster" }), rows)._unsafeUnwrap().color).toEqual([...CHART_WIDE_PALETTE]);
    });

    it("refuses an embedding that colors by neither channel", () => {
        expect(deriveChartOption(block({ x: "UMAP_1", y: "UMAP_2" }), PBMC)._unsafeUnwrapErr().detail).toBe(
            'The embedding colors its cells by a "group" channel or by a "color" channel. Name one of the two.',
        );
    });
});

describe("the continuous color of an embedding", () => {
    const option = deriveChartOption(block({ x: "UMAP_1", y: "UMAP_2", color: "LYZ" }), PBMC)._unsafeUnwrap();
    const map = (option.visualMap as EchartOption[])[0];

    it("draws a zero in the gray ground and clips the scale at the 99th percentile", () => {
        // The linear 99th percentile of the seven values, between 3.218876 and 4.1.
        const clip = 3.218876 + (4.1 - 3.218876) * 0.94;
        expect(map.min).toBe(0);
        expect(map.max).toBeCloseTo(clip, 9);
        expect(map.range).toEqual([0.6931472, map.max]);
        expect(map.outOfRange).toEqual({ color: EMBEDDING_GROUND });
        expect(map.inRange).toEqual({ color: [...SEQUENTIAL_RAMP] });
        expect(map.calculable).toBe(false);
        expect(asObj(option).visualMap).toBeDefined();
    });

    it("widens the band of the scale to a long scale title, thus the narrowed body never cuts the title", () => {
        const title = "LYZ (log-normalized)";
        const labeled: ChartBlock = {
            ...block({ x: "UMAP_1", y: "UMAP_2", color: "LYZ" }),
            binding: { kind: "artifact-table", path: "cells.csv", hash: HASH, columnLabels: { LYZ: title } },
        };
        const render = deriveChartRender(labeled, PBMC, undefined, { key: "e1", columns: [] })._unsafeUnwrap();
        const scaleLeft = (render.option.visualMap as EchartOption[])[0].left as number;
        const media = render.option.media as EchartOption[];
        // The body takes the width of the chosen rule, and the title of the scale ends inside it.
        const chosen = media
            .filter((rule) => asObj(rule.query).maxWidth === undefined && ((asObj(rule.query).minHeight as number) ?? 0) <= render.bodyPx)
            .pop();
        const left = ((asObj(chosen?.option).visualMap as EchartOption[])[0].left as number) ?? scaleLeft;
        expect(render.widthPx as number).toBeGreaterThanOrEqual(left + title.length * 12 * 0.6);
    });

    it("draws the high values on top", () => {
        const colors = (seriesOf(option)[0].data as unknown[][]).map((item) => item[2]);
        expect(colors).toEqual([0, 0, 0.6931472, 1.0986123, 1.3862944, 3.218876, 4.1]);
    });

    it("keeps the draw order on the page, where a dense embedding reads the payload", () => {
        const columns = ["UMAP_1", "UMAP_2", "ISG15"];
        const rows: ChartRow[] = Array.from({ length: 9000 }, (_row, index) => ({
            UMAP_1: (index % 300) / 10,
            UMAP_2: Math.floor(index / 300) / 10,
            ISG15: (index * 7919) % 13 === 0 ? 0 : ((index * 7919) % 97) / 10,
        }));
        const dense = block({ x: "UMAP_1", y: "UMAP_2", color: "ISG15" });
        const render = deriveChartRender(dense, rows, columns, { key: "k1", columns })._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.series[0].rise).toBe(true);
        const build = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
            payload: { columns: string[]; rows: ChartRow[] },
            descriptor: ChartDataSource["series"][number],
            rule: unknown,
        ) => unknown[];
        const page = build({ columns, rows }, source.series[0], undefined);
        expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[0].data));
    });
});

describe("the facet of an embedding", () => {
    /** Kang 2018 cells of the two conditions, from the gallery table. */
    const KANG: ChartRow[] = [
        { UMAP_1: 8.23633975339041, UMAP_2: 1.5331460651541937, cell_type: "CD14+ Monocytes", condition: "control", ISG15: 0 },
        { UMAP_1: 9.455536072970489, UMAP_2: -1.2639282527779352, cell_type: "CD14+ Monocytes", condition: "control", ISG15: 0 },
        { UMAP_1: -1.686629587887666, UMAP_2: 3.7504578050757633, cell_type: "CD4 T cells", condition: "control", ISG15: 0 },
        { UMAP_1: 8.603572076083282, UMAP_2: 1.3854737099791754, cell_type: "CD14+ Monocytes", condition: "stimulated", ISG15: 1.3671056 },
        { UMAP_1: -2.1, UMAP_2: 4.2, cell_type: "CD4 T cells", condition: "stimulated", ISG15: 2.5 },
    ];
    const option = deriveChartOption(block({ x: "UMAP_1", y: "UMAP_2", color: "ISG15", facet: "condition" }), KANG)._unsafeUnwrap();

    it("draws one square for each condition, with one shared range", () => {
        const grids = option.grid as EchartOption[];
        expect(grids.length).toBe(2);
        expect(grids.every((grid) => grid.width === grids[0].width && grid.height === grid.width)).toBe(true);
        const axes = (option.xAxis as EchartOption[]).slice(0, 2);
        expect(axes[0].min).toBe(axes[1].min);
        expect(axes[0].max).toBe(axes[1].max);
    });

    it("names each panel over its square, and keys the dimensions under the first square alone", () => {
        const names = (option.xAxis as EchartOption[]).filter((axis) => axis.position === "top").map((axis) => [axis.gridIndex, axis.name]);
        expect(names).toEqual([
            [0, "control"],
            [1, "stimulated"],
        ]);
        expect((option.xAxis as EchartOption[])[1].name).toBeUndefined();
    });

    it("draws the zero cells of each panel in the ground", () => {
        const map = (option.visualMap as EchartOption[])[0];
        expect(map.seriesIndex).toEqual([0, 1]);
        expect(map.outOfRange).toEqual({ color: EMBEDDING_GROUND });
    });
});
