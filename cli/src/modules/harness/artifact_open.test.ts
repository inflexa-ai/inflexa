import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { echartHtml, materializeTarget, readFileReference, readPresentation, readReportPreview, readReportPreviewFailed } from "./artifact_open.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import { writeMarker } from "../anchor/marker.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../analysis/output.ts";
import type { OpenTarget } from "../../types/session.ts";

describe("readPresentation", () => {
    test("text-shaped markdown/code/table become inline bodies", () => {
        expect(readPresentation({ id: "p", title: "T", content: { kind: "markdown", body: "hi" } })).toEqual({
            shape: "inline",
            title: "T",
            body: { kind: "markdown", body: "hi" },
        });
        expect(readPresentation({ id: "p", content: { kind: "code", code: "x", language: "r" } })).toEqual({
            shape: "inline",
            title: undefined,
            body: { kind: "code", code: "x", language: "r" },
        });
        expect(readPresentation({ id: "p", content: { kind: "table", headers: ["a"], rows: [["1"]] } })).toEqual({
            shape: "inline",
            title: undefined,
            body: { kind: "table", headers: ["a"], rows: [["1"]], caption: undefined },
        });
    });

    test("echart becomes an openable entry carrying the deep-copied spec + pres id + dataPath", () => {
        const spec = { series: [{ type: "scatter" }] };
        const out = readPresentation({ id: "pres-chart", title: "Volcano", content: { kind: "echart", spec, dataPath: "runs/r/out.csv" } });
        expect(out.shape).toBe("card");
        if (out.shape === "card" && out.entry.target.kind === "echart") {
            expect(out.entry.target.presId).toBe("pres-chart");
            expect(out.entry.target.dataPath).toBe("runs/r/out.csv");
            // Deep copy: mutating the source spec does not reach the readout (copy-on-receive).
            spec.series[0]!.type = "MUTATED";
            expect(out.entry.target.spec).toEqual({ series: [{ type: "scatter" }] });
        }
    });

    test("an unrecognized presentation kind degrades to an inline note (observed, not swallowed)", () => {
        const out = readPresentation({ id: "p", content: { kind: "hologram" } });
        expect(out.shape).toBe("inline");
        if (out.shape === "inline" && out.body.kind === "markdown") expect(out.body.body).toContain("unsupported presentation: hologram");
    });
});

describe("readFileReference", () => {
    test("each file becomes an openable entry; a multi-file gallery carries its containing folder", () => {
        const out = readFileReference({
            id: "g",
            title: "Figures",
            files: [{ path: "runs/r/figures/a.png" }, { path: "runs/r/figures/b.png", caption: "heatmap" }],
        });
        expect(out.title).toBe("Figures");
        expect(out.entries.map((e) => e.name)).toEqual(["a.png", "b.png"]);
        expect(out.entries[0]?.icon).toBe("image");
        expect(out.entries[1]?.caption).toBe("heatmap");
        expect(out.folderPath).toBe("runs/r/figures");
    });

    test("a single-file reference carries no folder affordance", () => {
        const out = readFileReference({ id: "g", files: [{ path: "runs/r/out.csv" }] });
        expect(out.entries[0]?.icon).toBe("document");
        expect(out.folderPath).toBeUndefined();
    });
});

describe("readReportPreview / readReportPreviewFailed", () => {
    test("a preview resolves against previews/{previewId}/{previewPath}", () => {
        const out = readReportPreview({ id: "x", previewId: "prv-9", version: 3, title: "Report", previewPath: "v3/index.html", format: "html" });
        expect(out.entry.name).toBe("Report v3");
        expect(out.entry.target).toEqual({ kind: "workspace-file", path: "previews/prv-9/v3/index.html" });
    });

    test("a failed preview is an unavailable entry naming the reason", () => {
        const out = readReportPreviewFailed({ id: "x", previewId: "p", version: 2, reason: "render timed out" });
        expect(out.entry.target).toEqual({ kind: "unavailable", reason: "render timed out" });
        expect(out.entry.caption).toBe("render timed out");
    });
});

describe("echartHtml", () => {
    test("embeds the spec, a pinned-major CDN script, and a visible offline fallback notice", () => {
        const html = echartHtml({ series: [{ type: "line" }] }, null, null);
        expect(html).toContain("cdn.jsdelivr.net/npm/echarts@5");
        expect(html).toContain('"series"');
        expect(html).toContain("could not load"); // offline fallback notice
        expect(html).not.toContain("papaparse"); // an inline chart carries no parser
    });

    test("escapes `<` in the embedded spec so a string field cannot break out of the script tag", () => {
        const html = echartHtml({ title: { text: "</script><b>x" } }, null, null);
        expect(html).not.toContain("</script><b>x");
        expect(html).toContain("\\u003c");
    });

    test("embeds a relative data URL fetched and parsed at render time — never the data itself", () => {
        const html = echartHtml({}, "../runs/r/out.csv", null);
        expect(html).toContain('var dataUrl = "../runs/r/out.csv"');
        expect(html).toContain("fetch(dataUrl)");
        expect(html).toContain("cdn.jsdelivr.net/npm/papaparse@5"); // pinned-major in-page parser
        expect(html).toContain('id="datanote" style="display:none"'); // note hidden until a load failure
    });

    test("shows a visible data note when the shell is pre-degraded (invalid dataPath shape)", () => {
        const html = echartHtml({}, null, 'Data file "x.csv" could not be loaded — the chart is shown without its data.');
        expect(html).toContain('<div id="datanote">Data file "x.csv" could not be loaded');
        expect(html).toContain("var dataUrl = null");
    });
});

describe("materializeTarget — the workspace presentations directory", () => {
    const created: string[] = [];

    function tmp(): string {
        const dir = mkdtempSync(join(tmpdir(), "inflexa-artifact-"));
        created.push(dir);
        return dir;
    }

    /** Seed a resolvable analysis (anchor marker + rows) and return its materialized workspace root. */
    function seedAnalysis(analysisId: string, slug: string): string {
        const home = tmp();
        writeMarker(home, "A1")._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: analysisId, createdAt: 1, updatedAt: 1, name: asStr256("A"), slug, anchorId: "A1", projectId: null })._unsafeUnwrap();
        const root = workspaceRootForAnalysisId(analysisId)._unsafeUnwrap();
        mkdirSync(root, { recursive: true });
        return root;
    }

    beforeEach(() => {
        freshDb();
        // The workspace-root memo is process state that outlives freshDb(); each test rebuilds its own
        // anchor under a fresh tmpdir, so a carried-over entry would resolve onto a prior test's home.
        invalidateWorkspaceRoot();
    });

    afterEach(() => {
        for (const dir of created) rmSync(dir, { recursive: true, force: true });
        created.length = 0;
    });

    test("an identical echart card materializes once into {root}/presentations (idempotent)", () => {
        const root = seedAnalysis("ana-idem", "idem");
        const target: OpenTarget = { kind: "echart", presId: "pres-idem-echart", spec: { series: [{ type: "bar" }] } };
        const first = materializeTarget("ana-idem", target)._unsafeUnwrap();
        expect(first).toBe(join(root, "presentations", "pres-idem-echart.html"));
        const content = readFileSync(first, "utf8");
        const second = materializeTarget("ana-idem", target)._unsafeUnwrap();
        expect(second).toBe(first); // same deterministic path
        expect(readFileSync(second, "utf8")).toBe(content); // reused, not rewritten differently
    });

    test("an svg card materializes to presentations/<pres-id>.svg", () => {
        const root = seedAnalysis("ana-svg", "svg");
        const target: OpenTarget = { kind: "svg", presId: "pres-idem-svg", markup: "<svg><rect/></svg>" };
        const path = materializeTarget("ana-svg", target)._unsafeUnwrap();
        expect(path).toBe(join(root, "presentations", "pres-idem-svg.svg"));
        expect(readFileSync(path, "utf8")).toBe("<svg><rect/></svg>");
    });

    test("an existing presentation file is served untouched (no rewrite)", () => {
        seedAnalysis("ana-reuse", "reuse");
        const target: OpenTarget = { kind: "echart", presId: "pres-norewrite", spec: { series: [{ type: "bar" }] } };
        const dest = materializeTarget("ana-reuse", target)._unsafeUnwrap();
        // Tamper with the materialized file; a re-open that rewrote it would clobber the sentinel. The
        // existsSync shortcut — valid because the pres- id is a genuine content hash of the whole tool
        // input and the shell embeds nothing beyond that input — serves the file untouched.
        writeFileSync(dest, "SENTINEL");
        const again = materializeTarget("ana-reuse", target)._unsafeUnwrap();
        expect(again).toBe(dest);
        expect(readFileSync(again, "utf8")).toBe("SENTINEL");
    });

    test("a dataPath chart references its CSV by relative URL and never embeds the bytes", () => {
        const root = seedAnalysis("ana-ref", "ref");
        mkdirSync(join(root, "runs", "r"), { recursive: true });
        writeFileSync(join(root, "runs", "r", "out.csv"), "label,value\nSENTINEL_CELL_9137,10");
        const target: OpenTarget = { kind: "echart", presId: "pres-ref", spec: { series: [{ type: "line" }] }, dataPath: "runs/r/out.csv" };

        const path = materializeTarget("ana-ref", target)._unsafeUnwrap();
        expect(path).toBe(join(root, "presentations", "pres-ref.html"));
        const html = readFileSync(path, "utf8");
        // The shell imports the artifact from where it sits ({root}/presentations → ../runs/…).
        expect(html).toContain('var dataUrl = "../runs/r/out.csv"');
        expect(html).not.toContain("SENTINEL_CELL_9137");

        // A rewritten CSV needs no rematerialization — the shell fetches the current bytes at render time.
        writeFileSync(join(root, "runs", "r", "out.csv"), "label,value\nB,999");
        const again = materializeTarget("ana-ref", target)._unsafeUnwrap();
        expect(again).toBe(path);
        expect(readFileSync(again, "utf8")).toBe(html);
    });

    test("an untrusted traversal dataPath is refused before a URL is derived — the shell pre-degrades", () => {
        // validatePath rejects the shape (it survives a reload from a persisted tool_use, bypassing the
        // live tool's validation), so no URL is derived and the shell carries the visible no-data note.
        seedAnalysis("ana-guard", "guard");
        const target: OpenTarget = { kind: "echart", presId: "pres-traversal-guard", spec: { series: [] }, dataPath: "../../etc/passwd" };
        const html = readFileSync(materializeTarget("ana-guard", target)._unsafeUnwrap(), "utf8");
        expect(html).toContain('<div id="datanote">Data file "../../etc/passwd" could not be loaded');
        expect(html).toContain("var dataUrl = null");
    });

    test("an unresolvable workspace root is `unresolved` — nothing materializes", () => {
        const echart: OpenTarget = { kind: "echart", presId: "pres-lost", spec: {} };
        const svg: OpenTarget = { kind: "svg", presId: "pres-lost", markup: "<svg/>" };
        expect(materializeTarget("ana-nonexistent", echart)._unsafeUnwrapErr()).toEqual({ type: "unresolved" });
        expect(materializeTarget("ana-nonexistent", svg)._unsafeUnwrapErr()).toEqual({ type: "unresolved" });
    });
});
