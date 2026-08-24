/**
 * Prefix-sufficient header readouts.
 *
 * Most of what a header says sits at the front of the file: the magic bytes, a
 * declared `##` preamble, a delimited header row, the first records. Reading that
 * costs one bounded prefix and no parser over the whole file, so it runs here in
 * the harness process rather than in a container.
 *
 * Every function below is pure over a `Buffer` — the I/O is the caller's (see
 * `enrich.ts`), which is what makes the whole surface testable from synthetic bytes.
 */

import { constants as zlibConstants, createGunzip, createZstdDecompress } from "node:zlib";
import type { Transform } from "node:stream";

/** Bytes read from each file. The readout's whole per-file I/O budget. */
export const READOUT_PREFIX_BYTES = 262_144;

/** Cap on the text window a readout inspects, whether decompressed or raw. */
export const READOUT_TEXT_BYTES = 262_144;

/** Header lines scanned for a format's declared metadata. */
const MAX_META_LINES = 200;
const MAX_COLUMNS_REPORTED = 12;
const MAX_COLUMN_NAME_CHARS = 24;
const MAX_FIELD_CHARS = 200;
const MAX_LINE_CHARS = 120;
const MAX_RECORD_CHARS = 80;
/** Window scanned for a NUL byte before the prefix is called binary. */
const BINARY_SNIFF_BYTES = 4096;

export type ReadoutFields = Record<string, string | number | boolean>;

export interface PrefixReadout {
    readonly fields: ReadoutFields;
    /** Why the fields are thin or empty. Present alongside whatever WAS read. */
    readonly unavailable?: string;
}

/**
 * Read what a bounded prefix can say about a file.
 *
 * `wrapper` is the compression the scan already identified from these same bytes
 * (see `formats.ts`); it is reported alongside the inner readout, never in place
 * of it.
 */
export async function readPrefix(args: { readonly prefix: Buffer; readonly format: string; readonly wrapper?: string }): Promise<PrefixReadout> {
    const { prefix, format, wrapper } = args;
    if (prefix.length === 0) return { fields: {}, unavailable: "file is empty" };
    if (wrapper === undefined) return decodeText(prefix, format);

    const inner = await decompressBounded(prefix, wrapper);
    if (inner === undefined) return { fields: { wrapper }, unavailable: `${wrapper} has no in-process prefix decoder` };
    if (inner.length === 0) return { fields: { wrapper }, unavailable: `${wrapper} prefix did not decompress` };
    return withWrapper(containerFields(inner) ?? decodeText(inner, format), wrapper);
}

function withWrapper(readout: PrefixReadout, wrapper: string): PrefixReadout {
    return { ...readout, fields: { ...readout.fields, wrapper } };
}

/**
 * Decompress a prefix, tolerating the truncated tail that a prefix always has.
 *
 * `Z_SYNC_FLUSH` as the finish flush is what makes the cut-off member yield its
 * decoded bytes instead of an error, and the output cap is what keeps a highly
 * compressible prefix from expanding without bound.
 */
async function decompressBounded(raw: Buffer, wrapper: string): Promise<Buffer | undefined> {
    const stream = decompressorFor(wrapper);
    if (stream === undefined) return undefined;
    return await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            stream.removeAllListeners();
            stream.destroy();
            resolve(Buffer.concat(chunks).subarray(0, READOUT_TEXT_BYTES));
        };
        stream.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total >= READOUT_TEXT_BYTES) finish();
        });
        stream.on("end", finish);
        stream.on("close", finish);
        stream.on("error", finish);
        stream.end(raw);
    });
}

function decompressorFor(wrapper: string): Transform | undefined {
    if (wrapper === "gzip" || wrapper === "bgzip") return createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
    if (wrapper === "zstd") return createZstdDecompress();
    return undefined;
}

/**
 * The two bioinformatics containers whose payload is binary but whose header is a
 * plain text block at a known offset — so a prefix reaches them and no container
 * parser is needed.
 */
function containerFields(inner: Buffer): PrefixReadout | undefined {
    if (inner.length >= 8 && inner.subarray(0, 4).toString("latin1") === "BAM\u0001") {
        const textLength = inner.readInt32LE(4);
        const header = inner.subarray(8, 8 + Math.min(Math.max(textLength, 0), READOUT_TEXT_BYTES)).toString("utf8");
        const readout = textFields(header, "sam");
        return { ...readout, fields: { ...readout.fields, container: "bam" } };
    }
    if (inner.subarray(0, 3).toString("latin1") === "BCF") return { fields: { container: "bcf" } };
    return undefined;
}

function decodeText(buf: Buffer, format: string): PrefixReadout {
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { fields: {}, unavailable: "binary content with no prefix-readable header" };
    return textFields(buf.subarray(0, READOUT_TEXT_BYTES).toString("utf8"), format);
}

function textFields(text: string, format: string): PrefixReadout {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    const head = lines[0];
    if (head === undefined) return { fields: {}, unavailable: "no text in the prefix" };

    if (format === "markdown") return markdownFields(lines);
    if (format === "json" || head.startsWith("{") || head.startsWith("[")) return jsonFields(text, lines);
    if (format === "yaml" || head.trim() === "---") return yamlFields(lines);
    if (head.startsWith("##")) return metaHeaderFields(lines);
    if (head.startsWith(">")) return { fields: { firstRecord: clip(head.slice(1), MAX_RECORD_CHARS), recordsInPrefix: countPrefixed(lines, ">") } };
    if (head.startsWith("@HD") || head.startsWith("@SQ")) return samFields(lines);
    if (head.startsWith("@") && lines.length > 1) return { fields: { firstRecord: clip(head.slice(1), MAX_RECORD_CHARS), readLength: lines[1]!.length } };
    return delimitedFields(lines) ?? { fields: { firstLine: clip(head, MAX_LINE_CHARS), linesInPrefix: lines.length } };
}

/**
 * The `##` preamble VCF, GFF, and their relatives declare.
 *
 * Where the preamble carries no column line of its own, the first data line is
 * sniffed as a delimited row: a GFF's nine columns are a fact about the file that
 * a meta-line count alone does not carry.
 */
function metaHeaderFields(lines: readonly string[]): PrefixReadout {
    const fields: ReadoutFields = {};
    let sawColumns = false;
    for (const line of lines.slice(0, MAX_META_LINES)) {
        if (line.startsWith("##fileformat=")) fields.fileformat = clip(line.slice("##fileformat=".length), 40);
        else if (line.startsWith("##gff-version")) fields.gffVersion = clip(line.slice("##gff-version".length), 20);
        else if (line.startsWith("##reference=")) fields.reference = clip(line.slice("##reference=".length), 80);
        else if (line.startsWith("#CHROM")) {
            const samples = line.split("\t").slice(9);
            fields.sampleCount = samples.length;
            fields.samples = clip(samples.slice(0, 5).join(", "), MAX_FIELD_CHARS);
            sawColumns = true;
            break;
        }
    }
    fields.metaLines = countPrefixed(lines, "##");
    if (!sawColumns) {
        const delimited = delimitedFields(lines);
        if (delimited) return { fields: { ...fields, ...delimited.fields } };
    }
    return { fields };
}

function samFields(lines: readonly string[]): PrefixReadout {
    const fields: ReadoutFields = {
        referenceSequences: countPrefixed(lines, "@SQ"),
        readGroups: countPrefixed(lines, "@RG"),
    };
    const sortOrder = /(?:^|\t)SO:([^\t]+)/.exec(lines.find((line) => line.startsWith("@HD")) ?? "");
    if (sortOrder) fields.sortOrder = clip(sortOrder[1]!, 20);
    return { fields };
}

const DELIMITERS: readonly { readonly char: string; readonly name: string }[] = [
    { char: ",", name: "comma" },
    { char: "\t", name: "tab" },
    { char: ";", name: "semicolon" },
    { char: "|", name: "pipe" },
];

function sniffDelimiter(line: string): { readonly char: string; readonly name: string } | undefined {
    let best: { readonly char: string; readonly name: string } | undefined;
    let bestCount = 0;
    for (const candidate of DELIMITERS) {
        const count = line.split(candidate.char).length - 1;
        if (count > bestCount) {
            best = candidate;
            bestCount = count;
        }
    }
    return best;
}

/**
 * The delimited-text readout: which separator, which row carries the column names,
 * and what those names are. The header row is found past any comment preamble, so a
 * `#`-commented TSV reports its columns rather than its first comment line.
 */
function delimitedFields(lines: readonly string[]): PrefixReadout | undefined {
    const headerIndex = lines.findIndex((line) => !line.startsWith("#"));
    if (headerIndex < 0) return undefined;
    const header = lines[headerIndex]!;
    const delimiter = sniffDelimiter(header);
    if (delimiter === undefined) return undefined;

    const columns = splitDelimited(header, delimiter.char).map((cell) => cell.trim());
    const fields: ReadoutFields = {
        delimiter: delimiter.name,
        columnCount: columns.length,
        columns: clip(
            columns
                .slice(0, MAX_COLUMNS_REPORTED)
                .map((cell) => cell.slice(0, MAX_COLUMN_NAME_CHARS))
                .join(", "),
            MAX_FIELD_CHARS,
        ),
        headerRow: looksLikeHeader(columns),
        linesInPrefix: lines.length,
    };
    if (headerIndex > 0) fields.commentLines = headerIndex;
    return { fields };
}

/** Distinct, mostly non-numeric cells name columns; a row of numbers is data. */
function looksLikeHeader(columns: readonly string[]): boolean {
    if (columns.length === 0) return false;
    const numeric = columns.filter((cell) => cell !== "" && Number.isFinite(Number(cell))).length;
    return new Set(columns).size === columns.length && numeric * 2 < columns.length;
}

function splitDelimited(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index]!;
        if (quoted) {
            if (char !== '"') current += char;
            else if (line[index + 1] === '"') {
                current += '"';
                index++;
            } else quoted = false;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === delimiter) {
            cells.push(current);
            current = "";
        } else current += char;
    }
    cells.push(current);
    return cells;
}

function jsonFields(text: string, lines: readonly string[]): PrefixReadout {
    const whole = parseJson(text.slice(0, READOUT_TEXT_BYTES));
    if (Array.isArray(whole)) {
        const first = whole[0];
        return {
            fields: {
                jsonType: "array",
                elementCount: whole.length,
                ...(isRecord(first) ? { firstElementKeys: joinKeys(Object.keys(first)) } : {}),
            },
        };
    }
    if (isRecord(whole)) {
        const keys = Object.keys(whole);
        return { fields: { jsonType: "object", keyCount: keys.length, keys: joinKeys(keys) } };
    }
    if (whole !== undefined) return { fields: { jsonType: typeof whole } };

    // A prefix of JSON Lines truncates mid-record at worst once, at the tail.
    const candidates = lines.slice(0, MAX_META_LINES);
    const parsed = candidates.map((line) => parseJson(line));
    const complete = parsed.filter((value) => value !== undefined);
    const record = parsed.find(isRecord);
    if (record !== undefined && complete.length >= Math.max(1, candidates.length - 1)) {
        return { fields: { jsonType: "json-lines", recordsInPrefix: lines.length, keys: joinKeys(Object.keys(record)) } };
    }
    return { fields: { firstLine: clip(lines[0]!, MAX_LINE_CHARS) }, unavailable: "JSON document extends past the readout prefix" };
}

/** Top-level keys, read positionally: an unindented `key:` line opens a mapping entry. */
function yamlFields(lines: readonly string[]): PrefixReadout {
    const keys: string[] = [];
    for (const line of lines.slice(0, MAX_META_LINES)) {
        const match = /^([A-Za-z_][\w.-]*):(\s|$)/.exec(line);
        if (match) keys.push(match[1]!);
    }
    const documents = lines.filter((line) => line.trim() === "---").length;
    return {
        fields: {
            topLevelKeyCount: keys.length,
            topLevelKeys: joinKeys(keys),
            linesInPrefix: lines.length,
            ...(documents > 0 ? { documentSeparators: documents } : {}),
        },
    };
}

function markdownFields(lines: readonly string[]): PrefixReadout {
    const headings = lines.filter((line) => /^#{1,6}\s/.test(line));
    return {
        fields: {
            title: clip((headings[0] ?? lines[0]!).replace(/^#+\s*/, ""), MAX_LINE_CHARS),
            headings: headings.length,
            linesInPrefix: lines.length,
        },
    };
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinKeys(keys: readonly string[]): string {
    return clip(
        keys
            .slice(0, MAX_COLUMNS_REPORTED)
            .map((key) => key.slice(0, MAX_COLUMN_NAME_CHARS))
            .join(", "),
        MAX_FIELD_CHARS,
    );
}

function countPrefixed(lines: readonly string[], prefix: string): number {
    return lines.filter((line) => line.startsWith(prefix)).length;
}

function clip(text: string, limit: number): string {
    return text.replace(/\s+/g, " ").trim().slice(0, limit);
}
