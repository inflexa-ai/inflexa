/**
 * The file tools of a script: `read_table`, `read_pdf`, `write_derived`, `render_chart`, and `export_pdf`.
 *
 * The VM of `run_script` has no file system. These tools are its only reach into the workspace, thus each one is
 * the boundary. `read_table` reads through the read seam of the workspace, which confines a path to the analysis
 * of the call and refuses a symbolic link. `write_derived` and `render_chart` write only into the `derived/`
 * directory of the scratch of the session.
 *
 * A table read holds at most 16 MiB, and the parse runs on the host. A larger table, or a format with no parser
 * here, is work for an analysis run, and the refusal says so.
 *
 * Each tool gives the files that it read or wrote as its call record. `run_script` collects the records of the
 * calls of one script, thus the provenance of the script chains each derived file to the tables that it read.
 */

import { ok, err, type Result } from "neverthrow";
import { z } from "zod";

import type { AgentSession } from "../../auth/types.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { markdownImageSources, markdownToPdf, type PdfImage } from "../../lib/markdown-pdf.js";
import { readPdfText, type PdfText } from "../../lib/pdf-text.js";
import { detectFormat, parseTable, type Row } from "../../report-model/production-resolver.js";
import { CHART_EXPORT_SIZES, SCATTER_CROWD_ROWS } from "../../report-render/design.js";
import { loadChartRuntime, plottedPoints, renderChartSvg } from "../../report-render/chart-export.js";
import { parseUnknownRecord, UnknownArraySchema } from "../../lib/unknown-containers.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import { normalizeEchartSpec } from "../display/normalize-echart-spec.js";
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

function refused(error: string): Result<never, ToolError> {
    return err({ error, retryable: false });
}

/**
 * A cell of a text table as a number, when the text is a plain decimal number. A text with a leading zero, such
 * as an identifier `007`, stays text, because a number loses its zeros.
 */
function numericCell(text: string): string | number {
    if (text.length === 0 || text !== text.trim()) return text;
    const value = Number(text);
    if (!Number.isFinite(value)) return text;
    const digits = text.startsWith("-") ? text.slice(1) : text;
    if (digits.length > 1 && digits.startsWith("0") && digits[1] !== ".") return text;
    if (digits.includes("x") || digits.includes("X") || digits.includes("o") || digits.includes("b")) return text;
    return value;
}

/** The rows of one table, the bytes that they came from, and the columns that they keep. */
export type TableRows = { readonly content: Buffer; readonly columns: string[]; readonly rows: Row[] };

/**
 * Read one table through the read seam, parse it on the host, and keep the named columns. A refusal is the line
 * that the script reads. `tooLarge` names where a table over the cap goes instead.
 */
export async function readTableRows(args: {
    readonly workspaceFs: WorkspaceFilesystem;
    readonly session: AgentSession;
    readonly path: string;
    readonly columns: readonly string[] | undefined;
    readonly tooLarge: string;
}): Promise<Result<TableRows, string>> {
    const { path, columns } = args;
    const format = detectFormat(path);
    if (format === undefined) {
        recordReadRefusal("unsupported_format");
        return err(`${path} has no table format that a script reads (csv, tsv, json, parquet); an analysis run reads it`);
    }
    const read = await args.workspaceFs.readFile({ session: args.session, path, maxBytes: TABLE_READ_CAP_BYTES });
    if (read.isErr()) return err(`${path} could not be read`);
    const file = read.value;
    if (file.kind === "not_found") return err(`${path} does not exist; find the path with workspace_search or list_files`);
    if (file.kind === "out_of_scope") return err(`${path} is outside this analysis`);
    if (file.kind === "truncated") {
        recordReadRefusal("too_large");
        return err(`${path} is ${String(file.totalSize)} bytes, over the 16 MiB cap of a script read; ${args.tooLarge}`);
    }
    const parsed = await parseTable(format, file.content);
    if (parsed === undefined) {
        recordReadRefusal("unparsable");
        return err(`${path} did not parse as ${format}: a ragged row, a repeated header, or a nested JSON value`);
    }
    recordReadBytes(file.content.length);

    const header = [...new Set(parsed.flatMap((row) => Object.keys(row)))];
    const missing = (columns ?? []).filter((column) => !header.includes(column));
    if (missing.length > 0) return err(`${path} has no column ${missing.join(", ")}; its columns are ${header.join(", ")}`);
    const kept = columns === undefined ? header : [...columns];
    const rows = parsed.map((row) => {
        const out: Row = {};
        for (const column of kept) {
            const cell = row[column];
            if (cell !== undefined) out[column] = typeof cell === "string" ? numericCell(cell) : cell;
        }
        return out;
    });
    return ok({ content: file.content, columns: kept, rows });
}

const readTableInput = z.object({
    path: z.string().min(1).describe("Analysis-rooted path of the table, for example 'runs/<runId>/<stepId>/output/de_results.csv'."),
    columns: z.array(z.string()).min(1).optional().describe("Keep only these columns. Absent: each column."),
});

export const ReadTableOutputSchema = z.object({
    path: z.string(),
    columns: z.array(z.string()).readonly(),
    rowCount: z.number(),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).readonly(),
});

const WrittenOutputSchema = z.object({ path: z.string().describe("The analysis-rooted path of the written file."), bytes: z.number() });

type ReadTableOutput = WithToolCallRecord<
    { readonly path: string; readonly columns: readonly string[]; readonly rowCount: number; readonly rows: readonly Record<string, string | number>[] },
    ScriptFileEffect
>;

function createReadTableTool(deps: Pick<ScriptFileToolsDeps, "workspaceFs" | "resolveWorkspaceRoot">): Tool<z.infer<typeof readTableInput>, ReadTableOutput> {
    return defineTool({
        id: "read_table",
        description:
            "Read one table of the workspace as rows: CSV, TSV, JSON (an array of flat objects), or parquet, up to 16 MiB. " +
            "Each row is an object keyed by column, and a cell that holds a plain number reads as a number. " +
            "A larger table, or another format such as h5ad, is work for an analysis run.",
        inputSchema: readTableInput,
        outputSchema: ReadTableOutputSchema,
        describeCall: ({ path }) => path,
        describeResult: (_input, result) => `${String(result.rowCount)} rows`,
        execute: async ({ path, columns }, ctx): Promise<Result<ReadTableOutput, ToolError>> => {
            const table = await readTableRows({ workspaceFs: deps.workspaceFs, session: ctx.session, path, columns, tooLarge: "an analysis run reads it" });
            if (table.isErr()) return refused(table.error);
            const { content, rows } = table.value;
            const { analysisId } = ctx.session.scope;
            const resolved = resolveWorkspacePath({ workspaceRoot: await deps.resolveWorkspaceRoot(analysisId), analysisId, path });
            const relative = resolved.kind === "ok" ? resolved.relative.split("\\").join("/") : path;
            const effect: ScriptFileEffect = { reads: [{ path: relative, hash: computeSha256(content) }] };
            return ok(withToolCallRecord({ path: relative, columns: table.value.columns, rowCount: rows.length, rows }, effect));
        },
    });
}

/** The cap of one PDF read, and the pages that one call reads. */
const PDF_READ_CAP_BYTES = 64 * 1024 * 1024;
const PDF_PAGES_PER_READ = 50;

const readPdfInput = z.object({
    path: z.string().min(1).describe("Analysis-rooted path of the PDF, for example 'data/inputs/<fileId>/paper.pdf'."),
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

export function createReadPdfTool(deps: Pick<ScriptFileToolsDeps, "workspaceFs" | "resolveWorkspaceRoot">): Tool<z.infer<typeof readPdfInput>, ReadPdfOutput> {
    return defineTool({
        id: "read_pdf",
        description:
            `Read the text of a PDF of the workspace page by page, up to 64 MiB and ${String(PDF_PAGES_PER_READ)} pages for each call. ` +
            "`totalPages` gives the page count, thus a script reads a long PDF in more calls and keeps the pages that it needs. " +
            "A scanned page with no text layer reads as an empty text.",
        inputSchema: readPdfInput,
        outputSchema: ReadPdfOutputSchema,
        describeCall: ({ path, firstPage, lastPage }) =>
            firstPage === undefined && lastPage === undefined ? path : `${path}, pages ${String(firstPage ?? 1)}-${String(lastPage ?? "")}`,
        describeResult: (_input, result) => `${String(result.pages.length)} of ${String(result.totalPages)} pages`,
        execute: async ({ path, firstPage, lastPage }, ctx): Promise<Result<ReadPdfOutput, ToolError>> => {
            if (!path.toLowerCase().endsWith(".pdf")) {
                recordReadRefusal("unsupported_format");
                return refused(`${path} is not a PDF; read_table reads a table, and read_file reads text`);
            }
            const read = await deps.workspaceFs.readFile({ session: ctx.session, path, maxBytes: PDF_READ_CAP_BYTES });
            if (read.isErr()) return refused(`${path} could not be read`);
            const file = read.value;
            if (file.kind === "not_found") return refused(`${path} does not exist; find the path with workspace_search or list_files`);
            if (file.kind === "out_of_scope") return refused(`${path} is outside this analysis`);
            if (file.kind === "truncated") {
                recordReadRefusal("too_large");
                return refused(`${path} is ${String(file.totalSize)} bytes, over the 64 MiB cap of a PDF read`);
            }
            const first = firstPage ?? 1;
            const last = Math.min(lastPage ?? first + PDF_PAGES_PER_READ - 1, first + PDF_PAGES_PER_READ - 1);
            let text: PdfText;
            try {
                text = await readPdfText(file.content, { first, last });
            } catch {
                recordReadRefusal("unparsable");
                return refused(`${path} did not open as a PDF: a damaged file, or a file with a password`);
            }
            recordReadBytes(file.content.length);
            const { analysisId } = ctx.session.scope;
            const resolved = resolveWorkspacePath({ workspaceRoot: await deps.resolveWorkspaceRoot(analysisId), analysisId, path });
            const relative = resolved.kind === "ok" ? resolved.relative.split("\\").join("/") : path;
            const effect: ScriptFileEffect = { reads: [{ path: relative, hash: computeSha256(file.content) }] };
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
    return [createReadTableTool(deps), createReadPdfTool(deps), createWriteDerivedTool(deps), ...createDocumentTools(deps)];
}

/** The script tools that read a table and a PDF of the workspace, and write nothing. */
export function createReadScriptTools(deps: Pick<ScriptFileToolsDeps, "workspaceFs" | "resolveWorkspaceRoot">): Tool[] {
    return [createReadTableTool(deps), createReadPdfTool(deps)];
}

/** The tools that make a document in a script: a chart as an SVG file, and a PDF from markdown. */
export function createDocumentTools(deps: DocumentToolsDeps): Tool[] {
    return [createRenderChartTool(deps), createExportPdfTool(deps)];
}
