/**
 * submit_report tool — postcondition gate. The runner refuses to emit
 * `data-report-preview` until this tool writes the success outcome.
 *
 * Checks:
 *   - index.html exists at versionDir/ with size > 0
 *   - no unrendered `{{ … }}` or `{% … %}` left in the output
 *   - all referenced asset paths resolve to files on disk
 *
 * On success, writes `{ ok: true, notes }` into the runner's closure-captured
 * outcome variable.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool } from "../define-tool.js";

// `[^{}]*` accepts any expression Nunjucks allows between delimiters
// (filters `{{ x | tojson }}`, inline conditionals `{{ a if b else c }}`,
// bracket access `{{ d['k'] }}`) but stops at nested braces — which aren't
// valid Nunjucks anyway. The `{%-?` arm covers whitespace-trimming tags.
const UNRENDERED_JINJA = /\{\{[^{}]*\}\}|\{%-?\s*\w/;

/** Terminal outcome the submit-report tool writes into the runner closure. */
export type ReportOutcome = { ok: true; notes: readonly string[] };

export interface SubmitReportToolState {
    readonly versionDir: string;
    readonly assetsDir: string;
    /** Write-through for the runner's closure-captured outcome variable. */
    setOutcome(outcome: ReportOutcome): void;
}

export function createSubmitReportTool(state: SubmitReportToolState): Tool {
    return defineTool({
        id: "submit_report",
        description:
            "Declare the report ready. Validates index.html exists, has no " +
            "unrendered Jinja, and that all referenced asset paths resolve. " +
            "You MUST call this to finish — the runner ignores any other claim " +
            "of success. Returns problems[] when checks fail; fix and re-submit. " +
            "Use `notes` to surface caveats to the caller (e.g. files skipped due " +
            "to the 50MB asset size limit, sections rendered with partial data, " +
            "missing inputs that forced a fallback) — these reach the conversation " +
            "agent and the user in the iteration result.",
        inputSchema: z.object({
            notes: z
                .array(z.string())
                .optional()
                .describe(
                    "Caveats / issues to surface to the caller. One short sentence " +
                        "per item. Examples: 'skipped raw_counts.h5ad (1.2GB > 50MB cap)', " +
                        "'pathway-enrichment section omitted — no GSEA output found'. " +
                        "Leave empty when the report shipped cleanly.",
                ),
        }),
        execute: async (input) => {
            const problems: string[] = [];

            // 1. index.html exists and is non-empty
            const indexPath = join(state.versionDir, "index.html");
            let html: string;
            try {
                const s = await stat(indexPath);
                if (!s.isFile() || s.size === 0) {
                    problems.push("index.html is empty or not a regular file");
                    return ok({ ok: false, problems });
                }
                html = await readFile(indexPath, "utf8");
            } catch {
                problems.push("index.html does not exist — call build_report first");
                return ok({ ok: false, problems });
            }

            // 2. No unrendered Jinja markers
            if (UNRENDERED_JINJA.test(html)) {
                const match = html.match(UNRENDERED_JINJA);
                problems.push(
                    `unrendered Jinja in output (e.g. ${JSON.stringify(match?.[0] ?? "")}); ` +
                        "build_report likely failed silently or report.html.j2 was edited after build",
                );
            }

            // 3. Asset reference resolution
            const refs = extractLocalRefs(html);
            for (const ref of refs) {
                const resolved = resolveLocalRef(ref, state.versionDir, state.assetsDir);
                if (!resolved) {
                    problems.push(`asset reference does not resolve: ${ref}`);
                    continue;
                }
                try {
                    const s = await stat(resolved);
                    if (!s.isFile()) problems.push(`asset reference is not a regular file: ${ref}`);
                } catch {
                    problems.push(`asset reference missing on disk: ${ref}`);
                }
            }

            if (problems.length === 0) {
                const notes = (input.notes ?? []).map((n) => n.trim()).filter(Boolean);
                state.setOutcome({ ok: true, notes });
                return ok({ ok: true, problems: [] as string[] });
            }
            return ok({ ok: false, problems });
        },
    });
}

const SRC_HREF_RE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const FETCH_RE = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/gi;

function extractLocalRefs(html: string): string[] {
    const refs = new Set<string>();
    for (const m of html.matchAll(SRC_HREF_RE)) refs.add(m[1]);
    for (const m of html.matchAll(FETCH_RE)) refs.add(m[1]);
    // Filter to local refs only — drop absolute URLs and data: / blob: schemes.
    const out: string[] = [];
    for (const ref of refs) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // http:, https:, data:, blob:
        if (ref.startsWith("//")) continue; // protocol-relative
        if (ref.startsWith("#")) continue; // anchor
        out.push(ref);
    }
    return out;
}

function resolveLocalRef(ref: string, versionDir: string, assetsDir: string): string | undefined {
    // Strip leading slash, query string, and fragment.
    const cleaned = ref.split("?")[0].split("#")[0].replace(/^\/+/, "");
    if (!cleaned) return undefined;

    const candidate = resolve(versionDir, cleaned);
    // The candidate must stay under either versionDir or assetsDir (the
    // shared assets dir is the symlink target — both are valid roots).
    const inVersion = candidate.startsWith(versionDir + sep) || candidate === versionDir;
    const inAssets = candidate.startsWith(assetsDir + sep) || candidate === assetsDir;
    if (!inVersion && !inAssets) return undefined;
    return candidate;
}
