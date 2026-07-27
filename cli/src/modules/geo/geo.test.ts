import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchLike } from "../../lib/download.ts";
import {
    downloadGeoSeries,
    geoSeriesUrls,
    measureGeoArtifacts,
    parseAutoindex,
    parseByteSize,
    parseGseAccession,
    resolveGeoArtifacts,
    type GeoProgress,
} from "./geo.ts";

/** Test pacing: no real backoff, no inter-request spacing. Production defaults are exercised in prod. */
const FAST = { retryBaseMs: 0, spacingMs: 0 } as const;

/**
 * The exact body ftp.ncbi.nlm.nih.gov serves for a populated directory, captured live.
 *
 * Reproduced byte-for-byte rather than idealized, because the two things that broke this parser are
 * exactly the two an idealized fixture omits: the parent link is an ABSOLUTE path (not `../`), and
 * every page carries the site-wide hhs.gov footer link outside the `<pre>` block.
 */
const REAL_MATRIX_INDEX = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">
<html>
 <head>
  <title>Index of /geo/series/GSE185nnn/GSE185553/matrix</title>
 </head>
 <body>
<h1>Index of /geo/series/GSE185nnn/GSE185553/matrix</h1>
<pre>Name                             Last modified      Size  <hr><a href="/geo/series/GSE185nnn/GSE185553/">Parent Directory</a>                                      -
<a href="GSE185553_series_matrix.txt.gz">GSE185553_series_matrix.txt.gz</a>   2026-07-12 00:35  3.1K
<hr></pre>
<a href="https://www.hhs.gov/vulnerability-disclosure-policy/index.html">HHS Vulnerability Disclosure</a>
`;

/** The exact body NCBI serves for a directory with no index — the normal state of `suppl/` for a Series with no supplementary files. */
const REAL_FORBIDDEN_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
<head>
<title>Access forbidden!</title>
<link rev="made" href="mailto:webadmin@ncbi.nlm.nih.gov" />
</head>
<body>
<h1>Access forbidden!</h1>
<p>You don't have permission to access the requested directory.
There is either no index document or the directory is read-protected.</p>
<p>If you think this is a server error, please contact
the <a href="mailto:webadmin@ncbi.nlm.nih.gov">webmaster</a>.</p>
<h2>Error 403</h2>
<address><a href="/">ftp.ncbi.nlm.nih.gov</a><br /><span>Apache</span></address>
</body>
</html>
`;

describe("parseGseAccession", () => {
    test("accepts a well-formed GSE id", () => {
        expect(parseGseAccession("GSE12345")._unsafeUnwrap()).toBe("GSE12345");
    });

    test("uppercase-normalizes and trims surrounding whitespace", () => {
        expect(parseGseAccession("  gse12345 ")._unsafeUnwrap()).toBe("GSE12345");
    });

    test("rejects a non-Series accession (GSM/GPL/GDS)", () => {
        expect(parseGseAccession("GSM12345")._unsafeUnwrapErr().type).toBe("invalid_accession");
        expect(parseGseAccession("GPL96")._unsafeUnwrapErr().type).toBe("invalid_accession");
    });

    test("rejects garbage and a bare number", () => {
        expect(parseGseAccession("hello")._unsafeUnwrapErr().type).toBe("invalid_accession");
        expect(parseGseAccession("12345")._unsafeUnwrapErr().type).toBe("invalid_accession");
        expect(parseGseAccession("GSE")._unsafeUnwrapErr().type).toBe("invalid_accession");
    });
});

describe("geoSeriesUrls", () => {
    const FTP = "https://ftp.ncbi.nlm.nih.gov/geo/series";

    test("buckets the last three digits as nnn and builds the subdir urls", () => {
        const u = geoSeriesUrls("GSE12345");
        expect(u.softDir).toBe(`${FTP}/GSE12nnn/GSE12345/soft/`);
        expect(u.matrixDir).toBe(`${FTP}/GSE12nnn/GSE12345/matrix/`);
        expect(u.supplDir).toBe(`${FTP}/GSE12nnn/GSE12345/suppl/`);
    });

    test("a sub-1000 accession buckets to GSEnnn", () => {
        expect(geoSeriesUrls("GSE567").softDir).toBe(`${FTP}/GSEnnn/GSE567/soft/`);
    });

    test("a four-digit accession buckets to GSE1nnn", () => {
        expect(geoSeriesUrls("GSE1234").softDir).toBe(`${FTP}/GSE1nnn/GSE1234/soft/`);
    });

    test("a six-digit accession buckets to GSE123nnn", () => {
        expect(geoSeriesUrls("GSE123456").softDir).toBe(`${FTP}/GSE123nnn/GSE123456/soft/`);
    });
});

describe("parseAutoindex", () => {
    const MATRIX_DIR = "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE185nnn/GSE185553/matrix/";

    test("returns exactly the files from a real NCBI autoindex, dropping the hhs.gov footer link", () => {
        expect(parseAutoindex(REAL_MATRIX_INDEX, MATRIX_DIR)).toEqual(["GSE185553_series_matrix.txt.gz"]);
    });

    test("a real 'Access forbidden' page lists no files (its mailto: and / links are not names)", () => {
        expect(parseAutoindex(REAL_FORBIDDEN_PAGE, MATRIX_DIR)).toEqual([]);
    });

    test("keeps every per-platform matrix part of a multi-platform series", () => {
        const html = `<a href="/geo/series/GSE12nnn/GSE12345/">Parent Directory</a>
            <a href="GSE12345-GPL96_series_matrix.txt.gz">a</a>
            <a href="GSE12345-GPL97_series_matrix.txt.gz">b</a>
            <a href="https://www.hhs.gov/vulnerability-disclosure-policy/index.html">HHS</a>`;
        expect(parseAutoindex(html, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/matrix/")).toEqual([
            "GSE12345-GPL96_series_matrix.txt.gz",
            "GSE12345-GPL97_series_matrix.txt.gz",
        ]);
    });

    test("drops sort links, both parent-link spellings, and subdirectory links", () => {
        const html = `<a href="?C=N;O=D">Name</a><a href="?C=M;O=A">Last modified</a>
            <a href="/geo/series/GSE12nnn/GSE12345/">Parent Directory</a><a href="../">Up</a>
            <a href="soft/">soft/</a><a href="#top">top</a>
            <a href="GSE12345_family.soft.gz">keep me</a>`;
        expect(parseAutoindex(html, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/soft/")).toEqual(["GSE12345_family.soft.gz"]);
    });

    test("drops any off-origin href, however file-like", () => {
        const html = `<a href="https://evil.example.com/GSE12345_counts.txt.gz">x</a>
            <a href="//evil.example.com/GSE12345_counts.txt.gz">y</a>`;
        expect(parseAutoindex(html, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/")).toEqual([]);
    });

    test("percent-decodes a name for disk and un-escapes HTML entities", () => {
        const html = `<a href="GSE1%20counts%2Cfinal.txt">a</a><a href="p&amp;q.tsv">b</a>`;
        expect(parseAutoindex(html, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/")).toEqual(["GSE1 counts,final.txt", "p&q.tsv"]);
    });

    test("refuses traversal, both plain and percent-encoded", () => {
        const html = `<a href="a/../../../../etc/passwd">plain</a>
            <a href="%2e%2e%2f%2e%2e%2fetc%2fpasswd">encoded</a>
            <a href="..%2fescape.txt">mixed</a>
            <a href="-rf.txt">leading dash</a>`;
        expect(parseAutoindex(html, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/")).toEqual([]);
    });

    test("de-duplicates a name Apache links twice and tolerates single-quoted, uppercase attributes", () => {
        const html = `<A HREF='GSE12345_counts.txt.gz'>x</A><a href="GSE12345_counts.txt.gz">x again</a>`;
        expect(parseAutoindex(html, "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/")).toEqual(["GSE12345_counts.txt.gz"]);
    });
});

/** Render a listing the way NCBI really does — parent link, files, hhs.gov footer — so no stub is kinder than production. */
function renderIndex(dirPath: string, files: readonly string[]): string {
    const rows = files.map((f) => `<a href="${encodeURIComponent(f)}">${f}</a>`).join("\n");
    return `<pre><hr><a href="${dirPath}">Parent Directory</a>\n${rows}\n<hr></pre>
<a href="https://www.hhs.gov/vulnerability-disclosure-policy/index.html">HHS Vulnerability Disclosure</a>`;
}

/** A fetch stub serving an Apache autoindex per directory url; any other url is a 404. */
function serveDirs(dirs: Record<string, readonly string[]>): FetchLike {
    return async (input) => {
        const url = String(input);
        const files = dirs[url];
        if (files === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
        return new Response(renderIndex(new URL(url).pathname.replace(/[^/]+\/$/, ""), files));
    };
}

describe("resolveGeoArtifacts", () => {
    const acc = "GSE12345";
    const u = geoSeriesUrls(acc);

    test("collects soft, every matrix part, and every supplementary file", async () => {
        const fetchStub = serveDirs({
            [u.softDir]: [`${acc}_family.soft.gz`],
            [u.matrixDir]: [`${acc}-GPL96_series_matrix.txt.gz`, `${acc}-GPL97_series_matrix.txt.gz`],
            [u.supplDir]: [`${acc}_RAW.tar`, `${acc}_counts.txt.gz`],
        });
        const artifacts = (await resolveGeoArtifacts(acc, { fetch: fetchStub, ...FAST }))._unsafeUnwrap();
        expect(artifacts.map((a) => a.fileName)).toEqual([
            `${acc}_family.soft.gz`,
            `${acc}-GPL96_series_matrix.txt.gz`,
            `${acc}-GPL97_series_matrix.txt.gz`,
            `${acc}_RAW.tar`,
            `${acc}_counts.txt.gz`,
        ]);
        expect(artifacts[0]?.url).toBe(`${u.softDir}${acc}_family.soft.gz`);
        expect(artifacts[3]?.url).toBe(`${u.supplDir}${acc}_RAW.tar`);
    });

    test("an absent directory (404) contributes nothing rather than failing", async () => {
        const fetchStub = serveDirs({ [u.softDir]: [`${acc}_family.soft.gz`], [u.matrixDir]: [`${acc}_series_matrix.txt.gz`] });
        const artifacts = (await resolveGeoArtifacts(acc, { fetch: fetchStub, ...FAST }))._unsafeUnwrap();
        expect(artifacts.map((a) => a.fileName)).toEqual([`${acc}_family.soft.gz`, `${acc}_series_matrix.txt.gz`]);
    });

    test("a suppl/ that persistently answers 403 is an empty directory, not a failed resolve", async () => {
        const fetchStub: FetchLike = async (input) => {
            const url = String(input);
            if (url === u.supplDir) return new Response(REAL_FORBIDDEN_PAGE, { status: 403, statusText: "Forbidden" });
            if (url === u.softDir) return new Response(renderIndex("/", [`${acc}_family.soft.gz`]));
            return new Response("missing", { status: 404, statusText: "Not Found" });
        };
        const artifacts = (await resolveGeoArtifacts(acc, { fetch: fetchStub, ...FAST }))._unsafeUnwrap();
        expect(artifacts.map((a) => a.fileName)).toEqual([`${acc}_family.soft.gz`]);
    });

    test("a 403 that clears on retry yields the directory's files (NCBI sheds load with 403)", async () => {
        let supplCalls = 0;
        const fetchStub: FetchLike = async (input) => {
            const url = String(input);
            if (url === u.supplDir) {
                supplCalls += 1;
                if (supplCalls < 3) return new Response(REAL_FORBIDDEN_PAGE, { status: 403, statusText: "Forbidden" });
                return new Response(renderIndex("/", [`${acc}_counts.txt.gz`]));
            }
            return new Response("missing", { status: 404, statusText: "Not Found" });
        };
        const artifacts = (await resolveGeoArtifacts(acc, { fetch: fetchStub, ...FAST }))._unsafeUnwrap();
        expect(artifacts.map((a) => a.fileName)).toEqual([`${acc}_counts.txt.gz`]);
        expect(supplCalls).toBe(3);
    });

    test("a transport throw is retried and only then reported as unreachable", async () => {
        let calls = 0;
        const fetchStub: FetchLike = async () => {
            calls += 1;
            throw new Error("ECONNRESET");
        };
        const resolved = await resolveGeoArtifacts(acc, { fetch: fetchStub, ...FAST });
        expect(resolved._unsafeUnwrapErr().type).toBe("unreachable");
        expect(calls).toBe(4);
    });

    test("a persistent 5xx is unreachable, not an empty series", async () => {
        const fetchStub: FetchLike = async () => new Response("boom", { status: 503, statusText: "Service Unavailable" });
        const resolved = await resolveGeoArtifacts(acc, { fetch: fetchStub, ...FAST });
        expect(resolved._unsafeUnwrapErr().type).toBe("unreachable");
    });

    test("a series exposing no processed files is a no_processed_files outcome", async () => {
        const artifacts = await resolveGeoArtifacts(acc, { fetch: serveDirs({}), ...FAST });
        expect(artifacts._unsafeUnwrapErr().type).toBe("no_processed_files");
    });
});

/** A fetch stub serving a full series: the three dir autoindexes plus each file's body (`content:<name>`). */
function serveSeries(
    acc: string,
    layout: { soft?: readonly string[]; matrix?: readonly string[]; suppl?: readonly string[] },
    opts: { readonly sizes?: Record<string, number>; readonly breakOn?: string } = {},
): FetchLike {
    const u = geoSeriesUrls(acc);
    const dirFiles: Record<string, readonly string[]> = {};
    if (layout.soft) dirFiles[u.softDir] = layout.soft;
    if (layout.matrix) dirFiles[u.matrixDir] = layout.matrix;
    if (layout.suppl) dirFiles[u.supplDir] = layout.suppl;
    const bodies = new Map<string, string>();
    for (const [dir, names] of Object.entries(dirFiles)) for (const name of names) bodies.set(`${dir}${encodeURIComponent(name)}`, `content:${name}`);
    return async (input, init) => {
        const url = String(input);
        const listing = dirFiles[url];
        if (listing !== undefined) return new Response(renderIndex("/", listing));
        const body = bodies.get(url);
        if (body === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
        if (opts.breakOn !== undefined && url.endsWith(encodeURIComponent(opts.breakOn)) && init?.method !== "HEAD") {
            return new Response("gone", { status: 500, statusText: "Internal Server Error" });
        }
        const declared = opts.sizes?.[url.split("/").pop() ?? ""];
        const headers = declared === undefined ? undefined : { "content-length": String(declared) };
        return new Response(init?.method === "HEAD" ? null : body, headers === undefined ? {} : { headers });
    };
}

describe("downloadGeoSeries", () => {
    const geoRoots: string[] = [];
    function geoRoot(): string {
        const p = mkdtempSync(join(tmpdir(), "inflexa-geo-"));
        geoRoots.push(p);
        return p;
    }
    afterEach(() => {
        for (const p of geoRoots.splice(0)) rmSync(p, { recursive: true, force: true });
    });

    test("downloads every resolved artifact into destDir and returns their paths", async () => {
        const dest = join(geoRoot(), "GSE12345");
        const stub = serveSeries("GSE12345", {
            soft: ["GSE12345_family.soft.gz"],
            matrix: ["GSE12345_series_matrix.txt.gz"],
            suppl: ["GSE12345_counts.txt.gz"],
        });
        const paths = (await downloadGeoSeries("GSE12345", dest, { fetch: stub, ...FAST }))._unsafeUnwrap();
        expect(paths.map((p) => p.split("/").pop())).toEqual(["GSE12345_family.soft.gz", "GSE12345_series_matrix.txt.gz", "GSE12345_counts.txt.gz"]);
        expect(readFileSync(join(dest, "GSE12345_family.soft.gz"), "utf8")).toBe("content:GSE12345_family.soft.gz");
        expect(readFileSync(join(dest, "GSE12345_counts.txt.gz"), "utf8")).toBe("content:GSE12345_counts.txt.gz");
    });

    test("reports resolution and per-file progress", async () => {
        const dest = join(geoRoot(), "GSE12345");
        const stub = serveSeries("GSE12345", { soft: ["GSE12345_family.soft.gz"] }, { sizes: { "GSE12345_family.soft.gz": 2048 } });
        const events: string[] = [];
        await downloadGeoSeries("GSE12345", dest, { fetch: stub, ...FAST, onProgress: (e) => events.push(e.type) });
        expect(events).toEqual(["resolved", "file_started", "file_completed"]);
    });

    test("refuses a series whose declared size exceeds the cap, downloading nothing", async () => {
        const root = geoRoot();
        const dest = join(root, "GSE12345");
        const stub = serveSeries("GSE12345", { suppl: ["GSE12345_RAW.tar"] }, { sizes: { "GSE12345_RAW.tar": 5000 } });
        const result = await downloadGeoSeries("GSE12345", dest, { fetch: stub, ...FAST, maxBytes: 1000 });
        const error = result._unsafeUnwrapErr();
        expect(error.type).toBe("too_large");
        expect(existsSync(dest)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
    });

    test("a transfer that fails partway writes nothing and leaves no directory behind", async () => {
        const root = geoRoot();
        const dest = join(root, "GSE12345");
        const stub = serveSeries("GSE12345", { soft: ["GSE12345_family.soft.gz"], suppl: ["GSE12345_counts.txt.gz"] }, { breakOn: "GSE12345_counts.txt.gz" });
        const result = await downloadGeoSeries("GSE12345", dest, { fetch: stub, ...FAST });
        expect(result._unsafeUnwrapErr().type).toBe("http_failed");
        // The whole point of staging: the SOFT file did transfer, but nothing survives a partial set.
        expect(existsSync(dest)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
    });

    test("propagates a no_processed_files series as an error", async () => {
        const result = await downloadGeoSeries("GSE12345", join(geoRoot(), "GSE12345"), { fetch: serveSeries("GSE12345", {}), ...FAST });
        expect(result._unsafeUnwrapErr().type).toBe("no_processed_files");
    });
});

describe("parseByteSize", () => {
    test("reads a bare number as bytes and binary units case-insensitively", () => {
        expect(parseByteSize("2048")).toBe(2048);
        expect(parseByteSize("1KB")).toBe(1024);
        expect(parseByteSize("64gb")).toBe(64 * 1024 ** 3);
        expect(parseByteSize(" 1.5 TB ")).toBe(Math.floor(1.5 * 1024 ** 4));
    });

    test("round-trips a size copied out of formatBytes output", () => {
        expect(parseByteSize((32 * 1024 ** 3).formatBytes().replace(" ", ""))).toBe(32 * 1024 ** 3);
    });

    test("rejects a malformed or non-positive size", () => {
        for (const bad of ["", "abc", "10PB", "-5GB", "0", "1..5GB", "5 GB extra"]) expect(parseByteSize(bad)).toBeUndefined();
    });
});

describe("downloadGeoSeries progress heartbeat", () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
    });

    test("reports file_progress as bytes arrive, so a long transfer is never silent", async () => {
        const root = mkdtempSync(join(tmpdir(), "inflexa-geo-"));
        roots.push(root);
        const u = geoSeriesUrls("GSE12345");
        const fileUrl = `${u.softDir}GSE12345_family.soft.gz`;
        const stub: FetchLike = async (input, init) => {
            const url = String(input);
            if (url === u.softDir) return new Response(renderIndex("/", ["GSE12345_family.soft.gz"]));
            if (url !== fileUrl) return new Response("missing", { status: 404, statusText: "Not Found" });
            if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "30" } });
            // Three chunks: a single-chunk body could not tell a heartbeat from a completion event.
            // The declared size rides the GET (not the HEAD probe), which is where the readout reads it.
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (let i = 0; i < 3; i += 1) controller.enqueue(new Uint8Array(10));
                        controller.close();
                    },
                }),
                { headers: { "content-length": "30" } },
            );
        };
        const events: GeoProgress[] = [];
        const result = await downloadGeoSeries("GSE12345", join(root, "GSE12345"), { fetch: stub, ...FAST, heartbeatMs: 0, onProgress: (e) => events.push(e) });

        expect(result.isOk()).toBe(true);
        const progress = events.filter((e) => e.type === "file_progress");
        expect(progress.length).toBeGreaterThanOrEqual(2);
        // A running total, not per-chunk deltas — the last one is the whole file.
        expect(progress.at(-1)).toEqual({ type: "file_progress", fileName: "GSE12345_family.soft.gz", bytes: 30, declaredBytes: 30 });
        expect(events.map((e) => e.type)).toEqual(["resolved", "file_started", "file_progress", "file_progress", "file_progress", "file_completed"]);
    });

    test("the heartbeat gap suppresses intermediate reports", async () => {
        const root = mkdtempSync(join(tmpdir(), "inflexa-geo-"));
        roots.push(root);
        const u = geoSeriesUrls("GSE12345");
        const stub: FetchLike = async (input, init) => {
            const url = String(input);
            if (url === u.softDir) return new Response(renderIndex("/", ["GSE12345_family.soft.gz"]));
            if (!url.endsWith("GSE12345_family.soft.gz")) return new Response("missing", { status: 404, statusText: "Not Found" });
            if (init?.method === "HEAD") return new Response(null);
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(10));
                        controller.close();
                    },
                }),
            );
        };
        const events: GeoProgress[] = [];
        // A gap no test run can outlast: every chunk lands inside it, so none reports.
        await downloadGeoSeries("GSE12345", join(root, "GSE12345"), { fetch: stub, ...FAST, heartbeatMs: 600_000, onProgress: (e) => events.push(e) });
        expect(events.filter((e) => e.type === "file_progress")).toEqual([]);
    });
});

describe("measureGeoArtifacts", () => {
    test("sums declared sizes and counts the artifacts that declared none", async () => {
        const stub: FetchLike = async (input) => {
            const url = String(input);
            if (url.endsWith("/sized.txt")) return new Response(null, { headers: { "content-length": "1500" } });
            return new Response(null);
        };
        const size = await measureGeoArtifacts(
            [
                { url: "https://ftp.ncbi.nlm.nih.gov/a/sized.txt", fileName: "sized.txt" },
                { url: "https://ftp.ncbi.nlm.nih.gov/a/unsized.txt", fileName: "unsized.txt" },
            ],
            { fetch: stub, ...FAST },
        );
        expect(size).toEqual({ declaredBytes: 1500, sized: 1, unsized: 1 });
    });

    test("a probe that throws is unknown size, never a failure", async () => {
        const stub: FetchLike = async () => {
            throw new Error("ECONNRESET");
        };
        const size = await measureGeoArtifacts([{ url: "https://ftp.ncbi.nlm.nih.gov/a/x.txt", fileName: "x.txt" }], { fetch: stub, ...FAST });
        expect(size).toEqual({ declaredBytes: 0, sized: 0, unsized: 1 });
    });
});
