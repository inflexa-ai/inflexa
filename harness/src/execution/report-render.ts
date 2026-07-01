/**
 * Report renderer — Node-side Nunjucks render of v{N}/report.html.j2 to v{N}/index.html.
 *
 * Stateless pure module: no harness imports, no env reads at import time,
 * safe to run standalone in tests.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nunjucks from "nunjucks";

export interface RenderReportOptions {
    versionDir: string;
    templatesDir: string;
}

export interface RenderReportResult {
    ok: boolean;
    indexBytes: number;
    error?: {
        kind: "missing-template" | "syntax" | "runtime";
        message: string;
        line?: number;
        snippet?: string;
    };
}

/**
 * Render `${versionDir}/report.html.j2` to `${versionDir}/index.html`.
 *
 * Loader resolution order: [versionDir, templatesDir]. `report.html.j2`
 * lives in versionDir; `extends "base.html.j2"` and `include "components/..."`
 * resolve from templatesDir. Autoescape is OFF — templates own escaping.
 *
 * `${templatesDir}/echarts-theme.json` is read, parsed, re-stringified, and
 * passed as `echarts_theme` (a JSON string) for safe inlining inside a
 * `<script>` block.
 *
 * Returns `{ ok: true, indexBytes }` on success. On failure, returns
 * `{ ok: false, indexBytes: 0, error }` with `error.kind`:
 *   - "missing-template" — `report.html.j2` (or any `extends`/`include` target)
 *      not found by either loader. Message identifies the missing path.
 *   - "syntax" — Nunjucks parse error in any loaded template.
 *   - "runtime" — anything else thrown during render or write.
 */
export async function renderReport(opts: RenderReportOptions): Promise<RenderReportResult> {
    const { versionDir, templatesDir } = opts;

    let echartsThemeJson: string;
    try {
        const raw = await readFile(join(templatesDir, "echarts-theme.json"), "utf8");
        echartsThemeJson = JSON.stringify(JSON.parse(raw));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const kind: "missing-template" | "runtime" = isNotFound(err) ? "missing-template" : "runtime";
        return {
            ok: false,
            indexBytes: 0,
            error: { kind, message: `failed to load echarts-theme.json: ${msg}` },
        };
    }

    const env = new nunjucks.Environment(
        new nunjucks.FileSystemLoader([versionDir, templatesDir], {
            noCache: true,
        }),
        { autoescape: false, throwOnUndefined: false },
    );

    let html: string;
    try {
        html = env.render("report.html.j2", { echarts_theme: echartsThemeJson });
    } catch (err) {
        return { ok: false, indexBytes: 0, error: classifyNunjucksError(err) };
    }

    try {
        const indexPath = join(versionDir, "index.html");
        await writeFile(indexPath, html, "utf8");
        return { ok: true, indexBytes: Buffer.byteLength(html, "utf8") };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            indexBytes: 0,
            error: { kind: "runtime", message: `failed to write index.html: ${msg}` },
        };
    }
}

function isNotFound(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: unknown }).code;
    return code === "ENOENT";
}

function classifyNunjucksError(err: unknown): NonNullable<RenderReportResult["error"]> {
    const message = err instanceof Error ? err.message : String(err);

    if (/template not found/i.test(message)) {
        return { kind: "missing-template", message };
    }

    // Nunjucks tags parse errors with "Template render error" + "expected" /
    // "unexpected" / "parseError" markers; the Template error carries lineno.
    const lineno = (err as { lineno?: unknown })?.lineno;
    const colno = (err as { colno?: unknown })?.colno;
    const line = typeof lineno === "number" ? lineno : undefined;

    const isSyntax = /parseError|expected|unexpected token|unexpected end of/i.test(message) || /Template render error.*line \d+/i.test(message);

    if (isSyntax) {
        const snippet = extractSnippet(message, line, typeof colno === "number" ? colno : undefined);
        return snippet ? { kind: "syntax", message, line, snippet } : line !== undefined ? { kind: "syntax", message, line } : { kind: "syntax", message };
    }

    return line !== undefined ? { kind: "runtime", message, line } : { kind: "runtime", message };
}

function extractSnippet(message: string, line?: number, col?: number): string | undefined {
    if (!line) return undefined;
    const m = message.split("\n").find((l) => l.trim().length > 0 && !/^\s*at\s/.test(l));
    if (!m) return undefined;
    return col !== undefined ? `${m} (col ${col})` : m;
}
