import { existsSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { validatePath } from "@inflexa-ai/harness/tools/lib/path-validation";
import { err, ok, type Result } from "neverthrow";

import { mkdirResult, writeFileResult } from "../../lib/fs.ts";
import { openExternal } from "../../lib/open_external.ts";
import { workspaceRootForAnalysisId } from "../analysis/output.ts";
import type { OpenableEntry, OpenableIcon, OpenTarget, PresentationBody } from "../../types/session.ts";

// The `artifact-open` capability: the shared readers that turn a harness display-card `data` payload
// into a normalized card model, plus open-time RESOLUTION (reference → path) and MATERIALIZATION
// (echart/svg spec → a self-contained file under the analysis workspace's `presentations/` directory).
// Consumed by BOTH the TUI store adapter (`hooks/conversation.ts` wraps the readouts into `Part`s) and
// the REPL printer (`chat_printer.ts` renders them as OSC 8 links), so the coercion + resolution logic
// lives in one place.
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
 * The workspace-reserved directory `echart`/`svg` presentations materialize into, a sibling of the
 * harness-owned `data/`/`runs/`/`reports/`/`previews/` roots. Living inside the analysis tree keeps a
 * presentation next to the artifacts it renders, so a `dataPath` chart can reference its CSV by a
 * relative URL.
 */
const PRESENTATIONS_DIR = "presentations";

/** `{workspaceRoot}/presentations/<filename>`, or `null` when the root is unresolvable (moved/deleted anchor). */
function presentationFilePath(analysisId: string, filename: string): string | null {
    return workspaceRootForAnalysisId(analysisId).match(
        (root): string | null => join(root, PRESENTATIONS_DIR, filename),
        () => null,
    );
}

/**
 * The path an entry WOULD resolve to, for display beside the card — never materializes and never opens.
 * `workspace-file` joins the analysis workspace root (`null` when the root is unresolvable — a moved or
 * deleted anchor); `echart`/`svg` name their deterministic presentations file (which may not exist until
 * opened); `unavailable` has no path.
 */
export function resolveEntryPath(analysisId: string, target: OpenTarget): string | null {
    switch (target.kind) {
        case "workspace-file":
            return workspaceRootForAnalysisId(analysisId).match(
                (root) => join(root, target.path),
                () => null,
            );
        case "echart":
            return presentationFilePath(analysisId, `${target.presId}.html`);
        case "svg":
            return presentationFilePath(analysisId, `${target.presId}.svg`);
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
 * they materialize on demand, so their presentations file's absence is expected, not a fault.
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
 * the resolved workspace path (missing → `missing`); `echart`/`svg` materialize their presentations
 * file and return it; `unavailable` never resolves. This is the seam the REPL printer links to (an OSC 8
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
            return materializeSvg(analysisId, target);
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

/** Write `content` to the presentations file at `dest` (creating its directory), mapping fs faults onto the error channel. */
function writePresentationFile(dest: string, content: string): Result<string, OpenArtifactError> {
    return mkdirResult(dirname(dest), "materialize:mkdir")
        .andThen(() => writeFileResult(dest, content, "materialize:write"))
        .map(() => dest)
        .mapErr((e): OpenArtifactError => ({ type: "materialize_failed", cause: e.cause }));
}

/** Materialize a `svg` presentation as `presentations/<pres-id>.svg`, reusing the file when it already exists (idempotent). */
function materializeSvg(analysisId: string, target: Extract<OpenTarget, { kind: "svg" }>): Result<string, OpenArtifactError> {
    const dest = presentationFilePath(analysisId, `${target.presId}.svg`);
    if (dest === null) return err({ type: "unresolved" });
    if (existsSync(dest)) return ok(dest);
    return writePresentationFile(dest, target.markup);
}

/**
 * The relative URL a `dataPath` shell fetches its CSV through at render time, derived from where the
 * shell sits (`{root}/presentations/`) against the analysis-rooted `dataPath` — so the shell and the
 * artifact travel together with the analysis tree (copy or move the tree and the chart still finds its
 * data). Segments are percent-encoded so a space/`#` in an artifact name survives URL parsing.
 */
function dataUrlFor(dataPath: string): string {
    const rel = posix.relative(`/${PRESENTATIONS_DIR}`, posix.join("/", dataPath));
    return rel
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

/**
 * Materialize an `echart` presentation as `presentations/<pres-id>.html`. The `pres-` id is a genuine
 * content hash of the whole tool input (spec + `dataPath`), and the shell embeds nothing beyond that
 * input — an artifact-sourced chart carries only a RELATIVE URL to its CSV, fetched and parsed inside
 * the shell at render time — so the file is a pure function of the id and is reused when it already
 * exists (idempotent), for both variants. A rewritten CSV needs no rematerialization: the next open
 * fetches the current bytes. A `dataPath` whose SHAPE is invalid (untrusted — it survives a reload from
 * a persisted tool_use, bypassing the live tool's validation) degrades to a shell with a visible
 * no-data note, never a crash.
 */
function materializeEchart(analysisId: string, target: Extract<OpenTarget, { kind: "echart" }>): Result<string, OpenArtifactError> {
    const dest = presentationFilePath(analysisId, `${target.presId}.html`);
    if (dest === null) return err({ type: "unresolved" });
    if (existsSync(dest)) return ok(dest);
    if (target.dataPath === undefined) return writePresentationFile(dest, echartHtml(target.spec, null, null));
    if (validatePath(target.dataPath) !== null) {
        return writePresentationFile(
            dest,
            echartHtml(target.spec, null, `Data file "${target.dataPath}" could not be loaded — the chart is shown without its data.`),
        );
    }
    return writePresentationFile(dest, echartHtml(target.spec, dataUrlFor(target.dataPath), null));
}

// ── the self-contained echart HTML shell ─────────────────────────────────────────────────────────────

/** Minimal HTML-escape for the interior text of our own `<div>` notices (not general-purpose sanitization). */
function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the self-contained echart HTML: the spec embedded inline, ECharts loaded from a pinned-major CDN
 * URL (`echarts@5`), and a VISIBLE fallback notice shown when the script cannot load (offline) so a blank
 * tab is never mysterious. `dataUrl`, when present, is the RELATIVE URL of the chart's data artifact,
 * fetched at render time and parsed into `dataset.source` in-page by PapaParse (pinned-major CDN, same
 * pattern as ECharts; delimiter auto-detection, `dynamicTyping` for numeric cells, header row first as
 * dimension names) — the data lives only in the artifact, never in this file — with a visible degradation
 * note when the fetch or parse fails (a `file://`-opened page may be denied local data access by the
 * browser). `dataNote`, when present, pre-degrades the shell (an invalid `dataPath` shape refused before
 * a URL was derived). Exported for unit tests. Embedded JSON has `<` escaped so a string field can never
 * break out of the script.
 */
export function echartHtml(spec: Record<string, unknown>, dataUrl: string | null, dataNote: string | null): string {
    // Escape `<` in the embedded JSON so a spec string containing `</script>` cannot terminate the script tag.
    const specJson = JSON.stringify(spec).replace(/</g, "\\u003c");
    // The URL rides the same escaped-JSON channel as the spec — an untrusted-shaped path cannot break out.
    const dataUrlJson = JSON.stringify(dataUrl).replace(/</g, "\\u003c");
    const noteAttr = dataNote ? "" : ' style="display:none"';
    // The parser script tag is emitted only for data-carrying shells, so an inline chart stays one fetch.
    const papaScript = dataUrl !== null ? '<script src="https://cdn.jsdelivr.net/npm/papaparse@5"></script>\n' : "";
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
<div id="datanote"${noteAttr}>${escapeHtml(dataNote ?? "")}</div>
<div id="chart"></div>
<div id="offline">
  <p>The chart library could not load (are you offline?). The chart spec is shown below.</p>
  <pre id="spec"></pre>
</div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5"></script>
${papaScript}<script>
  var spec = ${specJson};
  var dataUrl = ${dataUrlJson};
  function showNote(message) {
    var note = document.getElementById("datanote");
    note.textContent = message;
    note.style.display = "block";
  }
  function render(option) {
    var chart = echarts.init(document.getElementById("chart"));
    chart.setOption(option);
    window.addEventListener("resize", function () { chart.resize(); });
  }
  if (!window.echarts) {
    document.getElementById("chart").style.display = "none";
    document.getElementById("offline").style.display = "block";
    document.getElementById("spec").textContent = JSON.stringify(spec, null, 2);
  } else if (dataUrl === null) {
    render(spec);
  } else {
    fetch(dataUrl)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        if (!window.Papa) throw new Error("the data parser library could not load");
        // Strip a UTF-8 BOM so the first header cell is not prefixed with U+FEFF.
        var body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        // Array-of-arrays with the header as row 0 IS the ECharts dataset.source shape;
        // dynamicTyping turns numeric cells into numbers so value axes and encode-by-name work.
        var parsed = Papa.parse(body, { dynamicTyping: true, skipEmptyLines: "greedy" });
        if (!parsed.data || parsed.data.length === 0) throw new Error("empty data file");
        spec.dataset = { source: parsed.data };
        render(spec);
      })
      .catch(function (e) {
        showNote('Data file "' + dataUrl + '" could not be loaded (' + e.message + ') — the chart is shown without its data. If this page was opened from disk (file://), the browser may block local data access; serve the analysis folder over HTTP to load it.');
        render(spec);
      });
  }
</script>
</body>
</html>
`;
}
