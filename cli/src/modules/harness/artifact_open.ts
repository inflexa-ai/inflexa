import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { err, ok, type Result } from "neverthrow";

import { env } from "../../lib/env.ts";
import { mkdirResult, readFileResult, writeFileResult } from "../../lib/fs.ts";
import { openExternal } from "../../lib/open_external.ts";
import { workspaceRootForAnalysisId } from "../analysis/output.ts";
import type { OpenableEntry, OpenableIcon, OpenTarget, PresentationBody } from "../../types/session.ts";

// The `artifact-open` capability: the shared readers that turn a harness display-card `data` payload
// into a normalized card model, plus open-time RESOLUTION (reference → path) and MATERIALIZATION
// (echart/svg spec → a self-contained cache file). Consumed by BOTH the TUI store adapter
// (`hooks/conversation.ts` wraps the readouts into `Part`s) and the REPL printer (`chat_printer.ts`
// renders them as OSC 8 links), so the coercion + resolution logic lives in one place.
//
// COPY-ON-RECEIVE: the readers run inside the in-process emit path, whose `data` shares mutable
// references with the agent loop. Every reader extracts primitives and DEEP-COPIES the echart spec at
// receipt, so nothing the loop later mutates can reach the store (the same hazard the card readers in
// `chat_printer.ts` guard).
//
// OPEN-TIME RESOLUTION: a card stores only the semantic reference (analysis-rooted paths, the embedded
// spec, the `pres-` id) — never a resolved location — so the same card resolves to a workspace file
// today and (unchanged) to a local-webserver URL under the planned front+back architecture.

// ── loose-value coercion (untrusted emit `data`) ────────────────────────────────────────────────────

/** Coerce `v` to a string, defaulting to empty — every field below is read off untrusted emit `data`. */
function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** Coerce `v` to an optional string (undefined when absent/mistyped), for fields the card omits when unset. */
function optStr(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

/** Coerce `v` to a fresh string array (copy-on-receive), tolerating non-string cells. */
function strArr(v: unknown): string[] {
    return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : [];
}

/** Coerce `v` to a fresh matrix of strings (copy-on-receive) for table rows. */
function strMatrix(v: unknown): string[][] {
    return Array.isArray(v) ? v.map(strArr) : [];
}

/** Deep-copy an echart spec object at receipt so no mutable loop reference survives; `{}` on non-objects. */
function cloneSpec(v: unknown): Record<string, unknown> {
    if (typeof v !== "object" || v === null) return {};
    try {
        // structuredClone deep-copies the plain JSON-shaped spec (copy-on-receive); a spec carrying an
        // unclonable value (never, for a tool-input JSON object) degrades to an empty spec rather than throwing.
        return structuredClone(v) as Record<string, unknown>;
    } catch {
        return {};
    }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff", ".tif"]);

/** The glyph shape a referenced file's row shows: images get the image marker, everything else a document. */
function iconForPath(path: string): OpenableIcon {
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
    return IMAGE_EXTENSIONS.has(ext) ? "image" : "document";
}

// ── readers: harness `data` payload → normalized card model ──────────────────────────────────────────

/**
 * A `data-presentation` readout: text-shaped (`markdown`/`code`/`table`) becomes an inline body; the
 * pixel-shaped `echart`/`svg` become a single openable entry (materialized on open).
 */
export type PresentationReadout = { shape: "inline"; title?: string; body: PresentationBody } | { shape: "card"; title?: string; entry: OpenableEntry };

/**
 * Read a `show_user` presentation payload (`{ id, title?, content: { kind, ... } }`, flat on reload).
 * Text-shaped kinds map to an inline body; `echart`/`svg` map to an openable entry carrying the embedded
 * spec/markup + the deterministic `pres-` id. An unrecognized kind degrades to an inline note naming it.
 */
export function readPresentation(data: unknown): PresentationReadout {
    const d = (data ?? {}) as Record<string, unknown>;
    const id = str(d.id);
    const title = optStr(d.title);
    const content = (d.content ?? {}) as Record<string, unknown>;
    const kind = str(content.kind);
    switch (kind) {
        case "markdown":
            return { shape: "inline", title, body: { kind: "markdown", body: str(content.body) } };
        case "code":
            return { shape: "inline", title, body: { kind: "code", code: str(content.code), language: str(content.language) } };
        case "table":
            return {
                shape: "inline",
                title,
                body: { kind: "table", headers: strArr(content.headers), rows: strMatrix(content.rows), caption: optStr(content.caption) },
            };
        case "echart": {
            // `dataPath` is the harness `PresentationContent` echart's optional analysis-rooted CSV
            // reference, read loosely off untrusted emit `data` (like every field here) and resolved to
            // `dataset.source` at open time. Omitted from the target when absent so a self-contained spec
            // carries no empty key.
            const dataPath = optStr(content.dataPath);
            return {
                shape: "card",
                title,
                entry: {
                    icon: "chart",
                    name: title ?? "Chart",
                    target: {
                        kind: "echart",
                        presId: id,
                        spec: cloneSpec(content.spec),
                        ...(dataPath !== undefined ? { dataPath } : {}),
                    },
                },
            };
        }
        case "svg":
            return {
                shape: "card",
                title,
                entry: { icon: "image", name: title ?? "Diagram", target: { kind: "svg", presId: id, markup: str(content.markup) } },
            };
        default:
            // Observe an unrecognized presentation kind rather than swallowing it — render a visible inline note.
            return { shape: "inline", title, body: { kind: "markdown", body: `_(unsupported presentation: ${kind || "unknown"})_` } };
    }
}

/** A `data-file-reference` readout: one entry per referenced file, plus the shared containing folder for a gallery. */
export type FileReferenceReadout = { title?: string; entries: OpenableEntry[]; folderPath?: string };

/**
 * Read a `show_file` payload (`{ id, title?, files: [{ path, runId?, caption? }] }`). Each file becomes
 * an openable `workspace-file` entry; a multi-file gallery also carries `folderPath` (the first file's
 * directory) for the reveal-containing-folder affordance.
 */
export function readFileReference(data: unknown): FileReferenceReadout {
    const d = (data ?? {}) as Record<string, unknown>;
    const title = optStr(d.title);
    const rawFiles = Array.isArray(d.files) ? d.files : [];
    const entries: OpenableEntry[] = rawFiles.map((f) => {
        const file = (f ?? {}) as Record<string, unknown>;
        const path = str(file.path);
        return {
            icon: iconForPath(path),
            name: basename(path) || path,
            ...(optStr(file.caption) !== undefined ? { caption: optStr(file.caption)! } : {}),
            target: { kind: "workspace-file", path },
        };
    });
    const firstPath = rawFiles.length > 0 ? str((rawFiles[0] as Record<string, unknown>).path) : "";
    const dir = firstPath ? dirname(firstPath) : "";
    const folderPath = entries.length > 1 && dir && dir !== "." ? dir : undefined;
    return { title, entries, ...(folderPath !== undefined ? { folderPath } : {}) };
}

/** A single-entry openable readout (a report preview or a failed preview). */
export type PreviewReadout = { title?: string; entry: OpenableEntry };

/**
 * Read a `data-report-preview` payload (`{ id, previewId, version, title, previewPath, format }`). The
 * preview resolves against `previews/{previewId}/{previewPath}` in the workspace at open time.
 */
export function readReportPreview(data: unknown): PreviewReadout {
    const d = (data ?? {}) as Record<string, unknown>;
    const title = optStr(d.title);
    const previewId = str(d.previewId);
    const previewPath = str(d.previewPath);
    const version = typeof d.version === "number" ? d.version : 0;
    const name = `${title ?? "Report"} v${version}`;
    return { title, entry: { icon: "report", name, target: { kind: "workspace-file", path: `previews/${previewId}/${previewPath}` } } };
}

/**
 * Read a `data-report-preview-failed` payload (`{ id, previewId, version, reason, errorKind? }`) into a
 * degraded card entry: nothing to open, the failure reason shown as the caption.
 */
export function readReportPreviewFailed(data: unknown): PreviewReadout {
    const d = (data ?? {}) as Record<string, unknown>;
    const version = typeof d.version === "number" ? d.version : 0;
    const reason = str(d.reason) || "unknown reason";
    return { entry: { icon: "report", name: `Report preview v${version} failed`, caption: reason, target: { kind: "unavailable", reason } } };
}

// ── open-time resolution + materialization ──────────────────────────────────────────────────────────

/** Why an artifact could not be opened. Every case carries what the notice needs to name the path/reason. */
export type OpenArtifactError =
    | { type: "unresolved" }
    | { type: "missing"; path: string }
    | { type: "materialize_failed"; cause: unknown }
    | { type: "open_failed"; path: string; cause: unknown }
    | { type: "unavailable"; reason: string };

/**
 * The path an entry WOULD resolve to, for display beside the card — never materializes and never opens.
 * `workspace-file` joins the analysis workspace root (`null` when the root is unresolvable — a moved or
 * deleted anchor); `echart`/`svg` name their deterministic cache file (which may not exist until opened);
 * `unavailable` has no path.
 */
export function resolveEntryPath(analysisId: string, target: OpenTarget): string | null {
    switch (target.kind) {
        case "workspace-file":
            return workspaceRootForAnalysisId(analysisId).match(
                (root) => join(root, target.path),
                () => null,
            );
        case "echart":
            return join(env.presentationCacheDir, `${target.presId}.html`);
        case "svg":
            return join(env.presentationCacheDir, `${target.presId}.svg`);
        case "unavailable":
            return null;
        default: {
            const _exhaustive: never = target;
            return _exhaustive;
        }
    }
}

/**
 * True when an entry should render in the degraded state: a `workspace-file` whose resolved path is
 * missing (workspace desync) or `unavailable` (a failed preview). `echart`/`svg` are never degraded —
 * they materialize on demand, so their cache file's absence is expected, not a fault.
 */
export function entryDegraded(analysisId: string, target: OpenTarget): boolean {
    switch (target.kind) {
        case "workspace-file": {
            const path = resolveEntryPath(analysisId, target);
            return path === null || !existsSync(path);
        }
        case "echart":
        case "svg":
            return false;
        case "unavailable":
            return true;
        default: {
            const _exhaustive: never = target;
            return _exhaustive;
        }
    }
}

/** Spawn the OS opener for `path`, mapping its failure onto the artifact error channel (carrying the path). */
function spawnOpen(path: string): Result<string, OpenArtifactError> {
    return openExternal(path)
        .map(() => path)
        .mapErr((e): OpenArtifactError => ({ type: "open_failed", path, cause: e.cause }));
}

/**
 * Resolve an entry to a concrete, ready-to-open location WITHOUT opening it: `workspace-file` returns
 * the resolved workspace path (missing → `missing`); `echart`/`svg` materialize their cache file and
 * return it; `unavailable` never resolves. This is the seam the REPL printer links to (an OSC 8
 * `file://` path) and the shared step {@link openEntry} builds on. Never throws.
 */
export function materializeTarget(analysisId: string, target: OpenTarget): Result<string, OpenArtifactError> {
    switch (target.kind) {
        case "workspace-file": {
            const path = resolveEntryPath(analysisId, target);
            if (path === null) return err({ type: "unresolved" });
            if (!existsSync(path)) return err({ type: "missing", path });
            return ok(path);
        }
        case "echart":
            return materializeEchart(analysisId, target);
        case "svg":
            return materializeSvg(target);
        case "unavailable":
            return err({ type: "unavailable", reason: target.reason });
        default: {
            const _exhaustive: never = target;
            return _exhaustive;
        }
    }
}

/**
 * Resolve an entry to an openable location and open it in the default OS application, returning the
 * resolved path. Materializes `echart`/`svg` first; `unavailable` never opens. Never throws — a failed
 * open is a `Result` err the caller degrades to a notice.
 */
export function openEntry(analysisId: string, target: OpenTarget): Result<string, OpenArtifactError> {
    return materializeTarget(analysisId, target).andThen(spawnOpen);
}

/** Open the analysis-rooted `folder` (a gallery's containing directory) in the OS file browser. */
export function openFolder(analysisId: string, folder: string): Result<string, OpenArtifactError> {
    const root = workspaceRootForAnalysisId(analysisId).match(
        (r): string | null => r,
        () => null,
    );
    if (root === null) return err({ type: "unresolved" });
    const dir = join(root, folder);
    if (!existsSync(dir)) return err({ type: "missing", path: dir });
    return spawnOpen(dir);
}

/** Write `content` to the render cache at `dest` (creating the cache dir), mapping fs faults onto the error channel. */
function writeCache(dest: string, content: string): Result<string, OpenArtifactError> {
    return mkdirResult(env.presentationCacheDir, "materialize:mkdir")
        .andThen(() => writeFileResult(dest, content, "materialize:write"))
        .map(() => dest)
        .mapErr((e): OpenArtifactError => ({ type: "materialize_failed", cause: e.cause }));
}

/** Materialize a `svg` presentation as `<pres-id>.svg`, reusing the file when it already exists (idempotent). */
function materializeSvg(target: Extract<OpenTarget, { kind: "svg" }>): Result<string, OpenArtifactError> {
    const dest = join(env.presentationCacheDir, `${target.presId}.svg`);
    if (existsSync(dest)) return ok(dest);
    return writeCache(dest, target.markup);
}

/**
 * Materialize an `echart` presentation as a self-contained `<pres-id>.html` shell, reusing the file when
 * it exists (idempotent — the `pres-` id is a content hash, so an identical card is the same file). For an
 * artifact-sourced chart (`dataPath`), the workspace CSV is read and injected as `dataset.source`; a
 * missing/unparseable CSV degrades to a chart shown without its data (a visible notice), never a crash.
 */
function materializeEchart(analysisId: string, target: Extract<OpenTarget, { kind: "echart" }>): Result<string, OpenArtifactError> {
    const dest = join(env.presentationCacheDir, `${target.presId}.html`);
    if (existsSync(dest)) return ok(dest);
    let spec = target.spec;
    let dataNote: string | null = null;
    if (target.dataPath) {
        const source = readCsvSource(analysisId, target.dataPath);
        if (source !== null) spec = { ...spec, dataset: { source } };
        else dataNote = `Data file "${target.dataPath}" could not be loaded — the chart is shown without its data.`;
    }
    return writeCache(dest, echartHtml(spec, dataNote));
}

/** Read + parse the workspace CSV at the analysis-rooted `dataPath` into an ECharts `dataset.source`, or `null` on any failure. */
function readCsvSource(analysisId: string, dataPath: string): unknown[][] | null {
    const path = workspaceRootForAnalysisId(analysisId).match(
        (root): string | null => join(root, dataPath),
        () => null,
    );
    if (path === null || !existsSync(path)) return null;
    const text = readFileResult(path, "readCsvSource").match(
        (t): string | null => t,
        () => null,
    );
    return text === null ? null : parseCsvToSource(text);
}

// ── CSV → ECharts dataset.source (RFC-4180, header row, numeric inference) ────────────────────────────

/** Parse RFC-4180 CSV text into rows of string cells (quoted fields, escaped `""`, embedded newlines). */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    // Strip a leading UTF-8 BOM so the first header cell is not prefixed with U+FEFF.
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
            continue;
        }
        if (c === '"') inQuotes = true;
        else if (c === ",") {
            row.push(field);
            field = "";
        } else if (c === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (c !== "\r") field += c;
    }
    // Flush a final field/row that a missing trailing newline would otherwise strand.
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/**
 * Parse CSV text into an ECharts `dataset.source`: the header row first (dimension names), then data rows
 * whose fully-numeric columns are converted to numbers (per-column inference), so `encode`-by-name against
 * the header works. `null` when the CSV is empty. Exported for unit tests.
 */
export function parseCsvToSource(text: string): unknown[][] | null {
    const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
    if (rows.length === 0) return null;
    const header = rows[0]!;
    const data = rows.slice(1);
    // A column is numeric only when every data cell parses as a finite number (an empty column stays textual).
    const numeric = header.map((_, ci) => data.length > 0 && data.every((r) => r[ci] !== undefined && r[ci]!.trim() !== "" && !Number.isNaN(Number(r[ci]))));
    const body = data.map((r) => header.map((_, ci) => (numeric[ci] ? Number(r[ci] ?? "") : (r[ci] ?? ""))));
    return [header, ...body];
}

// ── the self-contained echart HTML shell ─────────────────────────────────────────────────────────────

/** Minimal HTML-escape for the interior text of our own `<div>` notices (not general-purpose sanitization). */
function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the self-contained echart HTML: the spec embedded inline, ECharts loaded from a pinned-major CDN
 * URL (`echarts@5`), and a VISIBLE fallback notice shown when the script cannot load (offline) so a blank
 * tab is never mysterious. `dataNote`, when present, warns that an artifact CSV could not be loaded.
 * Exported for unit tests. The spec's `<` are escaped so a string field can never break out of the script.
 */
export function echartHtml(spec: Record<string, unknown>, dataNote: string | null): string {
    // Escape `<` in the embedded JSON so a spec string containing `</script>` cannot terminate the script tag.
    const specJson = JSON.stringify(spec).replace(/</g, "\\u003c");
    const note = dataNote ? `<div id="datanote">${escapeHtml(dataNote)}</div>\n` : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>inflexa chart</title>
<style>
  html, body { margin: 0; height: 100%; background: #ffffff; font-family: system-ui, -apple-system, sans-serif; }
  #chart { width: 100%; height: 100%; }
  #offline { display: none; padding: 1rem; color: #b5002e; }
  #offline pre { white-space: pre-wrap; word-break: break-word; color: #333333; }
  #datanote { padding: 0.5rem 1rem; color: #804e00; background: #fff8e1; }
</style>
</head>
<body>
${note}<div id="chart"></div>
<div id="offline">
  <p>The chart library could not load (are you offline?). The chart spec is shown below.</p>
  <pre id="spec"></pre>
</div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5"></script>
<script>
  var spec = ${specJson};
  if (window.echarts) {
    var chart = echarts.init(document.getElementById("chart"));
    chart.setOption(spec);
    window.addEventListener("resize", function () { chart.resize(); });
  } else {
    document.getElementById("chart").style.display = "none";
    document.getElementById("offline").style.display = "block";
    document.getElementById("spec").textContent = JSON.stringify(spec, null, 2);
  }
</script>
</body>
</html>
`;
}
