/**
 * list_launch_dir — a read-only conversation-agent tool that enumerates candidate
 * input files in the analysis's anchor/launch folder (the folder the user launched
 * `inflexa` in), so the agent can surface files that exist on disk but are not yet
 * staged as analysis inputs.
 *
 * The harness's own workspace file tools are scoped to the analysis TREE
 * (`{anchor}/.inflexa/analyses/<slug>/`); the launch folder is its parent and
 * resolves out of scope there. Listing it is a host concept — the harness has no
 * notion of a launch directory — so the CLI injects this tool through the
 * `hostTools` seam. It reuses the staging walk's noise-directory exclusions
 * ({@link IGNORED_WALK_DIRS}) so `.git`/`.inflexa`/tooling noise is never
 * enumerated, and it writes nothing.
 */

import { join, sep } from "node:path";

import { defineTool, scopeResource, type ToolError } from "@inflexa-ai/harness";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { listAnalysisInputs } from "../../db/primary_query.ts";
import { resolveAnchor, resolvedPathOrCached } from "../anchor/anchor.ts";
import { findAnalysis } from "../analysis/analysis.ts";
import { resolveInputPath } from "../analysis/input.ts";
import { IGNORED_WALK_DIRS, walkFiles } from "../staging/staging.ts";
import { statResult } from "../../lib/fs.ts";

/** One candidate file under the launch folder: its anchor-relative path, size, and whether it is already a registered input. */
type LaunchDirEntry = { readonly path: string; readonly size: number; readonly registered: boolean };

/**
 * The tool outcome as data on the ok channel. `no_analysis` means the tool was
 * reached outside an analysis scope (it needs an analysis to resolve an anchor);
 * `no_anchor` means the analysis's home folder could not be located on disk
 * (a moved/deleted anchor — a routine desync, not a fault); `listed` carries the
 * candidates, sorted by path.
 */
type LaunchDirResult =
    | { readonly status: "no_analysis" }
    | { readonly status: "no_anchor" }
    | { readonly status: "error"; readonly message: string }
    | { readonly status: "listed"; readonly folder: string; readonly entries: readonly LaunchDirEntry[] };

/**
 * Build the set that decides whether a walked file is already an input: the absolute
 * paths of file inputs, plus the absolute paths of directory inputs (a file under any
 * of those is covered). Inputs whose anchor cannot be resolved are skipped — they
 * cannot match a file under this folder anyway.
 */
function registrationIndex(analysisId: string): { files: Set<string>; dirs: string[] } {
    const files = new Set<string>();
    const dirs: string[] = [];
    listAnalysisInputs(analysisId).match(
        (inputs) => {
            for (const input of inputs) {
                const abs = resolveInputPath(input).unwrapOr(null);
                if (abs === null) continue;
                if (input.isDir) dirs.push(abs);
                else files.add(abs);
            }
        },
        // A read failure only costs the registered/unregistered marks, never the listing.
        () => {},
    );
    return { files, dirs };
}

function isRegistered(abs: string, index: { files: Set<string>; dirs: string[] }): boolean {
    if (index.files.has(abs)) return true;
    return index.dirs.some((dir) => abs === dir || abs.startsWith(dir + sep));
}

/** Build the `list_launch_dir` conversation tool. Read-only; needs no host deps. */
export function createLaunchDirTool() {
    return defineTool({
        id: "list_launch_dir",
        description:
            "List candidate input files in the folder the user launched `inflexa` in (the analysis's anchor folder). " +
            "Use this when the user refers to data files 'in this folder' (or by name) that may not be staged as inputs yet — " +
            "the workspace file tools cannot see the launch folder, only this can. Each file comes back with its path " +
            "relative to the folder, its size, and whether it is ALREADY a registered input, so you can offer to add only the " +
            "ones that are not. Read-only: it registers nothing — use the input-management tool to actually add files.",
        inputSchema: z.object({}),
        execute: async (_input, ctx): Promise<Result<LaunchDirResult, ToolError>> => {
            const scoped = scopeResource(ctx.session.scope);
            if (scoped.resourceType !== "analysis") return ok({ status: "no_analysis" as const });
            const analysisId = scoped.resourceId;

            const analysis = findAnalysis(analysisId).unwrapOr(null);
            if (!analysis) return ok({ status: "no_anchor" as const });

            const folder = resolveAnchor(analysis.anchorId).map(resolvedPathOrCached).unwrapOr(null);
            if (folder === null) return ok({ status: "no_anchor" as const });

            const walked = walkFiles(folder, IGNORED_WALK_DIRS);
            if (walked.isErr()) return ok({ status: "error" as const, message: `could not read the launch folder: ${walked.error.op}` });

            const index = registrationIndex(analysisId);
            const entries: LaunchDirEntry[] = walked.value
                .map((rel) => {
                    const abs = join(folder, rel);
                    const size = statResult(abs, "list_launch_dir:size")
                        .map((s) => s.size)
                        .unwrapOr(0);
                    return { path: rel, size, registered: isRegistered(abs, index) };
                })
                .sort((a, b) => a.path.localeCompare(b.path));

            return ok({ status: "listed" as const, folder, entries });
        },
    });
}
