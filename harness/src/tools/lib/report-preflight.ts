/**
 * Report pre-flight — deterministic asset staging for iterate-report.
 *
 * Runs before the report-builder agent starts. Resolves each declared
 * source under the analysis root, enforces the 50MB cap, copies bytes
 * into the preview's shared assets/ dir, and enriches the brief with
 * inferred kind, size, CSV columns, head rows, and row count.
 *
 * The builder receives a complete brief and never has to discover or
 * stage anything itself.
 */

import { copyFile, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_ASSET_LABEL = "50MB";
const HEAD_BUF_BYTES = 64 * 1024;
const HEAD_ROW_COUNT = 5;
const COUNT_CHUNK_BYTES = 64 * 1024;
// JSON enrichment parses the whole file to detect array-of-objects shape.
// Cap below the 50MB asset limit so we don't synchronously parse huge files
// just for metadata — large JSON gets staged but lands in the brief without
// columns/rowCount, the same way a non-tabular JSON would.
const JSON_ENRICH_MAX_BYTES = 5 * 1024 * 1024;

export type AssetKind = "csv" | "tsv" | "image" | "json" | "other";

export interface StagedAsset {
    name: string;
    path: string;
    kind: AssetKind;
    sizeBytes: number;
    rowCount?: number;
    columns?: string[];
    headRows?: string[][];
}

export interface PreflightSource {
    path: string;
    as?: string;
}

export type PreflightResult = { ok: true; staged: StagedAsset[] } | { ok: false; reason: string };

export interface PreflightOptions {
    sources: PreflightSource[];
    analysisRoot: string;
    assetsDirAbs: string;
}

export async function stageReportAssets(opts: PreflightOptions): Promise<PreflightResult> {
    await mkdir(opts.assetsDirAbs, { recursive: true });

    // Canonicalize analysisRoot so containment checks work when the path
    // traverses symlinks (e.g. macOS /var → /private/var).
    const analysisRoot = await realpath(opts.analysisRoot);

    // Dedupe by destination name. Identical (path, name) pairs collapse
    // silently; conflicting names from different paths are an error.
    const byName = new Map<string, PreflightSource>();
    for (const src of opts.sources) {
        const name = (src.as ?? basename(src.path)).trim();
        if (!name) {
            return { ok: false, reason: `source has no destination name: ${src.path}` };
        }
        const existing = byName.get(name);
        if (existing && existing.path !== src.path) {
            return {
                ok: false,
                reason: `duplicate asset name '${name}' from sources '${existing.path}' and '${src.path}' — use \`as\` to disambiguate`,
            };
        }
        byName.set(name, src);
    }

    const staged: StagedAsset[] = [];

    for (const [name, src] of byName) {
        const resolved = await resolveSource(src.path, analysisRoot);
        if (!resolved.ok) return resolved;

        let st;
        try {
            st = await stat(resolved.path);
        } catch {
            return { ok: false, reason: `source not found: ${src.path}` };
        }
        if (!st.isFile()) {
            return { ok: false, reason: `source is not a regular file: ${src.path}` };
        }
        if (st.size > MAX_ASSET_BYTES) {
            return {
                ok: false,
                reason: `source ${src.path} is ${formatBytes(st.size)} — exceeds ${MAX_ASSET_LABEL} cap`,
            };
        }

        const dst = resolveDestination(name, opts.assetsDirAbs);
        if (!dst.ok) return dst;
        await copyFile(resolved.path, dst.path);

        const kind = inferKind(name);
        const asset: StagedAsset = {
            name,
            path: src.path,
            kind,
            sizeBytes: st.size,
        };

        if (kind === "csv" || kind === "tsv") {
            const enriched = await enrichTabular(dst.path, kind === "tsv" ? "\t" : ",");
            if (enriched.columns) asset.columns = enriched.columns;
            if (enriched.headRows) asset.headRows = enriched.headRows;
            if (enriched.rowCount !== undefined) asset.rowCount = enriched.rowCount;
        } else if (kind === "json" && st.size <= JSON_ENRICH_MAX_BYTES) {
            const enriched = await enrichJson(dst.path);
            if (enriched.columns) asset.columns = enriched.columns;
            if (enriched.headRows) asset.headRows = enriched.headRows;
            if (enriched.rowCount !== undefined) asset.rowCount = enriched.rowCount;
        }

        staged.push(asset);
    }

    return { ok: true, staged };
}

/**
 * Resolves a source path under analysisRoot and canonicalizes through
 * symlinks. Sandbox steps have RW access to their own output dir on the
 * shared session storage, so a malicious or compromised step could create
 * a symlink pointing outside the analysis tree (e.g. to /etc/passwd).
 * `path.resolve` is purely lexical — only `realpath` catches symlink
 * escapes — so we re-validate containment after canonicalization.
 */
async function resolveSource(path: string, analysisRoot: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    if (path.includes("\0")) {
        return { ok: false, reason: `source contains null byte: ${path}` };
    }
    if (path.startsWith("/")) {
        return { ok: false, reason: `source must be relative to analysis root: ${path}` };
    }
    const lexical = resolve(analysisRoot, path);
    if (lexical !== analysisRoot && !lexical.startsWith(analysisRoot + sep)) {
        return { ok: false, reason: `source escapes analysis root: ${path}` };
    }
    let canonical: string;
    try {
        canonical = await realpath(lexical);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, reason: `source not found: ${path}` };
        }
        throw err;
    }
    if (canonical !== analysisRoot && !canonical.startsWith(analysisRoot + sep)) {
        return { ok: false, reason: `source escapes analysis root via symlink: ${path}` };
    }
    return { ok: true, path: canonical };
}

function resolveDestination(name: string, assetsDirAbs: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (name.includes("\0")) {
        return { ok: false, reason: `destination contains null byte: ${name}` };
    }
    // Reject any path-y name — assets/ is intentionally flat. `as: "subdir/x"`
    // would otherwise pass the starts-with check but fail at copyFile time
    // because the parent dir doesn't exist, bubbling an unhandled exception
    // out of stageReportAssets's {ok} contract.
    if (name !== basename(name)) {
        return { ok: false, reason: `destination must be a flat filename (no path separators): ${name}` };
    }
    const resolved = resolve(assetsDirAbs, name);
    if (!resolved.startsWith(assetsDirAbs + sep)) {
        return { ok: false, reason: `destination escapes assets dir: ${name}` };
    }
    return { ok: true, path: resolved };
}

function inferKind(name: string): AssetKind {
    const ext = extname(name).toLowerCase();
    if (ext === ".csv") return "csv";
    if (ext === ".tsv") return "tsv";
    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".svg" || ext === ".gif" || ext === ".webp") {
        return "image";
    }
    if (ext === ".json") return "json";
    return "other";
}

async function enrichTabular(path: string, delim: string): Promise<{ columns?: string[]; headRows?: string[][]; rowCount?: number }> {
    const fd = await open(path, "r");
    try {
        const buf = Buffer.alloc(HEAD_BUF_BYTES);
        const { bytesRead } = await fd.read(buf, 0, HEAD_BUF_BYTES, 0);
        const head = buf.subarray(0, bytesRead).toString("utf8");
        const lines = head.split(/\r?\n/);
        if (lines.length === 0 || lines[0].length === 0) return {};

        const columns = parseLine(lines[0], delim);
        const headRows: string[][] = [];
        for (let i = 1; i < lines.length && headRows.length < HEAD_ROW_COUNT; i++) {
            if (lines[i].length === 0) continue;
            headRows.push(parseLine(lines[i], delim));
        }

        const rowCount = await countRows(fd);

        const result: { columns?: string[]; headRows?: string[][]; rowCount?: number } = {
            columns,
        };
        if (headRows.length > 0) result.headRows = headRows;
        if (rowCount !== undefined) result.rowCount = rowCount;
        return result;
    } finally {
        await fd.close();
    }
}

function parseLine(line: string, delim: string): string[] {
    // Naive split — sufficient for analysis output where fields rarely contain
    // delimiters or embedded newlines. The builder reads the actual file via the
    // assets/ symlink for rendering; the brief just surfaces column names so the
    // conv agent can compose section content correctly.
    return line.split(delim).map((s) => s.replace(/^"|"$/g, ""));
}

/**
 * Detect array-of-objects JSON shape so the brief surfaces columns + a few
 * head rows the same way it does for CSV/TSV. Anything other than a top-level
 * array of objects (e.g. ECharts options, scalar config, nested aggregates)
 * is staged with no enrichment — the builder can still load it client-side
 * and use it directly, but the conv agent picks chart encoding without
 * column hints. Parses the full file; caller caps file size upstream.
 */
async function enrichJson(path: string): Promise<{ columns?: string[]; headRows?: string[][]; rowCount?: number }> {
    let parsed: unknown;
    try {
        const { readFile } = await import("node:fs/promises");
        parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
        return {};
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return {};

    // Sample the first non-null object for keys. Mixed-shape arrays still get
    // first-element keys — good enough for the brief; renderer reads the file
    // directly anyway.
    const first = parsed.find((r) => r && typeof r === "object" && !Array.isArray(r));
    if (!first) return { rowCount: parsed.length };

    const columns = Object.keys(first as Record<string, unknown>);
    const headRows: string[][] = [];
    for (let i = 0; i < parsed.length && headRows.length < HEAD_ROW_COUNT; i++) {
        const r = parsed[i];
        if (!r || typeof r !== "object" || Array.isArray(r)) continue;
        const obj = r as Record<string, unknown>;
        headRows.push(columns.map((c) => stringifyCell(obj[c])));
    }

    const result: { columns?: string[]; headRows?: string[][]; rowCount?: number } = {
        columns,
        rowCount: parsed.length,
    };
    if (headRows.length > 0) result.headRows = headRows;
    return result;
}

function stringifyCell(v: unknown): string {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
}

async function countRows(fd: import("node:fs/promises").FileHandle): Promise<number | undefined> {
    const buf = Buffer.alloc(COUNT_CHUNK_BYTES);
    let newlines = 0;
    let pos = 0;
    let lastByte = -1;
    while (true) {
        const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0x0a) newlines++;
        }
        lastByte = buf[bytesRead - 1];
        pos += bytesRead;
    }
    if (pos === 0) return 0;
    // If the file doesn't end with a newline, the last row wasn't counted.
    const total = lastByte === 0x0a ? newlines : newlines + 1;
    // Subtract one for the header.
    return Math.max(0, total - 1);
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
