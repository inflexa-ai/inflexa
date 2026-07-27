import { randomUUIDv7 } from "bun";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { declaredContentLength, downloadToFile, type DownloadError, type FetchLike } from "../../lib/download.ts";

/** The GEO FTP mirror (served over HTTPS) that holds per-series files and directory autoindexes. */
const GEO_FTP_BASE = "https://ftp.ncbi.nlm.nih.gov/geo/series";
/** The GEO web app that streams the bundled supplementary tar for a series. */
const GEO_WEB_BASE = "https://www.ncbi.nlm.nih.gov/geo/download";

/**
 * Total declared bytes a single Series may transfer before the command refuses.
 *
 * A runaway guard, not a curation policy: it exists so a mistyped accession that happens to resolve
 * to a whole-cohort `_RAW.tar` cannot silently fill the user's disk. Most bulk-expression Series are
 * well under a gigabyte; the ceiling is set high enough that a large single-cell Series still passes,
 * and the refusal names the measured size so a user who genuinely wants it knows what they are asking
 * for. Artifacts whose size the upstream never declared cannot be counted, so this bounds the
 * *declared* total — it is a floor on the real one, never a guarantee.
 */
export const GEO_SERIES_MAX_BYTES = 32 * 1024 ** 3;

/** Binary multipliers for {@link parseByteSize}; GEO and `formatBytes` both speak powers of 1024. */
const BYTE_UNITS: Readonly<Record<string, number>> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/**
 * Parse a human byte size (`500MB`, `1.5tb`, `2048`) into bytes, or `undefined` when it is not one.
 *
 * A bare number is bytes. Units are binary (`MB` = 1024²), matching `Number.prototype.formatBytes`,
 * so a ceiling a user copies out of the command's own output round-trips to the same value. Returns
 * `undefined` rather than an error type because the sole caller is a CLI flag boundary that has one
 * way-forward for every malformed spelling; a `Result` here would carry a distinction nothing reads.
 */
export function parseByteSize(raw: string): number | undefined {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
    if (!match) return undefined;
    const magnitude = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    const multiplier = unit === "" ? 1 : BYTE_UNITS[unit];
    if (multiplier === undefined || !Number.isFinite(magnitude)) return undefined;
    const bytes = Math.floor(magnitude * multiplier);
    return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** How many times one GEO request is attempted before its status is taken at face value. */
const GEO_RETRY_ATTEMPTS = 4;
/** Base of the exponential backoff between retries (500ms, 1s, 2s). */
const GEO_RETRY_BASE_MS = 500;
/** Pause between consecutive GEO requests, so a multi-file series does not read as a burst. */
const GEO_REQUEST_SPACING_MS = 150;

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

/** How GEO is reached. Production supplies none of these; the pacing knobs exist so a test need not sleep for real. */
export type GeoFetchOptions = {
    /** Fetch implementation; defaults to the runtime fetch. */
    readonly fetch?: FetchLike;
    /** Backoff base between retries; defaults to {@link GEO_RETRY_BASE_MS}. */
    readonly retryBaseMs?: number;
    /** Pause between consecutive requests; defaults to {@link GEO_REQUEST_SPACING_MS}. */
    readonly spacingMs?: number;
};

/** The Series' declared transfer cost exceeds {@link GEO_SERIES_MAX_BYTES}; nothing was fetched. */
export type GeoSizeError = { readonly type: "too_large"; readonly declaredBytes: number; readonly cap: number };

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
 * Undo the HTML escaping Apache applies to an `href` attribute value.
 *
 * An autoindex is HTML, so a file name containing `&` reaches us as `&amp;`. Resolving the escaped
 * form as a URL would silently mangle the name, so the entity pass runs before URL parsing. Only the
 * five predefined entities plus numeric `&#39;`/`&#x27;` are handled — an autoindex has no reason to
 * emit anything else, and a name we cannot decode faithfully is better skipped than guessed at.
 */
function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&#x0*27;/gi, "'")
        .replace(/&amp;/gi, "&"); // last: an escaped `&amp;amp;` must not decode twice
}

/**
 * Whether a decoded autoindex name is safe to use as a single path segment under the download dir.
 *
 * The listing is remote data, so its names are untrusted input to `join`. Percent-encoding is what
 * makes this non-obvious: `%2e%2e%2f` survives URL parsing as an opaque segment and only becomes
 * `../` after decoding, so containment has to be judged on the *decoded* name. Anything that is not
 * one ordinary segment — a separator, a traversal step, a NUL, a leading dash that would read as a
 * flag to some later consumer — is dropped rather than sanitized: a name we would have to rewrite is
 * not a name GEO published.
 */
function isSafeSegment(name: string): boolean {
    if (name === "" || name === "." || name === "..") return false;
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
    return !name.startsWith("-");
}

/**
 * Extract the file names from an Apache directory autoindex.
 *
 * GEO's FTP mirror serves each directory as HTML with no JSON alternative, and no HTML parser is
 * available, so this scans `href` attributes — but a scan alone cannot tell a file from the page
 * furniture. Each href is therefore *resolved against the directory URL* and kept only when the
 * result is same-origin and names exactly one more path segment under that directory. That single
 * test subsumes every case a hand-written filter kept getting wrong: sort links carry a query,
 * `../` and the absolute parent link resolve above the directory, subdirectory links leave a
 * trailing segment, `mailto:` has no matching origin, and NCBI's site-wide
 * `https://www.hhs.gov/vulnerability-disclosure-policy/…` footer link — present on every autoindex
 * page — is off-origin. It also disposes of traversal for free: `a/../../etc/passwd` normalizes
 * during resolution and lands outside the directory, so it never reaches the name check.
 */
export function parseAutoindex(html: string, dirUrl: string): string[] {
    let dir: URL;
    try {
        dir = new URL(dirUrl);
    } catch {
        return []; // A caller-built directory URL is always well-formed; a malformed one lists nothing.
    }
    const names: string[] = [];
    for (const match of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const raw = match[1] ?? match[2] ?? "";
        if (raw === "") continue;
        let resolved: URL;
        try {
            resolved = new URL(decodeHtmlEntities(raw), dir);
        } catch {
            continue; // Not a resolvable reference (e.g. a bare `javascript:` fragment) — not a file.
        }
        if (resolved.origin !== dir.origin) continue;
        if (resolved.search !== "" || resolved.hash !== "") continue;
        if (!resolved.pathname.startsWith(dir.pathname)) continue;
        const segment = resolved.pathname.slice(dir.pathname.length);
        if (segment === "" || segment.includes("/")) continue;
        let name: string;
        try {
            name = decodeURIComponent(segment);
        } catch {
            continue; // A malformed escape sequence is not a name we can reproduce on disk.
        }
        if (!isSafeSegment(name)) continue;
        if (!names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * Fetch one GEO URL, retrying the statuses NCBI uses to shed load.
 *
 * NCBI throttles by answering 403 — the same status its Apache serves for a directory with no index —
 * and the two are indistinguishable by status or body, which is why this retries rather than
 * classifying: a throttled request recovers within a couple of backoffs, while a genuinely empty
 * directory answers 403 every time and the caller reads the settled answer. 429 and 5xx are retried
 * for the ordinary reason. The backoff is exponential from {@link GEO_RETRY_BASE_MS}; a transport
 * throw is retried on the same schedule and only becomes an error once the attempts are spent.
 */
async function fetchGeo(url: string, options: GeoFetchOptions, init: RequestInit = {}): Promise<Result<Response, GeoResolveError>> {
    const doFetch = options.fetch ?? fetch;
    const base = options.retryBaseMs ?? GEO_RETRY_BASE_MS;
    let lastFailure = "";
    for (let attempt = 0; attempt < GEO_RETRY_ATTEMPTS; attempt += 1) {
        if (attempt > 0 && base > 0) await Promise.sleep(base * 2 ** (attempt - 1));
        let response: Response;
        try {
            response = await doFetch(url, init);
        } catch (cause) {
            lastFailure = `Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`;
            continue;
        }
        const shedding = response.status === 403 || response.status === 429 || response.status >= 500;
        if (!shedding || attempt === GEO_RETRY_ATTEMPTS - 1) return ok(response);
        lastFailure = `${url} answered HTTP ${response.status} ${response.statusText}`;
    }
    return err({ type: "unreachable", message: `${lastFailure} after ${GEO_RETRY_ATTEMPTS} attempts.` });
}

/**
 * List one autoindex directory's files as artifacts.
 *
 * An absent directory (404) and one that persists in answering 403 both contribute nothing rather
 * than failing the resolve. NCBI serves 403 for a directory that exists but has no index — the normal
 * state of `suppl/` for a Series whose authors deposited nothing — so treating it as fatal would make
 * "this Series has no supplementary files" indistinguishable from "GEO is down", and would abort a
 * download whose other directories listed perfectly well. {@link fetchGeo} has already retried it, so
 * a 403 arriving here is the settled answer, not a throttle.
 */
async function listDirectory(dirUrl: string, options: GeoFetchOptions): Promise<Result<GeoArtifact[], GeoResolveError>> {
    const response = await fetchGeo(dirUrl, options);
    if (response.isErr()) return err(response.error);
    if (response.value.status === 404 || response.value.status === 403) return ok([]);
    if (!response.value.ok)
        return err({ type: "unreachable", message: `Listing ${dirUrl} failed: HTTP ${response.value.status} ${response.value.statusText}.` });
    const html = await response.value.text();
    return ok(parseAutoindex(html, dirUrl).map((fileName) => ({ url: `${dirUrl}${encodeURIComponent(fileName)}`, fileName })));
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
export async function resolveGeoArtifacts(accession: string, options: GeoFetchOptions = {}): Promise<Result<GeoArtifact[], GeoResolveError>> {
    const urls = geoSeriesUrls(accession);
    const spacing = options.spacingMs ?? GEO_REQUEST_SPACING_MS;
    const artifacts: GeoArtifact[] = [];
    for (const [index, dirUrl] of [urls.softDir, urls.matrixDir, urls.supplDir].entries()) {
        if (index > 0 && spacing > 0) await Promise.sleep(spacing);
        const listed = await listDirectory(dirUrl, options);
        if (listed.isErr()) return err(listed.error);
        artifacts.push(...listed.value);
    }
    return artifacts.length > 0 ? ok(artifacts) : err({ type: "no_processed_files", accession });
}

/** What the upstream says a Series will cost before any of it moves. `unsized` artifacts declared nothing. */
export type GeoSeriesSize = { readonly declaredBytes: number; readonly sized: number; readonly unsized: number };

/**
 * Ask GEO how large each artifact is, so the cap and the readout can state bytes before transferring.
 *
 * Returns a plain value rather than a `Result`: a probe that fails, times out, or answers without a
 * usable `Content-Length` means one thing to every caller — that artifact's size is unknown — which is
 * a state the cap and the readout already handle. Letting a metadata probe fail a download that would
 * otherwise succeed would trade the work for the commentary on it. Probes run sequentially and spaced,
 * because a burst of HEADs is exactly what NCBI sheds.
 */
export async function measureGeoArtifacts(artifacts: readonly GeoArtifact[], options: GeoFetchOptions = {}): Promise<GeoSeriesSize> {
    const spacing = options.spacingMs ?? GEO_REQUEST_SPACING_MS;
    let declaredBytes = 0;
    let sized = 0;
    let unsized = 0;
    for (const artifact of artifacts) {
        if (sized + unsized > 0 && spacing > 0) await Promise.sleep(spacing);
        const probe = await fetchGeo(artifact.url, options, { method: "HEAD" });
        const size = probe.isOk() && probe.value.ok ? declaredContentLength(probe.value) : undefined;
        if (size === undefined) {
            unsized += 1;
            continue;
        }
        declaredBytes += size;
        sized += 1;
    }
    return { declaredBytes, sized, unsized };
}

/** Why downloading a Series failed: resolving its artifact set, its declared size, or transferring one of them. */
export type GeoDownloadError = GeoResolveError | GeoSizeError | DownloadError;

/**
 * How often an in-flight file reports its byte count.
 *
 * Not only a readout: a Series file can transfer for minutes without any other event, and the agent
 * path runs this command as a subprocess bounded by how long it stays QUIET. A periodic line is what
 * distinguishes a large download from a hung one, to the user and to that bound alike.
 */
const PROGRESS_HEARTBEAT_MS = 5_000;

/** Progress over a whole Series transfer — one event per phase, per file, and per heartbeat. */
export type GeoProgress =
    | { readonly type: "resolved"; readonly files: number; readonly size: GeoSeriesSize }
    | { readonly type: "file_started"; readonly fileName: string; readonly index: number; readonly total: number; readonly declaredBytes?: number }
    | { readonly type: "file_progress"; readonly fileName: string; readonly bytes: number; readonly declaredBytes?: number }
    | { readonly type: "file_completed"; readonly fileName: string; readonly bytes: number };

/** Options for {@link downloadGeoSeries}. */
export type DownloadGeoSeriesOptions = GeoFetchOptions & {
    readonly onProgress?: (event: GeoProgress) => void;
    /** Declared-bytes ceiling; defaults to {@link GEO_SERIES_MAX_BYTES}. */
    readonly maxBytes?: number;
    /** Minimum gap between `file_progress` events; defaults to {@link PROGRESS_HEARTBEAT_MS}. */
    readonly heartbeatMs?: number;
};

/**
 * Download a GEO Series' processed + supplementary artifact set into `destDir`.
 *
 * The bytes land in a sibling staging directory and are moved into `destDir` only once every artifact
 * has transferred, so a caller that enrols on `ok` can never enrol a partial set and a failed run
 * leaves nothing behind — the durable download directory is the analysis's, and littering it with the
 * debris of an aborted attempt would strand files no input row points at. A single failed transfer
 * aborts the set: the artifact list is what GEO published for the Series, so a missing member means
 * the local copy is not that Series. Returns the destination paths in resolution order.
 */
export async function downloadGeoSeries(
    accession: string,
    destDir: string,
    options: DownloadGeoSeriesOptions = {},
): Promise<Result<string[], GeoDownloadError>> {
    const resolved = await resolveGeoArtifacts(accession, options);
    if (resolved.isErr()) return err(resolved.error);
    const artifacts = resolved.value;

    const size = await measureGeoArtifacts(artifacts, options);
    options.onProgress?.({ type: "resolved", files: artifacts.length, size });
    const cap = options.maxBytes ?? GEO_SERIES_MAX_BYTES;
    if (size.declaredBytes > cap) return err({ type: "too_large", declaredBytes: size.declaredBytes, cap });

    // Sibling of destDir rather than a child: destDir is only created once the whole set has landed,
    // so an aborted run cannot leave an empty or half-filled accession directory for the next one to
    // mistake for a completed download.
    const staging = `${destDir}.incoming-${randomUUIDv7()}`;
    const spacing = options.spacingMs ?? GEO_REQUEST_SPACING_MS;
    const staged: { readonly from: string; readonly to: string }[] = [];
    try {
        for (const [index, artifact] of artifacts.entries()) {
            const to = join(destDir, artifact.fileName);
            // `parseAutoindex` already admits only single safe segments, so this can only fire if a
            // future caller supplies artifacts from elsewhere. Cheap, and the failure it prevents —
            // writing outside the analysis's download directory — is not one to leave to one guard.
            if (dirname(to) !== destDir)
                return err({ type: "io_failed", message: `Refusing ${artifact.fileName}: it does not name a file directly under ${destDir}.` });
            if (index > 0 && spacing > 0) await Promise.sleep(spacing);
            const from = join(staging, artifact.fileName);
            // Chunk events are far too frequent to forward as-is, so they are folded into a running
            // total and emitted at most once per heartbeat — enough to show life, never a flood.
            const heartbeat = options.heartbeatMs ?? PROGRESS_HEARTBEAT_MS;
            let declaredBytes: number | undefined;
            let transferred = 0;
            let lastReportAt = Date.now();
            const downloaded = await downloadToFile(artifact.url, from, {
                fetch: options.fetch,
                onProgress: (event) => {
                    if (event.type === "started") {
                        declaredBytes = event.declaredBytes;
                        options.onProgress?.({
                            type: "file_started",
                            fileName: artifact.fileName,
                            index,
                            total: artifacts.length,
                            ...(declaredBytes === undefined ? {} : { declaredBytes }),
                        });
                        return;
                    }
                    if (event.type !== "bytes") return;
                    transferred += event.bytes;
                    const now = Date.now();
                    if (now - lastReportAt < heartbeat) return;
                    lastReportAt = now;
                    options.onProgress?.({
                        type: "file_progress",
                        fileName: artifact.fileName,
                        bytes: transferred,
                        ...(declaredBytes === undefined ? {} : { declaredBytes }),
                    });
                },
            });
            if (downloaded.isErr()) return err(downloaded.error);
            options.onProgress?.({ type: "file_completed", fileName: artifact.fileName, bytes: downloaded.value.bytes });
            staged.push({ from, to });
        }
        await mkdir(destDir, { recursive: true });
        for (const { from, to } of staged) await rename(from, to);
        return ok(staged.map((s) => s.to));
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not move the downloaded ${accession} files into ${destDir}.`, cause });
    } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
}
