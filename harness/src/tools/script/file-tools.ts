/**
 * The file tools of a script: `read_table`, `write_derived`, and `render_chart`.
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

type ReadTableOutput = WithToolCallRecord<
    { readonly path: string; readonly columns: readonly string[]; readonly rowCount: number; readonly rows: readonly Record<string, string | number>[] },
    ScriptFileEffect
>;

function createReadTableTool(deps: ScriptFileToolsDeps): Tool<z.infer<typeof readTableInput>, ReadTableOutput> {
    return defineTool({
        id: "read_table",
        description:
            "Read one table of the workspace as rows: CSV, TSV, JSON (an array of flat objects), or parquet, up to 16 MiB. " +
            "Each row is an object keyed by column, and a cell that holds a plain number reads as a number. " +
            "A larger table, or another format such as h5ad, is work for an analysis run.",
        inputSchema: readTableInput,
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
export function createScriptFileTools(deps: ScriptFileToolsDeps): Tool[] {
    return [createReadTableTool(deps), createWriteDerivedTool(deps), createRenderChartTool(deps)];
}
