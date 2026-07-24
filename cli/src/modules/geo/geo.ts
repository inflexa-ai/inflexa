import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { downloadToFile, type DownloadError, type DownloadProgress, type FetchLike } from "../../lib/download.ts";

/** The GEO FTP mirror (served over HTTPS) that holds per-series files and directory autoindexes. */
const GEO_FTP_BASE = "https://ftp.ncbi.nlm.nih.gov/geo/series";
/** The GEO web app that streams the bundled supplementary tar for a series. */
const GEO_WEB_BASE = "https://www.ncbi.nlm.nih.gov/geo/download";

/** A malformed or non-Series accession — the input is echoed back so the caller can report it. */
export type GeoAccessionError = { readonly type: "invalid_accession"; readonly input: string };

/** The canonical URLs for one GEO Series' processed data. `softDir`/`matrixDir`/`supplDir` are autoindex directories to enumerate. */
export type GeoSeriesUrls = {
    readonly base: string;
    readonly softDir: string;
    readonly matrixDir: string;
    readonly supplDir: string;
    readonly bundle: string;
};

/** One downloadable GEO artifact: its absolute URL and the file name it should land under. */
export type GeoArtifact = { readonly url: string; readonly fileName: string };

/** Why resolving a Series' artifact set failed. `no_processed_files` is a resolvable series that exposes nothing to download. */
export type GeoResolveError = { readonly type: "unreachable"; readonly message: string } | { readonly type: "no_processed_files"; readonly accession: string };

/**
 * Validate and normalize a GEO Series accession.
 *
 * A Series is literally `GSE` + digits (GSM/GPL/GDS are other entity classes, not Series). The raw input
 * is trimmed and upper-cased first so `gse12345` and stray whitespace are accepted; anything else is an
 * `invalid_accession` on the error channel rather than a throw, so the command reports it and exits cleanly.
 */
export function parseGseAccession(raw: string): Result<string, GeoAccessionError> {
    const normalized = raw.trim().toUpperCase();
    return /^GSE\d+$/.test(normalized) ? ok(normalized) : err({ type: "invalid_accession", input: raw });
}

/**
 * The NCBI directory-bucket segment for a series, replacing the last three digits with `nnn`.
 *
 * GEO groups series into buckets of 1000: `GSE12345` lives under `GSE12nnn`, `GSE567` under `GSEnnn`,
 * `GSE1234` under `GSE1nnn`. The rule is "drop the last three digits, append nnn" — for a 1-3 digit
 * accession nothing is dropped, so the bucket is `GSEnnn`.
 */
function seriesBucket(accession: string): string {
    const digits = accession.slice(3);
    const prefix = digits.length > 3 ? digits.slice(0, -3) : "";
    return `GSE${prefix}nnn`;
}

/**
 * Build the canonical processed-data URLs for a (validated) GEO Series accession.
 *
 * `softDir`/`matrixDir`/`supplDir` are Apache autoindex directories the caller enumerates: a single-platform
 * series has one `..._series_matrix.txt.gz` under `matrix/`, a multi-platform series has one file per platform
 * and no combined file, so enumeration — not a guessed filename — finds them all. `bundle` is the web app's
 * single-tar endpoint for all supplementary files (a different host).
 */
export function geoSeriesUrls(accession: string): GeoSeriesUrls {
    const dir = `${GEO_FTP_BASE}/${seriesBucket(accession)}/${accession}/`;
    return {
        base: dir,
        softDir: `${dir}soft/`,
        matrixDir: `${dir}matrix/`,
        supplDir: `${dir}suppl/`,
        bundle: `${GEO_WEB_BASE}/?acc=${accession}&format=file`,
    };
}

/**
 * Extract the file names from an Apache directory autoindex.
 *
 * GEO's FTP mirror serves each directory as an HTML autoindex; there is no JSON listing and no available
 * HTML parser, so this scans `href="..."` attributes and keeps only real files — dropping the sort-order
 * links (`?C=...`), the parent-directory link (absolute or `../`), and subdirectory links (trailing `/`).
 */
export function parseAutoindex(html: string): string[] {
    return [...html.matchAll(/href="([^"]*)"/gi)]
        .map((match) => match[1] ?? "")
        .filter((href) => href !== "" && !href.startsWith("?") && !href.startsWith("/") && !href.startsWith("../") && !href.endsWith("/"));
}

/** List one autoindex directory's files as artifacts. A 404 (directory absent) is an empty list, not an error. */
async function listDirectory(dirUrl: string, doFetch: FetchLike): Promise<Result<GeoArtifact[], GeoResolveError>> {
    let response: Response;
    try {
        response = await doFetch(dirUrl, {});
    } catch (cause) {
        return err({ type: "unreachable", message: `Could not reach ${dirUrl}: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
    if (response.status === 404) return ok([]);
    if (!response.ok) return err({ type: "unreachable", message: `Listing ${dirUrl} failed: HTTP ${response.status} ${response.statusText}.` });
    const html = await response.text();
    return ok(parseAutoindex(html).map((fileName) => ({ url: `${dirUrl}${fileName}`, fileName })));
}

/**
 * Resolve a GEO Series accession to its processed + supplementary artifact set.
 *
 * Enumerates the `soft/`, `matrix/`, and `suppl/` autoindex directories and returns every file each holds:
 * the SOFT family record, one series-matrix file per platform (multi-platform series ship no combined file,
 * so enumeration — not a guessed filename — is what finds them all), and the author-deposited supplementary
 * files. Raw SRA reads are excluded by construction: they live in SRA, never under a Series' FTP tree. A
 * series that resolves but exposes no files in any of the three directories is a `no_processed_files` outcome.
 */
export async function resolveGeoArtifacts(accession: string, deps: { fetch?: FetchLike } = {}): Promise<Result<GeoArtifact[], GeoResolveError>> {
    const doFetch = deps.fetch ?? fetch;
    const urls = geoSeriesUrls(accession);
    const artifacts: GeoArtifact[] = [];
    for (const dirUrl of [urls.softDir, urls.matrixDir, urls.supplDir]) {
        const listed = await listDirectory(dirUrl, doFetch);
        if (listed.isErr()) return err(listed.error);
        artifacts.push(...listed.value);
    }
    return artifacts.length > 0 ? ok(artifacts) : err({ type: "no_processed_files", accession });
}

/** Why downloading a Series failed: either resolving its artifact set, or transferring one of them. */
export type GeoDownloadError = GeoResolveError | DownloadError;

/**
 * Download a GEO Series' processed + supplementary artifact set into `destDir`.
 *
 * Resolves the artifact set, then transfers each file (https-only, hashed, atomic) into `destDir` under its
 * own name. The whole set must land: a single failed transfer aborts and returns the error, so a caller that
 * enrolls the results only on `ok` never enrolls a partial set. Returns the local paths in resolution order.
 */
export async function downloadGeoSeries(
    accession: string,
    destDir: string,
    deps: { fetch?: FetchLike; onProgress?: (event: DownloadProgress) => void } = {},
): Promise<Result<string[], GeoDownloadError>> {
    const resolved = await resolveGeoArtifacts(accession, { fetch: deps.fetch });
    if (resolved.isErr()) return err(resolved.error);
    const paths: string[] = [];
    for (const artifact of resolved.value) {
        const downloaded = await downloadToFile(artifact.url, join(destDir, artifact.fileName), { fetch: deps.fetch, onProgress: deps.onProgress });
        if (downloaded.isErr()) return err(downloaded.error);
        paths.push(downloaded.value.path);
    }
    return ok(paths);
}
