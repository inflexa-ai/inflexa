/**
 * link_packages — extend the farm of the analysis with host-staged packages.
 *
 * The tool is the agent face of the `ExtendAnalysisFarm` seam. It exists only
 * when the embedder binds the seam (the harness-sandbox-agents spec): the
 * composition adds it to the always-on substrate, and no `meta.tools`
 * allowlist names it. The realization of the embedder links what the host
 * staged — the tool never installs, downloads, or acquires anything. A link
 * is live in a container that already runs, because the farm rides a bind
 * mount.
 *
 * Each entry is a query in the one grammar of the `package-identity`
 * capability, thus the agent learns one grammar for the plan, the tool, and
 * the prompt layer.
 */

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { parseQuery, type PackageQuery, type ParseQueryError } from "../../sandbox/package-identity.js";
import type { ExtendAnalysisFarm, PackageRequestOutcome } from "../../sandbox/types.js";

export type LinkPackagesDeps = {
    readonly extendAnalysisFarm: ExtendAnalysisFarm;
    readonly analysisId: string;
};

/** The tool result: one outcome per requested query, index-aligned, and what to do about each kind of outcome that occurred. */
export type LinkPackagesResult = {
    readonly outcomes: readonly PackageRequestOutcome[];
    readonly notes?: readonly string[];
};

const OUTCOME_NOTES: Partial<Record<PackageRequestOutcome["kind"], string>> = {
    absent: "`absent`: the store does not hold the package. `acquisitionPossible` says whether the host can acquire it. Report the package as missing, and do not request it again.",
    collision:
        "`collision`: the request resolves to two store directories. For a name that both tracks hold, call again with `python:<name>` or `r:<name>`. If that call also refuses, or the detail names two versions of one distribution, report it and continue without the package.",
    unavailable:
        "`unavailable`: the link pass could not answer, and this says nothing about the package. Report the reason, and do not request the packages again.",
};

/** The guidance for each kind of outcome in `outcomes`, once for each kind, in the order that the kinds first occur. */
function withNotes(outcomes: readonly PackageRequestOutcome[]): LinkPackagesResult {
    const notes = [...new Set(outcomes.map((outcome) => outcome.kind))].flatMap((kind) => OUTCOME_NOTES[kind] ?? []);
    return notes.length === 0 ? { outcomes } : { outcomes, notes };
}

/**
 * The refusal of one entry that is not a query. The text names the entry and
 * the issue, thus the agent corrects the entry it wrote instead of guessing
 * which of its packages the tool refused.
 */
function describeParseError(entry: string, error: ParseQueryError): string {
    switch (error.type) {
        case "empty":
            return `"${entry}" names no package — pass a bare name, or name==version`;
        case "location":
            return `"${entry}" is a location — pass a package name, never a path, a URL, or a store directory`;
        case "unknown_prefix":
            return `"${entry}" carries the prefix "${error.prefix}:", which this tool cannot read — the permitted prefixes are "python:" and "r:", and a bare name searches both tracks`;
        case "unsupported_specifier":
            return `"${entry}" pins with the specifier "${error.specifier}", which this tool cannot honor — pass a bare name, or name==version with one exact version`;
    }
}

/**
 * Call the seam, and give the outcomes or the one reason that the call gave
 * no answer. An `err` and a rejected realization each give that reason, thus
 * no call site sees a throw.
 */
export async function callExtendAnalysisFarm(
    extendAnalysisFarm: ExtendAnalysisFarm,
    analysisId: string,
    queries: readonly PackageQuery[],
): Promise<Result<readonly PackageRequestOutcome[], string>> {
    try {
        return (await extendAnalysisFarm(analysisId, queries)).mapErr((failure) => failure.reason);
    } catch (cause) {
        return err(errorMessageOf(cause) ?? textOf(cause));
    }
}

const LinkPackagesInputSchema = z.object({
    packages: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe(
            'The packages to link into the farm, each as `[python:|r:]<name>[==<version>]`, for example ["scanpy", "r:Seurat", "numpy==1.26.4"]. A bare name searches both tracks.',
        ),
});

export function createLinkPackagesTool(deps: LinkPackagesDeps): Tool<z.infer<typeof LinkPackagesInputSchema>, LinkPackagesResult> {
    return defineTool({
        id: "link_packages",
        description:
            "Link host-staged packages into the farm of this analysis, so an import that failed works without a restart. " +
            "It links what the host already staged, and it never installs, downloads, or acquires anything. " +
            "Pass each module name exactly as the import names it, optionally behind the track prefix `python:` or `r:`, and optionally pinned as `name==version`. " +
            "One outcome comes back for each request: `linked`, `present`, `absent`, `collision`, or `unavailable`; the result says what to do about each.",
        inputSchema: LinkPackagesInputSchema,
        view: "none",
        describeCall: ({ packages }) => packages.join(", "),
        execute: async (input): Promise<Result<LinkPackagesResult, ToolError>> => {
            // Every entry parses before any link lands. A partial link over a
            // batch whose tail is malformed leaves the farm in a state that the
            // agent did not ask for and cannot see.
            const queries: PackageQuery[] = [];
            for (const entry of input.packages) {
                const parsed = parseQuery(entry);
                if (parsed.isErr()) {
                    return err({ error: `link_packages refused the call: ${describeParseError(entry, parsed.error)}`, retryable: true });
                }
                queries.push(parsed.value);
            }
            // A call that gave no answer reads as `unavailable` per query. A
            // raw tool error teaches the agent nothing that `reason` does not.
            const linked = await callExtendAnalysisFarm(deps.extendAnalysisFarm, deps.analysisId, queries);
            if (linked.isErr()) {
                const reason = linked.error;
                return ok(withNotes(queries.map((query) => ({ kind: "unavailable" as const, spelling: query.spelling, reason }))));
            }
            return ok(withNotes(linked.value));
        },
    });
}
