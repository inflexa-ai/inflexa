/**
 * The report-builder prompt is agent-facing copy — the one layer no
 * typechecker validates. A tool name it states is a promise to the model:
 * naming one the runner never puts on the roster spends a turn on a call that
 * cannot dispatch, and omitting one the runner does construct leaves a
 * capability the model never reaches for. Nothing but review stands behind
 * that promise, so it is pinned mechanically here.
 *
 * How a "tool mention" is recognised, and why not more cheaply. A mention is
 * any id some `defineTool` in this package declares, appearing in the prompt on
 * word boundaries; the vocabulary of declared ids is scanned out of the source
 * rather than written down. Two simpler rules both fail:
 *
 *  - Backtick delimiting alone. `out_of_scope`, `neg_log_padj` and
 *    `sidebar_items` are backticked snake_case tokens naming a tool status
 *    value, a computed column and a template variable — none is a tool, and
 *    `csv`, `bar`, `notes` and `intent` are backticked too.
 *  - Identifier shape alone. `mkdir` and `grep` carry no underscore, so a
 *    snake_case rule misses exactly the names most in need of policing.
 *
 * Deriving the vocabulary from source is what keeps the guard alive over time:
 * a tool added anywhere in the harness immediately becomes a name this prompt
 * may not use unless the builder actually holds it.
 */

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { createVersionFsTools } from "../tools/report/version-fs.js";
import { reportBuilderPrompt } from "./report-builder.js";

const SRC_DIR = join(import.meta.dir, "..");

/**
 * The builder's entire filesystem surface. `createVersionFsTools` touches no
 * disk at construction, so the directory need not exist.
 */
const FILE_TOOL_ROSTER = createVersionFsTools({ versionDir: "/tmp/report-builder-prompt" })
    .map((tool) => tool.id)
    .sort();

/**
 * Tools the prompt names in order to state that the builder does NOT have
 * them. Those are mentions rather than claims, so they sit outside the roster
 * comparison — and each is asserted absent from the roster, so granting one
 * without rewriting the copy fails here.
 */
const DISCLAIMED_TOOLS = ["execute_command", "file_stat", "list_files", "workspace_search"];

/**
 * The builder's non-filesystem tools — the report and preview factories plus
 * the `report-html` skill pair the runner assembles alongside the version-fs
 * surface. Held out so the comparison below sees file tools only.
 */
const NON_FS_BUILDER_TOOLS = ["build_report", "preview_snapshot", "skill_read", "skill_search", "submit_report"];

/** Scanned once: the declared-id set is a property of the package, not of a test. */
const declaredToolIds = scanDeclaredToolIds();

describe("reportBuilderPrompt", () => {
    test("names exactly the file tools the runner constructs", async () => {
        const vocabulary = await declaredToolIds;
        const heldOut = new Set([...DISCLAIMED_TOOLS, ...NON_FS_BUILDER_TOOLS]);

        const mentioned = mentionedToolIds(reportBuilderPrompt, vocabulary).filter((id) => !heldOut.has(id));

        expect(mentioned).toEqual(FILE_TOOL_ROSTER);
    });

    test("the tools it declares unavailable are absent from the file surface", () => {
        expect(FILE_TOOL_ROSTER.filter((id) => DISCLAIMED_TOOLS.includes(id))).toEqual([]);
    });

    test("every tool name it is permitted to use is one the package declares", async () => {
        const vocabulary = await declaredToolIds;
        const permitted = [...FILE_TOOL_ROSTER, ...DISCLAIMED_TOOLS, ...NON_FS_BUILDER_TOOLS];

        // Doubles as the scan's own health check: a vocabulary that silently
        // stopped matching would let any phantom through the comparison above.
        expect(permitted.filter((id) => !vocabulary.has(id))).toEqual([]);
    });

    test("states no capability outside the builder's reach", () => {
        // `grep` is a real workspace tool, but the report runner does not put it
        // on this roster. The comparison above already covers it; naming it
        // makes the failure read as the concrete claim rather than a set diff.
        expect(reportBuilderPrompt).not.toMatch(/\bgrep\b/);

        // The builder's `read_file` is confined to the version directory, so a
        // design-system stylesheet under the shared templates tree has no path
        // it can open. That material reaches it through the `report-html` skill.
        expect(reportBuilderPrompt).not.toContain("theme.css");

        // Preview access lifetime is chosen by the `PreviewPublisher`
        // realization at mint time and is invisible from here, so any figure
        // stated in this prompt is unfalsifiable and drifts from the seam in
        // silence. The prompt states no lifetime at all.
        expect(reportBuilderPrompt).not.toMatch(/\bTTLs?\b/i);

        // A figure offends only when the sentence around it says access ends;
        // the builder's own timing copy is not a lifetime claim. See
        // `LIFETIME_VOCABULARY` for why the trigger is worded the way it is.
        expect(statedAccessLifetimes(reportBuilderPrompt)).toEqual([]);
    });
});

/** Any "N units of time" figure, whatever it is a figure about. */
const DURATION_FIGURE = /\d+\s*-?\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?)\b/gi;

/**
 * Vocabulary that makes a nearby duration a claim about how long access stays
 * good. What the requirement pins is a *stated access lifetime* matching the
 * value the code requests — not duration figures as a class, which the builder
 * has every reason to state about itself.
 *
 * The trigger is therefore verb sense, not subject noun. Keying on
 * preview/access nouns is the obvious reading and the wrong one: the builder's
 * own timing copy names `preview_snapshot` and says what it waits for, so a
 * noun rule flags the tool describing itself — and a guard that fires on honest
 * copy is met by deleting it rather than scoping it, costing the lifetime check
 * entirely. A lifetime claim says access *ends*: it expires, stops working,
 * closes, is gone, no longer works, holds only until some moment — or it bounds
 * the span outright (valid for, good for, lasts). Copy about what a call does
 * while it runs says the tool *waits*, and reaches for none of those.
 *
 * Being a keyword list, this is a floor and not a proof: phrasing outside it
 * ("your link dies at the 15-minute mark") reads as a lifetime to a model and
 * passes here. What it holds is the accidental path — copy edited back toward a
 * concrete figure in the words people reach for first — which is the
 * reintroduction nothing else in the build stands behind.
 */
const LIFETIME_VOCABULARY =
    /\b(?:ttls?|expir\w*|valid|invalid\w*|lifetime|lasts?|good for|access window|until|gone|no longer|cease\w*|close[sd]?|stop(?:s|ped)? working|revoke\w*|unavailable)\b/i;

/** How far either side of a figure still counts as the same sentence. */
const CLAIM_WINDOW = 48;

/**
 * Excerpts of `text` where a duration figure sits next to lifetime vocabulary
 * — i.e. reads as a promise about how long preview access lasts. Returned as
 * excerpts rather than a boolean so a failure shows the offending sentence.
 */
function statedAccessLifetimes(text: string): string[] {
    return [...text.matchAll(DURATION_FIGURE)]
        .map((match) => {
            const start = match.index ?? 0;
            return text.slice(Math.max(0, start - CLAIM_WINDOW), start + match[0].length + CLAIM_WINDOW);
        })
        .filter((excerpt) => LIFETIME_VOCABULARY.test(excerpt));
}

/** Ids from `vocabulary` that appear in `text` on word boundaries, sorted. */
function mentionedToolIds(text: string, vocabulary: ReadonlySet<string>): string[] {
    return [...vocabulary].filter((id) => new RegExp(`\\b${id}\\b`).test(text)).sort();
}

/**
 * Every id declared by a `defineTool` call under `src/`, read from source.
 * Importing them instead would mean constructing every dependency-bearing tool
 * factory in the package — a `Pool`, a sandbox, a provider — to learn a string.
 */
async function scanDeclaredToolIds(): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for (const relative of await readdir(SRC_DIR, { recursive: true })) {
        if (!relative.endsWith(".ts") || relative.endsWith(".test.ts")) continue;
        const source = await readFile(join(SRC_DIR, relative), "utf8");
        for (const match of source.matchAll(/defineTool\(\{\s*id:\s*"([a-z][a-z0-9_]*)"/g)) ids.add(match[1]!);
    }
    return ids;
}
