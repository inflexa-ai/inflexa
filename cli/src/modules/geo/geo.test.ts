import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchLike } from "../../lib/download.ts";
import { downloadGeoSeries, geoSeriesUrls, parseAutoindex, parseGseAccession, resolveGeoArtifacts } from "./geo.ts";

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
        expect(u.base).toBe(`${FTP}/GSE12nnn/GSE12345/`);
        expect(u.softDir).toBe(`${FTP}/GSE12nnn/GSE12345/soft/`);
        expect(u.matrixDir).toBe(`${FTP}/GSE12nnn/GSE12345/matrix/`);
        expect(u.supplDir).toBe(`${FTP}/GSE12nnn/GSE12345/suppl/`);
        expect(u.bundle).toBe("https://www.ncbi.nlm.nih.gov/geo/download/?acc=GSE12345&format=file");
    });

    test("a sub-1000 accession buckets to GSEnnn", () => {
        expect(geoSeriesUrls("GSE567").base).toBe(`${FTP}/GSEnnn/GSE567/`);
    });

    test("a four-digit accession buckets to GSE1nnn", () => {
        expect(geoSeriesUrls("GSE1234").base).toBe(`${FTP}/GSE1nnn/GSE1234/`);
    });

    test("a six-digit accession buckets to GSE123nnn", () => {
        expect(geoSeriesUrls("GSE123456").base).toBe(`${FTP}/GSE123nnn/GSE123456/`);
    });
});

describe("parseAutoindex", () => {
    test("extracts file hrefs, skipping parent-dir and Apache sort links", () => {
        const html = `<html><body>
            <a href="?C=N;O=D">Name</a>
            <a href="?C=M;O=A">Last modified</a>
            <a href="/geo/series/GSE12nnn/GSE12345/">Parent Directory</a>
            <a href="../">Up</a>
            <a href="GSE12345_series_matrix.txt.gz">GSE12345_series_matrix.txt.gz</a>
            <a href="GSE12345-GPL96_series_matrix.txt.gz">x</a>
            </body></html>`;
        expect(parseAutoindex(html)).toEqual(["GSE12345_series_matrix.txt.gz", "GSE12345-GPL96_series_matrix.txt.gz"]);
    });

    test("skips subdirectory links (trailing slash) and returns empty for a nav-only index", () => {
        expect(parseAutoindex(`<a href="?C=N;O=D">Name</a><a href="../">Parent Directory</a><a href="soft/">soft/</a>`)).toEqual([]);
    });
});

/** A fetch stub serving an Apache autoindex per directory url; any other url is a 404. */
function serveDirs(dirs: Record<string, readonly string[]>): FetchLike {
    return async (input) => {
        const url = String(input);
        const files = dirs[url];
        if (files === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
        const rows = files.map((f) => `<a href="${f}">${f}</a>`).join("\n");
        return new Response(`<html><a href="?C=N;O=D">Name</a><a href="../">Parent Directory</a>${rows}</html>`);
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
        const artifacts = (await resolveGeoArtifacts(acc, { fetch: fetchStub }))._unsafeUnwrap();
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
        const artifacts = (await resolveGeoArtifacts(acc, { fetch: fetchStub }))._unsafeUnwrap();
        expect(artifacts.map((a) => a.fileName)).toEqual([`${acc}_family.soft.gz`, `${acc}_series_matrix.txt.gz`]);
    });

    test("a series exposing no processed files is a no_processed_files outcome", async () => {
        const artifacts = await resolveGeoArtifacts(acc, { fetch: serveDirs({}) });
        expect(artifacts._unsafeUnwrapErr().type).toBe("no_processed_files");
    });
});

/** A fetch stub serving a full series: the three dir autoindexes plus each file's body (`content:<name>`). */
function serveSeries(acc: string, layout: { soft?: readonly string[]; matrix?: readonly string[]; suppl?: readonly string[] }): FetchLike {
    const u = geoSeriesUrls(acc);
    const dirFiles: Record<string, readonly string[]> = {};
    if (layout.soft) dirFiles[u.softDir] = layout.soft;
    if (layout.matrix) dirFiles[u.matrixDir] = layout.matrix;
    if (layout.suppl) dirFiles[u.supplDir] = layout.suppl;
    const bodies = new Map<string, string>();
    for (const [dir, names] of Object.entries(dirFiles)) for (const name of names) bodies.set(`${dir}${name}`, `content:${name}`);
    return async (input) => {
        const url = String(input);
        const listing = dirFiles[url];
        if (listing !== undefined) {
            const rows = listing.map((f) => `<a href="${f}">${f}</a>`).join("");
            return new Response(`<a href="../">Parent Directory</a>${rows}`);
        }
        const body = bodies.get(url);
        return body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(body);
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
        const dest = geoRoot();
        const stub = serveSeries("GSE12345", {
            soft: ["GSE12345_family.soft.gz"],
            matrix: ["GSE12345_series_matrix.txt.gz"],
            suppl: ["GSE12345_counts.txt.gz"],
        });
        const paths = (await downloadGeoSeries("GSE12345", dest, { fetch: stub }))._unsafeUnwrap();
        expect(paths.map((p) => p.split("/").pop())).toEqual(["GSE12345_family.soft.gz", "GSE12345_series_matrix.txt.gz", "GSE12345_counts.txt.gz"]);
        expect(readFileSync(join(dest, "GSE12345_family.soft.gz"), "utf8")).toBe("content:GSE12345_family.soft.gz");
    });

    test("propagates a no_processed_files series as an error", async () => {
        const result = await downloadGeoSeries("GSE12345", geoRoot(), { fetch: serveSeries("GSE12345", {}) });
        expect(result._unsafeUnwrapErr().type).toBe("no_processed_files");
    });
});
