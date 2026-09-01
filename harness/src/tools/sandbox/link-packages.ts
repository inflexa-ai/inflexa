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
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import type { ExtendAnalysisFarm, PackageRequestOutcome } from "../../sandbox/types.js";

export interface LinkPackagesDeps {
    readonly extendAnalysisFarm: ExtendAnalysisFarm;
    readonly analysisId: string;
}

/** The tool result: one outcome per requested package, index-aligned. */
export interface LinkPackagesResult {
    readonly outcomes: readonly PackageRequestOutcome[];
}

export function createLinkPackagesTool(deps: LinkPackagesDeps) {
    return defineTool({
        id: "link_packages",
        description:
            "Link host-staged packages into the farm of this analysis, so an import that failed works without a restart. " +
            "This tool links what the host already staged — it NEVER installs, downloads, or acquires anything. " +
            "Pass each module name verbatim, exactly as the import names it. " +
            "One outcome comes back per request: `linked` (the pool held it, and it is importable now), " +
            "`present` (the farm held it already), " +
            "`absent` (the pool does not hold it — a real answer, and `acquisitionPossible` states whether the host can acquire that ecosystem; report the package as missing, do not retry), " +
            "`collision` (the request resolves to two store directories — terminal for that package; the `detail` names the two pins and the packages that need each; report it and continue without it), " +
            "or `unavailable` (the link pass itself could not answer — the `reason` says why; it says nothing about the package's presence, so report the reason and do not re-request packages).",
        inputSchema: z.object({
            packages: z
                .array(
                    z.object({
                        name: z.string().min(1).describe("The module or package name, verbatim."),
                        version: z.string().optional().describe("One exact version, when the requirement pins one."),
                        ecosystem: z.enum(["python", "r"]).optional().describe("The ecosystem, when the bare name is ambiguous."),
                    }),
                )
                .min(1)
                .max(50)
                .describe("The packages to link into the farm."),
        }),
        describeCall: ({ packages }) => packages.map((p) => p.name).join(", "),
        execute: async (input): Promise<Result<LinkPackagesResult, ToolError>> => {
            // A realization throw reads as `unavailable` per request. The loop
            // would render the throw as a raw tool error, and a raw driver
            // message teaches the agent nothing that `reason` does not.
            try {
                const outcomes = await deps.extendAnalysisFarm(deps.analysisId, input.packages);
                return ok({ outcomes });
            } catch (cause) {
                const reason = cause instanceof Error ? cause.message : String(cause);
                return ok({ outcomes: input.packages.map((request) => ({ kind: "unavailable" as const, name: request.name, reason })) });
            }
        },
    });
}
