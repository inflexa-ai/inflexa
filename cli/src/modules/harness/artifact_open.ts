import { existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { validatePath } from "@inflexa-ai/harness/tools/lib/path-validation";
import { err, ok, type Result } from "neverthrow";

import { mkdirResult, writeFileResult } from "../../lib/fs.ts";
import { workspaceRootForAnalysisId } from "../analysis/output.ts";
import type { OpenTarget } from "../../types/session.ts";

// The `artifact-open` capability: open-time RESOLUTION (reference → path) and MATERIALIZATION
// (echart/svg spec → a self-contained file under the analysis workspace's `presentations/` directory).
// The server resolves a card for the TUI (`POST {A}/artifacts/resolve`), and the REPL printer
// (`dev/chat.ts`) links each entry as an OSC 8 path. The readers that turn a harness display-card part
// into the card model are in `chat_printer.ts`, because the TUI client reads them too.
//
// OPEN-TIME RESOLUTION: a card stores only the semantic reference (analysis-rooted paths, the embedded
// spec, the `pres-` id) — never a resolved location — so the same card resolves to a workspace file
// today and (unchanged) to a local-webserver URL under the planned front+back architecture.

/** Why an artifact is not ready to open. Every case carries what the notice needs to name the path/reason. */
export type OpenArtifactError =
    { type: "unresolved" } | { type: "missing"; path: string } | { type: "materialize_failed"; cause: unknown } | { type: "unavailable"; reason: string };

/**
 * The workspace-reserved directory `echart`/`svg` presentations materialize into, a sibling of the
 * harness-owned `data/`/`runs/`/`reports/` roots. Living inside the analysis tree keeps a
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

/**
 * Resolve an entry to a concrete, ready-to-open location WITHOUT opening it: `workspace-file` returns
 * the resolved workspace path (missing → `missing`); `echart`/`svg` materialize their presentations
 * file and return it; `unavailable` never resolves. The REPL printer links to the path (an OSC 8
 * `file://` path), and the artifact route of the server gives it to the client that opens it. Never throws.
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
 * Build the self-contained echart HTML: the spec embedded inline, ECharts loaded from an exact-version CDN
 * URL guarded by Subresource Integrity (`echarts@6.1.0`, the version the report templates pin) so a CDN or
 * package compromise cannot swap arbitrary JS into a chart page the user opens, and a VISIBLE fallback
 * notice shown when the script cannot load (offline, or refused by the browser on an integrity mismatch) so
 * a blank tab is never mysterious. `dataUrl`, when present, is the RELATIVE URL of the chart's data
 * artifact, fetched at render time and parsed into `dataset.source` in-page by PapaParse (same
 * exact-version + SRI pinning as ECharts; delimiter auto-detection, `dynamicTyping` for numeric cells,
 * header row first as dimension names) — the data lives only in the artifact, never in this file — with a
 * visible degradation note when the fetch or parse fails (a `file://`-opened page may be denied local data
 * access by the browser). `dataNote`, when present, pre-degrades the shell (an invalid `dataPath` shape
 * refused before a URL was derived). Exported for unit tests. Embedded JSON has `<` escaped so a string
 * field can never break out of the script.
 */
export function echartHtml(spec: Record<string, unknown>, dataUrl: string | null, dataNote: string | null): string {
    // Escape `<` in the embedded JSON so a spec string containing `</script>` cannot terminate the script tag.
    const specJson = JSON.stringify(spec).replace(/</g, "\\u003c");
    // The URL rides the same escaped-JSON channel as the spec — an untrusted-shaped path cannot break out.
    const dataUrlJson = JSON.stringify(dataUrl).replace(/</g, "\\u003c");
    const noteAttr = dataNote ? "" : ' style="display:none"';
    // The parser script tag is emitted only for data-carrying shells, so an inline chart stays one fetch.
    const papaScript =
        dataUrl !== null
            ? '<script src="https://cdn.jsdelivr.net/npm/papaparse@5.5.4/papaparse.min.js" integrity="sha384-cLjG6lwXwNDhUhTjXK3ohZ0rY1kC099EjtQic90lF92kT8M0+eD45d1inP5youpY" crossorigin="anonymous"></script>\n'
            : "";
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
<script src="https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js" integrity="sha384-C2iskrW/uPW46KzOjrvJIQo4YkV8lkD+QS0CrDN18IIPIpT/g2USu8bTP3nvmIAD" crossorigin="anonymous"></script>
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
