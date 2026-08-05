import { describe, expect, it } from "bun:test";

import type { Block, ReportDocument } from "../contracts/report-blocks.js";
import { createFixtureResolver } from "./fixture-resolver.js";
import type { ReportSnapshot } from "./reference-resolver.js";
import { validateReport, type ReportValidation } from "./validate.js";

const TABLE_A_PATH = "runs/run-1/step-a/output/de.csv";
const TABLE_B_PATH = "runs/run-1/step-b/output/counts.csv";
const FLOAT_PATH = "runs/run-1/step-c/output/floats.csv";
const SPARSE_PATH = "runs/run-1/step-c/output/sparse.csv";
const FIGURE_PATH = "runs/run-1/step-b/figures/volcano.png";
const TABLE_A_HASH = `sha256:${"a".repeat(64)}`;
const TABLE_B_HASH = `sha256:${"b".repeat(64)}`;
const FLOAT_HASH = `sha256:${"e".repeat(64)}`;
const SPARSE_HASH = `sha256:${"f".repeat(64)}`;
const FIGURE_HASH = `sha256:${"d".repeat(64)}`;
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
        [SPARSE_PATH]: { hash: SPARSE_HASH, rows: sparseRows },
        // An image carries a hash and no rows, thus it pins whole and addresses no cell.
        [FIGURE_PATH]: { hash: FIGURE_HASH },
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

    it("reports locator-out-of-range for a derivation given an artifact-file input", async () => {
        const result = await validateReport(
            reportWith({
                kind: "metric",
                id: "metric-file-input",
                label: "FileInput",
                value: {
                    kind: "derivation",
                    op: "ratio",
                    inputs: [
                        { kind: "artifact-value", run: "run-1", path: TABLE_A_PATH, hash: TABLE_A_HASH, locator: { column: "log2FoldChange", row: 0 } },
                        // A file pins whole bytes, thus it addresses no numeric scalar for the arithmetic.
                        { kind: "artifact-file", run: "run-1", path: FIGURE_PATH, hash: FIGURE_HASH },
                    ],
                },
            }),
            snapshot,
            resolver,
        );
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("metric-file-input");
        expect(failures[0].failure.reason).toBe("locator-out-of-range");
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

describe("validateReport — the hash assert", () => {
    /** Bind a metric to the first cell of table A, under the given assert. */
    function metricWithAssert(id: string, assertion: { hash?: string; value?: string | number; tolerance?: number }): Block {
        return {
            kind: "metric",
            id,
            label: "Pinned",
            value: {
                kind: "artifact-value",
                run: "run-1",
                path: TABLE_A_PATH,
                hash: TABLE_A_HASH,
                locator: { column: "log2FoldChange", row: 0 },
                assert: assertion,
            },
        };
    }

    it("validates an artifact-value under a hash-only assert that matches", async () => {
        const result = await validateReport(reportWith(metricWithAssert("metric-hash-ok", { hash: TABLE_A_HASH })), snapshot, resolver);
        expectValid(result);
    });

    it("reports assertion-failed for a hash-only assert that differs", async () => {
        const result = await validateReport(reportWith(metricWithAssert("metric-hash-bad", { hash: WRONG_HASH })), snapshot, resolver);
        const invalid = expectInvalid(result);
        const failures = invalid.resolutionFailures ?? [];
        expect(failures[0].blockId).toBe("metric-hash-bad");
        expect(failures[0].failure.reason).toBe("assertion-failed");
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

    it("validates a rounded authored figure against a value that float arithmetic shifts", async () => {
        expectValid(await validateReport(reportWith(deltaMetric("metric-delta-ok", 0.2)), snapshot, resolver));
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
