import { describe, expect, it } from "bun:test";

import type { ClaimBlock, SectionBlock, TextBlock } from "../../contracts/report-blocks.js";
import type { Reference } from "../../contracts/report-reference.js";
import { renderClaim, renderNav, renderSection, renderText } from "./prose.js";
import { ReferenceLedger } from "../references.js";

describe("renderText", () => {
    it("splits prose on a blank line into paragraphs", () => {
        const block: TextBlock = { kind: "text", id: "t1", content: { prose: "First paragraph.\n\nSecond paragraph." } };
        const html = renderText(block);
        expect(html.split("<p ").length - 1).toBe(2);
        expect(html).toContain("First paragraph.");
        expect(html).toContain("Second paragraph.");
    });

    it("renders the ordered list of six items after the lead paragraph", () => {
        const items = [
            "The cohort is small.",
            "The batch confounds.",
            "No cohort validates.",
            "The profile is bulk.",
            "The follow-up is short.",
            "One database.",
        ];
        const block: TextBlock = { kind: "text", id: "t2", content: { prose: "Six limits bound the reading.", list: { ordered: true, items } } };

        const html = renderText(block);

        // The lead sentence introduces the enumeration, thus the list comes after the paragraph.
        expect(html.indexOf("<p ")).toBeLessThan(html.indexOf("<ol "));
        expect(html).toContain("Six limits bound the reading.");
        expect(html.split("<li ").length - 1).toBe(6);
        for (const item of items) {
            expect(html).toContain(item);
        }
        expect(html).not.toContain("<ul ");
    });

    it("renders an unordered list alone when the prose is empty", () => {
        const block: TextBlock = { kind: "text", id: "t3", content: { prose: "", list: { ordered: false, items: ["One.", "Two.", "Three."] } } };

        const html = renderText(block);

        expect(html).toContain("<ul ");
        expect(html.split("<li ").length - 1).toBe(3);
        // An empty prose gives no paragraph, thus the page carries no empty line over the list.
        expect(html).not.toContain("<p ");
    });

    it("renders a block with no list exactly as it renders one that never had the field", () => {
        const block: TextBlock = { kind: "text", id: "t4", content: { prose: "First paragraph.\n\nSecond paragraph." } };

        expect(renderText(block)).toBe(`<p class="report-prose">First paragraph.</p><p class="report-prose">Second paragraph.</p>`);
    });

    it("keeps a script tag in an item as text", () => {
        const block: TextBlock = { kind: "text", id: "t5", content: { prose: "", list: { ordered: true, items: ["<script>alert(1)</script> is a risk."] } } };

        const html = renderText(block);

        // An item takes the escape of a paragraph, thus no item reaches the page as markup.
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>");
    });
});

describe("renderClaim", () => {
    it("gives two claims that share one reference the same marker number", () => {
        const reference: Reference = { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" };
        const claimA: ClaimBlock = { kind: "claim", id: "c1", content: { prose: "The first claim." }, bindings: [reference] };
        const claimB: ClaimBlock = { kind: "claim", id: "c2", content: { prose: "The second claim." }, bindings: [reference] };
        const ledger = new ReferenceLedger();
        const htmlA = renderClaim(claimA, ledger);
        const htmlB = renderClaim(claimB, ledger);
        // A citation binding marks in the bracket ladder, thus the two claims point at the bibliography.
        expect(htmlA).toContain(`href="#cite-1"`);
        expect(htmlB).toContain(`href="#cite-1"`);
        // The shared reference holds one entry, thus the ledger counts it one time.
        expect(ledger.citationEntries().length).toBe(1);
    });

    it("gives an artifact binding a superscript and a citation binding a bracket", () => {
        const artifact: Reference = { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
        const paper: Reference = { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" };
        const claim: ClaimBlock = { kind: "claim", id: "c4", content: { prose: "A claim." }, bindings: [artifact, paper] };

        const html = renderClaim(claim, new ReferenceLedger());

        // The two ladders each start at one, thus the form of the marker states which list it points at.
        expect(html).toContain(`href="#ref-1"`);
        expect(html).toContain(`href="#cite-1"`);
        expect(html).toContain("[1]");
    });

    it("keeps a script tag in the prose as text", () => {
        const reference: Reference = { kind: "citation", idKind: "pmid", id: "1", raw: "x" };
        const claim: ClaimBlock = { kind: "claim", id: "c3", content: { prose: "<script>alert(1)</script> is a risk." }, bindings: [reference] };
        const html = renderClaim(claim, new ReferenceLedger());
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>");
    });
});

describe("renderSection", () => {
    const section: SectionBlock = { kind: "section", id: "sec-1", title: "Overview", blocks: [{ kind: "text", id: "t", content: { prose: "x" } }] };

    it("renders h2 at depth 0", () => {
        const html = renderSection(section, 0, "");
        expect(html).toContain("<h2");
        expect(html).toContain(`id="sec-1"`);
    });

    it("renders h3 at depth 1", () => {
        expect(renderSection(section, 1, "")).toContain("<h3");
    });

    it("renders h4 at depth 3", () => {
        expect(renderSection(section, 3, "")).toContain("<h4");
    });

    it("wraps the child markup as raw content", () => {
        const html = renderSection(section, 0, "<p>child</p>");
        expect(html).toContain("</h2><p>child</p></section>");
    });
});

describe("renderNav", () => {
    it("targets each top-level section by its block id", () => {
        const child: TextBlock = { kind: "text", id: "t", content: { prose: "x" } };
        const first: SectionBlock = { kind: "section", id: "sec-1", title: "Overview", blocks: [child] };
        const second: SectionBlock = { kind: "section", id: "sec-2", title: "Results", blocks: [child] };
        const html = renderNav([first, second]);
        expect(html).toContain(`href="#sec-1"`);
        expect(html).toContain(`href="#sec-2"`);
        expect(html).toContain("Overview");
        expect(html).toContain("Results");
    });

    it("links the brand to the Inflexa site", () => {
        const child: TextBlock = { kind: "text", id: "t", content: { prose: "x" } };
        const html = renderNav([{ kind: "section", id: "sec-1", title: "Overview", blocks: [child] }]);
        expect(html).toContain(`<a class="report-nav-brand-name" href="https://inflexa.ai/">inflexa</a>`);
    });
});
