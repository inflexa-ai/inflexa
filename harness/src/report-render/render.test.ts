import { describe, expect, it } from "bun:test";

import type { CitationBlock, MetricBlock, ReportDocument, TextBlock } from "../contracts/report-blocks.js";
import { ASSETS_DIR, PAGE_ASSETS } from "./assets.js";
import { DESIGN_CSS } from "./design.js";
import { FIXTURE_DOCUMENT, FIXTURE_VALUES } from "./fixture.js";
import { CHART_BOOTSTRAP } from "./page.js";
import { renderReportPage } from "./render.js";

/** One citation reference. A claim binding and a citation binding both admit it. */
const citation: CitationBlock["binding"] = { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" };

/** One scalar reference for a metric block. The renderer never reads it. */
const scalarRef: MetricBlock["value"] = { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };

/**
 * Each `src` value and each `href` value of the page, in document order. The markup runtime quotes every
 * attribute value with a double quote, thus one pattern reads them all.
 */
function attributeReferences(html: string): string[] {
    return [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
}

/**
 * Each `url(...)` value of a style sheet, without its quotes. The `@font-face` rules reach the page through
 * the inline sheet, thus the font references live here and not in an attribute.
 */
function styleReferences(css: string): string[] {
    const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/g;
    return [...css.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
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
