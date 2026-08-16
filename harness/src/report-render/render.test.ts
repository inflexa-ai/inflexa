import { describe, expect, it } from "bun:test";
import { load } from "cheerio";

import type { Block, CitationBlock, MetricBlock, ReportDocument, TextBlock } from "../contracts/report-blocks.js";
import { ASSETS_DIR, PAGE_ASSETS } from "./assets.js";
import { DESIGN_CSS } from "./design.js";
import { FIXTURE_DOCUMENT, FIXTURE_VALUES } from "./fixture.js";
import { CHART_BOOTSTRAP, SECTION_SPY, TABLE_ENHANCER } from "./page.js";
import { renderReportPage } from "./render.js";
import type { RenderValues } from "./types.js";
import { SHOW_ALL_PREFIX, TABLE_ROW_CAP } from "./views/values.js";

/**
 * The site of the navigation brand. It is the one reference of the page that names a remote host.
 *
 * A brand link is a navigation, and a navigation costs no request. Thus the page still opens with no
 * network, and the stands-alone gate admits this one value.
 */
const BRAND_LINK = "https://inflexa.ai/";

/** One citation reference. A claim binding and a citation binding both admit it. */
const citation: CitationBlock["binding"] = { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" };

/** One scalar reference for a metric block. The renderer never reads it. */
const scalarRef: MetricBlock["value"] = { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };

/** The descriptor form of one `srcset` candidate: a pixel ratio such as `2x`, or a width such as `600w`. */
const SRCSET_DESCRIPTOR = /^\d+(?:\.\d+)?[wx]$/;

/**
 * Each candidate URL of one `srcset` value.
 *
 * A candidate URL holds no whitespace, and its descriptor follows it after whitespace. Thus whitespace
 * divides the list into a URL token and a descriptor token, and a comma divides two candidates that no
 * whitespace separates. A `data:` candidate holds its own commas, thus it stays whole.
 */
function srcsetCandidates(list: string): string[] {
    const candidates: string[] = [];
    for (const token of list.split(/\s+/)) {
        const trimmed = token.replace(/^,+|,+$/g, "");
        if (trimmed === "" || SRCSET_DESCRIPTOR.test(trimmed)) continue;
        if (trimmed.startsWith("data:")) {
            candidates.push(trimmed);
            continue;
        }
        for (const part of trimmed.split(",")) {
            if (part !== "") candidates.push(part);
        }
    }
    return candidates;
}

/**
 * Each `src`, `href`, and `srcset` value of the page, in document order.
 *
 * An attribute value rides a double quote or a single quote, and both forms are valid HTML. Thus the
 * pattern reads both, and a single-quoted remote source cannot pass the gate unread. A `srcset` value holds
 * a candidate list, thus it divides into its candidates.
 */
function attributeReferences(html: string): string[] {
    const references: string[] = [];
    for (const match of html.matchAll(/\b(srcset|src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const value = match[2] ?? match[3];
        if (match[1] === "srcset") references.push(...srcsetCandidates(value));
        else references.push(value);
    }
    return references;
}

/**
 * The tag name and the attribute name of each element that carries the given value in a reference
 * attribute, in document order. One element gives one entry for each attribute that names the value.
 *
 * The gate admits one remote value. A navigation to it costs no request, but a subresource with the same
 * value fetches on open. Thus the admission binds to the element, and a value alone never earns it.
 */
function referenceSites(html: string, value: string): string[] {
    const page = load(html);
    const sites: string[] = [];
    for (const element of page("[href], [src], [srcset]").toArray()) {
        for (const name of ["href", "src", "srcset"]) {
            const attribute = page(element).attr(name);
            if (attribute === undefined) continue;
            const values = name === "srcset" ? srcsetCandidates(attribute) : [attribute];
            if (values.includes(value)) sites.push(`${element.tagName}[${name}]`);
        }
    }
    return sites;
}

/**
 * Each remote-capable reference of a style sheet, without its quotes. The `@font-face` rules reach the page
 * through the inline sheet, thus the font references live here and not in an attribute.
 *
 * Three forms name a source. `url(...)` is the common one. A bare `@import` string and an `image-set()`
 * candidate each name a source with no `url()` wrapper, thus the `url(...)` pattern alone reads neither one.
 */
function styleReferences(css: string): string[] {
    const references: string[] = [];
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/g)) {
        references.push(match[1] ?? match[2] ?? match[3]);
    }
    for (const match of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/g)) {
        references.push(match[1] ?? match[2]);
    }
    // One declaration ends at its semicolon, thus the scan of a list stops there. A comma divides the
    // candidates, and each candidate leads with its quoted source. Thus a `type(...)` hint inside a
    // candidate never reads as a source of its own.
    for (const list of css.matchAll(/image-set\(([^;]*)/g)) {
        for (const candidate of list[1].split(",")) {
            const quoted = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(candidate);
            if (quoted !== null) references.push(quoted[1] ?? quoted[2]);
        }
    }
    return references;
}

describe("renderReportPage assembly", () => {
    it("gives byte-identical output for the same document and values", () => {
        const first = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES);
        const second = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES);
        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
    });

    it("renders from in-memory inputs with no directory and no file", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        expect(typeof html).toBe("string");
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("The cohort holds 48 primary lung adenocarcinoma biopsies.");
        expect(html).toContain("A teal point rises under hypoxia");
    });
});

describe("renderReportPage text lists", () => {
    /** One page whose section holds the given text block. */
    function pageOfText(block: TextBlock): ReturnType<typeof load> {
        const document: ReportDocument = { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks: [block] }] };
        return load(renderReportPage(document, {})._unsafeUnwrap());
    }

    it("holds the lead paragraph and the ordered list of six items", () => {
        const items = [
            "The cohort is small.",
            "The batch confounds.",
            "No cohort validates.",
            "The profile is bulk.",
            "The follow-up is short.",
            "One database.",
        ];
        const page = pageOfText({ kind: "text", id: "t1", content: { prose: "Six limits bound the reading.", list: { ordered: true, items } } });

        expect(page("p.report-prose").text()).toBe("Six limits bound the reading.");
        expect(page("ol.report-list li").length).toBe(6);
        expect(
            page("ol.report-list li")
                .toArray()
                .map((node) => page(node).text()),
        ).toEqual(items);
    });

    it("holds the unordered list alone for a block with an empty prose", () => {
        const page = pageOfText({ kind: "text", id: "t2", content: { prose: "", list: { ordered: false, items: ["One.", "Two.", "Three."] } } });

        expect(page("ul.report-list li").length).toBe(3);
        // An empty prose gives no paragraph, thus the band holds the list alone.
        expect(page("p.report-prose").length).toBe(0);
    });

    it("fills the content column with the list, the same as with a paragraph", () => {
        const listRules = [...DESIGN_CSS.matchAll(/\.report-list\s*\{([^}]*)\}/g)].map((match) => match[1]);
        expect(listRules.length).toBe(1);
        // A list reads at the measure of the prose around it, thus no inner width caps it.
        expect(listRules[0]).not.toContain("max-width");
        expect(listRules[0]).toContain("line-height: 1.7");
    });
});

describe("the page stands alone", () => {
    /** A page whose citation card carries a pinned record, thus the body holds a PubMed navigation. */
    function pageWithACitation(): string {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "citation", id: "cit1", binding: { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al." } }],
                },
            ],
        };
        return renderReportPage(document, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap();
    }

    /**
     * The rule reads the element and never the value. A navigation costs no request when the page opens,
     * thus an anchor admits a remote host. A `src`, a `srcset`, and a stylesheet source each fetch on
     * open, thus none of them admits one.
     */
    function remoteSitesOf(html: string): string[] {
        const remote = [...attributeReferences(html), ...styleReferences(DESIGN_CSS)].filter((value) => /^https?:/i.test(value));
        return [...new Set(remote.flatMap((value) => referenceSites(html, value)))];
    }

    it("names a remote host at a navigation anchor and at no other element", () => {
        for (const html of [renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap(), pageWithACitation()]) {
            const references = [...attributeReferences(html), ...styleReferences(DESIGN_CSS)];
            expect(references.length).toBeGreaterThan(0);

            // A remote value of the style sheet reaches no element of the page, thus it gives no site and
            // the empty list fails this equality.
            expect(remoteSitesOf(html)).toEqual(["a[href]"]);

            // Each other reference resolves inside the page directory: a staged asset, an inline data URI,
            // or an anchor of the page itself. The scheme test reads the start of the value, thus a
            // namespace URI inside a data URI never reads as a host.
            const local = (value: string) =>
                value.startsWith(`${ASSETS_DIR}/`) || value.startsWith("data:") || value.startsWith("#") || /^https?:/i.test(value);
            expect(references.filter((value) => !local(value))).toEqual([]);
        }
    });

    it("names the brand host one time, thus no second surface fetches it", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        expect(html.split(BRAND_LINK).length - 1).toBe(1);
    });

    it("names one manifest entry for each staged asset reference", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        const staged = new Set(PAGE_ASSETS.map((asset) => asset.file));
        const prefix = `${ASSETS_DIR}/`;
        const stagedReferences = [...attributeReferences(html), ...styleReferences(DESIGN_CSS)].filter((value) => value.startsWith(prefix));
        expect(stagedReferences.length).toBeGreaterThan(0);

        // A reference that names no manifest entry is a file that the caller never stages, thus the page
        // would open with a failed request.
        const unstaged = stagedReferences.filter((value) => !staged.has(value.slice(prefix.length)));
        expect(unstaged).toEqual([]);
    });
});

describe("the stands-alone extraction", () => {
    /** The remote references of a value list. The test reads the start of a value, as the gate does. */
    function remote(values: string[]): string[] {
        return values.filter((value) => /^https?:/i.test(value));
    }

    it("reads a remote source out of each attribute form that HTML admits", () => {
        // Each line carries one remote source in a form that the double-quoted `src`/`href` pattern misses.
        const doctored = [
            `<img srcset="assets/one.png 1x, https://cdn.example.com/two.png 2x"/>`,
            `<img src='https://cdn.example.com/single.png'/>`,
            `<a href="#top">anchor</a>`,
        ].join("");
        expect(remote(attributeReferences(doctored))).toEqual(["https://cdn.example.com/two.png", "https://cdn.example.com/single.png"]);
    });

    it("reads a remote source out of each style form that CSS admits", () => {
        const doctored = [
            `@import "https://cdn.example.com/sheet.css";`,
            `.a { background-image: image-set("https://cdn.example.com/one.avif" 1x, "assets/one.png" 2x); }`,
            `.b { background-image: url("assets/local.svg"); }`,
        ].join("\n");
        expect(remote(styleReferences(doctored))).toEqual(["https://cdn.example.com/sheet.css", "https://cdn.example.com/one.avif"]);
    });

    it("names the element and the attribute of each site of one value", () => {
        // The exemption of the gate rides on the anchor. Thus the extraction must divide a navigation from
        // a subresource that names the same value.
        const doctored = `<a href="https://inflexa.ai/">brand</a><script src="https://inflexa.ai/"></script>`;
        expect(referenceSites(doctored, "https://inflexa.ai/")).toEqual(["a[href]", "script[src]"]);
    });

    it("keeps a data URI whole and reads no scheme out of the middle of one", () => {
        // The namespace URI inside the data URI names no host to fetch. The value must stay one value, thus
        // no fragment of it reaches the gate as a reference of its own.
        const dataUri = `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E`;
        const references = [
            ...attributeReferences(`<img srcset="${dataUri} 1x, assets/one.png 2x"/>`),
            ...styleReferences(`.a { background-image: url("${dataUri}"); }`),
        ];
        expect(references).toEqual([dataUri, "assets/one.png", dataUri]);
        expect(remote(references)).toEqual([]);
    });
});

describe("renderReportPage metric grouping", () => {
    /** One metric block. The label doubles as the id, thus a failure names the block that it renders. */
    function metric(id: string): Block {
        return { kind: "metric", id, label: id, value: scalarRef };
    }

    /** One text block. A block of a different kind ends a metric run. */
    function text(id: string): Block {
        return { kind: "text", id, content: { prose: id } };
    }

    /** A one-section document over the given blocks. */
    function pageOf(blocks: Block[]): ReportDocument {
        return { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks }] };
    }

    /** One scalar entry for each metric id. */
    function scalars(...ids: string[]): RenderValues {
        const values: RenderValues = {};
        for (const id of ids) {
            values[id] = { type: "scalar", value: 1 };
        }
        return values;
    }

    /** The grid count, the card count, and the count of the cards inside a grid. */
    function counts(html: string): { grids: number; cards: number; grouped: number } {
        const page = load(html);
        return {
            grids: page(".report-metric-grid").length,
            cards: page(".stat-card").length,
            grouped: page(".report-metric-grid .stat-card").length,
        };
    }

    it("groups a run of three metrics into one grid of three cards", () => {
        const html = renderReportPage(pageOf([metric("m1"), metric("m2"), metric("m3")]), scalars("m1", "m2", "m3"))._unsafeUnwrap();
        expect(counts(html)).toEqual({ grids: 1, cards: 3, grouped: 3 });
    });

    it("leaves a lone metric between two texts as a bare card", () => {
        const html = renderReportPage(pageOf([text("t1"), metric("m1"), text("t2")]), scalars("m1"))._unsafeUnwrap();
        // One metric reads as one statistic, not as a row of statistics. Thus no grid wraps it.
        expect(counts(html)).toEqual({ grids: 0, cards: 1, grouped: 0 });
    });

    it("groups a run of two that ends the section", () => {
        const html = renderReportPage(pageOf([text("t1"), metric("m1"), metric("m2")]), scalars("m1", "m2"))._unsafeUnwrap();
        expect(counts(html)).toEqual({ grids: 1, cards: 2, grouped: 2 });
    });

    it("groups a run inside a nested section", () => {
        const nested: Block = {
            kind: "section",
            id: "inner",
            title: "Inner",
            blocks: [metric("m1"), metric("m2"), text("t1")],
        };
        const html = renderReportPage(pageOf([text("t0"), nested]), scalars("m1", "m2"))._unsafeUnwrap();
        expect(counts(html)).toEqual({ grids: 1, cards: 2, grouped: 2 });
    });

    it("reports the missing value of one metric inside a run", () => {
        const problems = renderReportPage(pageOf([metric("m1"), metric("m2"), metric("m3")]), scalars("m1", "m3"))._unsafeUnwrapErr();
        expect(problems.length).toBe(1);
        expect(problems[0].kind).toBe("missing-value");
        expect(problems[0].blockId).toBe("m2");
    });
});

describe("renderReportPage value validation", () => {
    it("reports a missing metric value and gives no HTML", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "metric", id: "m1", label: "L", value: scalarRef }] }],
        };
        // `_unsafeUnwrapErr` throws on an ok result, thus the direct chain asserts the err case and no HTML.
        const problems = renderReportPage(document, {})._unsafeUnwrapErr();
        expect(problems.length).toBe(1);
        expect(problems[0].kind).toBe("missing-value");
        expect(problems[0].blockId).toBe("m1");
    });

    it("reports a wrong shape when a chart gets a scalar", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "chart",
                            id: "c1",
                            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" },
                            chartType: "bar",
                            encoding: { x: "day", y: "count" },
                        },
                    ],
                },
            ],
        };
        const problems = renderReportPage(document, { c1: { type: "scalar", value: 1 } })._unsafeUnwrapErr();
        expect(problems.length).toBe(1);
        expect(problems[0].kind).toBe("wrong-shape");
        expect(problems[0].blockId).toBe("c1");
        // The detail names the expected shape.
        expect(problems[0].detail).toContain("table");
    });

    it("collects both problems when two entries are absent", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        { kind: "metric", id: "m1", label: "L", value: scalarRef },
                        { kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } },
                    ],
                },
            ],
        };
        const problems = renderReportPage(document, {})._unsafeUnwrapErr();
        expect(problems.length).toBe(2);
        const ids = problems.map((problem) => problem.blockId);
        expect(ids).toContain("m1");
        expect(ids).toContain("tbl");
    });

    it("renders a claim with no value entry", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [citation] }] }],
        };
        const result = renderReportPage(document, {});
        expect(result.isOk()).toBe(true);
        const html = result._unsafeUnwrap();
        expect(html).toContain("A claim.");
        expect(html).toContain(`href="#cite-1"`);
    });
});

describe("renderReportPage navigation and references", () => {
    it("targets the three section ids from the navigation", () => {
        const child: TextBlock = { kind: "text", id: "t", content: { prose: "x" } };
        const document: ReportDocument = {
            title: "T",
            sections: [
                { kind: "section", id: "sec-1", title: "One", blocks: [child] },
                { kind: "section", id: "sec-2", title: "Two", blocks: [child] },
                { kind: "section", id: "sec-3", title: "Three", blocks: [child] },
            ],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap();
        expect(html).toContain(`href="#sec-1"`);
        expect(html).toContain(`href="#sec-2"`);
        expect(html).toContain(`href="#sec-3"`);
    });

    it("lists one entry for a reference that a claim and a citation share", () => {
        const shared: CitationBlock["binding"] = { kind: "citation", idKind: "pmid", id: "999", raw: "Shared source" };
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        { kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [shared] },
                        { kind: "citation", id: "cit1", binding: shared },
                    ],
                },
            ],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap();
        // The bibliography holds one entry.
        expect(html.split(`<li id="cite-`).length - 1).toBe(1);
        // The claim marker and the citation marker point at the same entry.
        expect(html.split(`href="#cite-1"`).length - 1).toBe(2);
    });

    it("lists one entry for one paper that two blocks name with different display text", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "claim",
                            id: "c1",
                            content: { prose: "A claim." },
                            bindings: [{ kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al. Science. 2016." }],
                        },
                        {
                            kind: "citation",
                            id: "cit1",
                            binding: { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo 2016" },
                        },
                    ],
                },
            ],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap();

        // The key names the paper, and the raw text is the words of the author. Thus one paper takes one
        // number, and the two markers point at the one entry.
        expect(html.split(`<li id="cite-`).length - 1).toBe(1);
        expect(html.split(`href="#cite-1"`).length - 1).toBe(2);
    });
});

describe("the citation bibliography", () => {
    /** One page whose section holds two artifact claims and two citation blocks. */
    const twoOfEach: ReportDocument = {
        title: "T",
        sections: [
            {
                kind: "section",
                id: "s",
                title: "S",
                blocks: [
                    { kind: "claim", id: "c1", content: { prose: "The first claim." }, bindings: [scalarRef] },
                    {
                        kind: "claim",
                        id: "c2",
                        content: { prose: "The second claim." },
                        bindings: [{ kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:bbb" }],
                    },
                    { kind: "citation", id: "cit1", binding: citation, note: "the first paper" },
                    {
                        kind: "citation",
                        id: "cit2",
                        binding: { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al." },
                        note: "the second paper",
                    },
                ],
            },
        ],
    };

    it("shows the marker, the short citation, the note, and the PubMed link of a recorded key", () => {
        const html = renderReportPage(
            twoOfEach,
            {},
            { "pmid:26997480": { citation: "Hugo et al. 2016", description: "The resistance paper." } },
        )._unsafeUnwrap();
        const card = load(html)("div.report-citation").last();

        expect(card.find("span.report-cite-marker").text()).toBe("[2]");
        expect(card.find("a.report-citation-source").text()).toBe("Hugo et al. 2016");
        expect(card.find("a.report-citation-source").attr("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/26997480/");
        expect(card.find("span.report-citation-note").text()).toBe("the second paper");
        expect(card.find("span.report-citation-key").text()).toBe("pmid:26997480");
        // The card sits in the body, thus it carries the short citation and never the description.
        expect(card.text()).not.toContain("The resistance paper.");

        // The appendix entry names the paper beside the key, and it carries the description under them.
        const entry = load(html)("li#cite-2");
        expect(entry.text()).toContain("Hugo et al. 2016");
        expect(entry.text()).toContain("pmid:26997480");
        expect(entry.find("div.report-cite-description").text()).toBe("The resistance paper.");
    });

    it("adds no description line to a record that carries none", () => {
        const html = renderReportPage(twoOfEach, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap();

        expect(load(html)("li#cite-2").text()).toContain("Hugo et al. 2016");
        expect(load(html)("li#cite-2 div.report-cite-description").length).toBe(0);
    });

    it("shows the key and the note alone for a key that the record map does not hold", () => {
        const html = renderReportPage(twoOfEach, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap();
        const card = load(html)("div.report-citation").first();

        expect(card.find("a.report-citation-source").length).toBe(0);
        expect(card.find("span.report-citation-key").text()).toBe("pmid:12345");
        expect(card.find("span.report-citation-note").text()).toBe("the first paper");
        // The bibliography entry of a record-less key names the key alone.
        expect(load(html)("li#cite-1").text()).toContain("pmid:12345");
        expect(load(html)("li#cite-1 span.report-cite-source").length).toBe(0);
    });

    it("counts the artifact markers and the citation markers in two ladders", () => {
        const page = load(renderReportPage(twoOfEach, {})._unsafeUnwrap());

        expect(
            page("sup.report-marker a")
                .toArray()
                .map((node) => page(node).text()),
        ).toEqual(["1", "2"]);
        expect(
            page("span.report-cite-marker a")
                .toArray()
                .map((node) => page(node).text()),
        ).toEqual(["[1]", "[2]"]);
        // The two appendix lists each hold two entries, thus no marker points across the ladders.
        expect(page("ol.report-references li").length).toBe(2);
        expect(page("ol.report-citations li").length).toBe(2);
    });

    it("names PubMed as a navigation and never as a loaded resource", () => {
        const html = renderReportPage(twoOfEach, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap();
        const link = "https://pubmed.ncbi.nlm.nih.gov/26997480/";

        // A navigation costs no request when the page opens, thus the page still stands alone.
        expect(referenceSites(html, link)).toEqual(["a[href]"]);
    });

    it("renders a stored pin that holds no record map as it did before", () => {
        const withNoRecords = renderReportPage(twoOfEach, {})._unsafeUnwrap();
        const withEmptyRecords = renderReportPage(twoOfEach, {}, {})._unsafeUnwrap();

        expect(withNoRecords).toBe(withEmptyRecords);
        expect(withNoRecords).not.toContain("pubmed.ncbi.nlm.nih.gov");
        expect(withNoRecords).toContain("pmid:12345");
    });
});

describe("the page identity", () => {
    const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();

    it("closes the page with the Inflexa footer note", () => {
        expect(html).toContain("Powered by Inflexa");
    });

    it("links the navigation brand to the Inflexa site", () => {
        const brand = load(html)("a.report-nav-brand-name");
        expect(brand.length).toBe(1);
        expect(brand.attr("href")).toBe(BRAND_LINK);
    });

    it("names the engine on no surface", () => {
        // The page is the surface that a reader outside the team sees. The engine name is an internal term,
        // thus no heading, no badge, and no note carries it.
        expect(html).not.toContain("Cortex");
        expect(html).not.toContain("CORTEX");
    });
});

describe("the one content column", () => {
    /** A document that carries prose, a table, and a chart. The three kinds must read at one measure. */
    const columnDocument: ReportDocument = {
        title: "T",
        sections: [
            {
                kind: "section",
                id: "s",
                title: "S",
                blocks: [
                    { kind: "text", id: "t", content: { prose: "Prose." } },
                    { kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } },
                    {
                        kind: "chart",
                        id: "cht",
                        binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" },
                        chartType: "bar",
                        encoding: { x: "day", y: "count" },
                    },
                ],
            },
        ],
    };

    /** One table value for the table block and one for the chart block. */
    const columnValues: RenderValues = {
        tbl: { type: "table", rows: [{ day: "Mon", count: 1 }] },
        cht: { type: "table", rows: [{ day: "Mon", count: 1 }] },
    };

    it("holds the prose, the table, and the chart inside the one column", () => {
        const page = load(renderReportPage(columnDocument, columnValues)._unsafeUnwrap());
        expect(page(".report-content .report-prose").length).toBe(1);
        expect(page(".report-content .report-table").length).toBe(1);
        expect(page(".report-content .report-chart").length).toBe(1);
        // One column sits inside each container, thus one mechanism serves the hero, each band, and the
        // footer. A second mechanism would let one region drift away from the rest.
        expect(page(".report-content").length).toBe(page(".report-container").length);
    });

    it("caps no prose measure below the column width", () => {
        const proseRules = [...DESIGN_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.report-prose\s*\{([^}]*)\}/g)].map((match) => match[1]);
        expect(proseRules.length).toBeGreaterThan(0);
        // An inner measure on the prose alone leaves a half-empty band beside a full-width table.
        for (const body of proseRules) {
            expect(body).not.toContain("max-width");
        }
        // The width rides one token, thus each region reads the same value.
        expect(DESIGN_CSS).toMatch(/\.report-content\s*\{[^}]*max-width:\s*var\(--content-max\)/);
        expect(DESIGN_CSS).toMatch(/--content-max:\s*\d+px/);
    });
});

describe("the appendix bands", () => {
    /** A document whose one claim binds an artifact, thus the provenance ladder holds one entry. */
    const artifactDocument: ReportDocument = {
        title: "T",
        sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [scalarRef] }] }],
    };

    /** A document whose one claim binds a paper, thus the citation ladder holds the only entry. */
    const citationDocument: ReportDocument = {
        title: "T",
        sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [citation] }] }],
    };

    it("titles the provenance list Data provenance", () => {
        const html = renderReportPage(artifactDocument, {})._unsafeUnwrap();
        expect(html).toContain("Data provenance");
        // A reader expects literature under "References". This list is provenance, thus no heading of the
        // page carries that word.
        expect(html).not.toContain(">References<");
        expect(load(html)("h2.report-ref-title").length).toBe(1);
        // The page cites no paper, thus it carries no bibliography band.
        expect(html).not.toContain("Literature");
    });

    it("titles the bibliography Literature, and titles no provenance band over it", () => {
        const html = renderReportPage(citationDocument, {})._unsafeUnwrap();
        const titles = load(html)("h2.report-ref-title")
            .toArray()
            .map((node) => load(html)(node).text());

        // The one appendix of the page holds papers, thus it wears the literature title alone. A reader
        // never reads a paper under the provenance heading.
        expect(titles).toEqual(["Literature"]);
        expect(html).toContain(`<ol class="report-citations">`);
        expect(html).not.toContain(`<ol class="report-references">`);
    });

    it("titles the two bands apart when the page holds both kinds of reference", () => {
        const both: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [scalarRef, citation] }],
                },
            ],
        };
        const html = renderReportPage(both, {})._unsafeUnwrap();
        const titles = load(html)("h2.report-ref-title")
            .toArray()
            .map((node) => load(html)(node).text());

        // The provenance band comes first, and the literature band continues the band alternation.
        expect(titles).toEqual(["Data provenance", "Literature"]);
    });

    it("reads quieter than the body of the report", () => {
        const itemRules = [...DESIGN_CSS.matchAll(/\.report-ref-item\s*\{([^}]*)\}/g)].map((match) => match[1]);
        const sizes = itemRules.flatMap((body) => [...body.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1])));
        expect(sizes.length).toBeGreaterThan(0);
        // The body reads at 16px. A reader consults one entry of the appendix from a marker, thus the
        // appendix reads smaller than the text that sent the reader to it.
        expect(Math.max(...sizes)).toBeLessThan(16);
    });
});

describe("the section scrollspy", () => {
    /** The class that the spy writes. The design source holds the matching rule under the same name. */
    const ACTIVE_CLASS = "report-nav-link-active";

    /** The viewport height of the fake page. The observation box is the top band of this height. */
    const VIEWPORT_HEIGHT = 1000;

    /** One navigation link that records each class name that the script writes. */
    type FakeLink = { getAttribute: () => string; classList: { add: (name: string) => void; remove: (name: string) => void }; classes: Set<string> };

    /** One section that reports a movable top offset, as `getBoundingClientRect` does in a browser. */
    type FakeSection = { id: string; box: { top: number }; getBoundingClientRect: () => { top: number } };

    /**
     * The result of one spy run: the active links, the intersection driver, the section placement, and the
     * observed root margin.
     */
    type SpyRun = { active: () => string[]; intersect: (visible: boolean[]) => void; place: (tops: number[]) => void; rootMargin: string };

    function fakeSection(id: string, top: number): FakeSection {
        const box = { top };
        return { id, box, getBoundingClientRect: () => ({ top: box.top }) };
    }

    function fakeLink(href: string): FakeLink {
        const classes = new Set<string>();
        return {
            getAttribute: () => href,
            classList: {
                add: (name: string) => {
                    classes.add(name);
                },
                remove: (name: string) => {
                    classes.delete(name);
                },
            },
            classes,
        };
    }

    /**
     * Run the emitted spy over fake page globals. The script hands its callback to the fake observer, thus
     * the test drives the intersection directly and no real browser is necessary.
     *
     * The `tops` list places each section in the coordinates of the fake page. The default list puts the
     * first section at the top of the box and each other section one viewport lower.
     */
    function runSpy(ids: string[], hasObserver = true, tops?: number[]): SpyRun {
        const links = ids.map((id) => fakeLink(`#${id}`));
        const sections = ids.map((id, index) => fakeSection(id, tops?.[index] ?? index * VIEWPORT_HEIGHT));
        let callback: ((entries: { target: unknown; isIntersecting: boolean }[]) => void) | undefined;
        let rootMargin = "";
        const doc = {
            readyState: "complete",
            documentElement: { clientHeight: VIEWPORT_HEIGHT },
            querySelectorAll: () => links,
            getElementById: (id: string) => sections[ids.indexOf(id)] ?? null,
            addEventListener: () => undefined,
        };
        const observer = hasObserver
            ? function (cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void, options: { rootMargin: string }) {
                  callback = cb;
                  rootMargin = options.rootMargin;
                  return { observe: () => undefined };
              }
            : undefined;
        new Function("document", "IntersectionObserver", SECTION_SPY)(doc, observer);
        return {
            active: () => links.filter((link) => link.classes.has(ACTIVE_CLASS)).map((link) => link.getAttribute()),
            intersect: (visible: boolean[]) => callback?.(sections.map((target, index) => ({ target, isIntersecting: visible[index] }))),
            place: (next: number[]) => {
                for (let index = 0; index < sections.length; index++) {
                    sections[index].box.top = next[index];
                }
            },
            rootMargin,
        };
    }

    it("marks the section nearest the top and marks no other", () => {
        const run = runSpy(["sec-1", "sec-2", "sec-3"]);
        run.intersect([false, true, true]);
        expect(run.active()).toEqual(["#sec-2"]);
    });

    it("moves the mark when a different section reaches the top", () => {
        const run = runSpy(["sec-1", "sec-2"]);
        run.intersect([false, true]);
        run.intersect([true, true]);
        expect(run.active()).toEqual(["#sec-1"]);
    });

    it("shrinks the observation box to the top band of the viewport", () => {
        const run = runSpy(["sec-1"]);
        run.intersect([true]);
        // The negative bottom margin is what keeps one section in the box at a time.
        expect(run.rootMargin).toMatch(/0px 0px -\d+% 0px/);
    });

    it("marks the first link when every section starts below the box", () => {
        // The page opens at scroll 0, and each section then sits under the box. A capture of that page must
        // still show the reader a position in the report.
        const run = runSpy(["sec-1", "sec-2", "sec-3"], true, [400, 1400, 2400]);
        run.intersect([false, false, false]);
        expect(run.active()).toEqual(["#sec-1"]);
    });

    it("marks the last section above the box when a short tail leaves the box empty", () => {
        // A tail that is shorter than the viewport never lifts the last section into the top band. Without
        // the fallback the link of that section can never take the mark.
        const run = runSpy(["sec-1", "sec-2", "sec-3"], true, [-1200, -800, -400]);
        run.intersect([false, false, false]);
        expect(run.active()).toEqual(["#sec-3"]);
    });

    it("prefers the observed section over the fallback", () => {
        // The fallback holds the mark on the first section here, thus the observed section is the one that
        // proves which reading wins.
        const run = runSpy(["sec-1", "sec-2"], true, [-900, 2000]);
        run.intersect([false, true]);
        expect(run.active()).toEqual(["#sec-2"]);
    });

    it("reads the section positions again on each paint", () => {
        const run = runSpy(["sec-1", "sec-2"], true, [400, 1400]);
        run.intersect([false, false]);
        expect(run.active()).toEqual(["#sec-1"]);

        // A scroll moves each section. A cached position would hold the mark on the first link for the
        // whole page.
        run.place([-1000, 100]);
        run.intersect([false, false]);
        expect(run.active()).toEqual(["#sec-2"]);
    });

    it("reads the end of the box from the margin that the observer takes", () => {
        const run = runSpy(["sec-1"]);
        run.intersect([true]);
        const margin = /-(\d+)% 0px/.exec(run.rootMargin);
        expect(margin).not.toBeNull();
        // The script is browser source text, thus the test reads it as text. The fallback measures the same
        // box that the observer takes, and one constant feeds both. Thus the two readings cannot drift.
        expect(SECTION_SPY).toContain(`(100 - ${margin?.[1]})`);
        expect(SECTION_SPY).toContain("clientHeight");
        expect(SECTION_SPY).toContain("getBoundingClientRect().top <= end");
        expect(SECTION_SPY).toContain("active = nearestAbove()");
    });

    it("keeps the plain links in a browser with no observer", () => {
        const run = runSpy(["sec-1", "sec-2"], false);
        run.intersect([true, false]);
        // The highlight is decoration, thus its absence costs the reader no navigation.
        expect(run.active()).toEqual([]);
    });

    it("rides the page beside the other scripts, with its rule in the design source", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        expect(html).toContain(SECTION_SPY);
        expect(DESIGN_CSS).toContain(`.${ACTIVE_CLASS}`);
    });
});

describe("the table enhancer", () => {
    /** The print block of the sheet. It is the last block, thus the tail from its opening is its body. */
    const PRINT_BLOCK = DESIGN_CSS.slice(DESIGN_CSS.indexOf("@media print"));

    /** A page with one table of `count` rows and two columns. */
    function tablePage(count: number): { document: ReportDocument; values: RenderValues } {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, padj: 0.01 });
        }
        return {
            document: {
                title: "T",
                sections: [
                    {
                        kind: "section",
                        id: "s",
                        title: "S",
                        blocks: [{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } }],
                    },
                ],
            },
            values: { tbl: { type: "table", rows } },
        };
    }

    it("rides the page after the scrollspy", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        expect(html).toContain(TABLE_ENHANCER);
        expect(html.indexOf(TABLE_ENHANCER)).toBeGreaterThan(html.indexOf(SECTION_SPY));
    });

    it("bounds the markup and the script at one cap", () => {
        // The view hides the rows past the cap, and the script applies the same cap again after each sort
        // and each filter. Two numbers here would show one count and then show a different one.
        expect(TABLE_ENHANCER).toContain(`var CAP = ${TABLE_ROW_CAP};`);
    });

    it("writes the classes that the view emits and that the design source styles", () => {
        expect(TABLE_ENHANCER).toContain(`"report-row-hidden"`);
        expect(TABLE_ENHANCER).toContain(`"data-table-sort-asc"`);
        expect(TABLE_ENHANCER).toContain(`"data-table-sort-desc"`);
        expect(DESIGN_CSS).toContain(".report-row-hidden");
        expect(DESIGN_CSS).toContain(".data-table-sort-asc");
        expect(DESIGN_CSS).toContain(".data-table-sort-desc");
    });

    it("reads no locale in the filter comparison and no locale in the sort", () => {
        // `toLowerCase` is exact over the ASCII range of a gene name. A locale method gives different text
        // and a different order on a different host, thus the page would stop being deterministic.
        expect(TABLE_ENHANCER).toContain("toLowerCase()");
        expect(TABLE_ENHANCER).not.toContain("localeCompare");
        expect(TABLE_ENHANCER).not.toContain("toLocale");
    });

    it("touches neither the reveal gate nor the readiness sentinel", () => {
        // The enhancer registers no reveal work. A page that waited on the enhancer would signal late.
        expect(TABLE_ENHANCER).not.toContain("__inflexa");
    });

    it("hides a row under the live marker alone, thus a browser with no script shows every row", () => {
        // The script writes the marker on each card that it takes. Without the marker no rule hides a row,
        // thus the plain table stays complete and no row hides behind a toggle that cannot open.
        const selectors = [...DESIGN_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[^{}]*\.report-row-hidden[^{}]*\{/g)].map((match) => match[0]);
        expect(selectors.length).toBeGreaterThan(0);
        for (const selector of selectors) {
            expect(selector).toContain(".report-table-live");
        }
        expect(TABLE_ENHANCER).toContain(`var LIVE = "report-table-live";`);
        expect(TABLE_ENHANCER).toContain("card.classList.add(LIVE);");
    });

    it("shows a control under the live marker alone", () => {
        const css = DESIGN_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
        for (const control of ["report-table-controls", "report-table-toggle"]) {
            const rules = [...css.matchAll(new RegExp(`([^{}]*\\.${control}[^{}]*)\\{([^}]*)\\}`, "g"))];
            const withDisplay = rules.filter((rule) => /display:\s*[a-z-]+/.test(rule[2]));
            expect(withDisplay.length).toBeGreaterThan(0);
            for (const rule of withDisplay) {
                if (/display:\s*none/.test(rule[2])) {
                    continue;
                }
                // A rule that shows the control must name the marker. Without it a browser with no script
                // paints an input and a button that nothing drives.
                expect(rule[1]).toContain(".report-table-live");
            }
            // The default is hidden, thus the control appears only after the script takes the card.
            const hiddenByDefault = withDisplay.some((rule) => !rule[1].includes(".report-table-live") && /display:\s*none/.test(rule[2]));
            expect(hiddenByDefault).toBe(true);
        }
    });

    it("gives the sort affordance under the live marker alone", () => {
        const css = DESIGN_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
        const rules = [...css.matchAll(/([^{}]*\.data-table-sort[^{}]*)\{([^}]*)\}/g)];
        const affordance = rules.filter((rule) => /cursor:/.test(rule[2]) || /:hover/.test(rule[1]));
        expect(affordance.length).toBeGreaterThan(0);
        for (const rule of affordance) {
            // A zero-row table never takes the marker. Its headers must then promise no sort.
            expect(rule[1]).toContain(".report-table-live");
        }
    });

    it("shows every row in the print form and drops the controls", () => {
        // The base rule hides a capped row. The print rule comes after it, thus it wins on paper.
        expect(DESIGN_CSS.indexOf(".report-row-hidden")).toBeLessThan(DESIGN_CSS.indexOf("@media print"));
        expect(PRINT_BLOCK).toMatch(/\.report-row-hidden\s*\{[^}]*display:\s*table-row/);
        expect(PRINT_BLOCK).toMatch(/\.report-table-live \.report-table-controls,\s*\.report-table-live \.report-table-toggle\s*\{[^}]*display:\s*none/);
    });

    it("puts the sort headers, the filter, the hidden rows, and the toggle on a page over the cap", () => {
        const over = tablePage(TABLE_ROW_CAP + 3);
        const page = load(renderReportPage(over.document, over.values)._unsafeUnwrap());
        expect(page("th.data-table-sort").length).toBe(2);
        expect(page(".report-table-filter").length).toBe(1);
        expect(page("tbody tr").length).toBe(TABLE_ROW_CAP + 3);
        expect(page("tbody tr.report-row-hidden").length).toBe(3);
        expect(page(".report-table-toggle").text()).toBe(`Show all ${TABLE_ROW_CAP + 3}`);
    });

    it("leaves a page at the cap with no hidden row and no toggle", () => {
        const atCap = tablePage(TABLE_ROW_CAP);
        const page = load(renderReportPage(atCap.document, atCap.values)._unsafeUnwrap());
        expect(page("tbody tr.report-row-hidden").length).toBe(0);
        expect(page(".report-table-toggle").length).toBe(0);
    });
});

describe("the table enhancer behavior", () => {
    /** The event that a header handler reads. The key selects the branch, and the guard stops the scroll. */
    interface FakeEvent {
        key?: string;
        preventDefault: () => void;
    }

    /** One element in the shape that the script reads: a class set, an attribute map, and its handlers. */
    interface FakeNode {
        classes: Set<string>;
        attributes: Record<string, string>;
        classList: { add: (name: string) => void; remove: (name: string) => void };
        addEventListener: (name: string, handler: (event: FakeEvent) => void) => void;
        setAttribute: (name: string, value: string) => void;
        getAttribute: (name: string) => string | null;
        fire: (name: string, key?: string) => void;
    }

    type FakeRow = FakeNode & { cells: { getAttribute: (name: string) => string | null }[] };
    type FakeFilter = FakeNode & { value: string };
    type FakeToggle = FakeNode & { textContent: string };
    type FakeCard = FakeNode & { querySelector: (selector: string) => unknown };

    /** The handles of one mounted table: the elements, the painted order, and the two readings of it. */
    interface Mounted {
        card: FakeNode;
        headers: FakeNode[];
        filter: FakeFilter;
        toggle: FakeToggle;
        column: (index: number) => string[];
        visible: () => string[];
    }

    function fakeNode(initial: string[] = []): FakeNode {
        const classes = new Set(initial);
        const attributes: Record<string, string> = {};
        const handlers: Record<string, ((event: FakeEvent) => void)[]> = {};
        return {
            classes,
            attributes,
            classList: {
                add: (name) => {
                    classes.add(name);
                },
                remove: (name) => {
                    classes.delete(name);
                },
            },
            addEventListener: (name, handler) => {
                handlers[name] = [...(handlers[name] ?? []), handler];
            },
            setAttribute: (name, value) => {
                attributes[name] = value;
            },
            getAttribute: (name) => attributes[name] ?? null,
            fire: (name, key) => {
                for (const handler of handlers[name] ?? []) {
                    handler({ key, preventDefault: () => undefined });
                }
            },
        };
    }

    /**
     * Mount one table of raw cell values and run the emitted enhancer over it.
     *
     * The script is browser source text. Each global arrives as a parameter, thus these fakes are the whole
     * DOM that it drives and no real browser is necessary. `appendChild` moves a row to the end, as the
     * browser method does, thus the painted order is the order that a reader sees.
     */
    function mount(cells: string[][], withToggle = false): Mounted {
        const rows: FakeRow[] = cells.map((values) => ({
            ...fakeNode(["report-row"]),
            cells: values.map((value) => ({ getAttribute: (name: string) => (name === "data-value" ? value : null) })),
        }));
        const headers = (cells[0] ?? []).map((_, index) => {
            const header = fakeNode(["data-table-sort"]);
            header.attributes["data-sort-index"] = String(index);
            return header;
        });
        const filter: FakeFilter = { ...fakeNode(), value: "" };
        const toggle: FakeToggle = { ...fakeNode(["report-table-toggle"]), textContent: `${SHOW_ALL_PREFIX}${rows.length}` };
        const painted = [...rows];
        const body = {
            rows,
            appendChild: (node: FakeRow) => {
                const at = painted.indexOf(node);
                if (at >= 0) {
                    painted.splice(at, 1);
                }
                painted.push(node);
            },
        };
        const table = { querySelector: () => body, querySelectorAll: () => headers };
        const card: FakeCard = {
            ...fakeNode(["report-table"]),
            querySelector: (selector: string): unknown => {
                if (selector === "table.data-table") {
                    return table;
                }
                if (selector === ".report-table-filter") {
                    return filter;
                }
                return withToggle ? toggle : null;
            },
        };
        const doc = {
            readyState: "complete",
            documentElement: { classList: { add: () => undefined } },
            querySelectorAll: () => [card],
            addEventListener: () => undefined,
        };
        new Function("document", TABLE_ENHANCER)(doc);
        return {
            card,
            headers,
            filter,
            toggle,
            column: (index) => painted.map((row) => row.cells[index].getAttribute("data-value") ?? ""),
            visible: () => painted.filter((row) => !row.classes.has("report-row-hidden")).map((row) => row.cells[0].getAttribute("data-value") ?? ""),
        };
    }

    it("sorts a numeric column that holds a sentinel by magnitude", () => {
        const table = mount([["10"], ["NA"], ["9"]]);
        table.headers[0].fire("click");
        // One value that parses keeps the column numeric. Under a text order `10` would rank before `9`.
        expect(table.column(0)).toEqual(["9", "10", "NA"]);
        table.headers[0].fire("click");
        // The sentinel holds no rank, thus it stays at the end under both directions.
        expect(table.column(0)).toEqual(["10", "9", "NA"]);
        table.headers[0].fire("click");
        expect(table.column(0)).toEqual(["10", "NA", "9"]);
    });

    it("sorts a text column in code-unit order", () => {
        const table = mount([["b"], ["A"], ["a"]]);
        table.headers[0].fire("click");
        expect(table.column(0)).toEqual(["A", "a", "b"]);
    });

    it("cycles from the keyboard and writes the sort state of each header", () => {
        const table = mount([
            ["2", "x"],
            ["1", "y"],
        ]);
        table.headers[0].fire("keydown", "Enter");
        expect(table.column(0)).toEqual(["1", "2"]);
        expect(table.headers[0].attributes["aria-sort"]).toBe("ascending");
        expect(table.headers[1].attributes["aria-sort"]).toBe("none");
        table.headers[0].fire("keydown", " ");
        expect(table.headers[0].attributes["aria-sort"]).toBe("descending");
        // A key that names no action leaves the order and the state as they are.
        table.headers[0].fire("keydown", "a");
        expect(table.headers[0].attributes["aria-sort"]).toBe("descending");
    });

    it("filters on the raw values of a row and forms no match across two cells", () => {
        const table = mount([
            ["AB", "CD"],
            ["ZZ", "YY"],
        ]);
        table.filter.value = "bc";
        table.filter.fire("input");
        expect(table.visible()).toEqual([]);
        table.filter.value = "cd";
        table.filter.fire("input");
        expect(table.visible()).toEqual(["AB"]);
    });

    it("finds the text that the trim hides, because the filter reads the raw value", () => {
        const table = mount([["HALLMARK_HYPOXIA%MSigDB%M5891"], ["TP53"]]);
        table.filter.value = "m5891";
        table.filter.fire("input");
        expect(table.visible()).toEqual(["HALLMARK_HYPOXIA%MSigDB%M5891"]);
    });

    it("counts the kept rows on the toggle and hides the toggle at the cap", () => {
        const cells: string[][] = [];
        for (let index = 0; index < TABLE_ROW_CAP + 5; index += 1) {
            cells.push([`G${index}`]);
        }
        const table = mount(cells, true);
        table.filter.fire("input");
        expect(table.visible().length).toBe(TABLE_ROW_CAP);
        expect(table.toggle.textContent).toBe(`${SHOW_ALL_PREFIX}${TABLE_ROW_CAP + 5}`);
        expect(table.toggle.classes.has("report-table-toggle-off")).toBe(false);

        table.toggle.fire("click");
        expect(table.visible().length).toBe(TABLE_ROW_CAP + 5);
        expect(table.toggle.textContent).toBe("Show fewer");
        table.toggle.fire("click");

        // The filter keeps 11 rows: `G1` and `G10` through `G19`. Nothing then waits behind the toggle.
        table.filter.value = "g1";
        table.filter.fire("input");
        expect(table.visible().length).toBe(11);
        expect(table.toggle.textContent).toBe(`${SHOW_ALL_PREFIX}11`);
        expect(table.toggle.classes.has("report-table-toggle-off")).toBe(true);

        table.filter.value = "";
        table.filter.fire("input");
        expect(table.toggle.textContent).toBe(`${SHOW_ALL_PREFIX}${TABLE_ROW_CAP + 5}`);
        expect(table.toggle.classes.has("report-table-toggle-off")).toBe(false);
    });

    it("marks a card that it takes and leaves a zero-row card unmarked", () => {
        expect(mount([["a"]]).card.classes.has("report-table-live")).toBe(true);
        expect(mount([]).card.classes.has("report-table-live")).toBe(false);
    });
});

describe("renderReportPage readiness signal", () => {
    it("carries the theme-ready dispatch and the sentinel in the page markup", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        // The bootstrap signals readiness when it completes, thus a capture keys on a real event and returns
        // when the page is ready instead of at a timeout.
        expect(html).toContain("window.__inflexaThemeReady = true");
        expect(html).toContain('document.dispatchEvent(new Event("inflexa-theme-ready"))');
    });
});

describe("the chart bootstrap under a broken chart", () => {
    /** One chart container beside its option script, the pair that the bootstrap walks. */
    function fakeContainer(id: string): unknown {
        return {
            getAttribute: () => id,
            nextElementSibling: { getAttribute: () => "application/json", textContent: "{}" },
        };
    }

    /**
     * Run the emitted bootstrap over fake page globals. Each global arrives as a parameter, thus the script
     * reads the fakes and no real browser is necessary.
     */
    function runBootstrap(containers: unknown[], init: (container: unknown) => unknown): { ready: boolean; errors: string[] } {
        const errors: string[] = [];
        const win: Record<string, unknown> = { addEventListener: () => undefined };
        const doc = {
            querySelectorAll: () => containers,
            dispatchEvent: () => true,
            addEventListener: () => undefined,
        };
        const echarts = { init, getInstanceByDom: () => undefined };
        const pageConsole = { error: (line: string) => errors.push(line) };
        // The bootstrap is browser source text. Each global arrives as a parameter, thus the fake console
        // of the page is the one that the script writes to.
        new Function("window", "document", "echarts", "console", CHART_BOOTSTRAP)(win, doc, echarts, pageConsole);
        return { ready: win.__inflexaThemeReady === true, errors };
    }

    it("signals readiness and initializes the later chart when one chart throws", () => {
        const good: string[] = [];
        const { ready, errors } = runBootstrap([fakeContainer("bad"), fakeContainer("good")], (container) => {
            if ((container as { getAttribute: () => string }).getAttribute() === "bad") {
                throw new Error("bad option");
            }
            good.push("init");
            return { setOption: () => undefined };
        });

        // The readiness signal still fires, thus a capture returns on the event and not at its timeout.
        expect(ready).toBe(true);
        // The later chart still initializes, thus one broken chart costs one chart.
        expect(good).toEqual(["init"]);
        // The fault reaches the console, thus the capture reads it and the agent repairs that one chart.
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("bad");
        expect(errors[0]).toContain("bad option");
    });
});

describe("renderReportPage number format", () => {
    /** A one-section page over one metric block and one table block. */
    function pageOf(blocks: Block[]): ReportDocument {
        return { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks }] };
    }

    it("shows a long metric value in the short form and the full digits on the title", () => {
        const document = pageOf([{ kind: "metric", id: "m1", label: "Effect size", value: scalarRef }]);
        const html = renderReportPage(document, { m1: { type: "scalar", value: -5.7618623255 } })._unsafeUnwrap();
        const value = load(html)(".stat-card-value");
        expect(value.text()).toBe("-5.76");
        expect(value.attr("title")).toBe("-5.7618623255");
    });

    it("gives a metric whose form hides no digit no title attribute", () => {
        const document = pageOf([{ kind: "metric", id: "m1", label: "Genes tested", value: scalarRef }]);
        const html = renderReportPage(document, { m1: { type: "scalar", value: 18432 } })._unsafeUnwrap();
        const value = load(html)(".stat-card-value");
        expect(value.text()).toBe("18,432");
        expect(value.attr("title")).toBeUndefined();
    });

    it("formats each numeric table cell by its column and passes a text cell through", () => {
        const document = pageOf([{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } }]);
        const values: RenderValues = {
            tbl: {
                type: "table",
                columns: ["gene", "log2FoldChange", "padj", "direction"],
                rows: [{ gene: "TP53", log2FoldChange: -3.089028528355109, padj: 0.0000427777663038, direction: "up" }],
            },
        };
        const cells = load(renderReportPage(document, values)._unsafeUnwrap())(".data-table tbody td");
        expect(cells.map((_, cell) => load(cell).text()).get()).toEqual(["TP53", "-3.09", "4.3e-5", "up"]);
        expect(cells.eq(1).attr("title")).toBe("-3.089028528355109");
        expect(cells.eq(2).attr("title")).toBe("0.0000427777663038");
        expect(cells.eq(3).attr("title")).toBeUndefined();
    });
});

describe("the stat card value style rule", () => {
    /** The declaration body of each `.stat-card-value` rule of a style sheet, with each comment removed. */
    function statValueRules(css: string): string[] {
        return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.stat-card-value\s*\{([^}]*)\}/g)].map((match) => match[1]);
    }

    it("guards the overflow of the value", () => {
        const rules = statValueRules(DESIGN_CSS);
        expect(rules.length).toBeGreaterThan(0);

        // A value that the number format cannot shorten, for example a long identifier, would paint past
        // the card edge without the guard.
        expect(rules.some((body) => /(?:^|;)\s*overflow-wrap\s*:\s*anywhere\b/.test(body))).toBe(true);
    });
});

describe("renderReportPage escaping", () => {
    it("keeps a script tag in the title as text in the title and the heading", () => {
        const document: ReportDocument = {
            title: "Report <script>alert(1)</script>",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "text", id: "t", content: { prose: "x" } }] }],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap();
        expect(html).toContain("<title>Report &lt;script&gt;alert(1)&lt;/script&gt;</title>");
        // The heading content holds the escaped form between its open and close tags.
        expect(html).toContain(">Report &lt;script&gt;alert(1)&lt;/script&gt;<");
        // The hostile tag never reaches the page as a live element.
        expect(html).not.toContain("<script>alert(1)");
    });
});
