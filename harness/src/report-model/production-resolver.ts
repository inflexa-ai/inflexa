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
 * The realization calls the shared assert functions in `assert-rules.ts` and the shared reference reads in
 * `reference-read.ts`, as the fixture realization does. Thus one semantics exists, and the fixture stays
 * the executable specification of the value tier. The two realizations are substitutable behind the seam.
 */

import { err, ok, type Result } from "neverthrow";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parquetMetadataAsync, parquetReadObjects, parquetSchema, type AsyncBuffer } from "hyparquet";
import { z } from "zod";

import type { ArtifactFileReference, ArtifactTableReference, ArtifactValueReference, Reference, UnresolvedReference } from "../contracts/report-reference.js";
import { allWithConcurrency } from "../lib/async-utils.js";
import { transferable, withDecodeSlot } from "../lib/host-workers.js";
import { computeSha256File } from "../lib/fs-helpers.js";
import { parseJsonAs } from "../lib/parse-json.js";
import { resolveWorkspacePath } from "../workspace/paths.js";
import { checkValueAssertion } from "./assert-rules.js";
import { fail, readArtifactTable, resolveCitation, resolveDerivation, selectRow } from "./reference-read.js";
import { fileTypeHoldsNoCell, snapshotEntry, type ReferenceResolver, type ReportSnapshot, type ResolvedValue } from "./reference-resolver.js";

/** One artifact row, as plain cells. A text-backed format holds a numeric column as a string. */
export type Row = Record<string, string | number>;

/**
 * The default cap on the file size that the host fast path reads. A larger file takes the fall-through.
 * The cap gates the cell extraction only. The identity compare streams the hash at every size.
 */
const DEFAULT_CAP_BYTES = 16 * 1024 * 1024;

/**
 * The most cells that the host fast path decodes for one table. A larger table takes the fall-through. The resolver
 * keeps the rows on the host, thus the budget bounds the memory of each read and of each cache entry.
 */
const HOST_CELL_BUDGET = 1_000_000;

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

/** The read cache that the host process holds, with one view for each analysis. */
export type ArtifactReadStore = {
    forAnalysis(analysisId: string): ArtifactReadCache;
};

/** The entries that the read store holds across each analysis, and the cells of the rows that they hold together. */
const READ_STORE_ENTRY_LIMIT = 128;
const READ_STORE_CELL_LIMIT = 2_000_000;

/** The cells of the rows of one read: the cells that each row holds. */
function cellsOf(read: ArtifactRead): number {
    let cells = 0;
    for (const row of read.rows ?? []) cells += Object.keys(row).length;
    return cells;
}

/**
 * Make the read store of the report path. One host process serves many analyses, thus the store holds one cache
 * across them, and it drops the least recently used entry while the entries pass {@link READ_STORE_ENTRY_LIMIT} or
 * the cells of the held rows pass {@link READ_STORE_CELL_LIMIT}. A dropped entry costs one read again, and it is
 * never wrong.
 *
 * A `Map` keeps its insertion order. Thus a read that deletes the key and sets it again moves the key to the end,
 * and the first key of the map is always the oldest use.
 */
export function createArtifactReadStore(): ArtifactReadStore {
    const entries = new Map<string, { read: ArtifactRead; cells: number }>();
    let heldCells = 0;
    const drop = (key: string): void => {
        const held = entries.get(key);
        if (held === undefined) return;
        heldCells -= held.cells;
        entries.delete(key);
    };
    return {
        forAnalysis(analysisId) {
            const keyOf = (absolutePath: string): string => `${analysisId}\u0000${absolutePath}`;
            return {
                get(absolutePath) {
                    const key = keyOf(absolutePath);
                    const held = entries.get(key);
                    if (held === undefined) return undefined;
                    entries.delete(key);
                    entries.set(key, held);
                    return held.read;
                },
                set(absolutePath, read) {
                    const key = keyOf(absolutePath);
                    drop(key);
                    const cells = cellsOf(read);
                    entries.set(key, { read, cells });
                    heldCells += cells;
                    for (const oldest of entries.keys()) {
                        if (entries.size <= READ_STORE_ENTRY_LIMIT && heldCells <= READ_STORE_CELL_LIMIT) break;
                        if (oldest === key) continue;
                        drop(oldest);
                    }
                },
            };
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
 *
 * The walk gives one record at a time, and a doubt gives one `undefined` and ends the walk. Thus a caller
 * that keeps only some records holds only those.
 */
function* delimitedRecords(text: string, delimiter: string): Generator<string[] | undefined> {
    const n = text.length;
    if (n === 0) {
        return;
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
                    yield undefined;
                    return;
                }
                if (i < n && text[i] !== delimiter && text[i] !== "\r" && text[i] !== "\n") {
                    yield undefined;
                    return;
                }
            } else {
                while (i < n) {
                    const ch = text.charAt(i);
                    if (ch === delimiter || ch === "\r" || ch === "\n") {
                        break;
                    }
                    if (ch === '"') {
                        yield undefined;
                        return;
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
        yield record;
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
}

/**
 * A cell of a text table as a number, when the text is a plain decimal number. A text with a leading zero, such
 * as an identifier `007`, stays text, because a number loses its zeros.
 */
export function numericCell(text: string): string | number {
    if (text.length === 0 || text !== text.trim()) return text;
    const value = Number(text);
    if (!Number.isFinite(value)) return text;
    const digits = text.startsWith("-") ? text.slice(1) : text;
    if (digits.length > 1 && digits.startsWith("0") && digits[1] !== ".") return text;
    if (digits.includes("x") || digits.includes("X") || digits.includes("o") || digits.includes("b")) return text;
    return value;
}

/**
 * What a decode keeps: the named columns, or each column; the rows from `offset`, up to `limit` rows; and at most
 * `cellBudget` cells, a cell being one value of one kept row and one kept column. `numericText` reads a plain decimal
 * text cell as a number ({@link numericCell}).
 */
export type TableDecodeOptions = {
    readonly columns?: readonly string[];
    readonly offset?: number;
    readonly limit?: number;
    readonly cellBudget: number;
    readonly numericText: boolean;
};

/**
 * The outcome of one decode. `totalRows` counts the rows of the whole table. A read over the budget keeps no row,
 * and it gives the cells that it would have given.
 */
export type TableDecode =
    | { readonly kind: "rows"; readonly columns: string[]; readonly rows: Row[]; readonly totalRows: number }
    | { readonly kind: "unparsable" }
    | { readonly kind: "missing_columns"; readonly missing: string[]; readonly columns: string[] }
    | { readonly kind: "over_budget"; readonly cells: number; readonly budget: number; readonly columns: string[]; readonly totalRows: number };

/** The kept columns of a table, or the named columns that it does not hold. */
function keptColumns(header: readonly string[], options: TableDecodeOptions): { kept: string[] } | { missing: string[] } {
    if (options.columns === undefined) return { kept: [...header] };
    const missing = options.columns.filter((column) => !header.includes(column));
    return missing.length > 0 ? { missing } : { kept: [...options.columns] };
}

/** The first row and the end of the range of rows that a decode keeps, in a table of `total` rows. */
function rowRange(total: number, options: TableDecodeOptions): { start: number; end: number } {
    const start = Math.min(options.offset ?? 0, total);
    return { start, end: options.limit === undefined ? total : Math.min(total, start + options.limit) };
}

/**
 * Keep the cells of one row: the kept columns, each cell coerced. The row is the object that the reader made, thus
 * the decode makes no second set of rows. A cell with no value leaves the row.
 */
function keepCells(row: Record<string, unknown>, kept: readonly string[], numericText: boolean): Row {
    const out: Row = {};
    for (const column of kept) {
        const coerced = coerceCell(row[column]);
        if (coerced !== undefined) out[column] = numericText && typeof coerced === "string" ? numericCell(coerced) : coerced;
    }
    return out;
}

/**
 * Decode a delimited file. The format has no index, thus the walk counts each record. It keeps the records of the
 * range until the cells pass the budget, and then it keeps nothing and counts on, thus a refusal gives the exact
 * cells and the walk holds no more than the budget.
 */
function decodeDelimited(text: string, delimiter: string, options: TableDecodeOptions): TableDecode {
    const records = delimitedRecords(text, delimiter);
    const first = records.next();
    if (first.done === true) return { kind: "rows", columns: [], rows: [], totalRows: 0 };
    const header = first.value;
    if (header === undefined || new Set(header).size !== header.length) return { kind: "unparsable" };
    const columns = keptColumns(header, options);
    if ("missing" in columns) return { kind: "missing_columns", missing: columns.missing, columns: header };
    const { kept } = columns;
    const indexes = kept.map((column) => header.indexOf(column));
    const start = options.offset ?? 0;
    const end = options.limit === undefined ? Number.POSITIVE_INFINITY : start + options.limit;
    const rows: Row[] = [];
    let total = 0;
    let overBudget = false;
    for (const fields of records) {
        if (fields === undefined) return { kind: "unparsable" };
        // A blank line parses as one empty field, thus the walk drops it and reads no dialect into it. A
        // record with more than one field, or one non-empty field, still obeys the count check, thus a
        // genuinely ragged record falls through.
        if (fields.length === 1 && fields[0] === "") continue;
        if (fields.length !== header.length) return { kind: "unparsable" };
        const index = total++;
        if (overBudget || index < start || index >= end) continue;
        if ((rows.length + 1) * kept.length > options.cellBudget) {
            overBudget = true;
            rows.length = 0;
            continue;
        }
        const row: Row = {};
        for (const [k, column] of kept.entries()) {
            const value = fields[indexes[k] ?? -1];
            if (value !== undefined) row[column] = options.numericText ? numericCell(value) : value;
        }
        rows.push(row);
    }
    if (overBudget) {
        const range = rowRange(total, options);
        return { kind: "over_budget", cells: (range.end - range.start) * kept.length, budget: options.cellBudget, columns: header, totalRows: total };
    }
    return { kind: "rows", columns: kept, rows, totalRows: total };
}

/**
 * Parse a delimited file into rows. The first record is the header. A ragged record and a repeated header
 * name are structural doubt, thus each gives back `undefined` and the file falls through.
 */
export function parseDelimited(text: string, delimiter: string): Row[] | undefined {
    const decoded = decodeDelimited(text, delimiter, { cellBudget: Number.POSITIVE_INFINITY, numericText: false });
    return decoded.kind === "rows" ? decoded.rows : undefined;
}

/** A cell of a JSON table: the scalars JSON carries. A non-finite number stays a cell — `JSON.parse`
 * reads an over-large literal as Infinity, and the coercion drops it. A nested value is structural doubt. */
const JsonTableCell = z.custom<string | number | boolean | null>(
    (cell) => cell === null || typeof cell === "number" || typeof cell === "string" || typeof cell === "boolean",
);

/**
 * Decode a JSON file. The strict shape is an array of flat objects with scalar cells. A parse fault, a top-level
 * value that is not an array, and a nested cell are structural doubt. The header is each key in the order of its
 * first row.
 */
function decodeJsonTable(text: string, options: TableDecodeOptions): TableDecode {
    let table: readonly Record<string, string | number | boolean | null>[];
    try {
        table = parseJsonAs(text, z.array(z.record(z.string(), JsonTableCell)));
    } catch {
        return { kind: "unparsable" };
    }
    const header = [...new Set(table.flatMap((row) => Object.keys(row)))];
    const columns = keptColumns(header, options);
    if ("missing" in columns) return { kind: "missing_columns", missing: columns.missing, columns: header };
    const range = rowRange(table.length, options);
    const cells = (range.end - range.start) * columns.kept.length;
    if (cells > options.cellBudget) return { kind: "over_budget", cells, budget: options.cellBudget, columns: header, totalRows: table.length };
    const rows = table.slice(range.start, range.end).map((row) => keepCells(row, columns.kept, options.numericText));
    return { kind: "rows", columns: columns.kept, rows, totalRows: table.length };
}

/**
 * Wrap in-memory bytes as an `AsyncBuffer`, thus the parquet reader reads from memory and opens no file. Each slice
 * copies only the range that the reader asks for.
 */
function toAsyncBuffer(bytes: Uint8Array): AsyncBuffer {
    // A plain view, because `Buffer#slice` gives a view of the whole buffer and `Uint8Array#slice` a copy of the range.
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { byteLength: view.byteLength, slice: (start: number, end?: number) => view.slice(start, end ?? view.byteLength).buffer };
}

/**
 * Decode a parquet file with the pure-JavaScript reader, thus no native library enters the package. The metadata
 * gives the row count and the columns before any page is decoded, thus a read over the budget decodes nothing. The
 * reader decodes only the kept columns and the rows of the range. A reader fault is structural doubt.
 */
async function decodeParquet(bytes: Uint8Array, options: TableDecodeOptions): Promise<TableDecode> {
    const file = toAsyncBuffer(bytes);
    try {
        const metadata = await parquetMetadataAsync(file);
        const header = parquetSchema(metadata).children.map((child) => child.element.name);
        const totalRows = Number(metadata.num_rows);
        const columns = keptColumns(header, options);
        if ("missing" in columns) return { kind: "missing_columns", missing: columns.missing, columns: header };
        const range = rowRange(totalRows, options);
        const cells = (range.end - range.start) * columns.kept.length;
        if (cells > options.cellBudget) return { kind: "over_budget", cells, budget: options.cellBudget, columns: header, totalRows };
        if (range.end === range.start || columns.kept.length === 0) return { kind: "rows", columns: columns.kept, rows: [], totalRows };
        const records: Array<Record<string, unknown>> = await parquetReadObjects({
            file,
            metadata,
            columns: columns.kept,
            rowStart: range.start,
            rowEnd: range.end,
            rowFormat: "object",
            utf8: true,
        });
        const rows = records.map((record) => keepCells(record, columns.kept, options.numericText));
        return { kind: "rows", columns: columns.kept, rows, totalRows };
    } catch {
        return { kind: "unparsable" };
    }
}

/**
 * Decode the bytes of one table in a decided format, with the columns, the range, and the budget of `options`. A
 * caller runs it in a decode worker (`lib/host-workers.ts`), because a table under the file cap can hold millions
 * of cells.
 */
export async function decodeTable(format: TabularFormat, bytes: Uint8Array, options: TableDecodeOptions): Promise<TableDecode> {
    if (format === "parquet") return decodeParquet(bytes, options);
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    if (format === "json") return decodeJsonTable(text, options);
    return decodeDelimited(text, format === "tsv" ? "\t" : ",", options);
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
    // The decode slot is held from before the read, thus a read that waits for a slot holds no bytes.
    const held = await withDecodeSlot(undefined, async (run) => {
        let bytes: Buffer;
        try {
            bytes = await readFile(identity.absolute);
        } catch {
            return undefined;
        }
        const buffer = transferable(bytes);
        return run({ kind: "table", bytes: buffer, path, format, options: { cellBudget: HOST_CELL_BUDGET, numericText: false } }, { transfer: [buffer] });
    });
    // With no signal, the wait for the slot ends only with the slot.
    const decoded = held.isOk() ? held.value : undefined;
    if (decoded === undefined) {
        return { kind: "fall-through", detail: "the file could not be read" };
    }
    if (decoded.isErr()) {
        return {
            kind: "fall-through",
            detail: decoded.error.kind === "out_of_memory" ? "the decode passed the memory of its worker" : PARSE_FAULT_DETAIL[format],
        };
    }
    const table = decoded.value;
    switch (table.kind) {
        case "rows":
            return { kind: "rows", rows: table.rows };
        case "over_budget":
            return { kind: "fall-through", detail: `the table holds ${table.cells} cells, over the ${table.budget}-cell budget of the host read` };
        case "unparsable":
        case "missing_columns":
        case "entry":
            return { kind: "fall-through", detail: PARSE_FAULT_DETAIL[format] };
        default: {
            const unhandled: never = table;
            throw new Error(`unhandled table decode: ${JSON.stringify(unhandled)}`);
        }
    }
}

/** The detail of a parse fault, for each format. */
const PARSE_FAULT_DETAIL: Record<TabularFormat, string> = {
    csv: "the delimited parse did not succeed",
    tsv: "the delimited parse did not succeed",
    json: "the JSON parse did not succeed",
    parquet: "the parquet read did not succeed",
};

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
        const selection = selectRow(rows, locator);
        if (selection.isErr()) {
            return fail(reference, selection.error.reason, selection.error.detail);
        }

        // A real table holds an empty cell, and a parse gives it back as an absent key. An absent key is
        // not a value that a scalar reference can bind. An empty string is a value, thus it stays valid.
        // A cell that parsed as `null` never lands in a row: `coerceCell` drops it, so `null` is not
        // an absence the resolver can meet here.
        const cell: string | number | undefined = selection.value[locator.column];
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
        return readArtifactTable(reference, gated.value);
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

    async function resolve(reference: Reference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>> {
        switch (reference.kind) {
            case "artifact-value":
                return resolveArtifactValue(reference, snapshot);
            case "artifact-table":
                return resolveArtifactTable(reference, snapshot);
            case "artifact-file":
                return resolveArtifactFile(reference, snapshot);
            case "derivation":
                return resolveDerivation(reference, snapshot, resolveArtifactValue);
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
