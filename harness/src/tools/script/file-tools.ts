/**
 * The file tools of a script: `read_table`, `read_pdf`, `write_derived`, `render_chart`, and `export_pdf`.
 *
 * The VM of `run_script` has no file system. These tools are its only reach into the workspace, thus each one is
 * the boundary. `read_table` reads through the read seam of the workspace, which confines a path to the analysis
 * of the call and refuses a symbolic link. `write_derived` and `render_chart` write only into the `derived/`
 * directory of the scratch of the session.
 *
 * A table read holds at most 16 MiB, and it gives at most {@link TABLE_CELL_BUDGET} cells. The decode runs on the host
 * in a decode worker (`lib/host-workers.ts`), thus a table that decodes past the memory of the worker fails the call
 * and not the host. A larger table, or a format with no parser here, is work for an analysis run, and the refusal
 * says so. `list_archive` lists the files of a compressed file, and
 * a read names one of them as its `entry`. A gzip-compressed table reads with no entry.
 *
 * Each tool gives the files that it read or wrote as its call record. `run_script` collects the records of the
 * calls of one script, thus the provenance of the script chains each derived file to the tables that it read.
 */

import { ok, err, type Result } from "neverthrow";
import { z } from "zod";

import type { AgentSession } from "../../auth/types.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { markdownImageSources, markdownToPdf, type PdfImage } from "../../lib/markdown-pdf.js";
import { transferable, withDecodeSlot, type HostTaskFailure } from "../../lib/host-workers.js";
import { detectFormat, type Row } from "../../report-model/production-resolver.js";
import { CHART_EXPORT_SIZES, SCATTER_CROWD_ROWS } from "../../report-render/design.js";
import { loadChartRuntime, plottedPoints, renderChartSvg } from "../../report-render/chart-export.js";
import { parseUnknownRecord, UnknownArraySchema } from "../../lib/unknown-containers.js";
import type { WorkspaceReadLineage } from "../../provenance/workspace-reads.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import { normalizeEchartSpec } from "../display/normalize-echart-spec.js";
import type { ArchiveEntryRef, HostTask, HostTaskAnswer } from "../../workspace/decode-tasks.js";
import { ARCHIVE_SCAN_CAP_BYTES, archiveKindOf, gzipEntryName, type ArchiveEntry, type EntryRefusal } from "./archive.js";
import { recordReadBytes, recordReadRefusal } from "./metrics.js";
import type { ScratchFile, ScriptRead, ScriptScratch } from "./scratch.js";

/** The cap of one table read. It matches the cap of the report path, which reads with the same parsers. */
export const TABLE_READ_CAP_BYTES = 16 * 1024 * 1024;

/** What one call of a file tool did to files. `run_script` reads it from the call record of a nested call. */
export type ScriptFileEffect = {
    readonly reads?: readonly ScriptRead[];
    readonly writes?: readonly ScratchFile[];
};

export const ScriptFileEffectSchema = z.object({
    reads: z.array(z.object({ path: z.string(), hash: z.string() })).optional(),
    writes: z.array(z.object({ path: z.string(), hash: z.string(), size: z.number() })).optional(),
});

export type ScriptFileToolsDeps = {
    readonly workspaceFs: WorkspaceFilesystem;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly scratch: ScriptScratch;
};

/** `lineage` records each read in the lineage of a step. */
type ReadScriptToolsDeps = Pick<ScriptFileToolsDeps, "workspaceFs" | "resolveWorkspaceRoot"> & { readonly lineage?: WorkspaceReadLineage };

function refused(error: string): Result<never, ToolError> {
    return err({ error, retryable: false });
}

/** The cap of the compressed file that a read of an entry reads. */
const ARCHIVE_READ_CAP_BYTES = 64 * 1024 * 1024;

/**
 * The bytes of one read: the file on disk, its hash, and the entry inside it that the read names. The decode worker
 * opens the entry, thus the main thread holds only the file.
 */
type ReadBytes = { readonly bytes: Buffer; readonly size: number; readonly hash: string; readonly archive: ArchiveEntryRef | undefined };

/** The arguments of one file read of a script tool. */
type ScriptFileRead = {
    readonly workspaceFs: WorkspaceFilesystem;
    readonly session: AgentSession;
    readonly path: string;
    readonly entry: string | undefined;
    readonly maxBytes: number;
    readonly tooLarge: string;
};

const entryInput = z
    .string()
    .min(1)
    .optional()
    .describe("The file inside a compressed file at `path` (zip, tar, tar.gz), as `list_archive` names it. Absent: `path` itself.");

/**
 * Read one file of the workspace through the read seam, and name the entry of a compressed file that the read opens.
 * A gzip-compressed file with no entry reads as its one entry. A refusal is the line that the script reads.
 */
async function readScriptFile(args: ScriptFileRead): Promise<Result<ReadBytes, string>> {
    const { path, maxBytes } = args;
    const kind = archiveKindOf(path);
    const entry = args.entry ?? (kind === "gzip" ? gzipEntryName(path) : undefined);
    if (entry !== undefined && kind === undefined) return err(`${path} is not a compressed file that a script opens (zip, tar, tar.gz, gz)`);
    const cap = kind === undefined ? maxBytes : ARCHIVE_READ_CAP_BYTES;
    const read = await args.workspaceFs.readFile({ session: args.session, path, maxBytes: cap });
    if (read.isErr()) return err(`${path} could not be read`);
    const file = read.value;
    if (file.kind === "not_found") return err(`${path} does not exist; find the path with workspace_search or list_files`);
    if (file.kind === "out_of_scope") return err(`${path} is outside this analysis`);
    if (file.kind === "truncated") {
        recordReadRefusal("too_large");
        return err(`${path} is ${String(file.totalSize)} bytes, over the ${String(cap / (1024 * 1024))} MiB cap of a script read; ${args.tooLarge}`);
    }
    const archive = kind === undefined || entry === undefined ? undefined : { kind, entry, entryCap: maxBytes };
    return ok({ bytes: file.content, size: file.content.byteLength, hash: computeSha256(file.content), archive });
}

/**
 * Read one file and decode it in a decode worker, with the decode slot held from before the read to the end of the
 * decode. A read that waits for a slot thus holds no bytes. The bytes move to the worker, thus the answer carries the
 * size and the hash of the read, and not its bytes.
 */
async function readAndDecode<T extends HostTask>(
    read: ScriptFileRead,
    signal: AbortSignal | undefined,
    taskOf: (bytes: ArrayBuffer, file: ReadBytes) => T,
): Promise<Result<{ readonly file: ReadBytes; readonly answer: HostTaskAnswer<T> }, string>> {
    const held = await withDecodeSlot(signal, async (run) => {
        const file = await readScriptFile(read);
        if (file.isErr()) return err(file.error);
        const buffer = transferable(file.value.bytes);
        const decoded = await run(taskOf(buffer, file.value), { transfer: [buffer] });
        return decoded.isErr() ? err(workerFailure(read.path, decoded.error)) : ok({ file: file.value, answer: decoded.value });
    });
    return held.isErr() ? err(`the read of ${read.path} was cancelled`) : held.value;
}

/** The line that a script reads for an entry of a compressed file that did not open. */
function entryRefusal(path: string, entry: string, maxBytes: number, refusal: EntryRefusal, tooLarge: string): string {
    switch (refusal.kind) {
        case "not_found":
            return `${path} holds no file ${entry}; list_archive gives its files`;
        case "too_large":
            recordReadRefusal("too_large");
            return `${entry} in ${path} is over the ${String(maxBytes / (1024 * 1024))} MiB cap of a script read, or its archive decompresses past ${String(ARCHIVE_SCAN_CAP_BYTES / (1024 * 1024))} MiB; ${tooLarge}`;
        case "unparsable":
            recordReadRefusal("unparsable");
            return `${path} did not open: ${refusal.detail}`;
        default: {
            const unhandled: never = refusal;
            throw new Error(`unhandled entry refusal: ${JSON.stringify(unhandled)}`);
        }
    }
}

/** The line that a script reads for a decode worker that gave no answer. */
function workerFailure(path: string, failure: HostTaskFailure): string {
    switch (failure.kind) {
        case "out_of_memory":
            recordReadRefusal("out_of_memory");
            return `${path} needs more memory to decode than a script read holds; read fewer columns with \`columns\`, or fewer rows with \`offset\` and \`limit\``;
        case "aborted":
            return `the read of ${path} was cancelled`;
        case "crashed":
            return `the decode of ${path} failed: ${failure.detail}`;
        default: {
            const unhandled: never = failure;
            throw new Error(`unhandled worker failure: ${JSON.stringify(unhandled)}`);
        }
    }
}

/** The most cells that one table read gives: the kept rows times the kept columns. */
export const TABLE_CELL_BUDGET = 500_000;

/**
 * The rows of one table, the columns that they keep, the rows of the whole table, and the hash of the file on disk
 * that held them. A read of an entry names the compressed file, thus its hash is the hash of that file.
 */
export type TableRows = { readonly hash: string; readonly columns: string[]; readonly rows: Row[]; readonly totalRows: number };

/** The line that a script reads for a table over the cell budget, with the ways to read less. */
function overBudget(path: string, cells: number, budget: number, columns: readonly string[], totalRows: number): string {
    return (
        `${path} holds ${String(totalRows)} rows and the read asks for ${String(cells)} cells, over the budget of ${String(budget)} cells of one read. ` +
        `Read less: name the columns that you need with \`columns\`, read a page of rows with \`offset\` and \`limit\`, or find a few rows with \`grep\`. ` +
        `The columns are ${columns.join(", ")}`
    );
}

/**
 * Read one table through the read seam, and decode it in a decode worker with the named columns, the range of rows,
 * and the cell budget. The bytes move to the worker, and only the kept rows come back. A refusal is the line that the
 * script reads. `tooLarge` names where a table over the file cap goes instead.
 */
export async function readTableRows(args: {
    readonly workspaceFs: WorkspaceFilesystem;
    readonly session: AgentSession;
    readonly path: string;
    readonly entry?: string;
    readonly columns: readonly string[] | undefined;
    readonly offset?: number;
    readonly limit?: number;
    readonly tooLarge: string;
    readonly signal?: AbortSignal;
}): Promise<Result<TableRows, string>> {
    const { path, columns } = args;
    const kind = archiveKindOf(path);
    const name = args.entry ?? (kind === "gzip" ? gzipEntryName(path) : path);
    const format = detectFormat(name);
    if (format === undefined) {
        recordReadRefusal("unsupported_format");
        if (kind !== undefined && kind !== "gzip" && args.entry === undefined)
            return err(`${path} is a compressed file; list_archive gives its files, and an entry names one`);
        return err(`${name} has no table format that a script reads (csv, tsv, json, parquet); an analysis run reads it`);
    }
    const decoded = await readAndDecode(
        { workspaceFs: args.workspaceFs, session: args.session, path, entry: args.entry, maxBytes: TABLE_READ_CAP_BYTES, tooLarge: args.tooLarge },
        args.signal,
        (bytes, file) => ({
            kind: "table",
            bytes,
            path,
            archive: file.archive,
            format,
            options: { columns, offset: args.offset, limit: args.limit, cellBudget: TABLE_CELL_BUDGET, numericText: true },
        }),
    );
    if (decoded.isErr()) return err(decoded.error);
    const { file, answer: table } = decoded.value;
    const { hash, archive } = file;
    switch (table.kind) {
        case "entry":
            return err(entryRefusal(path, archive?.entry ?? name, TABLE_READ_CAP_BYTES, table.refusal, args.tooLarge));
        case "unparsable":
            recordReadRefusal("unparsable");
            return err(`${name} did not parse as ${format}: a ragged row, a repeated header, or a nested JSON value`);
        case "missing_columns":
            return err(`${path} has no column ${table.missing.join(", ")}; its columns are ${table.columns.join(", ")}`);
        case "over_budget":
            recordReadRefusal("over_budget");
            return err(overBudget(path, table.cells, table.budget, table.columns, table.totalRows));
        case "rows":
            recordReadBytes(file.size);
            return ok({ hash, columns: table.columns, rows: table.rows, totalRows: table.totalRows });
        default: {
            const unhandled: never = table;
            throw new Error(`unhandled table decode: ${JSON.stringify(unhandled)}`);
        }
    }
}

const readTableInput = z.object({
    path: z.string().min(1).describe("Analysis-rooted path of the table, for example 'runs/<runId>/<stepId>/output/de_results.csv'."),
    entry: entryInput,
    columns: z.array(z.string()).min(1).optional().describe("Keep only these columns. Absent: each column."),
    offset: z.number().int().min(0).optional().describe("The first row to read, 0-based. Absent: 0."),
    limit: z.number().int().min(1).optional().describe("The most rows to read. Absent: each row from `offset`."),
});

export const ReadTableOutputSchema = z.object({
    path: z.string(),
    columns: z.array(z.string()).readonly(),
    rowCount: z.number().describe("The rows that this read gives."),
    totalRows: z.number().describe("The rows of the whole table."),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).readonly(),
});

const WrittenOutputSchema = z.object({ path: z.string().describe("The analysis-rooted path of the written file."), bytes: z.number() });

type ReadTableOutput = WithToolCallRecord<
    {
        readonly path: string;
        readonly columns: readonly string[];
        readonly rowCount: number;
        readonly totalRows: number;
        readonly rows: readonly Record<string, string | number>[];
    },
    ScriptFileEffect
>;

function createReadTableTool(deps: ReadScriptToolsDeps): Tool<z.infer<typeof readTableInput>, ReadTableOutput> {
    const { lineage } = deps;
    return defineTool({
        id: "read_table",
        concurrent: true,
        description:
            "Read one table of the workspace as rows: CSV, TSV, JSON (an array of flat objects), or parquet, up to 16 MiB. " +
            "Each row is an object keyed by column, and a cell that holds a plain number reads as a number. " +
            `One read gives at most ${TABLE_CELL_BUDGET.toLocaleString("en-US")} cells (rows times columns): name the columns that you need, and read a large table in pages with \`offset\` and \`limit\`. ` +
            "A gzip-compressed table reads as it is, and `entry` reads one table inside a zip or a tar. " +
            "A larger table, or another format such as h5ad, is work for an analysis run.",
        inputSchema: readTableInput,
        outputSchema: ReadTableOutputSchema,
        view: "none",
        describeCall: ({ path, entry }) => (entry === undefined ? path : `${path} : ${entry}`),
        describeResult: (_input, result) => `${String(result.rowCount)} rows`,
        foldCallRecord: lineage === undefined ? undefined : (effect: ScriptFileEffect) => lineage.track(effect.reads ?? []),
        execute: async ({ path, entry, columns, offset, limit }, ctx): Promise<Result<ReadTableOutput, ToolError>> => {
            const table = await readTableRows({
                workspaceFs: deps.workspaceFs,
                session: ctx.session,
                path,
                entry,
                columns,
                offset,
                limit,
                tooLarge: "an analysis run reads it",
                signal: ctx.signal,
            });
            if (table.isErr()) return refused(table.error);
            const { hash, rows, totalRows } = table.value;
            const { analysisId } = ctx.session.scope;
            const resolved = resolveWorkspacePath({ workspaceRoot: await deps.resolveWorkspaceRoot(analysisId), analysisId, path });
            const relative = resolved.kind === "ok" ? resolved.relative.split("\\").join("/") : path;
            const effect: ScriptFileEffect = { reads: [{ path: relative, hash }] };
            return ok(withToolCallRecord({ path: relative, columns: table.value.columns, rowCount: rows.length, totalRows, rows }, effect));
        },
    });
}

const listArchiveInput = z.object({
    path: z.string().min(1).describe("Analysis-rooted path of a compressed file: .zip, .tar, .tar.gz, .tgz, or .gz."),
});

const ListArchiveOutputSchema = z.object({
    path: z.string(),
    entries: z.array(z.object({ name: z.string(), bytes: z.number() })).readonly(),
});

type ListArchiveOutput = WithToolCallRecord<{ readonly path: string; readonly entries: readonly ArchiveEntry[] }, ScriptFileEffect>;

function createListArchiveTool(deps: ReadScriptToolsDeps): Tool<z.infer<typeof listArchiveInput>, ListArchiveOutput> {
    const { lineage } = deps;
    return defineTool({
        id: "list_archive",
        concurrent: true,
        description:
            "List the files inside a compressed file of the workspace (zip, tar, tar.gz, gz), each with its decompressed size. " +
            "`read_table` and `read_pdf` then read one of them as their `entry`.",
        inputSchema: listArchiveInput,
        outputSchema: ListArchiveOutputSchema,
        view: "none",
        describeCall: ({ path }) => path,
        describeResult: (_input, result) => `${String(result.entries.length)} files`,
        foldCallRecord: lineage === undefined ? undefined : (effect: ScriptFileEffect) => lineage.track(effect.reads ?? []),
        execute: async ({ path }, ctx): Promise<Result<ListArchiveOutput, ToolError>> => {
            const kind = archiveKindOf(path);
            if (kind === undefined) {
                recordReadRefusal("unsupported_format");
                return refused(`${path} is not a compressed file that a script opens (zip, tar, tar.gz, gz)`);
            }
            const listed = await readAndDecode(
                {
                    workspaceFs: deps.workspaceFs,
                    session: ctx.session,
                    path,
                    entry: undefined,
                    maxBytes: ARCHIVE_READ_CAP_BYTES,
                    tooLarge: "an analysis run opens it",
                },
                ctx.signal,
                (bytes) => ({ kind: "archive-list", bytes, path, archive: kind }),
            );
            if (listed.isErr()) return refused(listed.error);
            const { hash } = listed.value.file;
            const { answer } = listed.value;
            if (answer.kind === "entry") {
                const { refusal } = answer;
                if (refusal.kind === "too_large") {
                    recordReadRefusal("too_large");
                    return refused(`${path} decompresses past ${String(ARCHIVE_SCAN_CAP_BYTES / (1024 * 1024))} MiB; an analysis run opens it`);
                }
                recordReadRefusal("unparsable");
                return refused(`${path} did not open${refusal.kind === "unparsable" ? `: ${refusal.detail}` : ""}`);
            }
            const { analysisId } = ctx.session.scope;
            const resolved = resolveWorkspacePath({ workspaceRoot: await deps.resolveWorkspaceRoot(analysisId), analysisId, path });
            const relative = resolved.kind === "ok" ? resolved.relative.split("\\").join("/") : path;
            const effect: ScriptFileEffect = { reads: [{ path: relative, hash }] };
            return ok(withToolCallRecord({ path: relative, entries: answer.entries }, effect));
        },
    });
}

/** The cap of one PDF read, and the pages that one call reads. */
const PDF_READ_CAP_BYTES = 64 * 1024 * 1024;
const PDF_PAGES_PER_READ = 50;

const readPdfInput = z.object({
    path: z.string().min(1).describe("Analysis-rooted path of the PDF, for example 'data/inputs/<fileId>/paper.pdf'."),
    entry: entryInput,
    firstPage: z.number().int().min(1).optional().describe("The first page to read, 1-based. Absent: 1."),
    lastPage: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`The last page to read. One call reads at most ${String(PDF_PAGES_PER_READ)} pages. Absent: as many as that cap allows.`),
});

const ReadPdfOutputSchema = z.object({
    path: z.string(),
    totalPages: z.number(),
    pages: z.array(z.object({ page: z.number(), text: z.string() })).readonly(),
});

type ReadPdfOutput = WithToolCallRecord<z.infer<typeof ReadPdfOutputSchema>, ScriptFileEffect>;

export function createReadPdfTool(deps: ReadScriptToolsDeps): Tool<z.infer<typeof readPdfInput>, ReadPdfOutput> {
    const { lineage } = deps;
    return defineTool({
        id: "read_pdf",
        concurrent: true,
        description:
            `Read the text of a PDF of the workspace page by page, up to 64 MiB and ${String(PDF_PAGES_PER_READ)} pages for each call. ` +
            "`totalPages` gives the page count, thus a script reads a long PDF in more calls and keeps the pages that it needs. " +
            "A scanned page with no text layer reads as an empty text.",
        inputSchema: readPdfInput,
        outputSchema: ReadPdfOutputSchema,
        view: "none",
        describeCall: ({ path, entry, firstPage, lastPage }) => {
            const file = entry === undefined ? path : `${path} : ${entry}`;
            return firstPage === undefined && lastPage === undefined ? file : `${file}, pages ${String(firstPage ?? 1)}-${String(lastPage ?? "")}`;
        },
        describeResult: (_input, result) => `${String(result.pages.length)} of ${String(result.totalPages)} pages`,
        // `run_script` folds the record of a nested call only into a tool that folds records.
        foldCallRecord: lineage === undefined ? undefined : (effect: ScriptFileEffect) => lineage.track(effect.reads ?? []),
        execute: async ({ path, entry, firstPage, lastPage }, ctx): Promise<Result<ReadPdfOutput, ToolError>> => {
            const kind = archiveKindOf(path);
            const name = entry ?? (kind === "gzip" ? gzipEntryName(path) : path);
            if (!name.toLowerCase().endsWith(".pdf")) {
                recordReadRefusal("unsupported_format");
                if (kind !== undefined && kind !== "gzip" && entry === undefined)
                    return refused(`${path} is a compressed file; list_archive gives its files, and an entry names one`);
                return refused(`${name} is not a PDF; read_table reads a table, and read_file reads text`);
            }
            const first = firstPage ?? 1;
            const last = Math.min(lastPage ?? first + PDF_PAGES_PER_READ - 1, first + PDF_PAGES_PER_READ - 1);
            const decoded = await readAndDecode(
                { workspaceFs: deps.workspaceFs, session: ctx.session, path, entry, maxBytes: PDF_READ_CAP_BYTES, tooLarge: "an analysis run reads it" },
                ctx.signal,
                (bytes, file) => ({ kind: "pdf-text", bytes, path, archive: file.archive, first, last }),
            );
            if (decoded.isErr()) return refused(decoded.error);
            const { file, answer } = decoded.value;
            const { hash, archive } = file;
            if (answer.kind === "entry")
                return refused(entryRefusal(path, archive?.entry ?? path, PDF_READ_CAP_BYTES, answer.refusal, "an analysis run reads it"));
            if (answer.kind === "unreadable") {
                recordReadRefusal("unparsable");
                return refused(`${path} did not open as a PDF: a damaged file, or a file with a password`);
            }
            const { text } = answer;
            recordReadBytes(file.size);
            const { analysisId } = ctx.session.scope;
            const resolved = resolveWorkspacePath({ workspaceRoot: await deps.resolveWorkspaceRoot(analysisId), analysisId, path });
            const relative = resolved.kind === "ok" ? resolved.relative.split("\\").join("/") : path;
            const effect: ScriptFileEffect = { reads: [{ path: relative, hash }] };
            return ok(withToolCallRecord({ path: relative, totalPages: text.totalPages, pages: text.pages }, effect));
        },
    });
}

/** One cell as delimited text: quoted when it holds the delimiter, a quote, or a line break. */
function delimitedCell(value: string | number | boolean | null | undefined, delimiter: string): string {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (!text.includes(delimiter) && !text.includes('"') && !text.includes("\n") && !text.includes("\r")) return text;
    return `"${text.replaceAll('"', '""')}"`;
}

export type Cell = string | number | boolean | null;

/** The rows as CSV or TSV: the header is each key in the order of its first row, then one line for each row. */
function delimitedText(rows: readonly Record<string, Cell>[], delimiter: string): string {
    const header = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const lines = [header.map((name) => delimitedCell(name, delimiter)).join(delimiter)];
    for (const row of rows) lines.push(header.map((name) => delimitedCell(row[name], delimiter)).join(delimiter));
    return `${lines.join("\n")}\n`;
}

/** The text of `rows` in the format that the extension of `name` names, or `undefined` for another extension. */
export function rowsText(name: string, rows: readonly Record<string, Cell>[]): string | undefined {
    const lower = name.toLowerCase();
    if (lower.endsWith(".csv")) return delimitedText(rows, ",");
    if (lower.endsWith(".tsv")) return delimitedText(rows, "\t");
    if (lower.endsWith(".json")) return `${JSON.stringify(rows, null, 2)}\n`;
    return undefined;
}

const writeDerivedInput = z.object({
    name: z.string().min(1).describe("One file name, for example 'de_top50.csv'. With `rows`, the extension picks the format: .csv, .tsv, or .json."),
    content: z.string().optional().describe("The text of the file. Give `content` or `rows`."),
    rows: z
        .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
        .optional()
        .describe("Table rows, each an object keyed by column. Give `content` or `rows`."),
});

type WrittenOutput = WithToolCallRecord<{ readonly path: string; readonly bytes: number }, ScriptFileEffect>;

function written(file: ScratchFile): WrittenOutput {
    return withToolCallRecord({ path: file.path, bytes: file.size }, { writes: [file] });
}

function createWriteDerivedTool(deps: ScriptFileToolsDeps): Tool<z.infer<typeof writeDerivedInput>, WrittenOutput> {
    return defineTool({
        id: "write_derived",
        description:
            "Save a file that the script derived, in the derived directory of this conversation, and show it to the user. " +
            "The file lands in that directory only, never at a path that the user names: for such a path, return the content and write it with `write_file`. " +
            "A name holds one file: a second write of the name with other content is refused.",
        inputSchema: writeDerivedInput,
        outputSchema: WrittenOutputSchema,
        view: "none",
        describeCall: ({ name }) => name,
        describeResult: (_input, result) => result.path,
        execute: async ({ name, content, rows }, ctx): Promise<Result<WrittenOutput, ToolError>> => {
            if ((content === undefined) === (rows === undefined)) return refused("give exactly one of `content` and `rows`");
            const text = rows === undefined ? content : rowsText(name, rows);
            if (text === undefined) return refused(`${name} names no table format: with rows, end the name in .csv, .tsv, or .json`);
            const write = await deps.scratch.writeDerived({ session: ctx.session, invocationId: ctx.invocationId, name, content: text });
            if (write.status === "refused") return refused(write.reason);
            return ok(written(write.file));
        },
    });
}

const renderChartInput = z.object({
    name: z.string().min(1).describe("File name of the SVG, for example 'volcano.svg'."),
    spec: z
        .record(z.string(), z.unknown())
        .describe("ECharts option, the same as `show_user` takes, with the rows inline in `dataset.source` or `series[].data`."),
    width: z.enum(["single", "double"]).optional().describe("Journal column: single (89 mm) or double (183 mm). Default double."),
});

/** The rows of `dataset.source` of an option, or of each dataset of a list. A chart from a dataset plots each one. */
function datasetRows(spec: Record<string, unknown>): number {
    const datasets = UnknownArraySchema.safeParse(spec.dataset);
    const list = datasets.success ? datasets.data : [spec.dataset];
    let count = 0;
    for (const dataset of list) {
        const source = UnknownArraySchema.safeParse(parseUnknownRecord(dataset)?.source);
        if (source.success) count += source.data.length;
    }
    return count;
}

function createRenderChartTool(deps: ScriptFileToolsDeps): Tool<z.infer<typeof renderChartInput>, WrittenOutput> {
    return defineTool({
        id: "render_chart",
        description:
            "Render an ECharts option to an SVG file at a journal column width, in the derived directory of this conversation, for a document. " +
            "To show a chart in the chat, use `show_user`.",
        inputSchema: renderChartInput,
        outputSchema: WrittenOutputSchema,
        view: "none",
        describeCall: ({ name }) => name,
        describeResult: (_input, result) => result.path,
        execute: async ({ name, spec, width }, ctx): Promise<Result<WrittenOutput, ToolError>> => {
            const fileName = name.toLowerCase().endsWith(".svg") ? name : `${name}.svg`;
            const option = normalizeEchartSpec(spec);
            const points = plottedPoints(option) + datasetRows(option);
            if (points > SCATTER_CROWD_ROWS) {
                return refused(`the chart draws ${String(points)} points, and an SVG file holds at most ${String(SCATTER_CROWD_ROWS)}; plot fewer points`);
            }
            const svg = renderChartSvg(await loadChartRuntime(), option, CHART_EXPORT_SIZES[width ?? "double"]);
            if (svg.isErr()) return refused(`the chart runtime refused the option: ${svg.error}`);
            const write = await deps.scratch.writeDerived({ session: ctx.session, invocationId: ctx.invocationId, name: fileName, content: svg.value });
            if (write.status === "refused") return refused(write.reason);
            return ok(written(write.file));
        },
    });
}

/** The file tools of a script, over one scratch directory. */
/** The cap of one image that a PDF embeds, and the cap of the markdown of one PDF. */
const PDF_IMAGE_CAP_BYTES = 16 * 1024 * 1024;
const PDF_MARKDOWN_CAP_CHARS = 1_000_000;

const exportPdfInput = z.object({
    name: z.string().min(1).describe("File name of the PDF, for example 'summary.pdf'."),
    markdown: z
        .string()
        .max(PDF_MARKDOWN_CAP_CHARS)
        .describe(
            "The document as markdown: headings, paragraphs, lists, tables, code, quotes, and images. An image names an SVG, PNG, or JPEG file of the workspace " +
                "by its analysis-rooted path, for example the path that `render_chart` gives; a chart SVG lands as vector graphics.",
        ),
    title: z.string().optional().describe("The title on the first page and in the metadata of the PDF."),
});

const ExportPdfOutputSchema = WrittenOutputSchema.extend({
    missingImages: z.array(z.string()).describe("Each image that the PDF shows as its alt text, because no such file of the workspace was readable."),
});

type ExportPdfOutput = WithToolCallRecord<z.infer<typeof ExportPdfOutputSchema>, ScriptFileEffect>;

const IMAGE_KINDS: Readonly<Record<string, "svg" | "png" | "jpeg">> = { ".svg": "svg", ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" };

function imageKindOf(path: string): "svg" | "png" | "jpeg" | undefined {
    const dot = path.lastIndexOf(".");
    return dot === -1 ? undefined : IMAGE_KINDS[path.slice(dot).toLowerCase()];
}

/** What the document tools of a script need. `imageScope` limits the images of a PDF to one directory of a session. */
export type DocumentToolsDeps = ScriptFileToolsDeps & {
    readonly imageScope?: (session: AgentSession) => string | undefined;
};

function createExportPdfTool(deps: DocumentToolsDeps): Tool<z.infer<typeof exportPdfInput>, ExportPdfOutput> {
    return defineTool({
        id: "export_pdf",
        description:
            "Make a PDF from markdown, in the derived directory of this conversation, and show it to the user. " +
            "Charts that `render_chart` wrote can appear in it as images. The PDF reads no URL.",
        inputSchema: exportPdfInput,
        outputSchema: ExportPdfOutputSchema,
        view: "none",
        describeCall: ({ name }) => name,
        describeResult: (_input, result) => result.path,
        execute: async ({ name, markdown, title }, ctx): Promise<Result<ExportPdfOutput, ToolError>> => {
            const fileName = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
            const { analysisId } = ctx.session.scope;
            const workspaceRoot = await deps.resolveWorkspaceRoot(analysisId);
            const images = new Map<string, PdfImage>();
            const reads: ScriptRead[] = [];
            const missingImages: string[] = [];
            const scope = deps.imageScope?.(ctx.session);
            for (const source of markdownImageSources(markdown)) {
                const kind = scope !== undefined && !source.startsWith(`${scope}/`) ? undefined : imageKindOf(source);
                const read =
                    kind === undefined ? undefined : await deps.workspaceFs.readFile({ session: ctx.session, path: source, maxBytes: PDF_IMAGE_CAP_BYTES });
                const file = read?.isOk() === true ? read.value : undefined;
                if (kind === undefined || file?.kind !== "ok") {
                    missingImages.push(source);
                    continue;
                }
                images.set(source, kind === "svg" ? { kind, svg: file.content.toString("utf8") } : { kind, bytes: file.content });
                const resolved = resolveWorkspacePath({ workspaceRoot, analysisId, path: source });
                reads.push({ path: resolved.kind === "ok" ? resolved.relative.split("\\").join("/") : source, hash: computeSha256(file.content) });
            }
            const pdf = await markdownToPdf({ markdown, title, images });
            const write = await deps.scratch.writeDerived({ session: ctx.session, invocationId: ctx.invocationId, name: fileName, content: pdf });
            if (write.status === "refused") return refused(write.reason);
            const effect: ScriptFileEffect = { reads, writes: [write.file] };
            return ok(withToolCallRecord({ path: write.file.path, bytes: write.file.size, missingImages }, effect));
        },
    });
}

export function createScriptFileTools(deps: ScriptFileToolsDeps): Tool[] {
    return [createReadTableTool(deps), createReadPdfTool(deps), createListArchiveTool(deps), createWriteDerivedTool(deps), ...createDocumentTools(deps)];
}

/** The script tools that read a table, a PDF, and the files of a compressed file of the workspace, and write nothing. */
export function createReadScriptTools(deps: ReadScriptToolsDeps): Tool[] {
    return [createReadTableTool(deps), createReadPdfTool(deps), createListArchiveTool(deps)];
}

/** The tools that make a document in a script: a chart as an SVG file, and a PDF from markdown. */
export function createDocumentTools(deps: DocumentToolsDeps): Tool[] {
    return [createRenderChartTool(deps), createExportPdfTool(deps)];
}
