import { describe, expect, it } from "bun:test";
import { load } from "cheerio";

import type { Block, CitationBlock, MetricBlock, ReportDocument, TextBlock } from "../contracts/report-blocks.js";
import { ASSETS_DIR, PAGE_ASSETS } from "./assets.js";
import { DESIGN_CSS } from "./design.js";
import { FIXTURE_DOCUMENT, FIXTURE_VALUES } from "./fixture.js";
import { CHART_BOOTSTRAP } from "./page.js";
import { renderReportPage } from "./render.js";
import type { RenderValues } from "./types.js";

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

describe("the page stands alone", () => {
    it("holds no attribute reference and no style reference with a remote scheme", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        const references = [...attributeReferences(html), ...styleReferences(DESIGN_CSS)];
        expect(references.length).toBeGreaterThan(0);

        // The scheme test reads the start of the value. A namespace URI inside a data URI names no host to
        // fetch, thus the test must not read a scheme out of the middle of a value.
        const remote = references.filter((value) => /^https?:/i.test(value));
        expect(remote).toEqual([]);

        // Each reference resolves inside the page directory: a staged asset, an inline data URI, or an
        // anchor of the page itself.
        const foreign = references.filter((value) => !(value.startsWith(`${ASSETS_DIR}/`) || value.startsWith("data:") || value.startsWith("#")));
        expect(foreign).toEqual([]);
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
        expect(html).toContain(`href="#ref-1"`);
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
        // The reference list holds one entry.
        expect(html.split(`<li id="ref-`).length - 1).toBe(1);
        // The claim marker and the citation marker point at the same entry.
        expect(html.split(`href="#ref-1"`).length - 1).toBe(2);
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
