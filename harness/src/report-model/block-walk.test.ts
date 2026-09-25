import { describe, expect, it } from "bun:test";

import type { Block } from "../contracts/report-blocks.js";
import { referencedPaths, walkBlocks } from "./block-walk.js";

const TABLE_PATH = "runs/run-1/step-a/output/de.csv";
const VALUE_PATH = "runs/run-1/step-b/output/counts.csv";
const FIGURE_PATH = "runs/run-1/step-a/figures/volcano.png";
const CHART_PATH = "report-sessions/t1/derived/merged.csv";
const INPUT_A_PATH = "runs/run-1/step-c/output/treated.csv";
const INPUT_B_PATH = "runs/run-1/step-c/output/control.csv";

const HASH = `sha256:${"a".repeat(64)}`;

describe("referencedPaths", () => {
    it("names the path of each binding kind that a block carries", () => {
        const blocks: Block[] = [
            { kind: "metric", id: "m1", label: "Genes", value: { kind: "artifact-value", path: VALUE_PATH, hash: HASH, locator: { column: "n", row: 0 } } },
            { kind: "table", id: "tb1", binding: { kind: "artifact-table", path: TABLE_PATH, hash: HASH } },
            { kind: "chart", id: "ch1", binding: { kind: "artifact-table", path: CHART_PATH, hash: HASH }, chartType: "bar", encoding: { x: "a", y: "b" } },
            { kind: "figure", id: "f1", binding: { kind: "artifact-file", path: FIGURE_PATH, hash: HASH } },
        ];

        // Each of the four evidentiary kinds names its artifact, thus a derived table that any one of them
        // binds counts as used.
        expect([...referencedPaths(walkBlocks(blocks).references)].sort()).toEqual([CHART_PATH, FIGURE_PATH, TABLE_PATH, VALUE_PATH].sort());
    });

    it("names the path of each input of a derivation reference", () => {
        const blocks: Block[] = [
            {
                kind: "metric",
                id: "m1",
                label: "Ratio",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        { kind: "artifact-value", path: INPUT_A_PATH, hash: HASH, locator: { column: "n", row: 0 } },
                        { kind: "artifact-value", path: INPUT_B_PATH, hash: HASH, locator: { column: "n", row: 0 } },
                    ],
                },
            },
        ];

        // A derivation reference reads two cells and it names no file of its own, thus a derived table that
        // feeds the arithmetic counts as used.
        expect([...referencedPaths(walkBlocks(blocks).references)].sort()).toEqual([INPUT_A_PATH, INPUT_B_PATH].sort());
    });

    it("names no path for a citation, and reads a nested section", () => {
        const blocks: Block[] = [
            {
                kind: "section",
                id: "s1",
                title: "Intro",
                blocks: [
                    { kind: "citation", id: "cit1", binding: { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" } },
                    {
                        kind: "claim",
                        id: "c1",
                        content: { prose: "A claim." },
                        bindings: [{ kind: "artifact-value", path: VALUE_PATH, hash: HASH, locator: { column: "n", row: 0 } }],
                    },
                ],
            },
        ];

        // A citation names a paper and never a file of the workspace. The walk is pre-order, thus a binding
        // under a section reaches the set.
        expect([...referencedPaths(walkBlocks(blocks).references)]).toEqual([VALUE_PATH]);
    });

    it("gives an empty set for a tree that binds nothing", () => {
        expect(referencedPaths(walkBlocks([{ kind: "text", id: "t1", content: { prose: "Body." } }]).references).size).toBe(0);
    });
});

describe("the columns of a chart grammar", () => {
    const binding = { kind: "artifact-table" as const, path: CHART_PATH, hash: HASH };

    /** The grammar columns that the walk collects for one chart block. */
    function columnsOf(block: Block): string[] | undefined {
        return walkBlocks([block]).references[0]?.encodingColumns;
    }

    it("names each new channel of the quick path and the sort column of each channel", () => {
        const block: Block = {
            kind: "chart",
            id: "ch1",
            binding,
            chartType: "scatter",
            encoding: {
                x: { column: "ratio", orderBy: "rank_x" },
                y: { column: "pathway", orderBy: "rank_y", order: "desc" },
                color: "padj",
                size: "count",
                low: "lo",
                high: "hi",
                facet: "cohort",
            },
        };

        // An invented column in any channel must reach the structural match, thus the walk names each one.
        expect(columnsOf(block)).toEqual(["ratio", "rank_x", "pathway", "rank_y", "padj", "count", "lo", "hi", "cohort"]);
    });

    it("names the new channels of each series and the facet of a composition", () => {
        const block: Block = {
            kind: "chart",
            id: "ch1",
            binding,
            composition: {
                series: [{ form: "bar", encoding: { x: { column: "arm", orderBy: "arm_rank" }, y: "mean", color: "score", low: "lo", high: "hi" } }],
                facet: "cohort",
            },
        };

        expect(columnsOf(block)).toEqual(["arm", "arm_rank", "mean", "score", "lo", "hi", "cohort"]);
    });

    it("names each channel of the canonical figures and each track column of the quick path", () => {
        const block: Block = {
            kind: "chart",
            id: "ch1",
            binding,
            chartType: "km",
            encoding: {
                x: "time",
                y: "survival",
                shape: "batch",
                p: "pvalue",
                censor: "n_censor",
                risk: "n_risk",
                hit: "in_set",
                metric: "stat",
                tracks: ["condition", "lane"],
            },
        };

        expect(columnsOf(block)).toEqual(["time", "survival", "batch", "pvalue", "n_censor", "n_risk", "in_set", "stat", "condition", "lane"]);
    });
});

describe("the references of a chart", () => {
    const binding = { kind: "artifact-table" as const, path: CHART_PATH, hash: HASH };
    const TRACK_PATH = "runs/run-1/step-d/output/domains.csv";
    const STAT_PATH = "runs/run-1/step-d/output/logrank.csv";

    const block: Block = {
        kind: "chart",
        id: "ch1",
        binding,
        chartType: "lollipop",
        encoding: { x: "position", y: "count" },
        track: { binding: { kind: "artifact-table", path: TRACK_PATH, hash: HASH }, start: "start", end: "end", label: "domain", length: "aa_length" },
        statistics: [
            { label: "Log-rank p", value: { kind: "artifact-value", path: STAT_PATH, hash: HASH, locator: { column: "p", row: 0 } } },
            { label: "HR", value: { kind: "artifact-value", path: STAT_PATH, hash: HASH, locator: { column: "hr", row: 0 } } },
        ],
    };

    it("collects the binding, the track, and each statistic in block order, each with its slot", () => {
        const references = walkBlocks([block]).references;
        expect(references.map((entry) => [entry.blockId, entry.slot, entry.reference.kind])).toEqual([
            ["ch1", "binding", "artifact-table"],
            ["ch1", "track", "artifact-table"],
            ["ch1", "statistic:0", "artifact-value"],
            ["ch1", "statistic:1", "artifact-value"],
        ]);
    });

    it("matches the track against its own columns, and each statistic against none", () => {
        const references = walkBlocks([block]).references;
        expect(references[1].encodingColumns).toEqual(["start", "end", "domain", "aa_length"]);
        expect(references[2].encodingColumns).toBeUndefined();
    });

    it("names the path of the track and of each statistic as a used path", () => {
        expect([...referencedPaths(walkBlocks([block]).references)].sort()).toEqual([CHART_PATH, STAT_PATH, TRACK_PATH].sort());
    });
});

describe("the trees of a chart", () => {
    const binding = { kind: "artifact-table" as const, path: CHART_PATH, hash: HASH };
    const SAMPLE_TREE = "runs/run-1/step-d/output/sample_tree.csv";
    const GENE_TREE = "runs/run-1/step-d/output/gene_tree.csv";
    const tree = (path: string) => ({ binding: { kind: "artifact-table" as const, path, hash: HASH }, parent: "parent", child: "child", height: "height" });

    const block: Block = {
        kind: "chart",
        id: "hm1",
        binding,
        chartType: "heatmap",
        encoding: { x: "sample", y: "gene", value: "z" },
        trees: { y: tree(GENE_TREE), x: tree(SAMPLE_TREE) },
    };

    it("collects the tree of x before the tree of y, after the binding, each with its slot", () => {
        const references = walkBlocks([block]).references;
        expect(references.map((entry) => [entry.slot, entry.reference.kind === "artifact-table" ? entry.reference.path : undefined])).toEqual([
            ["binding", CHART_PATH],
            ["tree:x", SAMPLE_TREE],
            ["tree:y", GENE_TREE],
        ]);
    });

    it("matches each tree against its own three columns", () => {
        const references = walkBlocks([block]).references;
        expect(references[1].encodingColumns).toEqual(["parent", "child", "height"]);
        expect(references[2].encodingColumns).toEqual(["parent", "child", "height"]);
        expect(references[0].encodingColumns).toEqual(["sample", "gene", "z"]);
    });

    it("puts the trees between the track and the statistics, and names each tree path as a used path", () => {
        const withAll: Block = {
            ...block,
            track: { binding: { kind: "artifact-table", path: "domains.csv", hash: HASH }, start: "s", end: "e", label: "l" },
            statistics: [{ label: "p", value: { kind: "artifact-value", path: "stats.csv", hash: HASH, locator: { column: "p", row: 0 } } }],
        };
        expect(walkBlocks([withAll]).references.map((entry) => entry.slot)).toEqual(["binding", "track", "tree:x", "tree:y", "statistic:0"]);
        expect([...referencedPaths(walkBlocks([block]).references)].sort()).toEqual([CHART_PATH, GENE_TREE, SAMPLE_TREE].sort());
    });
});
