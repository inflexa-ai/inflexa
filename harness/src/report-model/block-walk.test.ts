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
