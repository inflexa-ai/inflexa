/**
 * The production realization of the reference resolver. It reads the pinned artifact on disk, and it
 * gives the value that the belief points at.
 *
 * The realization holds three layers. Layer one is identity: membership through `snapshotEntry`, and a
 * streamed hash compare with `computeSha256File`. A hash mismatch fails before any parse. Layer two is
 * the host fast path: an in-process parse of a CSV, a TSV, a JSON, or a parquet file at or under the cap.
 * Layer three is the fall-through: an over-cap file or a host parse fault fails as `extraction-unavailable`.
 * On any doubt the read falls through, thus the host parser never gives a partial or guessed answer. An
 * extension that names no tabular format refuses the same way.
 *
 * A read of the bytes is the expensive part, thus an optional `ArtifactReadCache` outlives one resolver. It
 * holds the streamed hash and the parsed rows against a stat signature. Two tool calls of one analysis
 * share one cache.
 *
 * The realization calls the shared assert functions in `assert-rules.ts`, and it mirrors the locator walk
 * and the reason choices of `fixture-resolver.ts`. Thus one semantics exists, and the fixture stays the
 * executable specification of the value tier. The two realizations are substitutable behind the seam.
 */

import { err, ok, type Result } from "neverthrow";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parquetReadObjects, type AsyncBuffer } from "hyparquet";
import { z } from "zod";

import type {
    ArtifactFileReference,
    ArtifactTableReference,
    ArtifactValueReference,
    CitationReference,
    DerivationInputReference,
    DerivationReference,
    Reference,
    UnresolvedReason,
    UnresolvedReference,
} from "../contracts/report-reference.js";
import { allWithConcurrency } from "../lib/async-utils.js";
import { computeSha256File } from "../lib/fs-helpers.js";
import { parseJsonAs } from "../lib/parse-json.js";
import { resolveWorkspacePath } from "../workspace/paths.js";
import { asFiniteNumber, cellMatchesFilterValue, checkCitationAssertion, checkValueAssertion } from "./assert-rules.js";
import {
    applyRowBound,
    columnsHeldByNoRow,
    fileTypeHoldsNoCell,
    snapshotEntry,
    type ReferenceResolver,
    type ReportSnapshot,
    type ResolvedValue,
} from "./reference-resolver.js";

/** One artifact row, as plain cells. A text-backed format holds a numeric column as a string. */
export type Row = Record<string, string | number>;

/**
 * The default cap on the file size that the host fast path reads. A larger file takes the fall-through.
 * The cap gates the cell extraction only. The identity compare streams the hash at every size.
 */
const DEFAULT_CAP_BYTES = 16 * 1024 * 1024;

/**
 * The cap on how many artifacts the prepare batch reads at the same time. A large report holds hundreds
 * of references, thus an unbounded fan-out would open one read for each artifact at the same moment.
 */
const PREPARE_CONCURRENCY = 8;

/**
 * The disk facts of one artifact that outlive one resolver.
 *
 * `signature` states the bytes that the pass read: the size, the modification time, and the inode. A later
 * pass compares its own stat against it before it trusts anything here, thus a file that changed on disk is
 * read again. `rows` is present only for a clean read, because a read fault is transient and it must not
 * stick to the analysis.
 */
export type ArtifactRead = {
    readonly signature: string;
    readonly hash: string;
    readonly rows?: Array<Record<string, string | number>>;
};

/**
 * The read cache of one analysis. It holds what a read of the bytes costs: the streamed hash, and the parsed
 * rows. Two resolvers of one analysis share one cache, thus a preview and the record that follows it hash and
 * parse one unchanged file one time.
 *
 * The cache holds no authorization and no session value.
 */
export type ArtifactReadCache = {
    get(absolutePath: string): ArtifactRead | undefined;
    set(absolutePath: string, read: ArtifactRead): void;
};

/** The read caches that the host process holds, one for each recent analysis. */
export type ArtifactReadStore = {
    forAnalysis(analysisId: string): ArtifactReadCache;
};

/** The analyses that the read store holds at the same time. An older analysis drops out first. */
const ANALYSIS_CACHE_LIMIT = 4;

/** The artifacts that one analysis holds at the same time. The rows of a large file live here, thus the bound is small. */
const ARTIFACT_CACHE_LIMIT = 32;

/**
 * A bounded map that drops the least recently used entry.
 *
 * A `Map` keeps its insertion order. Thus a read that deletes the key and sets it again moves the key to the
 * end, and the first key of the map is always the oldest use.
 */
function createBoundedMap<V>(limit: number): { get(key: string): V | undefined; set(key: string, value: V): void } {
    const entries = new Map<string, V>();
    return {
        get(key) {
            const value = entries.get(key);
            if (value === undefined) {
                return undefined;
            }
            entries.delete(key);
            entries.set(key, value);
            return value;
        },
        set(key, value) {
            entries.delete(key);
            entries.set(key, value);
            if (entries.size > limit) {
                const oldest = entries.keys().next();
                if (!oldest.done) {
                    entries.delete(oldest.value);
                }
            }
        },
    };
}

/**
 * Make the read store of the report path. One host process serves many analyses, thus the store bounds both
 * dimensions: how many analyses it holds, and how many artifacts one analysis holds. A dropped entry costs
 * one read again, and it is never wrong.
 */
export function createArtifactReadStore(): ArtifactReadStore {
    const byAnalysis = createBoundedMap<ArtifactReadCache>(ANALYSIS_CACHE_LIMIT);
    return {
        forAnalysis(analysisId) {
            const held = byAnalysis.get(analysisId);
            if (held !== undefined) {
                return held;
            }
            const made = createBoundedMap<ArtifactRead>(ARTIFACT_CACHE_LIMIT);
            byAnalysis.set(analysisId, made);
            return made;
        },
    };
}

/**
 * The construction deps of the production resolver.
 *
 * `workspaceRoot` and `analysisId` contain the untrusted snapshot path through `resolveWorkspacePath`,
 * the same containment as the preview tool. `cap` gates the cell read, and it defaults to 16 MiB.
 * `readCache` is optional, thus a resolver with no cache reads every artifact itself and its reads die with it.
 */
export type ProductionResolverDeps = {
    readonly workspaceRoot: string;
    readonly analysisId: string;
    readonly cap?: number;
    readonly readCache?: ArtifactReadCache;
};

/** The tabular formats that the host fast path reads. Another extension names no format at all. */
export type TabularFormat = "csv" | "tsv" | "json" | "parquet";

/** The identity of one artifact, computed one time for each path. */
type Identity =
    | { kind: "missing" }
    | { kind: "unreadable"; detail: string }
    | { kind: "ready"; onDiskHash: string; fileType?: string | null; absolute: string; size: number; signature: string };

/** The identity of an artifact that is present, contained, and readable. */
type ReadyIdentity = Extract<Identity, { kind: "ready" }>;

/** The cells of one artifact, computed one time for each path that a reference reads. */
type Cells = { kind: "rows"; rows: Row[] } | { kind: "unavailable"; detail: string } | { kind: "unreadable"; detail: string };

/** The host read outcome. A fall-through carries the reason that the host read stopped. */
type HostRead = { kind: "rows"; rows: Row[] } | { kind: "fall-through"; detail: string } | { kind: "unsupported-format"; detail: string };

/** The cells of a fall-through. No reader outside the host exists, thus the reference fails as `extraction-unavailable`. */
function fallThroughCells(path: string, hostDetail: string): Cells {
    return { kind: "unavailable", detail: `the host read of the file at ${path} stopped because ${hostDetail}, and no other reader exists` };
}

/** Build an `Err` that carries the unresolved reference. The `detail` key is present only when there is a detail to carry. */
function fail(reference: Reference, reason: UnresolvedReason, detail?: string): Result<ResolvedValue, UnresolvedReference> {
    const failure: UnresolvedReference = detail !== undefined ? { reference, reason, detail } : { reference, reason };
    return err(failure);
}

/** A short account of a derivation input, for a detail that names which input broke the arithmetic. */
function describeReference(reference: DerivationInputReference): string {
    return `artifact value at ${reference.path} column ${reference.locator.column}`;
}

/**
 * Map a file extension to the format that the host arm reads. An unknown extension gives back `undefined`.
 *
 * This is the one format decision of the report path.
 */
export function detectFormat(path: string): TabularFormat | undefined {
    switch (extname(path).toLowerCase()) {
        case ".csv":
            return "csv";
        case ".tsv":
            return "tsv";
        case ".json":
            return "json";
        case ".parquet":
            return "parquet";
        default:
            return undefined;
    }
}

/**
 * Read one value as a cell, or drop it.
 *
 * A parquet integer column decodes as a `bigint`, thus the coercion narrows it to a number. A `null` or an
 * absent value is not a cell, thus it drops and the row omits the key. The fixture row omits an empty cell
 * the same way. An object or an array is structural doubt, thus it drops too and the format falls through
 * where the caller detects the loss.
 *
 * A non-finite number is not a cell either. A parquet float column holds a `NaN` or an `Infinity`, thus the
 * coercion drops it and the row omits the key.
 */
export function coerceCell(value: unknown): string | number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "bigint") {
        const narrowed = Number(value);
        return Number.isFinite(narrowed) ? narrowed : undefined;
    }
    if (typeof value === "boolean") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return undefined;
}

/**
 * Parse the records of a delimited file with one delimiter, per RFC 4180.
 *
 * A quoted field can hold the delimiter and a line break, and a pair of double quotes is one literal
 * quote. Any structural doubt gives back `undefined`, thus a parse fault falls through and is never a
 * guess. The doubt cases are a quote inside an unquoted field, text after a closing quote, and an
 * unterminated quoted field.
 */
function parseRecords(text: string, delimiter: string): string[][] | undefined {
    const records: string[][] = [];
    const n = text.length;
    if (n === 0) {
        return records;
    }
    let i = 0;
    while (i <= n) {
        const record: string[] = [];
        for (;;) {
            let field = "";
            if (i < n && text[i] === '"') {
                i += 1;
                let closed = false;
                while (i < n) {
                    const ch = text.charAt(i);
                    if (ch === '"') {
                        if (text[i + 1] === '"') {
                            field += '"';
                            i += 2;
                        } else {
                            i += 1;
                            closed = true;
                            break;
                        }
                    } else {
                        field += ch;
                        i += 1;
                    }
                }
                if (!closed) {
                    return undefined;
                }
                if (i < n && text[i] !== delimiter && text[i] !== "\r" && text[i] !== "\n") {
                    return undefined;
                }
            } else {
                while (i < n) {
                    const ch = text.charAt(i);
                    if (ch === delimiter || ch === "\r" || ch === "\n") {
                        break;
                    }
                    if (ch === '"') {
                        return undefined;
                    }
                    field += ch;
                    i += 1;
                }
            }
            record.push(field);
            if (i < n && text[i] === delimiter) {
                i += 1;
                continue;
            }
            break;
        }
        records.push(record);
        if (i < n && text[i] === "\r") {
            i += 1;
        }
        if (i < n && text[i] === "\n") {
            i += 1;
        }
        if (i >= n) {
            break;
        }
    }
    return records;
}

/**
 * Parse a delimited file into rows. The first record is the header. A ragged record and a repeated header
 * name are structural doubt, thus each gives back `undefined` and the file falls through.
 */
export function parseDelimited(text: string, delimiter: string): Row[] | undefined {
    const records = parseRecords(text, delimiter);
    if (records === undefined) {
        return undefined;
    }
    const header = records[0];
    if (header === undefined) {
        return [];
    }
    const seen = new Set<string>();
    for (const name of header) {
        if (seen.has(name)) {
            return undefined;
        }
        seen.add(name);
    }
    const rows: Row[] = [];
    for (const fields of records.slice(1)) {
        // A blank line parses as one empty field, thus the walk drops it and reads no dialect into it. A
        // record with more than one field, or one non-empty field, still obeys the count check, thus a
        // genuinely ragged record falls through.
        if (fields.length === 1 && fields[0] === "") {
            continue;
        }
        if (fields.length !== header.length) {
            return undefined;
        }
        const row: Row = {};
        for (const [c, name] of header.entries()) {
            const value = fields[c];
            if (value !== undefined) {
                row[name] = value;
            }
        }
        rows.push(row);
    }
    return rows;
}

/** A cell of a JSON table: the scalars JSON carries. A non-finite number stays a cell — `JSON.parse`
 * reads an over-large literal as Infinity, and the coercion drops it. A nested value is structural doubt. */
const JsonTableCell = z.custom<string | number | boolean | null>(
    (cell) => cell === null || typeof cell === "number" || typeof cell === "string" || typeof cell === "boolean",
);

/**
 * Parse a JSON file into rows. The strict shape is an array of flat objects with scalar cells. A parse
 * fault, a top-level value that is not an array, and a nested cell are structural doubt, thus each gives
 * back `undefined` and the file falls through.
 */
function parseJsonTable(text: string): Row[] | undefined {
    let table: readonly Record<string, string | number | boolean | null>[];
    try {
        table = parseJsonAs(text, z.array(z.record(z.string(), JsonTableCell)));
    } catch {
        return undefined;
    }
    const rows: Row[] = [];
    for (const fields of table) {
        const row: Row = {};
        for (const [key, cell] of Object.entries(fields)) {
            const coerced = coerceCell(cell);
            if (coerced !== undefined) {
                row[key] = coerced;
            }
        }
        rows.push(row);
    }
    return rows;
}

/** Wrap in-memory bytes as an `AsyncBuffer`, thus the parquet reader reads from memory and opens no file. */
function toAsyncBuffer(bytes: Buffer): AsyncBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return { byteLength: buffer.byteLength, slice: (start: number, end?: number) => buffer.slice(start, end) };
}

/**
 * Read a parquet file into rows with the pure-JavaScript reader, thus no native library enters the
 * package. A reader fault gives back `undefined`, thus the file falls through.
 */
async function parseParquet(bytes: Buffer): Promise<Row[] | undefined> {
    let records: Array<Record<string, unknown>>;
    try {
        records = await parquetReadObjects({ file: toAsyncBuffer(bytes), rowFormat: "object", utf8: true });
    } catch {
        return undefined;
    }
    const rows: Row[] = [];
    for (const record of records) {
        const row: Row = {};
        for (const [key, cell] of Object.entries(record)) {
            const coerced = coerceCell(cell);
            if (coerced !== undefined) {
                row[key] = coerced;
            }
        }
        rows.push(row);
    }
    return rows;
}

/**
 * Read the cells of one artifact through the host fast path. An over-cap file and a parse fault each give
 * back a fall-through. An extension that names no tabular format stops here.
 */
async function hostReadCells(cap: number, path: string, identity: ReadyIdentity): Promise<HostRead> {
    const format = detectFormat(path);
    if (format === undefined) {
        return { kind: "unsupported-format", detail: `the file at ${path} has no supported tabular format, thus no reader is decided for it` };
    }
    if (identity.size > cap) {
        return { kind: "fall-through", detail: `the file size of ${identity.size} bytes is over the ${cap}-byte cap` };
    }
    let bytes: Buffer;
    try {
        bytes = await readFile(identity.absolute);
    } catch {
        return { kind: "fall-through", detail: "the file could not be read" };
    }
    const rows = await parseTable(format, bytes);
    return rows === undefined ? { kind: "fall-through", detail: PARSE_FAULT_DETAIL[format] } : { kind: "rows", rows };
}

/** The detail of a parse fault, for each format. */
const PARSE_FAULT_DETAIL: Record<TabularFormat, string> = {
    csv: "the delimited parse did not succeed",
    tsv: "the delimited parse did not succeed",
    json: "the JSON parse did not succeed",
    parquet: "the parquet read did not succeed",
};

/** Parse the bytes of one table in a decided format. A parse fault gives back `undefined`. */
export async function parseTable(format: TabularFormat, bytes: Buffer): Promise<Row[] | undefined> {
    if (format === "parquet") return parseParquet(bytes);
    const text = bytes.toString("utf8");
    if (format === "json") return parseJsonTable(text);
    return parseDelimited(text, format === "tsv" ? "\t" : ",");
}

/**
 * Compute the identity of one artifact: membership, containment, and the on-disk hash.
 *
 * An agent authors a report reference, thus the path is untrusted. `resolveWorkspacePath` contains the
 * path against the workspace root, the same containment as the preview tool. The hash streams at every
 * size, thus a huge file never loads into memory here.
 *
 * The stat runs before the cache read, thus a deleted file is unreadable even when the cache holds its
 * bytes. A cached hash serves only bytes whose stat signature did not move. `fileType` states a role, and
 * the snapshot of this pass gives it, thus the cache never carries a role from an earlier snapshot.
 */
async function computeIdentity(
    workspaceRoot: string,
    analysisId: string,
    path: string,
    snapshot: ReportSnapshot,
    readCache?: ArtifactReadCache,
): Promise<Identity> {
    const entry = snapshotEntry(snapshot, path);
    if (entry === undefined) {
        return { kind: "missing" };
    }
    const resolved = resolveWorkspacePath({ workspaceRoot, analysisId, path });
    if (resolved.kind !== "ok") {
        return { kind: "unreadable", detail: `the artifact path ${path} escapes the workspace root` };
    }
    let size: number;
    let signature: string;
    try {
        const stats = await stat(resolved.absolute);
        size = stats.size;
        // The size, the modification time, and the inode together move when the bytes move. A rewrite in
        // place moves the time, and a replace by rename moves the inode.
        signature = `${stats.size}:${stats.mtimeMs}:${stats.ino}`;
    } catch {
        return { kind: "unreadable", detail: `the artifact at ${path} is not readable on disk` };
    }
    const shared = readCache?.get(resolved.absolute);
    if (shared !== undefined && shared.signature === signature) {
        return { kind: "ready", onDiskHash: shared.hash, fileType: entry.fileType, absolute: resolved.absolute, size, signature };
    }
    let onDiskHash: string;
    try {
        onDiskHash = await computeSha256File(resolved.absolute);
    } catch {
        return { kind: "unreadable", detail: `the artifact at ${path} is not readable on disk` };
    }
    readCache?.set(resolved.absolute, { signature, hash: onDiskHash });
    return { kind: "ready", onDiskHash, fileType: entry.fileType, absolute: resolved.absolute, size, signature };
}

/**
 * Give back the rows that an earlier pass read for these exact bytes, or `undefined` when nothing shared
 * them. The signature compare is the whole guard: a file that changed on disk holds a different signature,
 * thus the earlier rows never answer for the new bytes.
 */
function sharedRows(readCache: ArtifactReadCache | undefined, identity: ReadyIdentity): Row[] | undefined {
    const held = readCache?.get(identity.absolute);
    return held !== undefined && held.signature === identity.signature && held.rows !== undefined ? held.rows : undefined;
}

/**
 * Share the rows of one clean read, thus the next pass over the same bytes parses nothing again. A failed
 * read is transient, thus only rows enter the cache.
 */
function shareRows(readCache: ArtifactReadCache | undefined, identity: ReadyIdentity, rows: Row[]): void {
    readCache?.set(identity.absolute, { signature: identity.signature, hash: identity.onDiskHash, rows });
}

/**
 * The read access that one reference makes on one artifact. `needsCells` is false for a whole-file
 * reference, because a file is pinned by its bytes and holds no cell to read.
 */
type Access = {
    readonly path: string;
    readonly hash: string;
    readonly needsCells: boolean;
};

/** The reads that one reference makes. A citation reads no artifact, and a derivation reads its inputs. */
function accessesOf(reference: Reference): Access[] {
    switch (reference.kind) {
        case "artifact-value":
        case "artifact-table":
            return [{ path: reference.path, hash: reference.hash, needsCells: true }];
        case "artifact-file":
            return [{ path: reference.path, hash: reference.hash, needsCells: false }];
        case "derivation":
            return reference.inputs.map((input) => ({ path: input.path, hash: input.hash, needsCells: true }));
        case "citation":
            return [];
    }
}

/** The read intent of every reference at one path: whether a cell is read, and each pinned hash a cell reads. */
type PathIntent = {
    needsCells: boolean;
    readonly cellHashes: Set<string>;
};

/**
 * Make the production resolver over the workspace root.
 *
 * The resolver holds a per-pass cache. `prepare` groups the references by artifact, reads each file one
 * time, and fills the cache. `resolve` then answers from the cache. A `resolve` with no prior `prepare`
 * still answers, and it writes what it read into the same cache. Thus the cost is one read for each
 * artifact on both paths, and never one read for each reference.
 */
export function createProductionResolver(deps: ProductionResolverDeps): ReferenceResolver {
    const { workspaceRoot, analysisId, readCache } = deps;
    const cap = deps.cap ?? DEFAULT_CAP_BYTES;

    // The per-pass caches. `prepare` clears and refills them, thus a later pass reads the artifacts again.
    const idCache = new Map<string, Identity>();
    const cellsCache = new Map<string, Cells>();

    /**
     * Give back the identity of one path, from the cache after a prepare, or by a fresh read. A fresh read
     * enters the cache, thus a second reference at one path never streams the hash again.
     */
    async function getIdentity(path: string, snapshot: ReportSnapshot): Promise<Identity> {
        const cached = idCache.get(path);
        if (cached !== undefined) {
            return cached;
        }
        const identity = await computeIdentity(workspaceRoot, analysisId, path, snapshot, readCache);
        idCache.set(path, identity);
        return identity;
    }

    /**
     * Give back the cells of one path, from the cache after a prepare, or by a fresh read. A fresh read
     * runs the host fast path. The outcome enters the cache, thus a second reference at one path reads
     * nothing again.
     */
    async function getCells(path: string, identity: ReadyIdentity): Promise<Cells> {
        const cached = cellsCache.get(path);
        if (cached !== undefined) {
            return cached;
        }
        const shared = sharedRows(readCache, identity);
        if (shared !== undefined) {
            const held: Cells = { kind: "rows", rows: shared };
            cellsCache.set(path, held);
            return held;
        }
        const read = await hostReadCells(cap, path, identity);
        if (read.kind === "rows") {
            const parsed: Cells = { kind: "rows", rows: read.rows };
            shareRows(readCache, identity, read.rows);
            cellsCache.set(path, parsed);
            return parsed;
        }
        const unavailable: Cells = read.kind === "unsupported-format" ? { kind: "unavailable", detail: read.detail } : fallThroughCells(path, read.detail);
        cellsCache.set(path, unavailable);
        return unavailable;
    }

    /**
     * The identity gate that a cell-reading reference passes before a read of cells.
     *
     * The gate answers membership, the on-disk hash, and the file type. A hash mismatch fails before any
     * parse, thus a drifted file never reaches the host parser.
     */
    async function gateCells(
        reference: ArtifactValueReference | ArtifactTableReference,
        snapshot: ReportSnapshot,
    ): Promise<Result<Row[], UnresolvedReference>> {
        const identity = await getIdentity(reference.path, snapshot);
        if (identity.kind === "missing") {
            return err({ reference, reason: "artifact-missing", detail: `no artifact at ${reference.path}` });
        }
        if (identity.kind === "unreadable") {
            return err({ reference, reason: "unreadable-artifact", detail: identity.detail });
        }
        if (reference.hash !== identity.onDiskHash) {
            return err({ reference, reason: "hash-mismatch", detail: `expected ${reference.hash} but the artifact hash is ${identity.onDiskHash}` });
        }
        if (fileTypeHoldsNoCell(identity.fileType)) {
            return err({ reference, reason: "unreadable-artifact", detail: `the ${String(identity.fileType)} at ${reference.path} holds no cell to read` });
        }
        const cells = await getCells(reference.path, identity);
        if (cells.kind === "unavailable") {
            return err({ reference, reason: "extraction-unavailable", detail: cells.detail });
        }
        if (cells.kind === "unreadable") {
            return err({ reference, reason: "unreadable-artifact", detail: cells.detail });
        }
        return ok(cells.rows);
    }

    /** Walk the locator over the rows, and match the resolved cell against the authored belief. */
    function selectCell(reference: ArtifactValueReference, rows: Row[]): Result<ResolvedValue, UnresolvedReference> {
        const locator = reference.locator;
        let selectedRow: Row;
        if (locator.row !== undefined) {
            const row = rows[locator.row];
            if (row === undefined) {
                return fail(reference, "locator-out-of-range", `row ${locator.row} is outside the ${rows.length} rows`);
            }
            selectedRow = row;
        } else if (locator.rowFilter !== undefined) {
            const filter = locator.rowFilter;
            const matches = rows.filter((row) => cellMatchesFilterValue(row[filter.column], filter.value));
            const match = matches[0];
            if (match === undefined) {
                return fail(reference, "locator-out-of-range", `no row where ${filter.column} equals ${String(filter.value)}`);
            }
            if (matches.length > 1) {
                return fail(reference, "ambiguous-match", `${matches.length} rows where ${filter.column} equals ${String(filter.value)}`);
            }
            selectedRow = match;
        } else {
            // The locator schema forbids a locator with neither selector. The resolver cannot depend on a
            // prior parse, thus it treats a row that no selector addresses as out of range.
            return fail(reference, "locator-out-of-range", "the locator selects no row");
        }

        // A real table holds an empty cell, and a parse gives it back as an absent key. An absent key is
        // not a value that a scalar reference can bind. An empty string is a value, thus it stays valid.
        // A cell that parsed as `null` never lands in a row: `coerceCell` drops it, so `null` is not
        // an absence the resolver can meet here.
        const cell: string | number | undefined = selectedRow[locator.column];
        if (cell === undefined) {
            return fail(reference, "locator-out-of-range", `column ${locator.column} holds no value in the selected row`);
        }
        const valueFailure = checkValueAssertion(reference, reference.assert?.value, reference.assert?.tolerance, cell);
        return valueFailure !== undefined ? err(valueFailure) : ok({ type: "scalar", value: cell });
    }

    async function resolveArtifactValue(reference: ArtifactValueReference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
        const gated = await gateCells(reference, snapshot);
        return gated.isErr() ? err(gated.error) : selectCell(reference, gated.value);
    }

    async function resolveArtifactTable(reference: ArtifactTableReference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
        const gated = await gateCells(reference, snapshot);
        if (gated.isErr()) {
            return err(gated.error);
        }
        // The bound ranks the rows as the artifact holds them, thus a bound over a column that the subset
        // below leaves out still ranks them. An unknown bound column addresses nothing, exactly as an
        // unknown subset column does.
        const bound = reference.rowBound;
        const allRows = gated.value;
        if (bound !== undefined && columnsHeldByNoRow(allRows, [bound.column]).length > 0) {
            return fail(reference, "locator-out-of-range", `the row bound names column ${bound.column}, which the table at ${reference.path} does not hold`);
        }
        const rows = bound === undefined ? allRows : applyRowBound(allRows, bound);
        // The page states the shown count against the count of the artifact. This read is the one place that
        // holds both, thus a bounded table carries the pre-bound total out with its rows.
        const total = bound === undefined ? {} : { total: allRows.length };
        const columns = reference.columns;
        if (columns === undefined) {
            return ok({ type: "table", rows, ...total });
        }

        // A name that no row holds addresses nothing. Without this check a projection onto an invented
        // column gives an empty cell for each row and still resolves, which grounding exists to reject.
        const absent = columnsHeldByNoRow(rows, columns);
        if (absent.length > 0) {
            return fail(reference, "locator-out-of-range", `the table at ${reference.path} holds no column ${absent.join(", ")}`);
        }

        // Project each row onto the requested columns. A table tolerates a ragged row, thus a column that
        // a given row lacks is left out of that row and is not a failure.
        const projectedRows = rows.map((row) => {
            const projected: Row = {};
            for (const column of columns) {
                const cell = row[column];
                if (cell !== undefined) {
                    projected[column] = cell;
                }
            }
            return projected;
        });
        return ok({ type: "table", rows: projectedRows, columns, ...total });
    }

    async function resolveArtifactFile(reference: ArtifactFileReference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
        const identity = await getIdentity(reference.path, snapshot);
        if (identity.kind === "missing") {
            return fail(reference, "artifact-missing", `no artifact at ${reference.path}`);
        }
        if (identity.kind === "unreadable") {
            return fail(reference, "unreadable-artifact", identity.detail);
        }
        if (reference.hash !== identity.onDiskHash) {
            return fail(reference, "hash-mismatch", `expected ${reference.hash} but the artifact hash is ${identity.onDiskHash}`);
        }
        return ok({ type: "file", path: reference.path, hash: identity.onDiskHash });
    }

    async function resolveDerivation(reference: DerivationReference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
        const numbers: number[] = [];
        for (const input of reference.inputs) {
            const inputResult = await resolveArtifactValue(input, snapshot);
            if (inputResult.isErr()) {
                // Keep the inner reason so a reviewer sees the real cause, for example a missing artifact
                // under the derivation. The derivation itself did not fail on its own terms.
                return fail(reference, inputResult.error.reason, inputResult.error.detail);
            }
            const resolved = inputResult.value;
            const numeric = resolved.type === "scalar" ? asFiniteNumber(resolved.value) : undefined;
            if (numeric === undefined) {
                // The arithmetic needs a finite number. A cell that holds text does not address a usable
                // scalar, thus the closest reason is that the coordinate is out of range.
                return fail(reference, "locator-out-of-range", `input ${describeReference(input)} did not resolve to a finite number`);
            }
            numbers.push(numeric);
        }

        const a = numbers[0];
        const b = numbers[1];
        if (a === undefined || b === undefined) {
            return fail(reference, "locator-out-of-range", `operation ${reference.op} needs two inputs, and the derivation holds ${numbers.length}`);
        }
        let result: number;
        switch (reference.op) {
            case "ratio":
                result = a / b;
                break;
            case "delta":
                result = a - b;
                break;
            case "pctChange":
                // A fraction, not a percent. A change of one half gives 0.5, thus an author asserts 0.5 and
                // a `unit` of `%` only tells a renderer how to show it.
                result = (a - b) / b;
                break;
        }
        if (!Number.isFinite(result)) {
            return fail(reference, "locator-out-of-range", `operation ${reference.op} does not yield a finite value, because the divisor is zero`);
        }
        const valueFailure = checkValueAssertion(reference, reference.assert?.value, reference.assert?.tolerance, result);
        return valueFailure !== undefined ? err(valueFailure) : ok({ type: "scalar", value: result });
    }

    function resolveCitation(reference: CitationReference, snapshot: ReportSnapshot): Result<ResolvedValue, UnresolvedReference> {
        const key = `${reference.idKind}:${reference.id}`;
        if (snapshot.citations === undefined || !snapshot.citations.includes(key)) {
            return fail(reference, "artifact-missing", `the citation ${key} is not in the pinned evidence`);
        }
        const value: ResolvedValue = { type: "citation", id: key };
        const citationFailure = checkCitationAssertion(reference, reference.assert?.value, key);
        return citationFailure !== undefined ? err(citationFailure) : ok(value);
    }

    async function resolve(reference: Reference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
        switch (reference.kind) {
            case "artifact-value":
                return resolveArtifactValue(reference, snapshot);
            case "artifact-table":
                return resolveArtifactTable(reference, snapshot);
            case "artifact-file":
                return resolveArtifactFile(reference, snapshot);
            case "derivation":
                return resolveDerivation(reference, snapshot);
            case "citation":
                return resolveCitation(reference, snapshot);
        }
    }

    async function prepare(references: readonly Reference[], snapshot: ReportSnapshot): Promise<void> {
        idCache.clear();
        cellsCache.clear();

        // Group the read intent by path. Two references at one path share one file read.
        const byPath = new Map<string, PathIntent>();
        for (const reference of references) {
            for (const access of accessesOf(reference)) {
                let intent = byPath.get(access.path);
                if (intent === undefined) {
                    intent = { needsCells: false, cellHashes: new Set<string>() };
                    byPath.set(access.path, intent);
                }
                if (access.needsCells) {
                    intent.needsCells = true;
                    intent.cellHashes.add(access.hash);
                }
            }
        }

        // Compute the identity of each path, one read each, under the fan-out bound.
        const entries = [...byPath.entries()];
        const identityPairs = await allWithConcurrency(
            entries.map(([path]) => async () => ({ path, identity: await computeIdentity(workspaceRoot, analysisId, path, snapshot, readCache) })),
            PREPARE_CONCURRENCY,
        );
        for (const { path, identity } of identityPairs) {
            idCache.set(path, identity);
        }

        // Read cells for each cell-reading path whose on-disk hash matches an expected pin. A hash that no
        // pin expects means every reference at the path mismatches, thus no parse runs on a drifted file.
        const cellTargets: Array<{ path: string; identity: ReadyIdentity }> = [];
        for (const [path, intent] of entries) {
            const identity = idCache.get(path);
            if (intent.needsCells && identity !== undefined && identity.kind === "ready" && intent.cellHashes.has(identity.onDiskHash)) {
                cellTargets.push({ path, identity });
            }
        }
        // An earlier pass over these exact bytes already paid for the rows. Take them, thus the second pass
        // of one analysis parses nothing again.
        const pending: Array<{ path: string; identity: ReadyIdentity }> = [];
        for (const target of cellTargets) {
            const shared = sharedRows(readCache, target.identity);
            if (shared !== undefined) {
                cellsCache.set(target.path, { kind: "rows", rows: shared });
            } else {
                pending.push(target);
            }
        }
        const reads = await allWithConcurrency(
            pending.map((target) => async () => ({ target, read: await hostReadCells(cap, target.path, target.identity) })),
            PREPARE_CONCURRENCY,
        );

        for (const { target, read } of reads) {
            if (read.kind === "rows") {
                cellsCache.set(target.path, { kind: "rows", rows: read.rows });
                shareRows(readCache, target.identity, read.rows);
            } else if (read.kind === "unsupported-format") {
                cellsCache.set(target.path, { kind: "unavailable", detail: read.detail });
            } else {
                cellsCache.set(target.path, fallThroughCells(target.path, read.detail));
            }
        }
    }

    return { resolve, prepare };
}
