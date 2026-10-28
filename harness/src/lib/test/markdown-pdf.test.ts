import { describe, expect, test } from "bun:test";

import { markdownImageSources, markdownToPdf } from "../markdown-pdf.js";
import { readPdfText } from "../pdf-text.js";

const CHART = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><style>.bar{fill:#c00}</style><rect class="bar" x="10" y="10" width="80" height="40"/><text x="10" y="80" font-size="12">TNF-α ≤ 0.05</text></svg>`;

describe("markdownToPdf", () => {
    test("renders the headings, the text with Greek letters, a table, and the text of an SVG chart", async () => {
        const markdown = [
            "# Interferon response",
            "",
            "The treatment raises **ISG15** and β-catenin stays flat.",
            "",
            "| gene | log2FC |",
            "| --- | --- |",
            "| ISG15 | 3.1 |",
            "",
            "![Volcano of the response](derived/volcano.svg)",
        ].join("\n");

        const pdf = await markdownToPdf({ markdown, title: "Summary", images: new Map([["derived/volcano.svg", { kind: "svg", svg: CHART }]]) });
        const text = await readPdfText(pdf, { first: 1, last: 5 });

        const page = text.pages.map((p) => p.text).join("\n");
        expect(page).toContain("Summary");
        expect(page).toContain("Interferon response");
        expect(page).toContain("β-catenin");
        expect(page).toContain("ISG15");
        expect(page).toContain("TNF-α ≤ 0.05");
        expect(page).toContain("Volcano of the response");
    });

    test("prints the alt text of an image that the caller did not give", async () => {
        const pdf = await markdownToPdf({ markdown: "![A missing figure](https://example.com/x.png)", images: new Map() });
        const text = await readPdfText(pdf, { first: 1, last: 1 });

        expect(text.pages[0]?.text).toContain("[A missing figure]");
    });
});

describe("markdownImageSources", () => {
    test("names each image once, also inside a list and a table", () => {
        const markdown = "![a](one.svg)\n\n- ![b](two.png)\n\n| x |\n| --- |\n| ![c](one.svg) |\n";

        expect(markdownImageSources(markdown)).toEqual(["one.svg", "two.png"]);
    });
});
