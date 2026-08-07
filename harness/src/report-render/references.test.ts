import { describe, expect, it } from "bun:test";

import type { Reference } from "../contracts/report-reference.js";
import { ReferenceLedger, renderReferenceList } from "./references.js";

describe("ReferenceLedger.mark", () => {
    it("numbers references by first appearance", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
        const second: Reference = { kind: "artifact-value", path: "runs/r1/b.csv", hash: "sha256:bbb", locator: { column: "padj", row: 1 } };
        const ledger = new ReferenceLedger();
        expect(ledger.mark(first)).toBe(1);
        expect(ledger.mark(second)).toBe(2);
        // The first reference keeps its number, thus a second appearance adds no entry.
        expect(ledger.mark(first)).toBe(1);
        expect(ledger.entries().length).toBe(2);
    });

    it("dedupes two field-identical references built with different key orders", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 3 } };
        // The same fields as `first`, with a different key order at the top level and inside the locator.
        const second: Reference = { hash: "sha256:aaa", locator: { row: 3, column: "padj" }, path: "runs/r1/a.csv", kind: "artifact-value" };
        const ledger = new ReferenceLedger();
        expect(ledger.mark(first)).toBe(1);
        expect(ledger.mark(second)).toBe(1);
        expect(ledger.entries().length).toBe(1);
    });

    it("distinguishes two references that differ in one field", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 3 } };
        const second: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 4 } };
        const ledger = new ReferenceLedger();
        expect(ledger.mark(first)).toBe(1);
        expect(ledger.mark(second)).toBe(2);
    });
});

describe("renderReferenceList", () => {
    it("names a derivation with its operation and its two input paths", () => {
        const derivation: Reference = {
            kind: "derivation",
            op: "ratio",
            inputs: [
                { kind: "artifact-value", path: "runs/r1/treated.csv", hash: "sha256:aaa", locator: { column: "count", row: 0 } },
                { kind: "artifact-value", path: "runs/r1/control.csv", hash: "sha256:bbb", locator: { column: "count", row: 0 } },
            ],
        };
        const ledger = new ReferenceLedger();
        ledger.mark(derivation);
        const list = renderReferenceList(ledger);
        expect(list).toContain("ratio");
        expect(list).toContain("runs/r1/treated.csv");
        expect(list).toContain("runs/r1/control.csv");
        // The entry sits under the marker anchor of its first appearance.
        expect(list).toContain(`id="ref-1"`);
    });

    it("gives an empty string for an empty ledger", () => {
        expect(renderReferenceList(new ReferenceLedger())).toBe("");
    });
});
