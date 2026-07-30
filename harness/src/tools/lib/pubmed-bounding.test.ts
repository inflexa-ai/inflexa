import { describe, expect, it } from "bun:test";

import { boundArticleDetails, boundFullText } from "./pubmed-client.js";
import type { ArticleDetail, FullTextResult } from "./ncbi-utils.js";

/**
 * The two bounding functions behind the `pubmed` tool. They are unit-tested
 * directly because the interesting cases — a section larger than the whole
 * budget, an author list of hundreds — sit below the tool schema's own floors,
 * so they can only be reached from inside.
 */

const parsed: FullTextResult = {
    fullText: "",
    sections: [
        { heading: "Introduction", text: "a".repeat(100) },
        { heading: "Methods", text: "b".repeat(100) },
        { heading: "Results", text: "c".repeat(100) },
    ],
};

describe("boundFullText", () => {
    it("admits sections whole, in document order, until the budget would be exceeded", () => {
        const result = boundFullText(parsed, { maxChars: 250 });

        expect(result.sections.map((s) => s.heading)).toEqual(["Introduction", "Methods"]);
        expect(result.returnedChars).toBe(200);
        expect(result.totalChars).toBe(300);
        expect(result.truncated).toBe(true);
    });

    it("always returns the first section, even when it alone exceeds the budget", () => {
        const result = boundFullText(parsed, { maxChars: 10 });

        expect(result.sections.map((s) => s.heading)).toEqual(["Introduction"]);
        expect(result.returnedChars).toBe(100);
        expect(result.truncated).toBe(true);
    });

    it("reports every section in the outline regardless of what came back", () => {
        const result = boundFullText(parsed, { maxChars: 10 });

        expect(result.outline).toEqual([
            { heading: "Introduction", chars: 100, included: true },
            { heading: "Methods", chars: 100, included: false },
            { heading: "Results", chars: 100, included: false },
        ]);
    });

    it("filters by heading substring, case-insensitively", () => {
        const result = boundFullText(parsed, { sections: ["RESULTS"] });

        expect(result.sections.map((s) => s.heading)).toEqual(["Results"]);
        expect(result.fullText).toContain("## Results");
        expect(result.truncated).toBe(true);
    });

    it("returns everything when no filter and no budget pressure", () => {
        const result = boundFullText(parsed);

        expect(result.sections).toHaveLength(3);
        expect(result.truncated).toBe(false);
        expect(result.returnedChars).toBe(300);
    });

    it("yields an empty body when the filter matches no heading", () => {
        const result = boundFullText(parsed, { sections: ["supplementary"] });

        expect(result.sections).toEqual([]);
        expect(result.fullText).toBe("");
        expect(result.outline.every((o) => !o.included)).toBe(true);
    });
});

describe("boundArticleDetails", () => {
    const article: ArticleDetail = {
        pmid: "1",
        title: "t",
        abstract: "a",
        authors: Array.from({ length: 200 }, (_, i) => `Author ${i}`),
        journal: "j",
        year: "2021",
        doi: "d",
        meshTerms: Array.from({ length: 40 }, (_, i) => `Term ${i}`),
        pmcId: null,
    };

    it("trims a consortium author list to the leading names, keeping the count", () => {
        const [bounded] = boundArticleDetails([article]);

        expect(bounded!.authors).toHaveLength(5);
        expect(bounded!.authors[0]).toBe("Author 0");
        expect(bounded!.authorCount).toBe(200);
        expect(bounded!.meshTerms).toHaveLength(10);
        expect(bounded!.meshTermCount).toBe(40);
    });

    it("drops a list entirely at 0 without losing its size", () => {
        const [bounded] = boundArticleDetails([article], { maxAuthors: 0, maxMeshTerms: 0 });

        expect(bounded!.authors).toEqual([]);
        expect(bounded!.authorCount).toBe(200);
        expect(bounded!.meshTermCount).toBe(40);
    });

    it("leaves the abstract untouched — it is the reason to call details", () => {
        const [bounded] = boundArticleDetails([{ ...article, abstract: "x".repeat(5000) }]);

        expect(bounded!.abstract).toHaveLength(5000);
    });
});
