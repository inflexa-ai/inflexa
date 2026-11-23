/**
 * Reference-store discovery: `createListAvailableRefsTool`, a bounded, no-follow
 * inventory of the files in the reference store. Narrow with `path`/`category`,
 * filter with `query`, cap with `limit`; every response carries `returned`/`total`/
 * `hasMore` and the `categories` present, so a listing is never an unbounded
 * dump. Symlinks are never followed. This tool only ever READS the store.
 *
 * The store is read from the host filesystem at the embedder-supplied
 * `refStorePath` and reported at `/mnt/refs`, the container path sandboxes mount
 * it at — read where it lives, render where the caller will open it. Reading it
 * host-side is what lets a planner ask what reference data exists before any
 * sandbox is created; a step agent asking mid-run sees the same store, because
 * the mount and this path are the same bytes. An omitted `refStorePath` falls
 * back to that same container path — where a host that mounts the store into its
 * own process (a K8s pod holding the ref-store PVC) already sees it. The fallback
 * is stat-verified like any other root, so a host with nothing mounted there
 * still reports the store as unavailable.
 *
 * The files on disk are the whole inventory. The meaning of a file comes from a
 * look at its start: the format, and the first lines or the columns. A query
 * matches the path and that look, thus a caller searches by what the data IS,
 * and the directory layout of the store stays out of every interface. The look
 * of a file is cached under its path, its size, and its modification time, in
 * `.inflexa/peek-cache.json` of the store when the host can write it, and in
 * memory always.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join as hostJoin, posix as posixPath } from "node:path";

import { ok } from "neverthrow";
import { z } from "zod";

import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import { allWithConcurrency } from "../../lib/async-utils.js";
import { errnoOf } from "../../lib/fs-result.js";
import { runHostTask, transferable } from "../../lib/host-workers.js";
import { safeParseJsonAs } from "../../lib/parse-json.js";
import { capCodePoints, DETAIL_MAX_LENGTH, DETAIL_NEEDLE_MAX_LENGTH } from "../../loop/tool-detail.js";
import { REFS_CONTAINER_PATH } from "../../sandbox/mount-plan.js";
import { defineTool, type Tool } from "../define-tool.js";

/**
 * Container path the ref store is mounted at: every reported path is rendered
 * under it, and it is the read root when the embedder supplies none.
 */
const REFS_ROOT = REFS_CONTAINER_PATH;
const MAX_ENTRIES = 200;
/** A bare listing of a subtree with at most this many files gives the files themselves, with their looks. */
const SMALL_TREE_FILES = 40;
const MAX_SCANNED_ENTRIES = 2_000;
const MAX_PATH_BYTES = 40_000;
const MAX_ENVELOPE_BYTES = 64_000;
const MAX_INPUT_PATH_BYTES = 4_096;
/** The bytes of a look: the read from the start of a file, and the decompressed start of a gzip file. */
const PEEK_BYTES = 16_384;
const LOOK_LINES = 5;
const LOOK_LINE_CHARS = 200;
const LOOK_COLUMNS = 50;
const MAX_NEW_LOOKS = 200;
const LOOK_READ_WIDTH = 8;
const STORE_METADATA_DIRECTORY = ".inflexa";
const PEEK_CACHE_FILE = "peek-cache.json";
const MAX_PEEK_CACHE_BYTES = 8 * 1024 * 1024;

const ListAvailableRefsInputSchema = z.object({
    path: z
        .string()
        .max(MAX_INPUT_PATH_BYTES)
        .optional()
        .describe(
            "Directory beneath /mnt/refs to inspect — a returned absolute path or a store-relative path. Use it to drill into a subtree when a listing is truncated.",
        ),
    category: z
        .string()
        .max(MAX_INPUT_PATH_BYTES)
        .optional()
        .describe("The name of a top-level directory of the store to inspect, the same as `path` with one segment. Ignored when `path` is given."),
    query: z.string().optional().describe("Case-insensitive substring filter over the path of each file, its format, and its first lines or columns."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ENTRIES)
        .optional()
        .describe(
            `Max entries to return (default ${MAX_ENTRIES}); the response carries \`returned\`, \`total\`, and \`hasMore\` so truncation is never silent.`,
        ),
});

export type ListAvailableRefsDeps = Pick<EnvironmentStorePaths, "refStorePath"> & {
    /** Whether the agent holds `download_ref`. It selects what a query that matches nothing tells the agent to do. */
    readonly canDownload?: boolean;
};

/** What the start of a file shows: its format, and for a text its first lines, with the columns of a delimited table. */
export type ReferenceLook = {
    readonly format: string;
    readonly compression?: "gzip";
    readonly columns?: readonly string[];
    readonly lines?: readonly string[];
};

const ReferenceLookSchema = z.object({
    format: z.string(),
    compression: z.literal("gzip").optional(),
    columns: z.array(z.string()).optional(),
    lines: z.array(z.string()).optional(),
});

const PeekCacheFileSchema = z.object({
    version: z.literal(1),
    looks: z.record(z.string(), z.object({ bytes: z.number(), mtimeMs: z.number(), look: ReferenceLookSchema })),
});

/** A bounded, no-follow observation of the reference store. */
export type ReferenceInventoryEntry =
    | { readonly path: string; readonly kind: "file"; readonly bytes: number; readonly look?: ReferenceLook }
    | { readonly path: string; readonly kind: "symlink"; readonly bytes: 0 }
    | {
          readonly path: string;
          readonly kind: "directory";
          readonly bytes: number;
          readonly fileCount: number;
          readonly fileTypes: readonly string[];
          readonly truncated: boolean;
      };

/**
 * Structured result returned for every expected reference-store state. Bounding
 * is explicit: `returned`/`total`/`hasMore` describe how much of the match set
 * this response carries, `unlooked` counts the files that matched on their path
 * only, and `categories` is the drill-in index.
 */
export type ReferenceInventoryResult = {
    readonly available: boolean;
    readonly state: RawScan["state"] | "out_of_scope";
    readonly path: string;
    readonly entries: readonly ReferenceInventoryEntry[];
    readonly scannedEntries: number;
    readonly returned: number;
    readonly total: number;
    readonly truncated: boolean;
    readonly hasMore: boolean;
    readonly unlooked: number;
    readonly categories: readonly string[];
    readonly content: string;
};

/** A regular file of a scan, with the key of its look. */
type ScannedFile = { readonly relative: string; readonly bytes: number; readonly mtimeMs: number };

type RawScan = {
    readonly state: "unavailable" | "empty" | "populated" | "not_found" | "not_a_directory" | "symlink";
    readonly entries: ReferenceInventoryEntry[];
    readonly files: ScannedFile[];
    readonly scannedEntries: number;
    readonly truncated: boolean;
};

function resolveRequestedPath(input: string | undefined): { ok: true; path: string } | { ok: false; reason: string } {
    if (input === undefined || input === "" || input === REFS_ROOT) return { ok: true, path: REFS_ROOT };
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_PATH_BYTES) {
        return { ok: false, reason: `Path exceeds the ${MAX_INPUT_PATH_BYTES}-byte POSIX path limit.` };
    }
    if (input.includes("\0") || input.includes("\\")) return { ok: false, reason: "Path must use safe POSIX segments beneath /mnt/refs." };

    const relative = input.startsWith(`${REFS_ROOT}/`) ? input.slice(REFS_ROOT.length + 1) : input.startsWith("/") ? undefined : input;
    if (relative === undefined || relative.length === 0) return { ok: false, reason: "Path is outside /mnt/refs." };
    const segments = relative.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        return { ok: false, reason: "Path traversal and empty path segments are not allowed." };
    }
    if (segments[0] === STORE_METADATA_DIRECTORY) return { ok: false, reason: "Store metadata is not reference data." };
    const normalized = posixPath.join(REFS_ROOT, relative);
    if (!normalized.startsWith(`${REFS_ROOT}/`)) return { ok: false, reason: "Path is outside /mnt/refs." };
    return { ok: true, path: normalized };
}

function isStoreMetadata(relative: string): boolean {
    return relative === STORE_METADATA_DIRECTORY || relative.startsWith(`${STORE_METADATA_DIRECTORY}/`);
}

type ScannedName = {
    readonly name: string;
    readonly kind: "file" | "directory" | "symlink" | "other";
    readonly bytes: number;
    readonly mtimeMs: number;
};

/**
 * Inspect at most `limit` names in one directory, sorted by name.
 *
 * Sorting BEFORE the cap (rather than capping the raw readdir order) keeps
 * truncation deterministic: the same store yields the same prefix on every call,
 * which a durably-cached step result has to be able to promise.
 */
async function cappedEntries(directory: string, limit: number): Promise<{ values: ScannedName[]; cut: boolean }> {
    let names: string[];
    try {
        names = (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name);
    } catch {
        return { values: [], cut: false };
    }
    names.sort();
    const cut = names.length > limit;
    const values: ScannedName[] = [];
    for (const name of names.slice(0, limit)) {
        try {
            // lstat, never stat: a symlink is reported as a symlink and never resolved,
            // so a link out of the store cannot smuggle in a foreign file's size or type.
            const stats = await lstat(hostJoin(directory, name));
            if (stats.isSymbolicLink()) values.push({ name, kind: "symlink", bytes: 0, mtimeMs: 0 });
            else if (stats.isFile()) values.push({ name, kind: "file", bytes: stats.size, mtimeMs: stats.mtimeMs });
            else if (stats.isDirectory()) values.push({ name, kind: "directory", bytes: 0, mtimeMs: 0 });
            else values.push({ name, kind: "other", bytes: 0, mtimeMs: 0 });
        } catch {
            continue;
        }
    }
    return { values, cut };
}

/** Whether any component of `relative` beneath `root` is a symlink — the no-follow gate. */
async function crossesSymlink(root: string, relative: string): Promise<boolean> {
    let cursor = root;
    for (const segment of relative.split("/")) {
        cursor = hostJoin(cursor, segment);
        try {
            if ((await lstat(cursor)).isSymbolicLink()) return true;
        } catch {
            return false;
        }
    }
    return false;
}

/** Recursively total a directory's files, bounded by the remaining scan budget. */
async function summarizeDirectory(
    directory: string,
    scanned: number,
): Promise<{ bytes: number; fileCount: number; fileTypes: string[]; truncated: boolean; scanned: number }> {
    let totalBytes = 0;
    let fileCount = 0;
    let truncated = false;
    const fileTypes = new Set<string>();
    const stack = [directory];

    while (stack.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
        const current = stack.pop();
        if (current === undefined) break;
        const { values, cut } = await cappedEntries(current, MAX_SCANNED_ENTRIES - scanned);
        truncated = truncated || cut;
        const childDirectories: string[] = [];
        for (const child of values) {
            scanned += 1;
            if (child.kind === "directory") childDirectories.push(hostJoin(current, child.name));
            else if (child.kind === "file") {
                fileCount += 1;
                totalBytes += child.bytes;
                const suffix = posixPath.extname(child.name).toLowerCase();
                if (suffix) fileTypes.add(suffix);
            }
            if (scanned >= MAX_SCANNED_ENTRIES) {
                truncated = true;
                break;
            }
        }
        stack.push(...childDirectories.reverse());
    }
    return { bytes: totalBytes, fileCount, fileTypes: [...fileTypes].sort().slice(0, 10), truncated, scanned };
}

/**
 * Collect FILES anywhere beneath `directory`, bounded by the scan budget. A
 * search matches the path and the look of a file, and a directory has no look,
 * thus a search from the store root walks to the leaves.
 */
async function collectFiles(
    directory: string,
    relative: string,
    budget: { scanned: number },
): Promise<{ entries: ReferenceInventoryEntry[]; files: ScannedFile[]; truncated: boolean }> {
    const entries: ReferenceInventoryEntry[] = [];
    const files: ScannedFile[] = [];
    let truncated = false;
    const stack: { path: string; relative: string }[] = [{ path: directory, relative }];

    while (stack.length > 0 && budget.scanned < MAX_SCANNED_ENTRIES) {
        const current = stack.pop();
        if (current === undefined) break;
        const { values, cut } = await cappedEntries(current.path, MAX_SCANNED_ENTRIES - budget.scanned);
        truncated = truncated || cut;
        for (const child of values) {
            budget.scanned += 1;
            const childRelative = current.relative === "." ? child.name : `${current.relative}/${child.name}`;
            if (isStoreMetadata(childRelative)) continue;
            if (child.kind === "directory") {
                stack.push({ path: hostJoin(current.path, child.name), relative: childRelative });
            } else if (child.kind === "symlink") {
                entries.push({ path: `${REFS_ROOT}/${childRelative}`, kind: "symlink", bytes: 0 });
            } else if (child.kind === "file") {
                entries.push({ path: `${REFS_ROOT}/${childRelative}`, kind: "file", bytes: child.bytes });
                files.push({ relative: childRelative, bytes: child.bytes, mtimeMs: child.mtimeMs });
            }
            if (budget.scanned >= MAX_SCANNED_ENTRIES) {
                truncated = true;
                break;
            }
        }
    }
    return { entries, files, truncated };
}

/**
 * Scan the store beneath `root`, reporting every expected state as data.
 *
 * `recursive` selects the two modes: a browse lists immediate children (directories
 * summarized), a search walks to the files.
 */
async function scanStore(root: string, relative: string, recursive = false): Promise<RawScan> {
    const empty = (): Omit<RawScan, "state"> => ({ entries: [], files: [], scannedEntries: 0, truncated: false });
    try {
        if (!(await lstat(root)).isDirectory()) return { state: "unavailable", ...empty() };
    } catch {
        return { state: "unavailable", ...empty() };
    }

    if (relative !== "." && (await crossesSymlink(root, relative))) return { state: "symlink", ...empty() };

    const target = relative === "." ? root : hostJoin(root, ...relative.split("/"));
    let targetStats;
    try {
        targetStats = await lstat(target);
    } catch {
        return { state: "not_found", ...empty() };
    }
    if (!targetStats.isDirectory()) return { state: "not_a_directory", ...empty() };

    if (recursive) {
        const budget = { scanned: 0 };
        const walked = await collectFiles(target, relative, budget);
        return {
            state: walked.entries.length === 0 ? "empty" : "populated",
            entries: walked.entries,
            files: walked.files,
            scannedEntries: budget.scanned,
            truncated: walked.truncated,
        };
    }

    const entries: ReferenceInventoryEntry[] = [];
    const files: ScannedFile[] = [];
    let scanned = 0;
    let pathBytes = 0;
    const { values: children, cut } = await cappedEntries(target, Math.min(MAX_ENTRIES + 2, MAX_SCANNED_ENTRIES));
    let truncated = cut;

    for (const child of children) {
        const childRelative = relative === "." ? child.name : `${relative}/${child.name}`;
        if (isStoreMetadata(childRelative)) continue;
        scanned += 1;
        const rendered = `${REFS_ROOT}/${childRelative}`;

        let entry: ReferenceInventoryEntry | undefined;
        if (child.kind === "symlink") entry = { path: rendered, kind: "symlink", bytes: 0 };
        else if (child.kind === "file") entry = { path: rendered, kind: "file", bytes: child.bytes };
        else if (child.kind === "directory") {
            const summary = await summarizeDirectory(hostJoin(target, child.name), scanned);
            scanned = summary.scanned;
            truncated = truncated || summary.truncated;
            entry = {
                path: rendered,
                kind: "directory",
                bytes: summary.bytes,
                fileCount: summary.fileCount,
                fileTypes: summary.fileTypes,
                truncated: summary.truncated,
            };
        }

        if (entry) {
            if (entries.length < MAX_ENTRIES && pathBytes + Buffer.byteLength(rendered, "utf8") <= MAX_PATH_BYTES) {
                entries.push(entry);
                if (entry.kind === "file") files.push({ relative: childRelative, bytes: child.bytes, mtimeMs: child.mtimeMs });
                pathBytes += Buffer.byteLength(rendered, "utf8");
            } else {
                truncated = true;
            }
        }
        if (scanned >= MAX_SCANNED_ENTRIES) {
            truncated = true;
            break;
        }
    }

    return { state: entries.length === 0 ? "empty" : "populated", entries, files, scannedEntries: scanned, truncated };
}

type CachedLook = { readonly bytes: number; readonly mtimeMs: number; readonly look: ReferenceLook };

/** The looks of one store. `writable` turns false at the first write that the file system refuses. */
type PeekCache = { readonly looks: Map<string, CachedLook>; writable: boolean };

/** The cache of each store root of the process, thus the agents of one host share each look of a read-only store. */
const peekCaches = new Map<string, Promise<PeekCache>>();

function peekCacheOf(root: string): Promise<PeekCache> {
    let cache = peekCaches.get(root);
    if (cache === undefined) {
        cache = loadPeekCache(root);
        peekCaches.set(root, cache);
    }
    return cache;
}

async function loadPeekCache(root: string): Promise<PeekCache> {
    const looks = new Map<string, CachedLook>();
    if (await crossesSymlink(root, STORE_METADATA_DIRECTORY)) return { looks, writable: false };
    const file = hostJoin(root, STORE_METADATA_DIRECTORY, PEEK_CACHE_FILE);
    try {
        const stats = await lstat(file);
        if (!stats.isFile() || stats.size > MAX_PEEK_CACHE_BYTES) return { looks, writable: true };
        const parsed = safeParseJsonAs(await readFile(file, "utf-8"), PeekCacheFileSchema);
        if (parsed.success) for (const [relative, cached] of Object.entries(parsed.data.looks)) looks.set(relative, cached);
    } catch {
        // An absent or unreadable cache file starts an empty cache.
    }
    return { looks, writable: true };
}

/** Whether a write error is a store that the host cannot write, not a passing fault. */
function isReadOnlyFault(cause: unknown): boolean {
    const code = errnoOf(cause);
    return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

/**
 * Write the cache through a temporary file and a rename, thus a concurrent
 * reader sees the old file or the new file, never a part. A process that
 * writes at the same time can drop the new looks of the other process, and the
 * next call looks at those files again.
 */
async function savePeekCache(root: string, cache: PeekCache): Promise<void> {
    if (!cache.writable || (await crossesSymlink(root, STORE_METADATA_DIRECTORY))) return;
    const directory = hostJoin(root, STORE_METADATA_DIRECTORY);
    const temporary = hostJoin(directory, `${PEEK_CACHE_FILE}.${randomUUID()}.tmp`);
    try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, looks: Object.fromEntries(cache.looks) }));
        await rename(temporary, hostJoin(directory, PEEK_CACHE_FILE));
    } catch (cause) {
        if (isReadOnlyFault(cause)) cache.writable = false;
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

/** The first bytes of a file, and the key of the bytes that the read saw. */
type FileStart = { readonly start: Buffer; readonly bytes: number; readonly mtimeMs: number };

/**
 * Read at most {@link PEEK_BYTES} from the start of a file. `O_NOFOLLOW` keeps a
 * file that became a symlink after the scan out of the read, and `O_NONBLOCK`
 * keeps a file that became a FIFO from a wait.
 */
async function readStart(root: string, relative: string): Promise<FileStart | undefined> {
    let handle;
    try {
        handle = await open(hostJoin(root, ...relative.split("/")), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
        return undefined;
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) return undefined;
        const buffer = Buffer.alloc(Math.min(PEEK_BYTES, stats.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return { start: buffer.subarray(0, bytesRead), bytes: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
        return undefined;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

function isGzip(start: Uint8Array): boolean {
    return start[0] === 0x1f && start[1] === 0x8b;
}

function ascii(text: string): number[] {
    return Array.from(text, (char) => char.charCodeAt(0));
}

/** The magic bytes of a binary format, at `offset` from the start. */
const BINARY_MAGIC: readonly { readonly format: string; readonly bytes: readonly number[]; readonly offset?: number }[] = [
    { format: "hdf5", bytes: [0x89, ...ascii("HDF\r\n"), 0x1a, 0x0a] },
    { format: "parquet", bytes: ascii("PAR1") },
    { format: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
    { format: "sqlite", bytes: ascii("SQLite format 3\0") },
    { format: "pdf", bytes: ascii("%PDF-") },
    { format: "bam", bytes: [...ascii("BAM"), 0x01] },
    { format: "rds", bytes: [...ascii("X\n"), 0x00, 0x00, 0x00] },
    { format: "rdata", bytes: ascii("RDX") },
    { format: "arrow", bytes: ascii("ARROW1") },
    { format: "npy", bytes: [0x93, ...ascii("NUMPY")] },
    { format: "xz", bytes: [0xfd, ...ascii("7zXZ"), 0x00] },
    { format: "zstd", bytes: [0x28, 0xb5, 0x2f, 0xfd] },
    { format: "bzip2", bytes: ascii("BZh") },
    { format: "tar", bytes: ascii("ustar"), offset: 257 },
];

/** The text format of each known suffix. A suffix of a binary format is the format of a file that no magic names. */
const TEXT_FORMATS: Readonly<Record<string, string>> = {
    csv: "csv",
    tsv: "tsv",
    tab: "tsv",
    txt: "text",
    gmt: "gmt",
    gtf: "gtf",
    gff: "gff",
    gff3: "gff",
    bed: "bed",
    vcf: "vcf",
    fa: "fasta",
    fasta: "fasta",
    fna: "fasta",
    faa: "fasta",
    fai: "fasta index",
    fq: "fastq",
    fastq: "fastq",
    json: "json",
    obo: "obo",
    sam: "sam",
    mtx: "matrix market",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
};

const DELIMITERS: Readonly<Record<string, string>> = { csv: ",", tsv: "\t" };

function suffixOf(name: string): string {
    return posixPath.extname(name).slice(1).toLowerCase();
}

function magicFormat(content: Uint8Array): string | undefined {
    return BINARY_MAGIC.find(({ bytes, offset = 0 }) => bytes.every((byte, index) => content[offset + index] === byte))?.format;
}

/** The text of a start, or `undefined` for binary bytes. A start that ends inside a character drops that character. */
function textOf(content: Uint8Array): string | undefined {
    if (content.includes(0)) return undefined;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(content, { stream: true });
    } catch {
        return undefined;
    }
}

function sniffTextFormat(text: string): string | undefined {
    if (text.startsWith("##fileformat=VCF")) return "vcf";
    if (text.startsWith("%%MatrixMarket")) return "matrix market";
    if (text.startsWith(">")) return "fasta";
    if (text.startsWith("{") || text.startsWith("[")) return "json";
    return undefined;
}

/** The look of uncompressed content of the file `name`. */
function lookOfContent(name: string, content: Uint8Array): ReferenceLook {
    const suffix = suffixOf(name);
    const magic = magicFormat(content);
    const text = magic === undefined ? textOf(content) : undefined;
    if (text === undefined) return { format: magic ?? (suffix === "" ? "binary" : suffix) };
    const format = TEXT_FORMATS[suffix] ?? sniffTextFormat(text) ?? (suffix === "" ? "text" : suffix);
    const lines = text
        .split("\n")
        .slice(0, LOOK_LINES)
        .map((line) => capCodePoints(line.endsWith("\r") ? line.slice(0, -1) : line, LOOK_LINE_CHARS));
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    const delimiter = DELIMITERS[format];
    const header = lines[0];
    if (delimiter === undefined || header === undefined) return { format, lines };
    const columns = header
        .split(delimiter)
        .slice(0, LOOK_COLUMNS)
        .map((column) => column.trim())
        .map((column) => (column.length >= 2 && column.startsWith('"') && column.endsWith('"') ? column.slice(1, -1) : column));
    return { format, columns, lines };
}

/**
 * The look of a file from its start. `inflated` is the decompressed start of a
 * gzip file, `undefined` when it gave no byte. The format of a gzip file is the
 * format of its content, from the suffix below `.gz`.
 */
function lookOf(name: string, start: Uint8Array, inflated: Uint8Array | undefined): ReferenceLook {
    if (!isGzip(start)) return lookOfContent(name, start);
    const suffix = suffixOf(name);
    const inner = suffix === "gz" || suffix === "bgz" ? name.slice(0, -(suffix.length + 1)) : name;
    if (inflated === undefined) {
        const innerSuffix = suffixOf(inner);
        return { format: TEXT_FORMATS[innerSuffix] ?? (innerSuffix === "" ? "binary" : innerSuffix), compression: "gzip" };
    }
    return { ...lookOfContent(inner, inflated), compression: "gzip" };
}

/** The decompressed starts of the gzip starts, in one decode worker. A failed worker gives `undefined`. */
async function inflateStarts(starts: readonly Uint8Array[], signal: AbortSignal | undefined): Promise<readonly (Uint8Array | undefined)[] | undefined> {
    if (starts.length === 0) return [];
    const buffers = starts.map((start) => transferable(start));
    const answer = await runHostTask({ kind: "gzip-starts", starts: buffers, cap: PEEK_BYTES }, { transfer: buffers, signal });
    return answer.isOk() ? answer.value.starts : undefined;
}

/**
 * The look of each file, keyed by its store-relative path. A cached look serves
 * a file of the same size and modification time with no read. At most
 * {@link MAX_NEW_LOOKS} files get a new look, and `unlooked` counts the others.
 */
async function lookAtFiles(
    root: string,
    files: readonly ScannedFile[],
    signal: AbortSignal | undefined,
): Promise<{ readonly looks: ReadonlyMap<string, ReferenceLook>; readonly unlooked: number }> {
    const looks = new Map<string, ReferenceLook>();
    if (files.length === 0) return { looks, unlooked: 0 };
    const cache = await peekCacheOf(root);
    const pending: ScannedFile[] = [];
    for (const file of files) {
        const cached = cache.looks.get(file.relative);
        if (cached !== undefined && cached.bytes === file.bytes && cached.mtimeMs === file.mtimeMs) looks.set(file.relative, cached.look);
        else pending.push(file);
    }
    const taken = pending.slice(0, MAX_NEW_LOOKS);
    if (taken.length === 0) return { looks, unlooked: 0 };

    const starts = await allWithConcurrency(
        taken.map((file) => () => readStart(root, file.relative)),
        LOOK_READ_WIDTH,
    );
    const gzipIndexes = starts.flatMap((read, index) => (read !== undefined && isGzip(read.start) ? [index] : []));
    // A copy goes to the worker, because the transfer detaches the bytes that the look reads below.
    const inflated = await inflateStarts(
        gzipIndexes.map((index) => Buffer.from(starts[index]?.start ?? [])),
        signal,
    );
    const inflatedAt = new Map(gzipIndexes.map((index, position) => [index, inflated?.[position]]));

    let added = false;
    for (const [index, file] of taken.entries()) {
        const read = starts[index];
        if (read === undefined) continue;
        const look = lookOf(posixPath.basename(file.relative), read.start, inflatedAt.get(index));
        looks.set(file.relative, look);
        // A look that a failed worker cut short is not the look of the file, thus the next call looks again.
        if (inflated === undefined && inflatedAt.has(index)) continue;
        cache.looks.set(file.relative, { bytes: read.bytes, mtimeMs: read.mtimeMs, look });
        added = true;
    }
    if (added) await savePeekCache(root, cache);
    return { looks, unlooked: pending.length - taken.length };
}

function withLooks(entries: readonly ReferenceInventoryEntry[], looks: ReadonlyMap<string, ReferenceLook>): ReferenceInventoryEntry[] {
    return entries.map((entry) => {
        if (entry.kind !== "file") return entry;
        const look = looks.get(entry.path.slice(REFS_ROOT.length + 1));
        return look === undefined ? entry : { ...entry, look };
    });
}

/** Case-insensitive substring match over the path of an entry and the text of its look. */
function entryMatchesQuery(entry: ReferenceInventoryEntry, needle: string): boolean {
    if (entry.path.toLowerCase().includes(needle)) return true;
    if (entry.kind !== "file" || entry.look === undefined) return false;
    const { format, columns = [], lines = [] } = entry.look;
    return [format, ...columns, ...lines].some((field) => field.toLowerCase().includes(needle));
}

/** The drill-in index: the directory groups present in the scan. */
function collectCategories(entries: readonly ReferenceInventoryEntry[]): string[] {
    const names = new Set<string>();
    for (const entry of entries) if (entry.kind === "directory") names.add(posixPath.basename(entry.path));
    return [...names].sort();
}

function renderLook(look: ReferenceLook): string[] {
    const rendered = [`    ${look.format}${look.compression ? ` (${look.compression})` : ""}`];
    if (look.columns !== undefined) {
        rendered.push(`    columns: ${look.columns.join(", ")}`);
        for (const line of (look.lines ?? []).slice(1)) rendered.push(`    | ${line}`);
    } else {
        for (const line of look.lines ?? []) rendered.push(`    | ${line}`);
    }
    return rendered;
}

function unlookedNote(unlooked: number): string {
    return `${unlooked} files have no look yet and matched on their path only. Call list_available_refs again to look at them.`;
}

function renderContent(path: string, scan: RawScan, entries: readonly ReferenceInventoryEntry[], unlooked: number, canDownload: boolean): string {
    if (scan.state === "unavailable")
        return canDownload
            ? "No reference store is readable now. You can download a reference into the store with download_ref."
            : "No reference store is provisioned for this session. Nothing in the analysis environment can fetch reference data, and a later call " +
                  "in this run gives the same answer. Plan with the data at hand, or ask for the reference by what it is.";
    if (scan.state === "not_found") return `Reference path does not exist: ${path}`;
    if (scan.state === "not_a_directory") return `Reference path is not a directory: ${path}`;
    if (scan.state === "symlink") return `Reference path crosses a symlink and was not scanned: ${path}`;
    if (scan.state === "empty") return `Reference store path exists but contains no reference files: ${path}`;

    const lines = [`Reference files visible beneath ${path}:`];
    for (const entry of entries) {
        const details =
            entry.kind === "directory"
                ? `directory, ${entry.fileCount} files, ${entry.bytes} bytes${entry.fileTypes.length > 0 ? `, types: ${entry.fileTypes.join(", ")}` : ""}${entry.truncated ? ", summary truncated" : ""}`
                : entry.kind === "file"
                  ? `file, ${entry.bytes} bytes`
                  : "symlink (not followed)";
        lines.push(`- ${entry.path} (${details})`);
        if (entry.kind === "file" && entry.look !== undefined) lines.push(...renderLook(entry.look));
    }
    if (scan.truncated)
        lines.push(`Inventory truncated after scanning ${scan.scannedEntries} entries. Call list_available_refs with a narrower path to drill down.`);
    if (unlooked > 0) lines.push(unlookedNote(unlooked));
    return lines.join("\n");
}

function noMatchContent(path: string, query: string, unlooked: number, canDownload: boolean): string {
    const miss = `No reference beneath ${path} matches "${query}".`;
    const next = canDownload
        ? `The sandbox has no network. You can download the reference into the store with download_ref.`
        : `The store at ${REFS_ROOT} is the only reference data that the sandbox can read, and the sandbox has no network. ` +
          "Say that the dataset is absent now. Do not guess a path, and do not use a different dataset in its place.";
    return [miss, next, ...(unlooked > 0 ? [unlookedNote(unlooked)] : [])].join(" ");
}

/**
 * The whole inventory of the store with the look of each file, for a host-side
 * join: which collection a procedure names is present, and where. No envelope
 * bound, because the caller keeps the join and drops the listing.
 */
export async function readReferenceInventory(
    storeRoot: string,
): Promise<{ readonly available: boolean; readonly entries: readonly ReferenceInventoryEntry[] }> {
    const raw = await scanStore(storeRoot, ".", true);
    const { looks } = await lookAtFiles(storeRoot, raw.files, undefined);
    return { available: raw.state !== "unavailable", entries: withLooks(raw.entries, looks) };
}

/** Create reference discovery over the host-visible reference store. */
export function createListAvailableRefsTool(deps: ListAvailableRefsDeps): Tool<z.infer<typeof ListAvailableRefsInputSchema>, ReferenceInventoryResult> {
    const storeRoot = deps.refStorePath ?? REFS_ROOT;
    const canDownload = deps.canDownload ?? false;
    return defineTool({
        id: "list_available_refs",
        concurrent: true,
        description:
            "Find the reference data that you need, as a real path. It lists the reference store of this environment: the only reference data that an analysis script can open. " +
            'Search by what the data is, with `query` (for example "hallmark", "regulon", "mouse"), not by where you expect it: the layout of the store is not a stable interface. ' +
            "A query matches the path of a file and a look at its start: the format, and the first lines or the columns of a table. Its path works verbatim in a script. " +
            "Pass the path to the library explicitly: nothing points a library at the store, thus a library that finds its data through an environment variable needs that variable in the `env` of the command. " +
            "The listing changes only when a file is added to the store, thus one call for each question is enough.",
        inputSchema: ListAvailableRefsInputSchema,
        view: {
            input: (input) => input,
            result: (_input, result) => result,
            error: true,
        },
        // `execute` resolves `path ?? category` for the subtree it inspects, and
        // it ignores `category` when `path` is present. `query` is an ADDITIVE
        // filter over that subtree, thus the target keeps naming the call and the
        // filter rides beside it.
        //
        // A needle rides behind `matching "…"`: a bare needle reads as a path, and
        // a filtered subtree must name both halves, not the target alone. The two
        // halves join with a space and a word, as `grep` joins its own two halves.
        // A separator glyph belongs to a host, which owns its line and its own
        // vocabulary; the harness renders nothing and thus borrows nothing.
        //
        // Each half carries its own bound. The emit-site cap cuts the TAIL, and
        // `path` admits 4096 bytes, thus one long target would swallow the very
        // filter this detail exists to state. The needle takes a fixed budget, and
        // the target takes what the bounded filter leaves. Then both halves reach
        // a reader, and each one marks its own cut.
        //
        // A blank value counts as absent, because `execute` treats it that way: it
        // browses the store root for a blank target, and it applies no filter for a
        // blank needle. The precedence stays `??` and never `||`, thus a blank
        // `path` still suppresses `category` exactly as `execute` does.
        describeCall: ({ path, category, query }) => {
            const target = path ?? category;
            const named = target !== undefined && target.trim() !== "" ? target : undefined;
            const needle = query?.trim();
            const filter = needle === undefined || needle === "" ? undefined : `matching "${capCodePoints(needle, DETAIL_NEEDLE_MAX_LENGTH)}"`;
            if (named === undefined) return filter ?? "full reference store";
            if (filter === undefined) return named;
            // The budget comes off the rendered filter, never off a count of its
            // parts, thus it cannot drift from the template above. One code point
            // pays for the joining space.
            return `${capCodePoints(named, DETAIL_MAX_LENGTH - Array.from(filter).length - 1)} ${filter}`;
        },
        execute: async ({ path, category, query, limit }, ctx) => {
            // `category` is shorthand for a top-level path; an explicit `path` wins.
            const requestedInput = path ?? category;
            const requested = resolveRequestedPath(requestedInput);
            if (!requested.ok) {
                const response: ReferenceInventoryResult = {
                    available: false,
                    state: "out_of_scope",
                    path: requestedInput !== undefined && Buffer.byteLength(requestedInput, "utf8") <= MAX_INPUT_PATH_BYTES ? requestedInput : REFS_ROOT,
                    entries: [],
                    scannedEntries: 0,
                    returned: 0,
                    total: 0,
                    truncated: false,
                    hasMore: false,
                    unlooked: 0,
                    categories: [],
                    content: requested.reason,
                };
                return ok(response);
            }

            // A query searches the leaves. A bare listing gives the files of a small subtree with their looks, because a
            // download nests each file under its host and the path of its URL, and the names of those folders tell
            // nothing. A larger subtree browses this level.
            const needleGiven = (query?.trim() ?? "") !== "";
            const relative = posixPath.relative(REFS_ROOT, requested.path) || ".";
            const leaves = await scanStore(storeRoot, relative, true);
            const raw = needleGiven || (!leaves.truncated && leaves.files.length <= SMALL_TREE_FILES) ? leaves : await scanStore(storeRoot, relative, false);
            const { looks, unlooked } = await lookAtFiles(storeRoot, raw.files, ctx.signal);
            const looked = withLooks(raw.entries, looks);
            const categories = collectCategories(looked);
            const needle = query?.trim().toLowerCase();
            const matched = needle ? looked.filter((entry) => entryMatchesQuery(entry, needle)) : looked;
            const total = matched.length;
            const cap = limit ?? MAX_ENTRIES;
            let boundedEntries = matched.length > cap ? matched.slice(0, cap) : matched;

            const build = (list: readonly ReferenceInventoryEntry[], contentPath: string): ReferenceInventoryResult => {
                const truncated = raw.truncated || list.length < total;
                return {
                    available: raw.state !== "unavailable",
                    state: raw.state,
                    path: contentPath,
                    entries: list,
                    scannedEntries: raw.scannedEntries,
                    returned: list.length,
                    total,
                    truncated,
                    hasMore: truncated,
                    unlooked,
                    categories,
                    content: renderContent(contentPath, { ...raw, truncated }, list, unlooked, canDownload),
                };
            };

            let response = build(boundedEntries, requested.path);
            // An empty answer to a query reads as "look elsewhere" unless it says where else there is.
            if (needleGiven && total === 0 && raw.state === "populated") {
                response = { ...response, content: noMatchContent(requested.path, query?.trim() ?? "", unlooked, canDownload) };
            }
            while (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_ENVELOPE_BYTES && boundedEntries.length > 0) {
                boundedEntries = boundedEntries.slice(0, -1);
                response = build(boundedEntries, requested.path);
            }
            if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_ENVELOPE_BYTES) {
                response = {
                    ...build([], REFS_ROOT),
                    content: "Reference inventory output exceeded its bound. Call list_available_refs with a shorter, narrower path.",
                };
            }
            return ok(response);
        },
    });
}
