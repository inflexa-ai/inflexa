import { describe, expect, it } from "bun:test";

import type { Block, ReportDocument } from "../contracts/report-blocks.js";
import { parseReference, serializeReference, type Reference } from "../contracts/report-reference.js";
import { valuesMatch } from "./assert-rules.js";
import { createFixtureResolver } from "./fixture-resolver.js";
import type { ReferenceResolver, ReportSnapshot } from "./reference-resolver.js";
import { validateReport, type ReportValidation } from "./validate.js";

const TABLE_A_PATH = "runs/run-1/step-a/output/de.csv";
const TABLE_B_PATH = "runs/run-1/step-b/output/counts.csv";
const FLOAT_PATH = "runs/run-1/step-c/output/floats.csv";
const SPARSE_PATH = "runs/run-1/step-c/output/sparse.csv";
// A text-backed artifact. A CSV holds every cell as a string, thus a numeric column arrives as text.
const TEXT_PATH = "runs/run-1/step-d/output/text.csv";
const FIGURE_PATH = "runs/run-1/step-b/figures/volcano.png";
// A figure entry that carries rows. A caller supplies the rows of a fixture, thus the file type must
// refuse the read even when the rows would resolve.
const FIGURE_ROWS_PATH = "runs/run-1/step-e/figures/heatmap.png";
const LOG_PATH = "runs/run-1/step-e/logs/run.log";
// An `output` covers a table and an image alike, thus it refuses nothing.
const OUTPUT_PATH = "runs/run-1/step-e/output/typed.csv";
// A staged input file, which no run produced. Its reference carries no `run`.
const INPUT_PATH = "data/inputs/file-1/cohort.csv";
const TABLE_A_HASH = `sha256:${"a".repeat(64)}`;
const TABLE_B_HASH = `sha256:${"b".repeat(64)}`;
const FLOAT_HASH = `sha256:${"e".repeat(64)}`;
const SPARSE_HASH = `sha256:${"f".repeat(64)}`;
const TEXT_HASH = `sha256:${"9".repeat(64)}`;
const FIGURE_HASH = `sha256:${"d".repeat(64)}`;
const FIGURE_ROWS_HASH = `sha256:${"2".repeat(64)}`;
const LOG_HASH = `sha256:${"3".repeat(64)}`;
const OUTPUT_HASH = `sha256:${"4".repeat(64)}`;
const INPUT_HASH = `sha256:${"1".repeat(64)}`;
const WRONG_HASH = `sha256:${"c".repeat(64)}`;

const resolver = createFixtureResolver();

/**
 * A row promises a value for each key that it holds. A real parser gives back an empty cell as an absent
 * key, as `undefined`, or as `null`, thus the cast is the only way to build the rows that the resolver
 * must reject.
 */
const sparseRows = [
    { label: "blank", value: "" },
    { label: "undefined-cell", value: undefined },
    { label: "null-cell", value: null },
    { label: "absent-cell" },
] as unknown as Array<Record<string, string | number>>;

const snapshot: ReportSnapshot = {
    artifacts: {
        [TABLE_A_PATH]: {
            hash: TABLE_A_HASH,
            // Two rows share direction "up", thus a rowFilter on direction is ambiguous while gene stays unique.
            rows: [
                { gene: "TP53", log2FoldChange: 6, padj: 0.001, direction: "up" },
                { gene: "EGFR", log2FoldChange: 3, padj: 0.02, direction: "up" },
            ],
        },
        [TABLE_B_PATH]: {
            hash: TABLE_B_HASH,
            // The S2 value is zero, thus a ratio with it as the divisor is a division by zero.
            rows: [
                { sample: "S1", value: 10 },
                { sample: "S2", value: 0 },
            ],
        },
        [FLOAT_PATH]: {
            hash: FLOAT_HASH,
            // A delta over 0.3 and 0.1 gives 0.19999999999999998, thus it exercises the float noise of
            // ordinary arithmetic against a rounded authored figure.
            rows: [
                { name: "a", value: 0.3 },
                { name: "b", value: 0.1 },
                { name: "c", value: 1.05 },
            ],
        },
        [TEXT_PATH]: {
            hash: TEXT_HASH,
            // Each cell is a string, as a CSV parser gives it back. `padj` holds the exponent form that a
            // p-value uses, and `note` holds a cell that is text and never a number.
            rows: [
                { gene: "TP53", padj: "1.2e-45", count: "40", note: "n/a" },
                { gene: "EGFR", padj: "0.02", count: "10", note: "12 genes" },
            ],
        },
        [SPARSE_PATH]: { hash: SPARSE_HASH, rows: sparseRows },
        [INPUT_PATH]: { hash: INPUT_HASH, rows: [{ samples: 24 }] },
        // An image carries a hash and no rows, thus it pins whole and addresses no cell.
        [FIGURE_PATH]: { hash: FIGURE_HASH },
        [FIGURE_ROWS_PATH]: { hash: FIGURE_ROWS_HASH, fileType: "figure", rows: [{ gene: "TP53", value: 6 }] },
        [LOG_PATH]: { hash: LOG_HASH, fileType: "log", rows: [{ gene: "TP53", value: 6 }] },
        [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output", rows: [{ gene: "TP53", value: 6 }] },
    },
    citations: ["pmid:12345"],
};

function expectValid(result: ReportValidation): Extract<ReportValidation, { valid: true }> {
    if (!result.valid) {
        throw new Error(`expected a valid report but got ${JSON.stringify(result)}`);
    }
    return result;
}

function expectInvalid(result: ReportValidation): Extract<ReportValidation, { valid: false }> {
    if (result.valid) {
        throw new Error("expected an invalid report but got a valid one");
    }
    return result;
}

/** Wrap one block in a single-section report, the smallest valid document shape. */
function reportWith(block: Block): ReportDocument {
    return { title: "Report", sections: [{ kind: "section", id: "sec", title: "Section", blocks: [block] }] };
}

/** A fully grounded document with one of each block kind and a section nested in a section. */
function groundedReport(): ReportDocument {
    return {
        title: "Grounded report",
        sections: [
            {
                kind: "section",
                id: "sec-findings",
                title: "Findings",
                blocks: [
                    { kind: "text", id: "text-intro", content: { prose: "The cohort separates cleanly by condition." } },
                    {
                        kind: "claim",
                        id: "claim-target",
                        content: { prose: "The primary target rises in the treated arm." },
                        bindings: [
                            {
                                kind: "artifact-value",
                                run: "run-1",
                                path: TABLE_A_PATH,
                                hash: TABLE_A_HASH,
                                locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
                            },
                        ],
                    },
                    {
                        kind: "metric",
                        id: "metric-top",
                        label: "Top effect",
                        value: { kind: "artifact-value", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, locator: { column: "log2FoldChange", row: 0 } },
                    },
                    {
                        kind: "table",
                        id: "table-counts",
                        title: "Counts",
                        binding: { kind: "artifact-table", run: "run-1", path: TABLE_B_PATH, hash: TABLE_B_HASH },
                    },
                    {
                        kind: "section",
                        id: "sec-detail",
                        title: "Detail",
                        blocks: [
                            {
                                kind: "chart",
                                id: "chart-counts",
                                binding: { kind: "artifact-table", run: "run-1", path: TABLE_B_PATH, hash: TABLE_B_HASH },
                                chartType: "bar",
                                encoding: { x: "sample", y: "value" },
                            },
                            {
                                kind: "figure",
                                id: "figure-plot",
                                binding: { kind: "artifact-file", run: "run-1", path: FIGURE_PATH, hash: FIGURE_HASH },
                            },
                            {
                                kind: "citation",
                                id: "citation-ref",
                                binding: { kind: "citation", idKind: "pmid", id: "12345", raw: "Author et al." },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe("validateReport — a fully grounded report", () => {
    it("validates one of each block kind with a nested section and no warnings", async () => {
        const result = await validateReport(groundedReport(), snapshot, resolver);
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });
});

describe("validateReport — resolution failures", () => {
    it("reports artifact-missing for a claim bound to an absent path", async () => {
        const result = await validateReport(
            reportWith({
                kind: "claim",
                id: "claim-absent",
                content: { prose: "A grounded claim." },
                bindings: [{ kind: "artifact-value", run: "run-1", path: "runs/run-1/absent.csv", hash: TABLE_A_HASH, locator: { column: "x", row: 0 } }],
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures).toHaveLength(1);
        expect(failures[0].blockId).toBe("claim-absent");
        expect(failures[0].failure.reason).toBe("artifact-missing");
    });

    it("reports assertion-failed for a wrong asserted value", async () => {
        const result = await validateReport(
            reportWith({
                kind: "claim",
                id: "claim-assert",
                content: { prose: "An asserted claim." },
                bindings: [
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: TABLE_A_PATH,
                        hash: TABLE_A_HASH,
                        locator: { column: "log2FoldChange", row: 0 },
                        assert: { value: 999 },
                    },
                ],
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures).toHaveLength(1);
        expect(failures[0].failure.reason).toBe("assertion-failed");
    });

    it("reports locator-out-of-range for a rowFilter that matches no row", async () => {
        const result = await validateReport(
            reportWith({
                kind: "claim",
                id: "claim-zero",
                content: { prose: "A claim with no match." },
                bindings: [
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: TABLE_A_PATH,
                        hash: TABLE_A_HASH,
                        locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "MISSING" } },
                    },
                ],
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });

    it("reports ambiguous-match for a rowFilter that matches two rows", async () => {
        const result = await validateReport(
            reportWith({
                kind: "claim",
                id: "claim-ambiguous",
                content: { prose: "A claim with two matches." },
                bindings: [
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: TABLE_A_PATH,
                        hash: TABLE_A_HASH,
                        locator: { column: "log2FoldChange", rowFilter: { column: "direction", op: "eq", value: "up" } },
                    },
                ],
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("ambiguous-match");
    });

    it("reports hash-mismatch for a pinned hash that differs", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-hash",
                label: "Pinned",
                value: { kind: "artifact-value", run: "run-1", path: TABLE_A_PATH, hash: WRONG_HASH, locator: { column: "log2FoldChange", row: 0 } },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("metric-hash");
        expect(failures[0].failure.reason).toBe("hash-mismatch");
    });
});

describe("validateReport — grammar rejections", () => {
    it("rejects a metric that carries a child-block array", async () => {
        const document = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "metric",
                            id: "m",
                            label: "L",
                            value: {
                                kind: "artifact-value",
                                run: "run-1",
                                path: TABLE_A_PATH,
                                hash: TABLE_A_HASH,
                                locator: { column: "log2FoldChange", row: 0 },
                            },
                            blocks: [{ kind: "text", id: "child", content: { prose: "child" } }],
                        },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a text block that carries bindings", async () => {
        const document = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "text", id: "t", content: { prose: "text" }, bindings: [{ kind: "citation", idKind: "doi", id: "10.1/x", raw: "r" }] }],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a report with no sections", async () => {
        const invalid = expectInvalid(await validateReport({ title: "R", sections: [] }, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a section with no blocks", async () => {
        const document = { title: "R", sections: [{ kind: "section", id: "s", title: "S", blocks: [] }] };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a claim with an empty bindings array", async () => {
        const document = {
            title: "R",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c", content: { prose: "text" }, bindings: [] }] }],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a metric whose value is a numeric literal", async () => {
        const document = {
            title: "R",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "metric", id: "m", label: "L", value: 42 }] }],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });
});

describe("validateReport — block-level schema rejections", () => {
    it("rejects a block with no id", async () => {
        const document = {
            title: "R",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "text", content: { prose: "text" } }] }],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a block with an empty-string id", async () => {
        const document = {
            title: "R",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "text", id: "", content: { prose: "text" } }] }],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a block with no kind", async () => {
        const document = {
            title: "R",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ id: "t", content: { prose: "text" } }] }],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a block whose kind is not one of the eight", async () => {
        const document = {
            title: "R",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "sidebar", id: "sb", content: { prose: "text" } }] }],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("rejects a metric that carries a second binding", async () => {
        const document = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "metric",
                            id: "m",
                            label: "L",
                            value: {
                                kind: "artifact-value",
                                run: "run-1",
                                path: TABLE_A_PATH,
                                hash: TABLE_A_HASH,
                                locator: { column: "log2FoldChange", row: 0 },
                            },
                            bindings: [{ kind: "artifact-value", run: "run-1", path: TABLE_B_PATH, hash: TABLE_B_HASH, locator: { column: "value", row: 0 } }],
                        },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });
});

describe("validateReport — the whole-file pin", () => {
    it("validates a figure bound to an artifact-file that resolves", async () => {
        const result = await validateReport(
            reportWith({ kind: "figure", id: "figure-ok", binding: { kind: "artifact-file", run: "run-1", path: FIGURE_PATH, hash: FIGURE_HASH } }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });

    it("reports artifact-missing for a figure whose file is absent", async () => {
        const result = await validateReport(
            reportWith({
                kind: "figure",
                id: "figure-absent",
                binding: { kind: "artifact-file", run: "run-1", path: "runs/run-1/step-b/figures/absent.png", hash: FIGURE_HASH },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures).toHaveLength(1);
        expect(failures[0].blockId).toBe("figure-absent");
        expect(failures[0].failure.reason).toBe("artifact-missing");
    });

    it("reports hash-mismatch for a figure whose file hash differs", async () => {
        const result = await validateReport(
            reportWith({
                kind: "figure",
                id: "figure-hash",
                binding: { kind: "artifact-file", run: "run-1", path: FIGURE_PATH, hash: WRONG_HASH },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("figure-hash");
        expect(failures[0].failure.reason).toBe("hash-mismatch");
    });

    it("rejects a derivation given an artifact-file input, because a file addresses no scalar", async () => {
        const document = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "metric",
                            id: "metric-file-input",
                            label: "FileInput",
                            value: {
                                kind: "derivation",
                                op: "ratio",
                                inputs: [
                                    {
                                        kind: "artifact-value",
                                        run: "run-1",
                                        path: TABLE_A_PATH,
                                        hash: TABLE_A_HASH,
                                        locator: { column: "log2FoldChange", row: 0 },
                                    },
                                    // A file pins whole bytes, thus it addresses no numeric scalar for the
                                    // arithmetic. The grammar rejects it, and resolution never runs.
                                    { kind: "artifact-file", run: "run-1", path: FIGURE_PATH, hash: FIGURE_HASH },
                                ],
                            },
                        },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
        expect(invalid.resolutionFailures).toBeUndefined();
    });
});

describe("validateReport — derivations", () => {
    it("validates a ratio over two grounded cells", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-ratio",
                label: "Ratio",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_A_PATH,
                            hash: TABLE_A_HASH,
                            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
                        },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_A_PATH,
                            hash: TABLE_A_HASH,
                            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "EGFR" } },
                        },
                    ],
                    assert: { value: 2, tolerance: 0.0001 },
                },
            }),
            snapshot,
            resolver,
        );
        expectValid(result);
    });

    it("keeps the inner reason when a derivation input does not resolve", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-broken-input",
                label: "Broken",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        { kind: "artifact-value", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, locator: { column: "log2FoldChange", row: 0 } },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: "runs/run-1/absent.csv",
                            hash: TABLE_A_HASH,
                            locator: { column: "log2FoldChange", row: 0 },
                        },
                    ],
                },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("metric-broken-input");
        expect(failures[0].failure.reason).toBe("artifact-missing");
    });

    it("reports locator-out-of-range for a division by zero", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-divzero",
                label: "DivZero",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_B_PATH,
                            hash: TABLE_B_HASH,
                            locator: { column: "value", rowFilter: { column: "sample", op: "eq", value: "S1" } },
                        },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_B_PATH,
                            hash: TABLE_B_HASH,
                            locator: { column: "value", rowFilter: { column: "sample", op: "eq", value: "S2" } },
                        },
                    ],
                },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });

    it("validates a pctChange over two grounded cells", async () => {
        // TP53 is 6 and EGFR is 3, thus (6 - 3) / 3 is exactly 1.
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-pctchange",
                label: "PctChange",
                value: {
                    kind: "derivation",
                    op: "pctChange",
                    inputs: [
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_A_PATH,
                            hash: TABLE_A_HASH,
                            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
                        },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_A_PATH,
                            hash: TABLE_A_HASH,
                            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "EGFR" } },
                        },
                    ],
                    assert: { value: 1, tolerance: 0.0001 },
                },
            }),
            snapshot,
            resolver,
        );
        expectValid(result);
    });

    it("reports locator-out-of-range for a pctChange whose divisor is zero", async () => {
        // S1 is 10 and S2 is 0, thus (10 - 0) / 0 is not finite.
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-pctchange-divzero",
                label: "PctChangeDivZero",
                value: {
                    kind: "derivation",
                    op: "pctChange",
                    inputs: [
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_B_PATH,
                            hash: TABLE_B_HASH,
                            locator: { column: "value", rowFilter: { column: "sample", op: "eq", value: "S1" } },
                        },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TABLE_B_PATH,
                            hash: TABLE_B_HASH,
                            locator: { column: "value", rowFilter: { column: "sample", op: "eq", value: "S2" } },
                        },
                    ],
                },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });
});

describe("validateReport — an artifact-table with a column subset", () => {
    it("validates a table bound to a column subset of a wider artifact", async () => {
        // Table A holds four columns, thus a two-column subset is a strict projection that resolves.
        const result = await validateReport(
            reportWith({
                kind: "table",
                id: "table-subset",
                title: "Subset",
                binding: { kind: "artifact-table", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, columns: ["gene", "log2FoldChange"] },
            }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });

    it("reports locator-out-of-range for a column that no row holds", async () => {
        const result = await validateReport(
            reportWith({
                kind: "table",
                id: "table-invented",
                title: "Invented",
                binding: { kind: "artifact-table", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, columns: ["gene", "pValueAdjusted"] },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("table-invented");
        expect(failures[0].failure.reason).toBe("locator-out-of-range");
        expect(failures[0].failure.detail).toContain("pValueAdjusted");
    });

    it("validates a column that only some rows hold, because a table tolerates a ragged row", async () => {
        // The sparse rows share `label`, but only three of the four hold `value`.
        const result = await validateReport(
            reportWith({
                kind: "table",
                id: "table-ragged",
                title: "Ragged",
                binding: { kind: "artifact-table", run: "run-1", path: SPARSE_PATH, hash: SPARSE_HASH, columns: ["label", "value"] },
            }),
            snapshot,
            resolver,
        );
        expectValid(result);
    });
});

describe("validateReport — a chart encoding", () => {
    /** Bind a chart to table B, whose rows hold `sample` and `value`, under the given encoding. */
    function chartWith(id: string, encoding: { x?: string; y?: string; group?: string; value?: string }): Block {
        return {
            kind: "chart",
            id,
            binding: { kind: "artifact-table", run: "run-1", path: TABLE_B_PATH, hash: TABLE_B_HASH },
            chartType: "bar",
            encoding,
        };
    }

    it("validates an encoding whose channels name real columns", async () => {
        expectValid(await validateReport(reportWith(chartWith("chart-ok", { x: "sample", y: "value" })), snapshot, resolver));
    });

    it("reports locator-out-of-range for a channel that names a column the table does not hold", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(chartWith("chart-invented", { x: "sample", y: "invented" })), snapshot, resolver));
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("chart-invented");
        expect(failures[0].failure.reason).toBe("locator-out-of-range");
        expect(failures[0].failure.detail).toContain("invented");
    });

    it("names each absent channel, across every encoding slot", async () => {
        const invalid = expectInvalid(
            await validateReport(
                reportWith(chartWith("chart-many", { x: "nope-x", y: "value", group: "nope-group", value: "nope-value" })),
                snapshot,
                resolver,
            ),
        );
        const detail = (invalid.resolutionFailures ?? [])[0].failure.detail ?? "";
        expect(detail).toContain("nope-x");
        expect(detail).toContain("nope-group");
        expect(detail).toContain("nope-value");
    });

    it("reports a channel that the bound column subset leaves out", async () => {
        // The projection drops `value`, thus the y channel addresses nothing in the resolved table.
        const invalid = expectInvalid(
            await validateReport(
                reportWith({
                    kind: "chart",
                    id: "chart-outside-subset",
                    binding: { kind: "artifact-table", run: "run-1", path: TABLE_B_PATH, hash: TABLE_B_HASH, columns: ["sample"] },
                    chartType: "bar",
                    encoding: { x: "sample", y: "value" },
                }),
                snapshot,
                resolver,
            ),
        );
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });

    it("validates an encoding with no channel at all", async () => {
        expectValid(await validateReport(reportWith(chartWith("chart-bare", {})), snapshot, resolver));
    });
});

describe("validateReport — free-numeral warnings", () => {
    it("warns on a numeral in prose and stays valid", async () => {
        const result = await validateReport(
            reportWith({ kind: "text", id: "text-numeral", content: { prose: "Expression increased by 42% overall." } }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([{ blockId: "text-numeral", kind: "free-numeral", detail: "42%" }]);
    });

    it("gives no warning for clean prose", async () => {
        const result = await validateReport(
            reportWith({ kind: "text", id: "text-clean", content: { prose: "Expression increased markedly overall." } }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });

    it("gives no warning for the digits inside a gene symbol", async () => {
        const result = await validateReport(
            reportWith({ kind: "text", id: "text-symbols", content: { prose: "TP53, CD8, IL6, and the hg38 build agree." } }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });

    it("still warns on a free figure that sits beside a symbol", async () => {
        const result = await validateReport(
            reportWith({ kind: "text", id: "text-mixed", content: { prose: "TP53 rose 42% across 3 cohorts." } }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings.map((warning) => warning.detail)).toEqual(["42%", "3"]);
    });
});

describe("validateReport — multiple failures", () => {
    it("collects every failure across blocks", async () => {
        const document: ReportDocument = {
            title: "Broken report",
            sections: [
                {
                    kind: "section",
                    id: "sec",
                    title: "S",
                    blocks: [
                        {
                            kind: "claim",
                            id: "claim-a",
                            content: { prose: "A claim." },
                            bindings: [
                                { kind: "artifact-value", run: "run-1", path: "runs/run-1/absent.csv", hash: TABLE_A_HASH, locator: { column: "x", row: 0 } },
                            ],
                        },
                        {
                            kind: "metric",
                            id: "metric-b",
                            label: "M",
                            value: {
                                kind: "artifact-value",
                                run: "run-1",
                                path: TABLE_A_PATH,
                                hash: WRONG_HASH,
                                locator: { column: "log2FoldChange", row: 0 },
                            },
                        },
                        {
                            kind: "citation",
                            id: "citation-c",
                            binding: { kind: "citation", idKind: "pmid", id: "99999", raw: "Missing citation." },
                        },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        const failures = invalid.resolutionFailures ?? [];
        expect(failures).toHaveLength(3);
        expect(failures.map((f) => f.blockId).sort()).toEqual(["citation-c", "claim-a", "metric-b"]);
    });
});

describe("validateReport — the pin carries the belief about the bytes", () => {
    it("rejects an assert that carries a hash, because the pin already compares it", async () => {
        const document = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "metric",
                            id: "m",
                            label: "Pinned",
                            value: {
                                kind: "artifact-value",
                                run: "run-1",
                                path: TABLE_A_PATH,
                                hash: TABLE_A_HASH,
                                locator: { column: "log2FoldChange", row: 0 },
                                assert: { hash: TABLE_A_HASH },
                            },
                        },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.schemaIssues?.length ?? 0).toBeGreaterThan(0);
    });

    it("validates a metric bound to a staged input artifact that carries no run", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-input",
                label: "Input",
                value: { kind: "artifact-value", path: INPUT_PATH, hash: INPUT_HASH, locator: { column: "samples", row: 0 } },
            }),
            snapshot,
            resolver,
        );
        expectValid(result);
    });
});

describe("validateReport — a value match with no tolerance", () => {
    /** Bind a metric to the delta of the two float cells, under the given asserted value. */
    function deltaMetric(id: string, expected: number): Block {
        return {
            kind: "metric",
            id,
            label: "Delta",
            value: {
                kind: "derivation",
                op: "delta",
                inputs: [
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: FLOAT_PATH,
                        hash: FLOAT_HASH,
                        locator: { column: "value", rowFilter: { column: "name", op: "eq", value: "a" } },
                    },
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: FLOAT_PATH,
                        hash: FLOAT_HASH,
                        locator: { column: "value", rowFilter: { column: "name", op: "eq", value: "b" } },
                    },
                ],
                assert: { value: expected },
            },
        };
    }

    it("absorbs the float noise of a computed value", async () => {
        expectValid(await validateReport(reportWith(deltaMetric("metric-delta-ok", 0.2)), snapshot, resolver));
    });

    it("rejects a rounded authored figure, because only a tolerance permits one", async () => {
        // The delta is 0.19999999999999998. A rounded 0.19 sits far above the float noise that the
        // epsilon absorbs, thus the author must state a tolerance to accept it.
        const rounded = expectInvalid(await validateReport(reportWith(deltaMetric("metric-delta-rounded", 0.19)), snapshot, resolver));
        expect((rounded.resolutionFailures ?? [])[0].failure.reason).toBe("assertion-failed");
    });

    it("reports assertion-failed for a real mismatch with no tolerance", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-wrong-value",
                label: "Wrong",
                value: {
                    kind: "artifact-value",
                    run: "run-1",
                    path: FLOAT_PATH,
                    hash: FLOAT_HASH,
                    locator: { column: "value", rowFilter: { column: "name", op: "eq", value: "c" } },
                    assert: { value: 1.5 },
                },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("metric-wrong-value");
        expect(failures[0].failure.reason).toBe("assertion-failed");
    });
});

describe("validateReport — a cell that holds no value", () => {
    /** Bind a metric to the `value` cell of the sparse row that the given label selects. */
    function sparseMetric(id: string, label: string): Block {
        return {
            kind: "metric",
            id,
            label: "Sparse",
            value: {
                kind: "artifact-value",
                run: "run-1",
                path: SPARSE_PATH,
                hash: SPARSE_HASH,
                locator: { column: "value", rowFilter: { column: "label", op: "eq", value: label } },
            },
        };
    }

    it("validates a cell that holds an empty string", async () => {
        expectValid(await validateReport(reportWith(sparseMetric("metric-blank", "blank")), snapshot, resolver));
    });

    it("reports locator-out-of-range for a cell that holds undefined", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(sparseMetric("metric-undefined", "undefined-cell")), snapshot, resolver));
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].failure.reason).toBe("locator-out-of-range");
        expect(failures[0].failure.detail).toContain("value");
    });

    it("reports locator-out-of-range for a cell that holds null", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(sparseMetric("metric-null", "null-cell")), snapshot, resolver));
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });

    it("reports locator-out-of-range for a column that the row does not hold", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(sparseMetric("metric-absent", "absent-cell")), snapshot, resolver));
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });
});

describe("the resolver — cross-session resolution", () => {
    it("resolves a parsed reference to the same value as the original", async () => {
        const reference: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: TABLE_A_PATH,
            hash: TABLE_A_HASH,
            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
        };
        const parsed = parseReference(serializeReference(reference));
        if (parsed.isErr()) {
            throw new Error("expected the serialized reference to parse");
        }

        const fromOriginal = await resolver.resolve(reference, snapshot);
        const fromParsed = await resolver.resolve(parsed.value, snapshot);

        expect(fromParsed.isOk()).toBe(fromOriginal.isOk());
        expect(fromParsed._unsafeUnwrap()).toEqual(fromOriginal._unsafeUnwrap());
        expect(fromParsed._unsafeUnwrap()).toEqual({ type: "scalar", value: 6 });
    });
});

describe("validateReport — block id uniqueness", () => {
    it("rejects a document whose blocks share an id", async () => {
        const document: ReportDocument = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "sec",
                    title: "S",
                    blocks: [
                        { kind: "text", id: "same", content: { prose: "One." } },
                        { kind: "text", id: "same", content: { prose: "Two." } },
                        { kind: "text", id: "same", content: { prose: "Three." } },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.duplicateIds).toEqual(["same"]);
    });

    it("names each repeated id one time, in sorted order, across nested sections", async () => {
        const document: ReportDocument = {
            title: "R",
            sections: [
                {
                    kind: "section",
                    id: "sec",
                    title: "S",
                    blocks: [
                        { kind: "text", id: "zebra", content: { prose: "One." } },
                        { kind: "text", id: "alpha", content: { prose: "Two." } },
                        {
                            kind: "section",
                            id: "sec-inner",
                            title: "Inner",
                            blocks: [
                                { kind: "text", id: "zebra", content: { prose: "Three." } },
                                { kind: "text", id: "alpha", content: { prose: "Four." } },
                            ],
                        },
                    ],
                },
            ],
        };
        const invalid = expectInvalid(await validateReport(document, snapshot, resolver));
        expect(invalid.duplicateIds).toEqual(["alpha", "zebra"]);
    });

    it("gives no duplicateIds for a document whose ids are unique", async () => {
        const valid = expectValid(await validateReport(groundedReport(), snapshot, resolver));
        expect(valid).not.toHaveProperty("duplicateIds");
    });
});

describe("validateReport — a text-backed artifact", () => {
    /** Bind a metric to a cell of the text artifact, in the row of the given gene, under the given assert. */
    function textMetric(id: string, column: string, assert?: { value: string | number; tolerance?: number }, gene = "TP53"): Block {
        return {
            kind: "metric",
            id,
            label: "Text",
            value: {
                kind: "artifact-value",
                run: "run-1",
                path: TEXT_PATH,
                hash: TEXT_HASH,
                locator: { column, rowFilter: { column: "gene", op: "eq", value: gene } },
                ...(assert !== undefined ? { assert } : {}),
            },
        };
    }

    it("matches a numeric assert against the string cell that a CSV holds", async () => {
        expectValid(await validateReport(reportWith(textMetric("metric-text-number", "count", { value: 40 })), snapshot, resolver));
    });

    it("matches a numeric assert against a cell in the exponent form of a p-value", async () => {
        expectValid(await validateReport(reportWith(textMetric("metric-text-exponent", "padj", { value: 1.2e-45 })), snapshot, resolver));
    });

    it("matches a string assert against the same string cell", async () => {
        expectValid(await validateReport(reportWith(textMetric("metric-text-string", "note", { value: "n/a" })), snapshot, resolver));
    });

    it("reports assertion-failed for a numeric assert that the string cell does not hold", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(textMetric("metric-text-wrong", "count", { value: 41 })), snapshot, resolver));
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("assertion-failed");
    });

    it("names the type of each side, thus a failed match never reads as two identical values", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(textMetric("metric-text-typed", "note", { value: 12 }, "EGFR")), snapshot, resolver));
        const detail = (invalid.resolutionFailures ?? [])[0].failure.detail ?? "";
        expect(detail).toContain("the number 12");
        expect(detail).toContain(`the string "12 genes"`);
    });

    it("reads a cell that holds text as text, thus a leading numeral never matches", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(textMetric("metric-text-prefix", "note", { value: "12" }, "EGFR")), snapshot, resolver));
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("assertion-failed");
    });

    it("runs the arithmetic of a derivation over two string cells", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-text-ratio",
                label: "Ratio",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TEXT_PATH,
                            hash: TEXT_HASH,
                            locator: { column: "count", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
                        },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TEXT_PATH,
                            hash: TEXT_HASH,
                            locator: { column: "count", rowFilter: { column: "gene", op: "eq", value: "EGFR" } },
                        },
                    ],
                    assert: { value: 4 },
                },
            }),
            snapshot,
            resolver,
        );
        expectValid(result);
    });

    it("reports locator-out-of-range for a derivation input whose cell holds text", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-text-nonnumeric",
                label: "Ratio",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TEXT_PATH,
                            hash: TEXT_HASH,
                            locator: { column: "note", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
                        },
                        {
                            kind: "artifact-value",
                            run: "run-1",
                            path: TEXT_PATH,
                            hash: TEXT_HASH,
                            locator: { column: "count", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
                        },
                    ],
                },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
        expect((invalid.resolutionFailures ?? [])[0].failure.detail).toContain("note");
    });
});

describe("validateReport — a citation assertion", () => {
    /** Bind a citation block to the pinned pmid, under the given asserted key. */
    function citationBlock(id: string, assert?: { value: string }): Block {
        return {
            kind: "citation",
            id,
            binding: { kind: "citation", idKind: "pmid", id: "12345", raw: "Author et al.", ...(assert !== undefined ? { assert } : {}) },
        };
    }

    it("validates a citation whose asserted key matches the resolved key", async () => {
        expectValid(await validateReport(reportWith(citationBlock("cite-ok", { value: "pmid:12345" })), snapshot, resolver));
    });

    it("reports assertion-failed for an asserted key that names a different source", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(citationBlock("cite-wrong", { value: "pmid:99999" })), snapshot, resolver));
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("assertion-failed");
    });

    it("reports assertion-failed for a bare id, because the key carries its idKind prefix", async () => {
        const invalid = expectInvalid(await validateReport(reportWith(citationBlock("cite-bare", { value: "12345" })), snapshot, resolver));
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("assertion-failed");
    });
});

describe("validateReport — the remaining resolution outcomes", () => {
    it("reports locator-out-of-range for a fixed row index past the last row", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-row-past-end",
                label: "Past",
                value: { kind: "artifact-value", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, locator: { column: "log2FoldChange", row: 7 } },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
        expect((invalid.resolutionFailures ?? [])[0].failure.detail).toContain("7");
    });

    /** Bind to the `value` cell of the sparse row that holds an empty string. */
    const blankCell = {
        kind: "artifact-value",
        run: "run-1",
        path: SPARSE_PATH,
        hash: SPARSE_HASH,
        locator: { column: "value", rowFilter: { column: "label", op: "eq", value: "blank" } },
    } as const;

    it("reports assertion-failed for a zero asserted against a blank cell", async () => {
        // `Number("")` gives 0. A blank cell that reads as zero would ground a figure on an absence.
        const result = await validateReport(
            reportWith({ kind: "metric", id: "metric-blank-zero", label: "Blank", value: { ...blankCell, assert: { value: 0 } } }),
            snapshot,
            resolver,
        );
        expect((expectInvalid(result).resolutionFailures ?? [])[0].failure.reason).toBe("assertion-failed");
    });

    it("reports locator-out-of-range for a derivation over a blank cell", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-blank-input",
                label: "Blank",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        { kind: "artifact-value", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, locator: { column: "log2FoldChange", row: 0 } },
                        blankCell,
                    ],
                },
            }),
            snapshot,
            resolver,
        );
        expect((expectInvalid(result).resolutionFailures ?? [])[0].failure.reason).toBe("locator-out-of-range");
    });

    it("reports artifact-missing for a table bound to an absent path", async () => {
        const result = await validateReport(
            reportWith({
                kind: "table",
                id: "table-absent",
                binding: { kind: "artifact-table", run: "run-1", path: "runs/run-1/absent-table.csv", hash: TABLE_A_HASH },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        expect((invalid.resolutionFailures ?? [])[0].failure.reason).toBe("artifact-missing");
    });
});

describe("validateReport — the file type of the pinned entry", () => {
    it("reports unreadable-artifact for a value bound to a figure that carries rows", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-figure-cell",
                label: "Figure cell",
                value: { kind: "artifact-value", run: "run-1", path: FIGURE_ROWS_PATH, hash: FIGURE_ROWS_HASH, locator: { column: "value", row: 0 } },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures).toHaveLength(1);
        expect(failures[0].blockId).toBe("metric-figure-cell");
        expect(failures[0].failure.reason).toBe("unreadable-artifact");
    });

    it("reports unreadable-artifact for a table bound to a log", async () => {
        const result = await validateReport(
            reportWith({ kind: "table", id: "table-log", binding: { kind: "artifact-table", run: "run-1", path: LOG_PATH, hash: LOG_HASH } }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures).toHaveLength(1);
        expect(failures[0].blockId).toBe("table-log");
        expect(failures[0].failure.reason).toBe("unreadable-artifact");
    });

    it("validates a figure bound to an artifact-file whose entry is a figure", async () => {
        const result = await validateReport(
            reportWith({
                kind: "figure",
                id: "figure-typed",
                binding: { kind: "artifact-file", run: "run-1", path: FIGURE_ROWS_PATH, hash: FIGURE_ROWS_HASH },
            }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });

    it("validates a value bound to an output, because an output can hold a table", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-output-cell",
                label: "Output cell",
                value: { kind: "artifact-value", run: "run-1", path: OUTPUT_PATH, hash: OUTPUT_HASH, locator: { column: "value", row: 0 } },
            }),
            snapshot,
            resolver,
        );
        const valid = expectValid(result);
        expect(valid.warnings).toEqual([]);
    });
});

describe("validateReport — prepare before the loop", () => {
    /**
     * A stub resolver over the fixture. It counts each prepare, and it counts each resolve that runs while
     * no prepare has run yet. Thus the order of prepare and the loop is observable state.
     */
    function countingResolver(): { resolver: ReferenceResolver; prepareCount: () => number; resolvesBeforePrepare: () => number } {
        const fixture = createFixtureResolver();
        let prepareCount = 0;
        let resolvesBeforePrepare = 0;
        const resolver: ReferenceResolver = {
            async prepare() {
                prepareCount += 1;
            },
            async resolve(reference, snapshot) {
                if (prepareCount === 0) {
                    resolvesBeforePrepare += 1;
                }
                return fixture.resolve(reference, snapshot);
            },
        };
        return { resolver, prepareCount: () => prepareCount, resolvesBeforePrepare: () => resolvesBeforePrepare };
    }

    it("runs prepare one time before every resolve", async () => {
        const stub = countingResolver();
        expectValid(await validateReport(groundedReport(), snapshot, stub.resolver));
        expect(stub.prepareCount()).toBe(1);
        expect(stub.resolvesBeforePrepare()).toBe(0);
    });

    it("keeps the behavior of a realization without prepare", async () => {
        const withoutPrepare = createFixtureResolver();
        expect(withoutPrepare.prepare).toBeUndefined();
        expectValid(await validateReport(groundedReport(), snapshot, withoutPrepare));
    });
});

describe("assert-rules — one semantics for each realization", () => {
    /** Bind a metric to the delta of the two float cells, under the given assert. */
    function deltaMetric(id: string, assert: { value: number; tolerance?: number }): Block {
        return {
            kind: "metric",
            id,
            label: "Delta",
            value: {
                kind: "derivation",
                op: "delta",
                inputs: [
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: FLOAT_PATH,
                        hash: FLOAT_HASH,
                        locator: { column: "value", rowFilter: { column: "name", op: "eq", value: "a" } },
                    },
                    {
                        kind: "artifact-value",
                        run: "run-1",
                        path: FLOAT_PATH,
                        hash: FLOAT_HASH,
                        locator: { column: "value", rowFilter: { column: "name", op: "eq", value: "b" } },
                    },
                ],
                assert,
            },
        };
    }

    it("agrees with the fixture on a tolerance case", async () => {
        // The delta of the float cells a and b is 0.19999999999999998. A rounded 0.19 sits above the float
        // noise, thus a tolerance decides the match.
        const delta = 0.3 - 0.1;
        const expected = 0.19;
        const tolerance = 0.02;
        const shared = valuesMatch(expected, delta, tolerance);
        const throughFixture = (await validateReport(reportWith(deltaMetric("metric-agree", { value: expected, tolerance })), snapshot, resolver)).valid;
        expect(shared).toBe(true);
        expect(throughFixture).toBe(shared);
    });
});
