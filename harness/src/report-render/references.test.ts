import { describe, expect, it } from "bun:test";

import type { Reference } from "../contracts/report-reference.js";
import { renderBibliography, renderReferenceList } from "./views/references-view.js";
import { derivationChains, ReferenceLedger, type DerivationChain } from "./references.js";

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

    it("gives one number to one paper that two references name with different display text", () => {
        const first: Reference = { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al. Science. 2016." };
        const second: Reference = { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo 2016" };
        const ledger = new ReferenceLedger();

        // The key names the paper, thus the identity of the citation ladder reads the key and never the
        // serialization. A serialization identity would give one paper two numbers here.
        expect(ledger.mark(first)).toEqual({ ladder: "citation", n: 1 });
        expect(ledger.mark(second)).toEqual({ ladder: "citation", n: 1 });
        expect(ledger.citationEntries().length).toBe(1);
    });

    it("keeps two locators of one artifact apart", () => {
        const first: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
        const second: Reference = { kind: "artifact-value", path: "runs/r1/a.csv", hash: "sha256:aaa", locator: { column: "padj", row: 1 } };
        const ledger = new ReferenceLedger();

        // The provenance ladder keeps the whole serialization, because one file holds many cells.
        expect(ledger.mark(first).n).toBe(1);
        expect(ledger.mark(second).n).toBe(2);
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

    it("gives an empty string for a ledger that holds citations alone", () => {
        const ledger = new ReferenceLedger();
        ledger.mark({ kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" });

        // A citation belongs to the bibliography, thus the provenance list of such a page renders not at
        // all and its band carries no title.
        expect(renderReferenceList(ledger)).toBe("");
    });
});

describe("the chain line of a derived path", () => {
    const DERIVED = "report-sessions/t1/derived/merged.csv";

    /** One chain over two sources and one script. Each hash carries a long hex tail. */
    const chain: DerivationChain = {
        outputPath: DERIVED,
        sources: [
            { path: "runs/r1/de.csv", hash: `sha256:${"a".repeat(64)}` },
            { path: "runs/r1/counts.csv", hash: `sha256:${"b".repeat(64)}` },
        ],
        scriptHash: `sha256:${"c".repeat(64)}`,
    };

    /** A ledger that holds one whole-table binding over the derived path. */
    function ledgerOverDerived(): ReferenceLedger {
        const ledger = new ReferenceLedger();
        ledger.mark({ kind: "artifact-table", path: DERIVED, hash: `sha256:${"d".repeat(64)}` });
        return ledger;
    }

    it("names each source with its hash head, and the script hash head", () => {
        const list = renderReferenceList(ledgerOverDerived(), derivationChains([chain]));

        expect(list).toContain("runs/r1/de.csv");
        expect(list).toContain("runs/r1/counts.csv");
        expect(list).toContain(`<code class="report-ref-hash">${"a".repeat(12)}</code>`);
        expect(list).toContain(`<code class="report-ref-hash">${"b".repeat(12)}</code>`);
        expect(list).toContain(`<code class="report-ref-hash">${"c".repeat(12)}</code>`);
        // The head identifies the bytes. A whole hash reads as noise, thus no 64-character run reaches the
        // page and the algorithm name stays off the line.
        expect(list).not.toContain("a".repeat(13));
        expect(list).not.toContain(`sha256:${"a".repeat(12)}`);
    });

    it("keeps the artifact-table entry form over the chain line", () => {
        const list = renderReferenceList(ledgerOverDerived(), derivationChains([chain]));

        // A whole-table binding of a derived path reads as an artifact table, and the chain adds one line
        // under it.
        expect(list).toContain("Artifact table");
        expect(list).toContain(DERIVED);
        expect(list).toContain(`<div class="report-ref-chain">`);
    });

    it("renders no chain line for a path that the records do not hold", () => {
        const pinned = new ReferenceLedger();
        pinned.mark({ kind: "artifact-table", path: "runs/r1/de.csv", hash: `sha256:${"a".repeat(64)}` });

        // The chains hold one derived path, and this entry names another. Thus the entry reads exactly as
        // it does with no chains at all.
        expect(renderReferenceList(pinned, derivationChains([chain]))).toBe(renderReferenceList(pinned));
        expect(renderReferenceList(pinned)).not.toContain("report-ref-chain");
    });
});

describe("renderBibliography", () => {
    it("names the paper, the key, and the description of a citation that the pin recorded", () => {
        const paper: Reference = { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al." };
        const ledger = new ReferenceLedger();
        ledger.mark(paper);

        const list = renderBibliography(ledger, { "pmid:26997480": { citation: "Hugo et al. 2016", description: "The resistance paper." } });

        expect(list).toContain(`id="cite-1"`);
        expect(list).toContain("[1]");
        expect(list).toContain("Hugo et al. 2016");
        expect(list).toContain("pmid:26997480");
        expect(list).toContain(`<div class="report-cite-description">The resistance paper.</div>`);
    });

    it("names the key alone for a citation that the record map does not hold", () => {
        const paper: Reference = { kind: "citation", idKind: "doi", id: "10.1000/xyz", raw: "Roe 2021" };
        const ledger = new ReferenceLedger();
        ledger.mark(paper);

        const list = renderBibliography(ledger, {});

        expect(list).toContain(`id="cite-1"`);
        expect(list).toContain("doi:10.1000/xyz");
        expect(list).not.toContain("report-cite-source");
        expect(list).not.toContain("report-cite-description");
    });

    it("gives an empty string for a ledger that holds no citation", () => {
        const ledger = new ReferenceLedger();
        ledger.mark({ kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:aaa" });

        expect(renderBibliography(ledger)).toBe("");
    });
});
