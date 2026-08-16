import { describe, expect, it } from "bun:test";

import type { Reference } from "../contracts/report-reference.js";
import { renderReferenceList } from "./views/references-view.js";
import { ReferenceLedger } from "./references.js";

describe("ReferenceLedger.mark", () => {
    it("numbers references by first appearance", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
        const second: Reference = { kind: "artifact-value", path: "runs/r1/b.csv", hash: "sha256:bbb", locator: { column: "padj", row: 1 } };
        const ledger = new ReferenceLedger();
        expect(ledger.mark(first)).toEqual({ ladder: "provenance", n: 1 });
        expect(ledger.mark(second)).toEqual({ ladder: "provenance", n: 2 });
        // The first reference keeps its number, thus a second appearance adds no entry.
        expect(ledger.mark(first)).toEqual({ ladder: "provenance", n: 1 });
        expect(ledger.provenanceEntries().length).toBe(2);
    });

    it("dedupes two field-identical references built with different key orders", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 3 } };
        // The same fields as `first`, with a different key order at the top level and inside the locator.
        const second: Reference = { hash: "sha256:aaa", locator: { row: 3, column: "padj" }, path: "runs/r1/a.csv", kind: "artifact-value" };
        const ledger = new ReferenceLedger();
        expect(ledger.mark(first).n).toBe(1);
        expect(ledger.mark(second).n).toBe(1);
        expect(ledger.provenanceEntries().length).toBe(1);
    });

    it("distinguishes two references that differ in one field", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 3 } };
        const second: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 4 } };
        const ledger = new ReferenceLedger();
        expect(ledger.mark(first).n).toBe(1);
        expect(ledger.mark(second).n).toBe(2);
    });

    it("counts a citation in its own ladder", () => {
        const artifact: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
        const paper: Reference = { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" };
        const secondPaper: Reference = { kind: "citation", idKind: "pmid", id: "999", raw: "Roe 2021" };
        const ledger = new ReferenceLedger();

        // The artifact takes the first number of the provenance ladder, and the paper takes the first
        // number of the citation ladder. Thus one page carries the two sequences apart.
        expect(ledger.mark(artifact)).toEqual({ ladder: "provenance", n: 1 });
        expect(ledger.mark(paper)).toEqual({ ladder: "citation", n: 1 });
        expect(ledger.mark(secondPaper)).toEqual({ ladder: "citation", n: 2 });
        expect(ledger.provenanceEntries().length).toBe(1);
        expect(ledger.citationEntries().length).toBe(2);
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

    it("names the paper beside the key of a citation that the pin recorded", () => {
        const paper: Reference = { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al." };
        const ledger = new ReferenceLedger();
        ledger.mark(paper);

        const list = renderReferenceList(ledger, { "pmid:26997480": { citation: "Hugo et al. 2016", description: "The resistance paper." } });

        expect(list).toContain(`id="cite-1"`);
        expect(list).toContain("[1]");
        expect(list).toContain("Hugo et al. 2016");
        expect(list).toContain("pmid:26997480");
    });

    it("names the key alone for a citation that the record map does not hold", () => {
        const paper: Reference = { kind: "citation", idKind: "doi", id: "10.1000/xyz", raw: "Roe 2021" };
        const ledger = new ReferenceLedger();
        ledger.mark(paper);

        const list = renderReferenceList(ledger, {});

        expect(list).toContain(`id="cite-1"`);
        expect(list).toContain("doi:10.1000/xyz");
        expect(list).not.toContain("report-cite-source");
    });
});
