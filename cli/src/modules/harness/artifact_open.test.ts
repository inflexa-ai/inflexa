import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
    echartHtml,
    materializeTarget,
    parseCsvToSource,
    readFileReference,
    readPresentation,
    readReportPreview,
    readReportPreviewFailed,
} from "./artifact_open.ts";
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

describe("parseCsvToSource (RFC-4180, header row, numeric inference)", () => {
    test("keeps the header row and converts fully-numeric columns to numbers", () => {
        const source = parseCsvToSource("gene,log2fc,padj\nTP53,2.4,3e-8\nMYC,-1.8,1e-5");
        expect(source).not.toBeNull();
        expect(source![0]).toEqual(["gene", "log2fc", "padj"]);
        // `gene` stays textual; the numeric columns become numbers.
        expect(source![1]).toEqual(["TP53", 2.4, 3e-8]);
        expect(source![2]).toEqual(["MYC", -1.8, 1e-5]);
    });

    test("handles quoted fields with embedded commas and doubled quotes", () => {
        const source = parseCsvToSource('name,note\n"a,b","he said ""hi"""');
        expect(source![1]).toEqual(["a,b", 'he said "hi"']);
    });

    test("returns null for empty input", () => {
        expect(parseCsvToSource("")).toBeNull();
    });
});

describe("echartHtml", () => {
    test("embeds the spec, a pinned-major CDN script, and a visible offline fallback notice", () => {
        const html = echartHtml({ series: [{ type: "line" }] }, null);
        expect(html).toContain("cdn.jsdelivr.net/npm/echarts@5");
        expect(html).toContain('"series"');
        expect(html).toContain("could not load"); // offline fallback notice
    });

    test("escapes `<` in the embedded spec so a string field cannot break out of the script tag", () => {
        const html = echartHtml({ title: { text: "</script><b>x" } }, null);
        expect(html).not.toContain("</script><b>x");
        expect(html).toContain("\\u003c");
    });

    test("shows a data note when an artifact CSV could not be loaded", () => {
        const html = echartHtml({}, 'Data file "x.csv" could not be loaded — the chart is shown without its data.');
        expect(html).toContain("could not be loaded");
    });
});

describe("materializeTarget idempotence", () => {
    test("an identical echart card materializes to the same cache file (no duplicates)", () => {
        // No `dataPath` → no workspace lookup, so this exercises the cache write against the test sandbox.
        const target: OpenTarget = { kind: "echart", presId: "pres-idem-echart", spec: { series: [{ type: "bar" }] } };
        const first = materializeTarget("a1", target)._unsafeUnwrap();
        const content = readFileSync(first, "utf8");
        const second = materializeTarget("a1", target)._unsafeUnwrap();
        expect(second).toBe(first); // same deterministic path
        expect(readFileSync(second, "utf8")).toBe(content); // reused, not rewritten differently
        expect(first.endsWith("pres-idem-echart.html")).toBe(true);
    });

    test("an svg card materializes to a .svg file keyed by its pres id", () => {
        const target: OpenTarget = { kind: "svg", presId: "pres-idem-svg", markup: "<svg><rect/></svg>" };
        const path = materializeTarget("a1", target)._unsafeUnwrap();
        expect(path.endsWith("pres-idem-svg.svg")).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("<svg><rect/></svg>");
    });

    test("an inline chart (no dataPath) is reused from cache without rewrite", () => {
        const target: OpenTarget = { kind: "echart", presId: "pres-inline-norewrite", spec: { series: [{ type: "bar" }] } };
        const dest = materializeTarget("a1", target)._unsafeUnwrap();
        // Tamper with the cached file; a re-open that rewrote it would clobber the sentinel. The
        // existsSync shortcut — valid only because the pres- id is a genuine content hash for an inline
        // chart — serves the file untouched.
        writeFileSync(dest, "SENTINEL");
        const again = materializeTarget("a1", target)._unsafeUnwrap();
        expect(again).toBe(dest);
        expect(readFileSync(again, "utf8")).toBe("SENTINEL");
    });

    test("an untrusted traversal dataPath is refused before any read — the chart degrades to the no-data note", () => {
        // validatePath rejects the shape before workspaceRootForAnalysisId is ever consulted (no DB
        // needed), so nothing is read and the chart renders with the degraded-data note.
        const target: OpenTarget = { kind: "echart", presId: "pres-traversal-guard", spec: { series: [] }, dataPath: "../../etc/passwd" };
        const html = readFileSync(materializeTarget("ana-nonexistent", target)._unsafeUnwrap(), "utf8");
        expect(html).toContain("could not be loaded");
    });
});

describe("materializeEchart dataPath charts — analysis-scoped, rematerialize-on-open", () => {
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

    test("a degraded 'could not be loaded' shell heals once the CSV appears (rematerialize-on-open)", () => {
        const root = seedAnalysis("ana-heal", "heal");
        const target: OpenTarget = { kind: "echart", presId: "pres-heal", spec: { series: [{ type: "line" }] }, dataPath: "runs/r/out.csv" };

        const first = materializeTarget("ana-heal", target)._unsafeUnwrap();
        expect(readFileSync(first, "utf8")).toContain("could not be loaded");
        // The dataPath chart's file is scoped by analysis, not the bare pres- id.
        expect(first.endsWith("pres-heal.html")).toBe(false);

        mkdirSync(join(root, "runs", "r"), { recursive: true });
        writeFileSync(join(root, "runs", "r", "out.csv"), "x,y\n1,2\n3,4");

        const second = materializeTarget("ana-heal", target)._unsafeUnwrap();
        const healed = readFileSync(second, "utf8");
        expect(second).toBe(first); // same analysis-scoped file, rewritten in place
        expect(healed).not.toContain("could not be loaded");
        expect(healed).toContain('"dataset"');
    });

    test("a rewritten CSV yields an updated dataset on the next materialization (never stale)", () => {
        const root = seedAnalysis("ana-rw", "rw");
        mkdirSync(join(root, "runs", "r"), { recursive: true });
        const csv = join(root, "runs", "r", "out.csv");
        const target: OpenTarget = { kind: "echart", presId: "pres-rw", spec: {}, dataPath: "runs/r/out.csv" };

        writeFileSync(csv, "label,value\nA,10");
        const v1 = readFileSync(materializeTarget("ana-rw", target)._unsafeUnwrap(), "utf8");
        expect(v1).toContain('["A",10]');

        writeFileSync(csv, "label,value\nA,999");
        const v2 = readFileSync(materializeTarget("ana-rw", target)._unsafeUnwrap(), "utf8");
        expect(v2).toContain('["A",999]');
        expect(v2).not.toContain('["A",10]'); // the prior dataset is gone, not a stale cache
    });
});
