/**
 * The validity gate of the rendered page.
 *
 * The markup types carry a permissive index signature. Thus an intrinsic element accepts an unknown
 * attribute in silence, and a misspelled attribute compiles clean. The type system cannot close this hole.
 *
 * This gate closes the hole at test time. `html-validate` validates the whole page as HTML, and
 * `csstree-validator` validates each inline style property and value. Both run offline, with no network
 * and no browser.
 *
 * A rule that fails on a deliberate design property of the page turns off here, with its reason beside it.
 * A rule never turns off to hide a real defect.
 */

import { describe, expect, it } from "bun:test";
// `csstree-validator` ships no type declarations, and the harness ignores `src/**/*.d.ts`, thus no local
// declaration can type the module. The directive accepts the untyped import, and the cast below pins the
// one signature that the gate uses.
// @ts-expect-error the module resolves without a type declaration.
import { validate as validateCssRaw } from "csstree-validator";
import { HtmlValidate } from "html-validate";

import type { ReportDocument } from "../contracts/report-blocks.js";
import { DESIGN_CSS } from "./design.js";
import { FIXTURE_DOCUMENT, FIXTURE_PROVENANCE, FIXTURE_VALUES } from "./fixture.js";
import { renderReportPage } from "./render.js";
import type { RenderValues } from "./types.js";

/** One `csstree-validator` finding. It names the property at fault, the class of the fault, and the message. */
type CssFinding = { name: string; message: string; property?: string };

/** The one signature that the gate uses. The cast gives the untyped import a precise type. */
const validateCss = validateCssRaw as (css: string, filename?: string) => CssFinding[];

/**
 * The HTML validator with the recommended preset. Two rules turn off, because the page rejects each one on
 * a deliberate design property. The rest of the preset stays on, thus the gate still catches a real defect
 * such as an unknown attribute or a style attribute that a view emits.
 */
const htmlValidate = new HtmlValidate({
    extends: ["html-validate:recommended"],
    rules: {
        // The renderer prints `<!doctype html>` in lowercase on purpose. A pinned render test asserts this
        // exact form, and the lowercase form is valid HTML5.
        "doctype-style": "off",
        // The markup runtime prints each void element in the self-closed form, for example `<meta/>` and
        // `<img/>`. The trailing slash is inert in HTML5, thus the compact form is a runtime property.
        "void-style": "off",
    },
});

/** Each finding of one validation, as the rule, the element, and the message. A failure reads as its own cause. */
async function htmlFindings(html: string): Promise<string[]> {
    const report = await htmlValidate.validateString(html);
    return report.results.flatMap((result) => result.messages.map((message) => `${message.ruleId} at ${message.selector ?? "?"}: ${message.message}`));
}

describe("the rendered page validates as HTML and CSS", () => {
    it("passes the offline HTML validation with the recommended preset", async () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;
        expect(await htmlFindings(html)).toEqual([]);
    });

    it("passes the same validation with the lineage stamp and the controls", async () => {
        // The provenance adds a data attribute to each grounded block and a control beside each marker. Both
        // ride the same gate, thus a misspelled attribute and a control in an illegal place fail here.
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES, undefined, undefined, FIXTURE_PROVENANCE)._unsafeUnwrap().html;
        expect(await htmlFindings(html)).toEqual([]);
    });

    it("passes the CSS property-syntax validation over DESIGN_CSS", () => {
        // `csstree-validator` skips a custom property by design, thus the `--color-*` tokens never report.
        // Each known property and value must match the css-tree grammar.
        const errors = validateCss(DESIGN_CSS, "design.css");
        const findings = errors.map((error) => `${error.property ?? error.name}: ${error.message}`);
        expect(findings).toEqual([]);
    });
});

describe("a raw script sink stays hardened", () => {
    /** A chart cell that tries to close the JSON script element too soon and to open a live script. */
    const hostileCell = "</script><script>alert(1)</script>";

    /** A document whose chart binds a string column that holds the hostile cell. The column feeds the x axis. */
    const hostileDocument: ReportDocument = {
        title: "Raw sink",
        sections: [
            {
                kind: "section",
                id: "sec",
                title: "Sink",
                blocks: [
                    {
                        kind: "chart",
                        id: "cht",
                        binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" },
                        chartType: "bar",
                        encoding: { x: "label", y: "count" },
                    },
                ],
            },
        ],
    };

    /** The chart table. The hostile cell rides the `label` column, thus it reaches the derived option and the JSON sink. */
    const hostileValues: RenderValues = {
        cht: {
            type: "table",
            rows: [
                { label: hostileCell, count: 5 },
                { label: "safe", count: 7 },
            ],
        },
    };

    it("keeps the hostile cell escaped in the inline JSON and the page whole", () => {
        const html = renderReportPage(hostileDocument, hostileValues)._unsafeUnwrap().html;

        // The `<` of the hostile cell reaches the inline JSON as the `\u003c` sequence.
        expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");

        // The page holds no early-closed script element and no injected live script.
        expect(html).not.toContain("</script><script>alert(1)</script>");
        expect(html).not.toContain("<script>alert(1)");

        // The inline JSON parses whole over the first `</script>`, thus the escape kept the element intact.
        // The cell round-trips byte for byte, thus the escape is transparent to the reader.
        const match = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(html);
        if (match === null) {
            throw new Error("The page holds no application/json script element.");
        }
        const parsed = JSON.parse(match[1]) as { xAxis: { data: unknown[] } };
        expect(parsed.xAxis.data).toContain(hostileCell);
        expect(JSON.stringify(parsed)).toContain(hostileCell);
    });
});
