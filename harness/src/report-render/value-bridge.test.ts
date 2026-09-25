import { describe, expect, it } from "bun:test";

import type { Block } from "../contracts/report-blocks.js";
import type { ChartSlot } from "../report-model/block-walk.js";
import type { ResolvedValue } from "../report-model/reference-resolver.js";
import { bridgeValues, collectResolutions, type BlockResolution, type FigureSourcePolicy } from "./value-bridge.js";

/** A figure policy that names the source from the pin, thus a test reads the echo that reached the policy. */
const stageAsset: FigureSourcePolicy = (file) => `assets/${file.hash}.png`;

describe("bridgeValues mappings", () => {
    it("maps a resolved scalar onto a metric value", () => {
        const resolutions: BlockResolution[] = [{ blockId: "met", kind: "metric", resolved: { type: "scalar", value: 0.0123 } }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values.met).toEqual({ type: "scalar", value: 0.0123 });
    });

    it("maps resolved rows onto a table value with no explicit columns", () => {
        const rows = [
            { gene: "TP53", padj: 0.01 },
            { gene: "MYC", padj: 0.02 },
        ];
        const resolutions: BlockResolution[] = [{ blockId: "tbl", kind: "table", resolved: { type: "table", rows } }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values.tbl).toEqual({ type: "table", rows });
        // The order stays absent, thus the renderer keeps its first-row order.
        expect(values.tbl).not.toHaveProperty("columns");
    });

    it("maps resolved rows onto a table value with the explicit column order", () => {
        const rows = [{ gene: "TP53", padj: 0.01 }];
        const columns = ["padj", "gene"];
        const resolutions: BlockResolution[] = [{ blockId: "tbl", kind: "table", resolved: { type: "table", rows, columns } }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values.tbl).toEqual({ type: "table", rows, columns });
    });

    it("carries the pre-bound total of a bounded table onto the render value", () => {
        const rows = [{ gene: "TP53", padj: 0.01 }];
        const resolutions: BlockResolution[] = [{ blockId: "tbl", kind: "table", resolved: { type: "table", rows, total: 14201 } }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        // The resolution is the one step that reads the whole artifact, thus the renderer takes the count
        // and never counts again.
        expect(values.tbl).toEqual({ type: "table", rows, total: 14201 });
    });

    it("maps a resolved table onto a chart value, the same as a table", () => {
        const rows = [
            { day: "Mon", count: 5 },
            { day: "Tue", count: 7 },
        ];
        const resolutions: BlockResolution[] = [{ blockId: "cht", kind: "chart", resolved: { type: "table", rows } }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values.cht).toEqual({ type: "table", rows });
    });

    it("maps a resolved file echo onto a figure source through the policy", () => {
        const resolutions: BlockResolution[] = [{ blockId: "fig", kind: "figure", resolved: { type: "file", path: "runs/r1/plot.png", hash: "sha256:abc" } }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        // The figure carries the policy result as its `src`, thus the bridge holds no policy of its own.
        expect(values.fig).toEqual({ type: "figure", src: "assets/sha256:abc.png" });
    });
});

describe("bridgeValues no-value kinds", () => {
    it("adds no entry for a citation kind", () => {
        const resolutions: BlockResolution[] = [{ blockId: "cit", kind: "citation" }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values).toEqual({});
    });

    it("adds no entry for a text kind", () => {
        const resolutions: BlockResolution[] = [{ blockId: "txt", kind: "text" }];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values).toEqual({});
    });
});

describe("bridgeValues mismatch refusal", () => {
    it("refuses a table block whose reference resolved to a scalar", () => {
        const resolutions: BlockResolution[] = [{ blockId: "tbl", kind: "table", resolved: { type: "scalar", value: 1 } }];
        const mismatches = bridgeValues(resolutions, stageAsset)._unsafeUnwrapErr();
        expect(mismatches).toEqual([{ blockId: "tbl", blockKind: "table", expected: "table", actual: "scalar" }]);
    });

    it("collects every mismatch and does not stop at the first", () => {
        const resolutions: BlockResolution[] = [
            { blockId: "met", kind: "metric", resolved: { type: "table", rows: [] } },
            { blockId: "fig", kind: "figure", resolved: { type: "scalar", value: 2 } },
        ];
        const mismatches = bridgeValues(resolutions, stageAsset)._unsafeUnwrapErr();
        expect(mismatches).toHaveLength(2);
        const ids = mismatches.map((entry) => entry.blockId);
        expect(ids).toContain("met");
        expect(ids).toContain("fig");
    });
});

describe("bridgeValues chart slots", () => {
    const rows = [{ time: 1, survival: 0.9 }];
    const domains = [{ start: 1, end: 90, domain: "PWWP" }];

    it("maps the track and each statistic of a chart onto its value, in block order", () => {
        const resolutions: BlockResolution[] = [
            {
                blockId: "cht",
                kind: "chart",
                resolved: { type: "table", rows },
                track: { type: "table", rows: domains, columns: ["start", "end", "domain"] },
                statistics: [
                    { label: "Log-rank p", resolved: { type: "scalar", value: 0.0013 } },
                    { label: "HR", resolved: { type: "scalar", value: "0.53" } },
                ],
            },
        ];
        const values = bridgeValues(resolutions, stageAsset)._unsafeUnwrap();
        expect(values.cht).toEqual({
            type: "table",
            rows,
            statistics: [
                { label: "Log-rank p", value: 0.0013 },
                { label: "HR", value: "0.53" },
            ],
            track: { rows: domains, columns: ["start", "end", "domain"] },
        });
    });

    it("refuses a statistic that resolved to a table and a track that resolved to a scalar, and names each slot", () => {
        const resolutions: BlockResolution[] = [
            {
                blockId: "cht",
                kind: "chart",
                resolved: { type: "table", rows },
                track: { type: "scalar", value: 3 },
                statistics: [
                    { label: "p", resolved: { type: "scalar", value: 0.01 } },
                    { label: "AUC", resolved: { type: "table", rows: [] } },
                ],
            },
        ];
        const mismatches = bridgeValues(resolutions, stageAsset)._unsafeUnwrapErr();
        expect(mismatches).toEqual([
            { blockId: "cht", blockKind: "chart", slot: "track", expected: "table", actual: "scalar" },
            { blockId: "cht", blockKind: "chart", slot: "statistic:1", expected: "scalar", actual: "table" },
        ]);
    });
});

describe("bridgeValues chart trees", () => {
    const rows = [{ sample: "s1", gene: "g1", z: 0.4 }];
    const geneTree = [{ parent: "n1", child: "g1", height: 0.8 }];
    const sampleTree = [{ parent: "m1", child: "s1", height: 1.2 }];
    const HASH = `sha256:${"a".repeat(64)}`;
    const tree = (path: string) => ({ binding: { kind: "artifact-table" as const, path, hash: HASH }, parent: "parent", child: "child", height: "height" });

    it("pairs each resolved tree with its axis, and maps the tree tables onto the chart value", () => {
        const block: Block = {
            kind: "chart",
            id: "hm",
            binding: { kind: "artifact-table", path: "z.csv", hash: HASH },
            chartType: "heatmap",
            encoding: { x: "sample", y: "gene", value: "z" },
            trees: { x: tree("sample_tree.csv"), y: tree("gene_tree.csv") },
        };
        const slots = new Map<ChartSlot, ResolvedValue>([
            ["tree:x", { type: "table", rows: sampleTree }],
            ["tree:y", { type: "table", rows: geneTree, columns: ["parent", "child", "height"] }],
        ]);
        const resolutions = collectResolutions([block], new Map([["hm", { type: "table", rows }]]), new Map([["hm", slots]]));
        expect(resolutions).toEqual([
            {
                blockId: "hm",
                kind: "chart",
                resolved: { type: "table", rows },
                trees: { x: { type: "table", rows: sampleTree }, y: { type: "table", rows: geneTree, columns: ["parent", "child", "height"] } },
            },
        ]);
        expect(bridgeValues(resolutions, stageAsset)._unsafeUnwrap().hm).toEqual({
            type: "table",
            rows,
            trees: { x: { rows: sampleTree }, y: { rows: geneTree, columns: ["parent", "child", "height"] } },
        });
    });

    it("refuses a tree that resolved to a scalar, and names the slot of its axis", () => {
        const resolutions: BlockResolution[] = [
            {
                blockId: "hm",
                kind: "chart",
                resolved: { type: "table", rows },
                trees: { x: { type: "table", rows: sampleTree }, y: { type: "scalar", value: 1 } },
            },
        ];
        expect(bridgeValues(resolutions, stageAsset)._unsafeUnwrapErr()).toEqual([
            { blockId: "hm", blockKind: "chart", slot: "tree:y", expected: "table", actual: "scalar" },
        ]);
    });
});
