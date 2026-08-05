import { describe, expect, it } from "bun:test";

import { createFixtureResolver } from "../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../report-model/reference-resolver.js";
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

describe("parseReference — cross-session resolution", () => {
    it("resolves a parsed reference to the same value as the original", async () => {
        const snapshot: ReportSnapshot = {
            artifacts: {
                "runs/run-1/step-a/output/de.csv": {
                    hash: HASH,
                    rows: [{ gene: "TP53", log2FoldChange: 6 }],
                },
            },
        };
        const reference: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: "runs/run-1/step-a/output/de.csv",
            hash: HASH,
            locator: { column: "log2FoldChange", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
        };
        const parsed = parseReference(serializeReference(reference));
        if (parsed.isErr()) {
            throw new Error("expected the serialized reference to parse");
        }

        const resolver = createFixtureResolver();
        const fromOriginal = await resolver.resolve(reference, snapshot);
        const fromParsed = await resolver.resolve(parsed.value, snapshot);

        expect(fromParsed.isOk()).toBe(fromOriginal.isOk());
        expect(fromParsed._unsafeUnwrap()).toEqual(fromOriginal._unsafeUnwrap());
        expect(fromParsed._unsafeUnwrap()).toEqual({ type: "scalar", value: 6 });
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
});

describe("parseReference — the per-kind assert shape", () => {
    /** Two grounded inputs, so that a rejected derivation is rejected for its assert and nothing else. */
    const derivationInputs = [
        { kind: "artifact-value", run: "r", path: "a.csv", hash: HASH, locator: { column: "value", row: 0 } },
        { kind: "artifact-value", run: "r", path: "b.csv", hash: HASH, locator: { column: "value", row: 0 } },
    ];

    it("round-trips a hash-only assert on an artifact-value", () => {
        const reference: Reference = {
            kind: "artifact-value",
            run: "run-1",
            path: "a.csv",
            hash: HASH,
            locator: { column: "value", row: 0 },
            assert: { hash: HASH },
        };
        expectRoundTrip(reference);
    });

    it("round-trips a hash-only assert on an artifact-table", () => {
        const reference: Reference = { kind: "artifact-table", run: "run-1", path: "a.csv", hash: HASH, assert: { hash: HASH } };
        expectRoundTrip(reference);
    });

    it("rejects an asserted value on an artifact-table", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { value: 5 } }), "schema-mismatch");
    });

    it("rejects an asserted value on an artifact-file", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-file", run: "r", path: "p", hash: HASH, assert: { value: 5 } }), "schema-mismatch");
    });

    it("rejects an asserted hash on a derivation", () => {
        expectParseError(encodeUnchecked({ kind: "derivation", op: "ratio", inputs: derivationInputs, assert: { hash: HASH } }), "schema-mismatch");
    });

    it("rejects an asserted hash on a citation", () => {
        expectParseError(encodeUnchecked({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text", assert: { hash: HASH } }), "schema-mismatch");
    });

    it("rejects a tolerance on an artifact-table", () => {
        expectParseError(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { tolerance: 0.1 } }), "schema-mismatch");
    });
});
