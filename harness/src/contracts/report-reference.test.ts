import { describe, expect, it } from "bun:test";

import { createFixtureResolver } from "../report-model/fixture-resolver.js";
import type { ReportSnapshot } from "../report-model/reference-resolver.js";
import { parseReference, serializeReference, type Reference } from "./report-reference.js";

const HASH = `sha256:${"a".repeat(64)}`;

/**
 * serializeReference validates nothing; it only encodes. A cast lets a test feed a malformed object
 * through the exact wire encoding, then assert that parseReference rejects it on the way back.
 */
function encodeUnchecked(value: unknown): string {
    return serializeReference(value as unknown as Reference);
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
        expect(parseReference(serializeReference(reference))).toEqual(reference);
    });

    it("round-trips an artifact-table with columns", () => {
        const reference: Reference = {
            kind: "artifact-table",
            run: "run-1",
            path: "runs/run-1/step-a/output/de.csv",
            hash: HASH,
            columns: ["gene", "log2FoldChange", "padj"],
        };
        expect(parseReference(serializeReference(reference))).toEqual(reference);
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
        expect(parseReference(serializeReference(reference))).toEqual(reference);
    });

    it("round-trips a citation", () => {
        const reference: Reference = {
            kind: "citation",
            idKind: "pmid",
            id: "12345",
            raw: "Author et al. 2020",
        };
        expect(parseReference(serializeReference(reference))).toEqual(reference);
    });

    it("round-trips an artifact-file", () => {
        const reference: Reference = {
            kind: "artifact-file",
            run: "run-1",
            path: "runs/run-1/step-b/figures/volcano.png",
            hash: HASH,
        };
        expect(parseReference(serializeReference(reference))).toEqual(reference);
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
        if (parsed === null) {
            throw new Error("expected the serialized reference to parse");
        }

        const resolver = createFixtureResolver();
        const fromOriginal = await resolver.resolve(reference, snapshot);
        const fromParsed = await resolver.resolve(parsed, snapshot);

        expect(fromParsed).toEqual(fromOriginal);
        expect(fromParsed).toEqual({ ok: true, value: { type: "scalar", value: 6 } });
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

describe("parseReference — null outcomes", () => {
    it("returns null for a wrong prefix", () => {
        expect(parseReference("wrong-prefix:v1:abc")).toBeNull();
    });

    it("returns null for a corrupt payload", () => {
        const sample = serializeReference({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text" });
        // The payload is base64url and holds no colon, thus the last colon marks the end of the prefix.
        const prefix = sample.slice(0, sample.lastIndexOf(":") + 1);
        const corrupt = prefix + Buffer.from("{ this is not json", "utf8").toString("base64url");
        expect(parseReference(corrupt)).toBeNull();
    });

    it("returns null for valid JSON that fails the schema", () => {
        expect(parseReference(encodeUnchecked({ foo: "bar" }))).toBeNull();
    });
});

describe("parseReference — schema rejection", () => {
    it("rejects an artifact reference without a hash", () => {
        expect(parseReference(encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", locator: { column: "c", row: 0 } }))).toBeNull();
    });

    it("rejects a derivation whose input is a derivation", () => {
        expect(
            parseReference(
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
            ),
        ).toBeNull();
    });

    it("rejects a locator with both rowFilter and row", () => {
        expect(
            parseReference(
                encodeUnchecked({
                    kind: "artifact-value",
                    run: "r",
                    path: "p",
                    hash: HASH,
                    locator: { column: "c", row: 0, rowFilter: { column: "c", op: "eq", value: 1 } },
                }),
            ),
        ).toBeNull();
    });

    it("rejects a locator with neither rowFilter nor row", () => {
        expect(parseReference(encodeUnchecked({ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c" } }))).toBeNull();
    });

    it("rejects an unknown kind", () => {
        expect(parseReference(encodeUnchecked({ kind: "made-up", run: "r", path: "p", hash: HASH }))).toBeNull();
    });

    it("rejects an extra unknown key", () => {
        expect(parseReference(encodeUnchecked({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text", extra: "nope" }))).toBeNull();
    });

    it("rejects a locator on an artifact-file", () => {
        expect(parseReference(encodeUnchecked({ kind: "artifact-file", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 } }))).toBeNull();
    });

    it("rejects a derivation with one input", () => {
        expect(
            parseReference(
                encodeUnchecked({
                    kind: "derivation",
                    op: "delta",
                    inputs: [{ kind: "artifact-value", run: "r", path: "p", hash: HASH, locator: { column: "c", row: 0 } }],
                }),
            ),
        ).toBeNull();
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
        expect(parseReference(serializeReference(reference))).toEqual(reference);
    });

    it("round-trips a hash-only assert on an artifact-table", () => {
        const reference: Reference = { kind: "artifact-table", run: "run-1", path: "a.csv", hash: HASH, assert: { hash: HASH } };
        expect(parseReference(serializeReference(reference))).toEqual(reference);
    });

    it("rejects an asserted value on an artifact-table", () => {
        expect(parseReference(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { value: 5 } }))).toBeNull();
    });

    it("rejects an asserted value on an artifact-file", () => {
        expect(parseReference(encodeUnchecked({ kind: "artifact-file", run: "r", path: "p", hash: HASH, assert: { value: 5 } }))).toBeNull();
    });

    it("rejects an asserted hash on a derivation", () => {
        expect(parseReference(encodeUnchecked({ kind: "derivation", op: "ratio", inputs: derivationInputs, assert: { hash: HASH } }))).toBeNull();
    });

    it("rejects an asserted hash on a citation", () => {
        expect(parseReference(encodeUnchecked({ kind: "citation", idKind: "doi", id: "10.1/x", raw: "text", assert: { hash: HASH } }))).toBeNull();
    });

    it("rejects a tolerance on an artifact-table", () => {
        expect(parseReference(encodeUnchecked({ kind: "artifact-table", run: "r", path: "p", hash: HASH, assert: { tolerance: 0.1 } }))).toBeNull();
    });
});
