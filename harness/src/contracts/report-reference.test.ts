import { describe, expect, it } from "bun:test";

import { parseReference, serializeReference, type ParseReferenceError, type Reference } from "./report-reference.js";

const HASH = `sha256:${"a".repeat(64)}`;

/**
 * serializeReference validates nothing; it only encodes. A cast lets a test feed a malformed object
 * through the exact wire encoding, then assert that parseReference rejects it on the way back.
 */
function encodeUnchecked(value: unknown): string {
    return serializeReference(value as unknown as Reference);
}

/** Assert that a reference survives a serialize then parse round trip unchanged. */
function expectRoundTrip(reference: Reference): void {
    const parsed = parseReference(serializeReference(reference));
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap()).toEqual(reference);
}

/** Assert that a URI fails to parse, with the given error kind. */
function expectParseError(uri: string, kind: ParseReferenceError["kind"]): void {
    parseReference(uri).match(
        () => {
            throw new Error(`expected a parse error but the URI parsed: ${uri}`);
        },
        (error) => {
            expect(error.kind).toBe(kind);
        },
    );
}

describe("serializeReference/parseReference — round trip", () => {
    it("round-trips an artifact-value with a rowFilter", () => {
        const reference: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: "runs/run-1/step-a/output/de.csv",
            hash: HASH,
            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
            unit: "log2",
        };
        expectRoundTrip(reference);
    });

    it("round-trips an artifact-table with columns", () => {
        const reference: Reference = {
            kind: "artifact-table",
            run: "run-1",
            path: "runs/run-1/step-a/output/de.csv",
            hash: HASH,
            columns: ["gene", "log2FoldChange", "padj"],
        };
        expectRoundTrip(reference);
    });

    it("round-trips an artifact-table that declares a column meaning and a column label", () => {
        const reference: Reference = {
            kind: "artifact-table",
            run: "run-1",
            path: "runs/run-1/step-a/output/de.csv",
            hash: HASH,
            columnMeanings: { significance: "p-value", log2FoldChange: "effect" },
            columnLabels: { significance: "Adjusted p-value" },
        };
        expectRoundTrip(reference);
    });

    it("round-trips a declaration whose key names no column, because a stale key is a normal condition", () => {
        const reference: Reference = {
            kind: "artifact-table",
            path: "runs/run-1/step-a/output/de.csv",
            hash: HASH,
            columns: ["gene"],
            columnMeanings: { absent: "count" },
            columnLabels: { absent: "Absent column" },
        };
        expectRoundTrip(reference);
    });

    it("round-trips a derivation with two inputs and an assert", () => {
        const reference: Reference = {
            kind: "derivation",
            op: "ratio",
            inputs: [
                { kind: "artifact-value", run: "run-1", path: "a.csv", hash: HASH, locator: { column: "value", row: 0 } },
                { kind: "artifact-value", run: "run-1", path: "b.csv", hash: HASH, locator: { column: "value", row: 0 } },
            ],
            assert: { value: 2, tolerance: 0.01 },
        };
        expectRoundTrip(reference);
    });

    it("round-trips a citation", () => {
        const reference: Reference = {
            kind: "citation",
            idKind: "pmid",
            id: "12345",
            raw: "Author et al. 2020",
        };
        expectRoundTrip(reference);
    });

    it("round-trips an artifact-file", () => {
        const reference: Reference = {
            kind: "artifact-file",
            run: "run-1",
            path: "runs/run-1/step-b/figures/volcano.png",
            hash: HASH,
        };
        expectRoundTrip(reference);
    });
});

describe("serializeReference — determinism", () => {
    it("gives the identical string on two calls", () => {
        const reference: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: "a.csv",
            hash: HASH,
            locator: { column: "gene", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
        };
        expect(serializeReference(reference)).toBe(serializeReference(reference));
    });

    it("ignores key insertion order", () => {
        const ordered: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: "a.csv",
            hash: HASH,
            locator: { column: "gene", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
        };
        const shuffled: Reference = {
            locator: { rowFilter: { value: "TP53", op: "eq", column: "gene" }, column: "gene" },
            hash: HASH,
            path: "a.csv",
            run: "run-1",
            kind: "artifact-value",
        };
        expect(serializeReference(ordered)).toBe(serializeReference(shuffled));
    });
});

describe("parseReference — error outcomes", () => {
    it("gives a bad-prefix error for a wrong prefix", () => {
        expectParseError("wrong-prefix:v1:abc", "bad-prefix");
    });

    it("gives an invalid-json error for a payload that is not JSON", () => {
        const sample = serializeReference({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text" });
        // The payload is base64url and holds no colon, thus the last colon marks the end of the prefix.
        const prefix = sample.slice(0, sample.lastIndexOf(":") + 1);
        const corrupt = prefix + Buffer.from("{ this is not json", "utf8").toString("base64url");
        expectParseError(corrupt, "invalid-json");
    });

    it("gives a schema-mismatch error for valid JSON that fails the schema", () => {
        expectParseError(encodeUnchecked({ foo: "bar" }), "schema-mismatch");
    });

    it("gives an invalid-payload error for a character outside the base64url alphabet", () => {
        // `Buffer.from` drops such a character and decodes what is left, thus without an explicit check
        // this payload would report as malformed JSON and name the wrong failure.
        expectParseError("inflexa-ref:v1:not base64!!", "invalid-payload");
        expectParseError("inflexa-ref:v1:eyJraW5kIjoiY2l0YXRpb24ifQ==", "invalid-payload");
    });

    it("gives an invalid-payload error for an empty payload", () => {
        expectParseError("inflexa-ref:v1:", "invalid-payload");
    });
});

describe("parseReference — schema rejection", () => {
    it("rejects an artifact reference without a hash", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", locator: { column: "c", row: 0 } }), "schema-mismatch");
    });

    it("rejects an uppercase hash", () => {
        expectParseError(
            encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", hash: "sha256:ABCDEF", locator: { column: "c", row: 0 } }),
            "schema-mismatch",
        );
    });

    it("rejects a derivation whose input is a derivation", () => {
        expectParseError(
            encodeUnchecked({
                kind: "derivation",
                op: "ratio",
                inputs: [
                    {
                        kind: "derivation",
                        op: "ratio",
                        inputs: [{ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 } }],
                    },
                ],
            }),
            "schema-mismatch",
        );
    });

    it("rejects a locator with both rowFilter and row", () => {
        expectParseError(
            encodeUnchecked({
                kind: "artifact-value",
                run: "r",
                path: "p",
                hash: HASH,
                locator: { column: "c", row: 0, rowFilter: { column: "c", op: "eq", value: 1 } },
            }),
            "schema-mismatch",
        );
    });

    it("rejects a locator with neither rowFilter nor row", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c" } }), "schema-mismatch");
    });

    it("rejects an unknown kind", () => {
        expectParseError(encodeUnchecked({ kind: "made-up", run: "r", path: "p", hash: HASH }), "schema-mismatch");
    });

    it("rejects an extra unknown key", () => {
        expectParseError(encodeUnchecked({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text", extra: "nope" }), "schema-mismatch");
    });

    it("rejects a locator on an artifact-file", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-file", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 } }), "schema-mismatch");
    });

    it("rejects a derivation with one input", () => {
        expectParseError(
            encodeUnchecked({
                kind: "derivation",
                op: "delta",
                inputs: [{ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 } }],
            }),
            "schema-mismatch",
        );
    });

    /**
     * The arithmetic needs a scalar, and only an `artifact-value` resolves to one. Each other kind is
     * rejected by the grammar, thus it never parses into a reference that always fails at resolution.
     */
    const scalarInput = { kind: "artifact-value", run: "r", path: "a.csv", hash: HASH, locator: { column: "value", row: 0 } };

    it("rejects a derivation whose input is an artifact-table", () => {
        expectParseError(
            encodeUnchecked({ kind: "derivation", op: "ratio", inputs: [scalarInput, { kind: "artifact-table", run: "r", path: "t.csv", hash: HASH }] }),
            "schema-mismatch",
        );
    });

    it("rejects a derivation whose input is an artifact-file", () => {
        expectParseError(
            encodeUnchecked({ kind: "derivation", op: "ratio", inputs: [scalarInput, { kind: "artifact-file", run: "r", path: "f.png", hash: HASH }] }),
            "schema-mismatch",
        );
    });

    it("rejects a derivation whose input is a citation", () => {
        expectParseError(
            encodeUnchecked({ kind: "derivation", op: "ratio", inputs: [scalarInput, { kind: "citation", idKind: "pmid", id: "1", raw: "t" }] }),
            "schema-mismatch",
        );
    });
});

describe("parseReference — the per-kind assert shape", () => {
    /** Two grounded inputs, so that a rejected derivation is rejected for its assert and nothing else. */
    const derivationInputs = [
        { kind: "artifact-value", run: "r", path: "a.csv", hash: HASH, locator: { column: "value", row: 0 } },
        { kind: "artifact-value", run: "r", path: "b.csv", hash: HASH, locator: { column: "value", row: 0 } },
    ];

    it("round-trips a value assert with a tolerance on an artifact-value", () => {
        const reference: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: "a.csv",
            hash: HASH,
            locator: { column: "value", row: 0 },
            assert: { value: 5, tolerance: 0.01 },
        };
        expectRoundTrip(reference);
    });

    it("rejects an asserted hash on an artifact-value, because the pin already carries it", () => {
        expectParseError(
            encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 }, assert: { hash: HASH } }),
            "schema-mismatch",
        );
    });

    it("rejects a column meaning outside the closed set of five", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-table", path: "t.csv", hash: HASH, columnMeanings: { padj: "probability" } }), "schema-mismatch");
    });

    it("rejects a column label that is not text", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-table", path: "t.csv", hash: HASH, columnLabels: { padj: 7 } }), "schema-mismatch");
    });

    it("rejects any assert on an artifact-table", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { hash: HASH } }), "schema-mismatch");
        expectParseError(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { value: 5 } }), "schema-mismatch");
        expectParseError(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { tolerance: 0.1 } }), "schema-mismatch");
    });

    it("rejects any assert on an artifact-file", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-file", run: "r", path: "p", hash: HASH, assert: { hash: HASH } }), "schema-mismatch");
        expectParseError(encodeUnchecked({ kind: "artifact-file", run: "r", path: "p", hash: HASH, assert: { value: 5 } }), "schema-mismatch");
    });

    it("rejects an asserted hash on a derivation", () => {
        expectParseError(encodeUnchecked({ kind: "derivation", op: "ratio", inputs: derivationInputs, assert: { hash: HASH } }), "schema-mismatch");
    });

    it("rejects an asserted hash on a citation", () => {
        expectParseError(encodeUnchecked({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text", assert: { hash: HASH } }), "schema-mismatch");
    });

    it("round-trips a citation assert that holds the prefixed key", () => {
        expectRoundTrip({ kind: "citation", idKind: "pmid", id: "12345", raw: "text", assert: { value: "pmid:12345" } });
    });

    it("rejects a numeric citation assert, because the resolved key is always text", () => {
        expectParseError(encodeUnchecked({ kind: "citation", idKind: "pmid", id: "12345", raw: "text", assert: { value: 12345 } }), "schema-mismatch");
    });

    it("rejects a tolerance on a citation assert, because a key match is exact", () => {
        expectParseError(
            encodeUnchecked({ kind: "citation", idKind: "pmid", id: "12345", raw: "text", assert: { value: "pmid:12345", tolerance: 1 } }),
            "schema-mismatch",
        );
    });

    it("rejects a tolerance with no asserted value", () => {
        expectParseError(
            encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 }, assert: { tolerance: 0.1 } }),
            "schema-mismatch",
        );
        expectParseError(encodeUnchecked({ kind: "derivation", op: "ratio", inputs: derivationInputs, assert: { tolerance: 0.1 } }), "schema-mismatch");
    });

    it("rejects an empty assert", () => {
        expectParseError(
            encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 }, assert: {} }),
            "schema-mismatch",
        );
        expectParseError(encodeUnchecked({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text", assert: {} }), "schema-mismatch");
    });
});

describe("parseReference — the optional run", () => {
    it("round-trips a staged input artifact that no run produced", () => {
        const reference: Reference = { kind: "artifact-table", path: "data/inputs/file-1/counts.csv", hash: HASH };
        expectRoundTrip(reference);
    });

    it("rejects an empty-string run", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-table", run: "", path: "p", hash: HASH }), "schema-mismatch");
    });
});
