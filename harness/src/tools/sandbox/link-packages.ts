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

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { parseQuery, type PackageQuery, type ParseQueryError } from "../../sandbox/package-identity.js";
import type { ExtendAnalysisFarm, PackageRequestOutcome } from "../../sandbox/types.js";

export interface LinkPackagesDeps {
    readonly extendAnalysisFarm: ExtendAnalysisFarm;
    readonly analysisId: string;
}

/** The tool result: one outcome per requested query, index-aligned. */
export interface LinkPackagesResult {
    readonly outcomes: readonly PackageRequestOutcome[];
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

export function createLinkPackagesTool(deps: LinkPackagesDeps) {
    return defineTool({
        id: "link_packages",
        description:
            "Link host-staged packages into the farm of this analysis, so an import that failed works without a restart. " +
            "This tool links what the host already staged — it NEVER installs, downloads, or acquires anything. " +
            "Pass each module name verbatim, exactly as the import names it, optionally behind the track prefix `python:` or `r:` and optionally pinned as `name==version`. " +
            "One outcome comes back per request: `linked` (the pool held it, and it is importable now), " +
            "`present` (the farm held it already), " +
            "`absent` (the pool does not hold it — a real answer, and `acquisitionPossible` states whether the host can acquire that ecosystem; report the package as missing, do not retry), " +
            "`collision` (the request resolves to two store directories; the `detail` names the two pins and the packages that need each), " +
            "or `unavailable` (the link pass itself could not answer — the `reason` says why; it says nothing about the package's presence, so report the reason and do not re-request packages). " +
            "After a `collision` of one name that BOTH tracks hold, call this tool again for that package with the prefixed form, `python:<name>` or `r:<name>`. " +
            "A collision is terminal only after that second call also refuses, or when it names two versions of one distribution — then report it and continue without the package.",
        inputSchema: z.object({
            packages: z
                .array(z.string().min(1))
                .min(1)
                .max(50)
                .describe(
                    'The packages to link into the farm, each as `[python:|r:]<name>[==<version>]`, for example ["scanpy", "r:Seurat", "numpy==1.26.4"]. A bare name searches both tracks.',
                ),
        }),
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
            // A realization throw reads as `unavailable` per query. The loop
            // would render the throw as a raw tool error, and a raw driver
            // message teaches the agent nothing that `reason` does not.
            try {
                const outcomes = await deps.extendAnalysisFarm(deps.analysisId, queries);
                return ok({ outcomes });
            } catch (cause) {
                const reason = cause instanceof Error ? cause.message : String(cause);
                return ok({ outcomes: queries.map((query) => ({ kind: "unavailable" as const, spelling: query.spelling, reason })) });
            }
        },
    });
}
