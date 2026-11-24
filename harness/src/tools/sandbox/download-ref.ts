/**
 * `download_ref` — the one tool that downloads a file into the reference store.
 *
 * A call takes HTTPS URLs on one host. Each file goes to `<store>/<host>/<path of the URL>`, with no query string, and
 * a `Content-Disposition` name replaces the last segment. The transfer writes a `.part` file beside the target, and a
 * later call continues it with a `Range` request. The rename to the target comes after a complete transfer only.
 *
 * Each hop must be HTTPS, and each address of its host must be public. The tool resolves the name, classifies each
 * address, and then connects to a classified address. Thus a second resolution cannot give the connection a different
 * address.
 *
 * `<store>/.inflexa/sources.jsonl` records the URL of each completed file. A URL that the record names, with its file
 * present, gives the existing path and no transfer.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { parseHTML } from "linkedom";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { ReferenceDownloadOptions } from "../../config/environment-stores.js";
import { formatBytes } from "../../input-scan/scan.js";
import { isAbsent } from "../../lib/fs-result.js";
import { safeParseJsonAs } from "../../lib/parse-json.js";
import { errorMessageOf } from "../../lib/thrown.js";
import { REFS_CONTAINER_PATH } from "../../sandbox/mount-plan.js";
import type { AskRequest } from "../approval/contract.js";
import { defineTool, type Tool, type ToolContext, type ToolError } from "../define-tool.js";
import { HARNESS_USER_AGENT } from "../lib/api-utils.js";
import { isGuardedAddress } from "../research/guarded-address.js";
import { archiveKindOf, extractTarStream, extractZipStream, type ExtractRefusal, type ExtractSummary } from "../script/archive.js";

/**
 * The hosts of public reference databases. A download from one of them, or from a subdomain of one, asks nothing.
 * A host of general file hosting is not here, because anyone can publish there: GitHub, Zenodo, figshare, and a cloud
 * bucket by its shared host. A bucket that a reference project owns is here by its own host name.
 */
export const DEFAULT_DOWNLOAD_AUTO_APPROVE_HOSTS: readonly string[] = [
    // Sequence, genome, and annotation archives
    "nih.gov",
    "ebi.ac.uk",
    "ensembl.org",
    "ensemblgenomes.org",
    "ucsc.edu",
    "gencodegenes.org",
    "ddbj.nig.ac.jp",
    "internationalgenome.org",
    "ngi-igenomes.s3.amazonaws.com",
    "1000genomes.s3.amazonaws.com",
    "gnomad-public-us-east-1.s3.amazonaws.com",
    // Proteins and structures
    "uniprot.org",
    "rcsb.org",
    "wwpdb.org",
    "pdbj.org",
    "proteinatlas.org",
    "proteomicsdb.org",
    // Pathways, gene sets, interactions, and ontologies
    "gsea-msigdb.org",
    "broadinstitute.org",
    "reactome.org",
    "wikipathways.org",
    "pathwaycommons.org",
    "geneontology.org",
    "obolibrary.org",
    "monarchinitiative.org",
    "string-db.org",
    "stringdb-downloads.org",
    "omnipathdb.org",
    "genome.jp",
    "kegg.jp",
    "maayanlab.cloud",
    "jaspar.elixir.no",
    "aertslab.org",
    // Expression, single-cell, and functional genomics
    "gtexportal.org",
    "encodeproject.org",
    "cziscience.com",
    "humancellatlas.org",
    "10xgenomics.com",
    "sanger.ac.uk",
    "panglaodb.se",
    "bgee.org",
    "clue.io",
    "lincsproject.org",
    "lincsportal.ccs.miami.edu",
    // Disease, variants, drugs, and cancer
    "cancer.gov",
    "cbioportal.org",
    "opentargets.org",
    "pharmgkb.org",
    "orphadata.com",
    "disgenet.org",
    "drugbank.com",
    "kircherlab.bihealth.org",
    "cadd.gs.washington.edu",
    // Model organisms
    "jax.org",
    "mousephenotype.org",
    "mcw.edu",
    "flybase.org",
    "wormbase.org",
    "zfin.org",
    "yeastgenome.org",
    "arabidopsis.org",
    "xenbase.org",
    // Metabolism and microbiome
    "hmdb.ca",
    "lipidmaps.org",
    "vmh.life",
    "bigg.ucsd.edu",
    "massive.ucsd.edu",
    "arb-silva.de",
    "ecogenomic.org",
    "unite.ut.ee",
    // Packages that ship reference data
    "bioconductor.org",
    "r-project.org",
];

const MAX_URLS = 20;
const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 120_000;
const PROGRESS_INTERVAL_MS = 2_000;
const SOURCES_DIR = ".inflexa";
const SOURCES_FILE = "sources.jsonl";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One resolved address of a host. */
export type ResolvedAddress = { readonly address: string; readonly family: number };

/** The response of one hop: the status, the headers, and the body stream. */
export type DownloadResponse = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: Readable };

export type DownloadRequestOptions = {
    readonly headers: Record<string, string>;
    /** The classified address that the connection must use. */
    readonly address: ResolvedAddress;
    readonly signal: AbortSignal;
};

/** How the tool reaches the network. A test gives a local server and a fixed resolution. */
export type DownloadRefOpts = {
    readonly resolveHost: (hostname: string) => Promise<readonly ResolvedAddress[]>;
    readonly request: (url: URL, options: DownloadRequestOptions) => Promise<DownloadResponse>;
    readonly now: () => number;
};

function httpsGet(url: URL, options: DownloadRequestOptions): Promise<DownloadResponse> {
    const { address, family } = options.address;
    return new Promise((resolve, reject) => {
        const request = httpsRequest(url, {
            // A pooled socket can carry a connection to an address that this hop did not classify.
            agent: false,
            headers: options.headers,
            signal: options.signal,
            timeout: IDLE_TIMEOUT_MS,
            lookup: (_hostname, lookupOptions, callback) => {
                if (lookupOptions.all === true) callback(null, [{ address, family }]);
                else callback(null, address, family);
            },
        });
        request.on("timeout", () => request.destroy(new Error(`the server sent no data for ${IDLE_TIMEOUT_MS / 1000} s`)));
        request.on("error", reject);
        request.on("response", (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
        request.end();
    });
}

export const DEFAULT_DOWNLOAD_REF_OPTS: DownloadRefOpts = {
    resolveHost: async (hostname) => {
        const family = isIP(hostname);
        if (family !== 0) return [{ address: hostname, family }];
        return dnsLookup(hostname, { all: true });
    },
    request: httpsGet,
    now: Date.now,
};

export type DownloadRefFile = {
    readonly url: string;
    readonly status: "downloaded" | "reused" | "failed";
    /** The path of the file, or of the directory of an extracted archive, under `/mnt/refs`. */
    readonly path?: string;
    readonly extracted?: boolean;
    /** The first files of an extracted archive, under `/mnt/refs`, and the count of the files past them. */
    readonly files?: readonly string[];
    readonly moreFiles?: number;
    readonly note?: string;
    readonly error?: string;
};

export type DownloadRefOutput = { readonly host: string; readonly files: readonly DownloadRefFile[] };

/** A URL of a call, checked: its normalized text, its host, and the segments of its path. */
type CheckedUrl = { readonly url: URL; readonly key: string; readonly host: string; readonly segments: readonly string[] };

function withoutTrailingDot(name: string): string {
    return name.endsWith(".") ? name.slice(0, -1) : name;
}

function hostOf(url: URL): string {
    const bare = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
    return withoutTrailingDot(bare.toLowerCase());
}

/** A name that can be one path segment of the store. */
function isSafeSegment(segment: string): boolean {
    return segment !== "" && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\") && !segment.includes("\0");
}

function checkUrl(raw: string): Result<CheckedUrl, string> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return err(`${raw} is not a valid URL`);
    }
    if (url.protocol !== "https:") return err(`${raw} does not use HTTPS`);
    if (url.username !== "" || url.password !== "") return err(`${raw} carries credentials`);
    url.hash = "";
    const segments: string[] = [];
    for (const encoded of url.pathname.split("/").slice(1)) {
        let segment: string;
        try {
            segment = decodeURIComponent(encoded);
        } catch {
            return err(`${raw} has a path segment that does not decode`);
        }
        if (!isSafeSegment(segment)) return err(`${raw} has an empty, ".", or ".." path segment, thus it gives no store path`);
        segments.push(segment);
    }
    if (segments.length === 0) return err(`${raw} names no file`);
    return ok({ url, key: url.toString(), host: hostOf(url), segments });
}

/** The checked URLs of a call, or the reason that the call is refused before any download. */
function checkCall(urls: readonly string[]): Result<{ host: string; urls: CheckedUrl[] }, string> {
    const checked: CheckedUrl[] = [];
    for (const raw of urls) {
        const one = checkUrl(raw);
        if (one.isErr()) return err(one.error);
        checked.push(one.value);
    }
    const hosts = [...new Set(checked.map((url) => url.host))];
    const [host] = hosts;
    if (host === undefined) return err("the call gives no URL");
    if (hosts.length > 1) return err(`a call downloads from one host, and the URLs name ${hosts.join(" and ")}. Make one call for each host.`);
    return ok({ host, urls: checked });
}

/** Does the host match an entry of the list: the entry itself, or a subdomain of it? */
export function isAutoApprovedHost(host: string, list: readonly string[]): boolean {
    return list.some((raw) => {
        let entry = withoutTrailingDot(raw.trim().toLowerCase());
        while (entry.startsWith(".")) entry = entry.slice(1);
        return entry !== "" && (host === entry || host.endsWith(`.${entry}`));
    });
}

/** The file name of a `Content-Disposition` header, when it names a name that can be one segment. */
export function dispositionName(header: string | undefined): string | undefined {
    if (header === undefined) return undefined;
    const params = new Map<string, string>();
    for (const part of header.split(";")) {
        const equals = part.indexOf("=");
        if (equals !== -1) params.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim());
    }
    let name: string | undefined;
    const extended = params.get("filename*");
    // The extended form is `charset'language'percent-encoded-name`.
    const encoded = extended?.slice(extended.lastIndexOf("'") + 1);
    if (encoded !== undefined && encoded !== "") {
        try {
            name = decodeURIComponent(encoded);
        } catch {
            name = undefined;
        }
    }
    const plain = params.get("filename");
    if (name === undefined && plain !== undefined) name = plain.length >= 2 && plain.startsWith('"') && plain.endsWith('"') ? plain.slice(1, -1) : plain;
    return name !== undefined && isSafeSegment(name) && name.length <= 255 ? name : undefined;
}

const SourceRecordSchema = z.object({ path: z.string(), url: z.string(), at: z.string() });

/** The store path of each URL in the source record. A later line for a URL replaces an earlier one. */
async function readSources(storePath: string): Promise<Map<string, string>> {
    const sources = new Map<string, string>();
    const stream = createReadStream(join(storePath, SOURCES_DIR, SOURCES_FILE), { encoding: "utf8" });
    try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
            const parsed = safeParseJsonAs(line, SourceRecordSchema);
            if (parsed.success) sources.set(parsed.data.url, parsed.data.path);
        }
    } catch (cause) {
        if (!isAbsent(cause)) throw cause;
    }
    return sources;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (cause) {
        if (isAbsent(cause)) return false;
        throw cause;
    }
}

async function sizeOf(path: string): Promise<number> {
    try {
        return (await stat(path)).size;
    } catch (cause) {
        if (isAbsent(cause)) return 0;
        throw cause;
    }
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

type Transfer =
    | { readonly kind: "done"; readonly headers: IncomingHttpHeaders }
    /** `missing` is the URL that answered 404, after the redirects. */
    | { readonly kind: "failed"; readonly reason: string; readonly missing?: URL };

/**
 * The response of the first address that connects, in the order of the resolution. A host can resolve to an address
 * that this machine has no route to, for example an IPv6 address on a network with IPv4 only, thus a failure before a
 * response tries the next address. Each address passed the guard before this call.
 */
async function requestFirstReachable(
    url: URL,
    addresses: readonly ResolvedAddress[],
    options: Omit<DownloadRequestOptions, "address">,
    opts: DownloadRefOpts,
): Promise<DownloadResponse> {
    let failure: unknown = new Error(`the host ${hostOf(url)} has no address`);
    for (const address of addresses) {
        try {
            return await opts.request(url, { ...options, address });
        } catch (cause) {
            if (options.signal.aborted) throw cause;
            failure = cause;
        }
    }
    throw failure;
}

/**
 * Transfer one URL into `part`, and follow the redirects. A `.part` file that exists continues with a `Range`
 * request. A server that sends the whole file again, or that refuses the range, starts the file again one time.
 */
async function transfer(
    start: URL,
    part: string,
    opts: DownloadRefOpts,
    signal: AbortSignal,
    onBytes: (written: number, total: number | undefined) => void,
): Promise<Transfer> {
    let current = start;
    let redirects = 0;
    let restarted = false;
    for (;;) {
        if (current.protocol !== "https:") return { kind: "failed", reason: `a redirect goes to ${current.toString()}, which does not use HTTPS` };
        let addresses: readonly ResolvedAddress[];
        try {
            addresses = await opts.resolveHost(hostOf(current));
        } catch (cause) {
            return { kind: "failed", reason: `the host ${hostOf(current)} did not resolve: ${errorMessageOf(cause) ?? "unknown error"}` };
        }
        if (addresses.length === 0) return { kind: "failed", reason: `the host ${hostOf(current)} has no address` };
        if (addresses.some((entry) => isGuardedAddress(entry.address))) {
            return { kind: "failed", reason: `the host ${hostOf(current)} has an internal address (loopback, private, link-local, or reserved)` };
        }

        const offset = await sizeOf(part);
        const headers: Record<string, string> = { "user-agent": HARNESS_USER_AGENT, "accept-encoding": "identity" };
        if (offset > 0) headers.range = `bytes=${offset}-`;
        const response = await requestFirstReachable(current, addresses, { headers, signal }, opts);
        const { status } = response;
        const location = firstHeader(response.headers, "location");

        if (REDIRECT_STATUSES.has(status) && location !== undefined) {
            response.body.destroy();
            if (redirects >= MAX_REDIRECTS) return { kind: "failed", reason: `the URL redirects more than ${MAX_REDIRECTS} times` };
            redirects += 1;
            try {
                current = new URL(location, current);
            } catch {
                return { kind: "failed", reason: `a redirect names ${location}, which is not a valid URL` };
            }
            continue;
        }

        const resumes = status === 206 && offset > 0 && (firstHeader(response.headers, "content-range") ?? "").startsWith(`bytes ${offset}-`);
        if ((status === 416 || status === 206) && offset > 0 && !resumes) {
            response.body.destroy();
            if (restarted) return { kind: "failed", reason: `the server answered HTTP ${status} to a range request` };
            restarted = true;
            await rm(part, { force: true });
            continue;
        }
        if (status !== 200 && !resumes) {
            response.body.destroy();
            return status === 404
                ? { kind: "failed", reason: "the server answered HTTP 404", missing: current }
                : { kind: "failed", reason: `the server answered HTTP ${status}` };
        }

        const length = Number.parseInt(firstHeader(response.headers, "content-length") ?? "", 10);
        const expected = Number.isFinite(length) ? length + (resumes ? offset : 0) : undefined;
        let received = resumes ? offset : 0;
        onBytes(received, expected);
        const counted = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
            for await (const chunk of source) {
                received += chunk.length;
                onBytes(received, expected);
                yield chunk;
            }
        };
        try {
            await pipeline(response.body, counted, createWriteStream(part, { flags: resumes ? "a" : "w" }), { signal });
        } catch (cause) {
            if (signal.aborted) throw cause;
            return { kind: "failed", reason: `the transfer broke: ${errorMessageOf(cause) ?? "unknown error"}. A new call continues it.` };
        }
        const written = await sizeOf(part);
        if (expected !== undefined && written !== expected) {
            return { kind: "failed", reason: `the transfer ended after ${written} of ${expected} bytes. A new call continues it.` };
        }
        return { kind: "done", headers: response.headers };
    }
}

const LISTING_MAX_BYTES = 512 * 1024;
const LISTING_MAX_NAMES = 100;

/** The body of a page as text, at most {@link LISTING_MAX_BYTES}, with the redirects, the HTTPS rule, and the address guard of a download. */
async function fetchPage(start: URL, opts: DownloadRefOpts, signal: AbortSignal): Promise<{ readonly url: URL; readonly text: string } | undefined> {
    let current = start;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        if (current.protocol !== "https:") return undefined;
        const addresses = await opts.resolveHost(hostOf(current));
        if (addresses.length === 0 || addresses.some((entry) => isGuardedAddress(entry.address))) return undefined;
        const response = await requestFirstReachable(
            current,
            addresses,
            { headers: { "user-agent": HARNESS_USER_AGENT, "accept-encoding": "identity" }, signal },
            opts,
        );
        const location = firstHeader(response.headers, "location");
        if (REDIRECT_STATUSES.has(response.status) && location !== undefined) {
            response.body.destroy();
            current = new URL(location, current);
            continue;
        }
        if (response.status !== 200) {
            response.body.destroy();
            return undefined;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            chunks.push(bytes);
            size += bytes.length;
            if (size >= LISTING_MAX_BYTES) break;
        }
        response.body.destroy();
        return { url: current, text: Buffer.concat(chunks).subarray(0, LISTING_MAX_BYTES).toString("utf8") };
    }
    return undefined;
}

/** The entries that a folder page links to: a name, or a name with `/` for a folder. Each link that leaves the folder is out. */
export function listingNames(html: string): string[] {
    const names = new Set<string>();
    const { document } = parseHTML(html);
    for (const anchor of document.querySelectorAll("a[href]")) {
        const raw = (anchor.getAttribute("href") ?? "").split("#")[0]?.split("?")[0] ?? "";
        if (raw === "" || raw.startsWith("/") || raw.startsWith("..") || raw.includes("://") || raw.startsWith("mailto:")) continue;
        let name: string;
        try {
            name = decodeURIComponent(raw);
        } catch {
            continue;
        }
        const [segment, ...rest] = name.split("/").filter((part) => part !== "");
        if (segment === undefined || rest.length > 0) continue;
        names.add(name.endsWith("/") ? `${segment}/` : segment);
    }
    return [...names];
}

/**
 * The reason of a 404 with the entries of the folder of the URL, thus a URL that is close to right corrects itself with
 * the next call. A folder that does not answer, or that lists nothing, leaves the reason as it is.
 */
async function withParentListing(reason: string, missing: URL, opts: DownloadRefOpts, signal: AbortSignal): Promise<string> {
    const parent = new URL("./", missing);
    parent.search = "";
    let page: Awaited<ReturnType<typeof fetchPage>>;
    try {
        page = await fetchPage(parent, opts, signal);
    } catch (cause) {
        if (signal.aborted) throw cause;
        return reason;
    }
    if (page === undefined) return reason;
    const names = listingNames(page.text);
    if (names.length === 0) return reason;
    const shown = names.slice(0, LISTING_MAX_NAMES);
    const more = names.length > shown.length ? `, and ${names.length - shown.length} more` : "";
    return `${reason}. The folder ${page.url.toString()} holds: ${shown.join(", ")}${more}`;
}

function describeRefusal(refusal: ExtractRefusal): string {
    return refusal.kind === "unsafe_entry" ? `the entry ${refusal.entry} leaves the directory of the archive` : refusal.detail;
}

const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar", ".zip"];

/** The name of an archive without its archive suffix. */
function withoutArchiveSuffix(name: string): string {
    const suffix = ARCHIVE_SUFFIXES.find((candidate) => name.toLowerCase().endsWith(candidate));
    return suffix === undefined ? name : name.slice(0, -suffix.length);
}

type Extraction = { readonly kind: "extracted"; readonly dir: string; readonly summary: ExtractSummary } | { readonly kind: "failed"; readonly reason: string };

/**
 * Extract an archive into a directory beside it, through a `.part` directory that becomes the directory only after a
 * complete extraction. Then delete the archive. A failed extraction removes the archive and the `.part` directory.
 */
async function extractBeside(archive: string, kind: "zip" | "tar" | "tar-gzip", name: string, dir: string): Promise<Extraction> {
    const target = join(dir, withoutArchiveSuffix(name));
    const staging = `${target}.part`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    let result: Result<ExtractSummary, ExtractRefusal>;
    try {
        const file = createReadStream(archive);
        if (kind === "tar-gzip") {
            const gunzip = createGunzip();
            file.on("error", (cause) => gunzip.destroy(cause));
            result = await extractTarStream(file.pipe(gunzip), staging);
        } else {
            result = await (kind === "tar" ? extractTarStream(file, staging) : extractZipStream(file, staging));
        }
    } catch (cause) {
        result = err({ kind: "unparsable", detail: errorMessageOf(cause) ?? "the archive did not read" });
    }
    if (result.isErr()) {
        await rm(staging, { recursive: true, force: true });
        await rm(archive, { force: true });
        return { kind: "failed", reason: `the extraction failed: ${describeRefusal(result.error)}` };
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await rm(archive, { force: true });
    return { kind: "extracted", dir: target, summary: result.value };
}

function containerPath(storePath: string, hostPath: string): string {
    return posix.join(REFS_CONTAINER_PATH, ...relative(storePath, hostPath).split(sep));
}

/** The result fields of an extraction: the directory, and the first files in it. */
function extractedFields(storePath: string, dir: string, summary: ExtractSummary): Pick<DownloadRefFile, "path" | "extracted" | "files" | "moreFiles"> {
    const path = containerPath(storePath, dir);
    const more = summary.files - summary.paths.length;
    return { path, extracted: true, files: summary.paths.map((file) => posix.join(path, file)), moreFiles: more > 0 ? more : undefined };
}

/** Append the store path of a completed file, or of the directory of an extracted archive, to the source record. */
async function recordSource(storePath: string, stored: string, url: string): Promise<void> {
    await mkdir(join(storePath, SOURCES_DIR), { recursive: true });
    const line = { path: relative(storePath, stored).split(sep).join("/"), url, at: new Date().toISOString() };
    await appendFile(join(storePath, SOURCES_DIR, SOURCES_FILE), `${JSON.stringify(line)}\n`);
}

function isExtractable(kind: ReturnType<typeof archiveKindOf>): kind is "zip" | "tar" | "tar-gzip" {
    return kind === "zip" || kind === "tar" || kind === "tar-gzip";
}

/** One line of progress. A forced line goes out at once, and another line waits for the end of the interval since the last line. */
type ReportProgress = (text: string, force: boolean) => void;

function progressReporter(ctx: ToolContext, opts: DownloadRefOpts): ReportProgress {
    let last = Number.NEGATIVE_INFINITY;
    return (text, force) => {
        const at = opts.now();
        if (!force && at - last < PROGRESS_INTERVAL_MS) return;
        last = at;
        const data = { id: `progress-${ctx.invocationId}`, toolUseId: ctx.invocationId, text };
        // A lost line of progress changes nothing, and the transfer does not wait for the stream.
        void Promise.resolve(ctx.emit({ type: "data-tool-progress", source: ctx.session.provenance, data })).catch(() => undefined);
    };
}

/** The downloads in this process, by store and URL. A second call for the same URL waits for the first. */
const inFlight = new Map<string, Promise<DownloadRefFile>>();

async function downloadOne(
    target: CheckedUrl,
    extract: boolean,
    storePath: string,
    sources: ReadonlyMap<string, string>,
    opts: DownloadRefOpts,
    signal: AbortSignal,
    progress: ReportProgress,
): Promise<DownloadRefFile> {
    const recorded = sources.get(target.key);
    if (recorded !== undefined && (await exists(join(storePath, recorded)))) {
        const recordedPath = join(storePath, recorded);
        const kind = archiveKindOf(basename(recordedPath));
        // An earlier call kept the archive. An extraction asked for now uses the archive on disk, with no transfer.
        if (!extract || !isExtractable(kind) || !(await stat(recordedPath)).isFile()) {
            return { url: target.key, status: "reused", path: containerPath(storePath, recordedPath) };
        }
        progress(`Extracting ${basename(recordedPath)}`, true);
        const extraction = await extractBeside(recordedPath, kind, basename(recordedPath), dirname(recordedPath));
        if (extraction.kind === "failed") return { url: target.key, status: "failed", error: extraction.reason };
        await recordSource(storePath, extraction.dir, target.key);
        return { url: target.key, status: "reused", ...extractedFields(storePath, extraction.dir, extraction.summary) };
    }

    const dir = join(storePath, target.host, ...target.segments.slice(0, -1));
    const urlName = target.segments.at(-1) ?? "";
    await mkdir(dir, { recursive: true });
    const part = join(dir, `${urlName}.part`);
    const label = urlName === "" ? target.host : urlName;
    const done = await transfer(target.url, part, opts, signal, (written, total) => {
        progress(total === undefined ? `${label}: ${formatBytes(written)}` : `${label}: ${formatBytes(written)} of ${formatBytes(total)}`, written === 0);
    });
    if (done.kind === "failed") {
        const error = done.missing === undefined ? done.reason : await withParentListing(done.reason, done.missing, opts, signal);
        return { url: target.key, status: "failed", error };
    }

    const name = dispositionName(firstHeader(done.headers, "content-disposition")) ?? urlName;
    const file = join(dir, name);
    await rename(part, file);

    if (!extract) {
        await recordSource(storePath, file, target.key);
        return { url: target.key, status: "downloaded", path: containerPath(storePath, file) };
    }
    const kind = archiveKindOf(name);
    if (!isExtractable(kind)) {
        await recordSource(storePath, file, target.key);
        const note = kind === "gzip" ? "a gzip file of one file stays compressed" : "the file is not a tar or zip archive";
        return { url: target.key, status: "downloaded", path: containerPath(storePath, file), extracted: false, note };
    }
    progress(`Extracting ${name}`, true);
    const extraction = await extractBeside(file, kind, name, dir);
    if (extraction.kind === "failed") return { url: target.key, status: "failed", error: extraction.reason };
    await recordSource(storePath, extraction.dir, target.key);
    return { url: target.key, status: "downloaded", ...extractedFields(storePath, extraction.dir, extraction.summary) };
}

const DownloadRefInputSchema = z.object({
    urls: z.array(z.string().min(1).max(2048)).min(1).max(MAX_URLS).describe("HTTPS URLs of the files, all on one host."),
    extract: z
        .boolean()
        .optional()
        .describe(
            "Extract each tar, tar.gz, tgz, or zip file into a directory beside it, and delete the archive. The result gives the paths of the extracted files. A gzip file of one file stays compressed.",
        ),
});

type DownloadRefInput = z.infer<typeof DownloadRefInputSchema>;

/** The `download_ref` tool over the store and the auto-approve hosts of the embedder. */
export function createDownloadRefTool(
    options: ReferenceDownloadOptions,
    opts: DownloadRefOpts = DEFAULT_DOWNLOAD_REF_OPTS,
): Tool<DownloadRefInput, DownloadRefOutput> {
    const autoApprove = [...DEFAULT_DOWNLOAD_AUTO_APPROVE_HOSTS, ...(options.autoApproveHosts ?? [])];
    return defineTool({
        id: "download_ref",
        description:
            "Download reference files over HTTPS into the reference store, which each sandbox reads at /mnt/refs. " +
            "Use it for a reference that the store does not hold. One call takes the URLs of one host. " +
            "Each file goes to /mnt/refs/<host>/<path of the URL>, and the result gives the path of each file. " +
            "A URL that an earlier call downloaded gives its existing path, with no new transfer. " +
            "A host that is not a known public reference database asks the user first. " +
            "A URL that the server does not have gives the files of its folder, thus the next call can name the right file. " +
            "A failed file is a normal result: report it, and continue with the data that you have.",
        inputSchema: DownloadRefInputSchema,
        view: "none",
        describeCall: ({ urls }) =>
            urls.length === 1
                ? urls[0]
                : `${urls.length} files from ${checkCall(urls)
                      .map((call) => call.host)
                      .unwrapOr("more than one host")}`,
        approval: ({ urls }): AskRequest | undefined => {
            const call = checkCall(urls);
            // A call that the check refuses runs no download, thus `execute` gives the refusal with no question.
            if (call.isErr() || isAutoApprovedHost(call.value.host, autoApprove)) return undefined;
            const { host } = call.value;
            return {
                title: `Download reference data from ${host}`,
                command: call.value.urls.map((url) => url.key).join("\n"),
                detail: `An "always" answer lets each later download from ${host} run with no question, in each analysis.`,
                grantKey: `download-ref:${host}`,
                grantScope: "user",
            };
        },
        execute: async ({ urls, extract }, ctx): Promise<Result<DownloadRefOutput, ToolError>> => {
            const call = checkCall(urls);
            if (call.isErr()) return err({ error: call.error, retryable: false });
            const sources = await readSources(options.storePath);
            const report = progressReporter(ctx, opts);
            const files: DownloadRefFile[] = [];
            for (const [index, target] of call.value.urls.entries()) {
                const position = call.value.urls.length > 1 ? `, file ${index + 1} of ${call.value.urls.length}` : "";
                const key = `${options.storePath}\0${target.key}`;
                const running = inFlight.get(key);
                if (running !== undefined) {
                    const earlier = await running;
                    files.push(earlier.status === "failed" ? earlier : { ...earlier, status: "reused" });
                    continue;
                }
                const progress: ReportProgress = (text, force) => report(`${text}${position}`, force);
                const download = downloadOne(target, extract === true, options.storePath, sources, opts, ctx.signal, progress).catch(
                    (cause: unknown): DownloadRefFile => {
                        if (ctx.signal.aborted) throw cause;
                        return { url: target.key, status: "failed", error: errorMessageOf(cause) ?? "the download failed" };
                    },
                );
                inFlight.set(key, download);
                try {
                    files.push(await download);
                } finally {
                    inFlight.delete(key);
                }
            }
            return ok({ host: call.value.host, files });
        },
    });
}
