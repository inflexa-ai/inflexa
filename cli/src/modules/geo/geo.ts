import { randomUUIDv7 } from "bun";
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { err, ok, type Result } from "neverthrow";
import PQueue from "p-queue";

import { declaredContentLength, downloadToFile, type DownloadError, type FetchLike } from "../../lib/download.ts";

/** The GEO FTP mirror (served over HTTPS) that holds per-series files and directory autoindexes. */
const GEO_FTP_BASE = "https://ftp.ncbi.nlm.nih.gov/geo/series";

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

/**
 * How many size probes may be open at once.
 *
 * Concurrency IS the rate limit for the sweep — four sockets, fewer than a browser opens against one host,
 * and fewer than the reference installer already asks of this same host. It is applied here and NOT to the
 * two neighbouring loops, because only here is a shed request harmless: a probe that loses is an artifact of
 * unknown size, which the cap and the readout already handle. A shed *listing* would instead read as an empty
 * directory (see {@link listDirectory}) and a shed *transfer* aborts the Series, so both stay serial.
 */
const GEO_SIZE_PROBE_CONCURRENCY = 4;

/**
 * Wall-clock budget for a whole size sweep, shared by every probe in it.
 *
 * A per-request timeout bounds one attempt but not the step: a Series of a hundred small files, each probe
 * free to retry a shed 403 four times, would hold the command silent for minutes before a byte moved — and
 * this command runs as a subprocess bounded by how long it stays QUIET. One deadline caps the step regardless
 * of how many artifacts it covers, which is what makes a metadata phase structurally incapable of causing that
 * kill; whatever has not answered when it fires is simply unsized.
 */
const GEO_SIZE_PROBE_BUDGET_MS = 15_000;

/**
 * The statuses NCBI uses to shed load.
 *
 * 403 is in the set because NCBI answers it both for a directory with no index and for a request it is
 * throttling (see {@link fetchGeo}). Shared with the artifact transfer so a shed GET is retried on the same
 * terms as a shed listing — a transfer that took the first answer would discard every artifact already
 * staged for the Series.
 */
function isSheddingStatus(status: number): boolean {
    return status === 403 || status === 429 || status >= 500;
}

/** A malformed or non-Series accession — the input is echoed back so the caller can report it. */
export type GeoAccessionError = { readonly type: "invalid_accession"; readonly input: string };

/** The canonical URLs for one GEO Series' processed data. `softDir`/`matrixDir`/`supplDir` are autoindex directories to enumerate. */
export type GeoSeriesUrls = {
    readonly softDir: string;
    readonly matrixDir: string;
    readonly supplDir: string;
};

/** One downloadable GEO artifact: its absolute URL and the file name it should land under. */
export type GeoArtifact = { readonly url: string; readonly fileName: string };

/** Progress over a whole Series operation — one event per phase, per file, and per heartbeat. */
export type GeoProgress =
    | { readonly type: "skipped"; readonly dirUrl: string; readonly fileName: string }
    | { readonly type: "resolved"; readonly files: number; readonly size: GeoSeriesSize }
    | { readonly type: "file_started"; readonly fileName: string; readonly index: number; readonly total: number; readonly declaredBytes?: number }
    | { readonly type: "file_progress"; readonly fileName: string; readonly bytes: number; readonly declaredBytes?: number }
    | { readonly type: "file_completed"; readonly fileName: string; readonly bytes: number };

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
    /** Budget for a whole size sweep; defaults to {@link GEO_SIZE_PROBE_BUDGET_MS}. */
    readonly budgetMs?: number;
};

/** How a Series' artifact set is resolved: the fetch seams, plus the channel a skipped name is reported on. */
export type GeoResolveOptions = GeoFetchOptions & {
    readonly onProgress?: (event: GeoProgress) => void;
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
 * and no combined file, so enumeration — not a guessed filename — finds them all.
 */
export function geoSeriesUrls(accession: string): GeoSeriesUrls {
    const dir = `${GEO_FTP_BASE}/${seriesBucket(accession)}/${accession}/`;
    return {
        softDir: `${dir}soft/`,
        matrixDir: `${dir}matrix/`,
        supplDir: `${dir}suppl/`,
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
 *
 * `onSkipped` is notified for an href that IS a file in this directory but whose name cannot be
 * reproduced on disk — an unusable percent-escape, or a segment {@link isSafeSegment} refuses.
 * Page furniture is not reported: a sort link or the footer was never a file, whereas a dropped
 * name means the set no longer matches what GEO published, and a caller that promises a complete
 * Series has to be able to say so. Reporting rather than failing keeps one odd supplementary file
 * from costing the user the rest of the download.
 */
export function parseAutoindex(html: string, dirUrl: string, onSkipped?: (fileName: string) => void): string[] {
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
            // A malformed escape sequence is not a name we can reproduce on disk. Reported under
            // its raw spelling, the only one we have.
            onSkipped?.(segment);
            continue;
        }
        if (!isSafeSegment(name)) {
            onSkipped?.(name);
            continue;
        }
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
    let lastFailure = `${url} was abandoned before it answered`;
    for (let attempt = 0; attempt < GEO_RETRY_ATTEMPTS; attempt += 1) {
        // A caller's deadline outranks the retry schedule: once it has fired, every further attempt fails
        // instantly, so retrying would spend the backoff for nothing and let a sweep outlive its budget.
        if (init.signal?.aborted === true) break;
        if (attempt > 0 && base > 0) await Promise.sleep(base * 2 ** (attempt - 1));
        let response: Response;
        try {
            response = await doFetch(url, init);
        } catch (cause) {
            lastFailure = `Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`;
            continue;
        }
        if (!isSheddingStatus(response.status) || attempt === GEO_RETRY_ATTEMPTS - 1) return ok(response);
        lastFailure = `${url} answered HTTP ${response.status} ${response.statusText}`;
        // A discarded response still owns its socket until the body is drained or cancelled, and an
        // abandoned one would hold the connection the imminent retry needs — the same reason the
        // transfer primitive drains before its own retry.
        await response.body?.cancel().catch(() => undefined);
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
async function listDirectory(dirUrl: string, options: GeoResolveOptions): Promise<Result<GeoArtifact[], GeoResolveError>> {
    const response = await fetchGeo(dirUrl, options);
    if (response.isErr()) return err(response.error);
    if (response.value.status === 404 || response.value.status === 403) return ok([]);
    if (!response.value.ok)
        return err({ type: "unreachable", message: `Listing ${dirUrl} failed: HTTP ${response.value.status} ${response.value.statusText}.` });
    const html = await response.value.text();
    const names = parseAutoindex(html, dirUrl, (fileName) => options.onProgress?.({ type: "skipped", dirUrl, fileName }));
    return ok(names.map((fileName) => ({ url: `${dirUrl}${encodeURIComponent(fileName)}`, fileName })));
}

/**
 * Resolve a GEO Series accession to its processed + supplementary artifact set.
 *
 * Enumerates the `soft/`, `matrix/`, and `suppl/` autoindex directories and returns every file each holds:
 * the SOFT family record, one series-matrix file per platform (multi-platform series ship no combined file,
 * so enumeration — not a guessed filename — is what finds them all), and the author-deposited supplementary
 * files. Raw SRA reads are excluded by construction: they live in SRA, never under a Series' FTP tree. A
 * series that resolves but exposes no files in any of the three directories is a `no_processed_files` outcome.
 *
 * The three listings stay serial. Issuing them together would save one spacing interval and risk the worst
 * failure in this module: {@link listDirectory} reads a settled 403 as "this directory holds nothing", so a
 * shed listing does not fail the command — it silently subtracts a directory from the Series. Landing on
 * `suppl/` that way yields an exit-zero download of a Series missing its supplementary files.
 */
export async function resolveGeoArtifacts(accession: string, options: GeoResolveOptions = {}): Promise<Result<GeoArtifact[], GeoResolveError>> {
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
 * otherwise succeed would trade the work for the commentary on it.
 *
 * Probes run behind a small queue under one deadline covering the whole sweep, rather than serially: this
 * is the phase between "the user pressed enter" and the first byte, and probed one at a time a Series of a
 * hundred small files is minutes of silence in a command whose agent-side bound IS silence. Bounding the
 * step is the load-bearing half, not the concurrency — anything unanswered when the deadline fires is
 * unsized, which costs an estimate, never a file. See {@link GEO_SIZE_PROBE_CONCURRENCY} for why the two
 * neighbouring loops stay serial regardless.
 */
export async function measureGeoArtifacts(artifacts: readonly GeoArtifact[], options: GeoFetchOptions = {}): Promise<GeoSeriesSize> {
    if (artifacts.length === 0) return { declaredBytes: 0, sized: 0, unsized: 0 };
    const queue = new PQueue({ concurrency: GEO_SIZE_PROBE_CONCURRENCY });
    // Started once, here, so the deadline covers the queue's whole drain rather than restarting per probe —
    // which is what makes the budget a bound on the step instead of on one request.
    const deadline = AbortSignal.timeout(options.budgetMs ?? GEO_SIZE_PROBE_BUDGET_MS);

    const declared = await Promise.all(
        artifacts.map((artifact) =>
            queue.add(async (): Promise<number | undefined> => {
                // Checked on entry as well as inside `fetchGeo`: a probe still queued when the budget fires
                // gives up here, so a fired deadline drains the backlog at once instead of one fetch at a time.
                if (deadline.aborted) return undefined;
                const probe = await fetchGeo(artifact.url, options, { method: "HEAD", signal: deadline });
                return probe.isOk() && probe.value.ok ? declaredContentLength(probe.value) : undefined;
            }),
        ),
    );

    let declaredBytes = 0;
    let sized = 0;
    for (const size of declared) {
        if (size === undefined) continue;
        declaredBytes += size;
        sized += 1;
    }
    return { declaredBytes, sized, unsized: artifacts.length - sized };
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

/** Options for {@link downloadGeoSeries}. */
export type DownloadGeoSeriesOptions = GeoResolveOptions & {
    /** Declared-bytes ceiling; defaults to {@link GEO_SERIES_MAX_BYTES}. */
    readonly maxBytes?: number;
    /** Minimum gap between `file_progress` events; defaults to {@link PROGRESS_HEARTBEAT_MS}. */
    readonly heartbeatMs?: number;
};

/**
 * Discard the staging directories earlier runs left behind, and recover an interrupted swap.
 *
 * The `finally` that removes staging does not run when the process is signalled, and this command's
 * commonest abort IS a signal: `run_inflexa` escalates SIGTERM→SIGKILL on its deadline, and a user's
 * ctrl-c does the same. Without a sweep every killed download deposits a partial `.incoming-…`
 * directory in the user's own data folder, permanently and cumulatively. Nothing else reclaims them,
 * so the next run does.
 *
 * `.replaced-…` is the previous copy held during the swap below, and is NOT unconditionally discarded:
 * if the process died between the two renames, that directory is the user's ONLY copy of the Series,
 * so an absent `destDir` means restore it rather than delete it.
 *
 * Accepted: two concurrent downloads of the same accession into the same folder would sweep each
 * other's staging. They already collide on `destDir` itself, so this adds no new failure class.
 */
async function sweepStaleStaging(destDir: string): Promise<void> {
    const parent = dirname(destDir);
    const prefix = basename(destDir);
    const entries = await readdir(parent).catch(() => [] as string[]);
    // Descending, so the first `.replaced-` seen is the newest: the suffix is a v7 uuid, which sorts
    // lexicographically by mint time.
    for (const entry of entries.sort().reverse()) {
        const path = join(parent, entry);
        if (entry.startsWith(`${prefix}.incoming-`)) await rm(path, { recursive: true, force: true }).catch(() => undefined);
        else if (entry.startsWith(`${prefix}.replaced-`)) {
            if (existsSync(destDir)) await rm(path, { recursive: true, force: true }).catch(() => undefined);
            else await rename(path, destDir).catch(() => undefined);
        }
    }
}

/**
 * Download a GEO Series' processed + supplementary artifact set into `destDir`.
 *
 * The bytes land in a sibling staging directory, which is swapped in as a WHOLE once every artifact
 * has transferred, so `destDir` either holds the complete published Series or does not exist at all —
 * a half-set can never be mistaken for a finished download. Swapping the directory rather than moving
 * files into an existing one is what makes a re-download a replacement: a per-file move merges into
 * whatever the previous run left, so a Series that dropped a file upstream would keep a stale copy
 * locally and still report complete. A single failed transfer aborts the set: the artifact list is
 * what GEO published for the Series, so a missing member means the local copy is not that Series, and
 * any previous copy is left exactly as it was. Returns the destination paths in resolution order.
 *
 * Debris in the user's own data folder is swept rather than merely avoided — the cleanup here cannot
 * run when the process is signalled, so {@link sweepStaleStaging} reclaims what earlier runs left.
 */
export async function downloadGeoSeries(
    accession: string,
    destDir: string,
    options: DownloadGeoSeriesOptions = {},
): Promise<Result<string[], GeoDownloadError>> {
    // Before anything is fetched, so a folder littered by earlier kills is clean even on a run that
    // then fails its own resolve — and so the disk the size cap is about to be judged against is the
    // one the transfer will actually use.
    await sweepStaleStaging(destDir);

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
                // The transfer is the one GEO request not routed through `fetchGeo`, so its schedule is
                // stated here instead: a single shed GET would otherwise abort the set and discard every
                // artifact already staged for it. Transfers stay SERIAL despite that — see
                // `GEO_SIZE_PROBE_CONCURRENCY` — because this is the path with the least room to absorb a
                // shed response, and parallelism would multiply exposure to exactly the status it sheds with.
                retry: { attempts: GEO_RETRY_ATTEMPTS, baseMs: options.retryBaseMs ?? GEO_RETRY_BASE_MS, shouldRetry: isSheddingStatus },
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
        }
        // `rename` refuses a non-empty destination, so an existing copy steps aside first and is
        // discarded only once the new one is in place. The window between the two renames is where a
        // signalled process would leave no `destDir` at all — which is exactly what `sweepStaleStaging`
        // restores from on the next run, so the pair is recoverable rather than merely narrow.
        const replaced = `${destDir}.replaced-${randomUUIDv7()}`;
        const hadPrevious = existsSync(destDir);
        if (hadPrevious) await rename(destDir, replaced);
        try {
            await rename(staging, destDir);
        } catch (cause) {
            if (hadPrevious) await rename(replaced, destDir).catch(() => undefined);
            throw cause;
        }
        if (hadPrevious) await rm(replaced, { recursive: true, force: true }).catch(() => undefined);
        return ok(artifacts.map((artifact) => join(destDir, artifact.fileName)));
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not move the downloaded ${accession} files into ${destDir}.`, cause });
    } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
}
