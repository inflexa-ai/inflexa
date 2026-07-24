/**
 * manage_inputs — an IN-PROCESS conversation-agent tool that adds, removes, and
 * lists an analysis's inputs during a live chat.
 *
 * It must run in-process (not via the `run_inflexa` subprocess) for two reasons the
 * design records: the CLI event `Bus` is in-process only, so a subprocess's
 * `prov.input_added` would never reach the running chat's profile-parity watcher;
 * and provenance is a per-process signed chain guarded by the analysis instance
 * lock, so a second (subprocess) writer would be refused by the lock or fork the
 * chain. Running here, the shared `addInputs`/`removeInput` mutate under the lock the
 * open chat already holds, the recorder appends coherently, and the in-process
 * `prov.input_*` event drives re-profiling for free. The `inputs add`/`remove`
 * subcommands are the TERMINAL surface and are agent-blocked; the agent uses this.
 */

import { existsSync } from "node:fs";

import { defineTool, scopeResource, type AskRequest, type ToolError } from "@inflexa-ai/harness";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { listAnalysisInputs } from "../../db/primary_query.ts";
import { holdsInstanceLock } from "../../lib/lock.ts";
import { resolveAnchor, resolvedPathOrCached } from "../anchor/anchor.ts";
import { addInputs, findAnalysis, removeInput } from "../analysis/analysis.ts";
import { expandAndResolve, matchInputRefs } from "../analysis/input.ts";

/** A current input as reported to the agent. */
type InputEntry = { readonly path: string; readonly isDir: boolean; readonly anchored: boolean };

/**
 * The tool outcome as data on the ok channel. `no_analysis` means there is no analysis to act
 * on — reached outside an analysis scope, or the scoped analysis row is gone; `no_anchor` means
 * the analysis exists but its home folder could not be located on disk (a moved/deleted anchor —
 * a routine desync, not a fault); `error` is a genuine fault (a DB failure, or a rejected mutation).
 */
type ManageInputsResult =
    | { readonly status: "no_analysis" }
    | { readonly status: "no_anchor" }
    | { readonly status: "not_found"; readonly missing: readonly string[] }
    | { readonly status: "added"; readonly added: readonly string[] }
    | { readonly status: "removed"; readonly removed: readonly string[]; readonly notInputs: readonly string[] }
    | { readonly status: "listed"; readonly inputs: readonly InputEntry[] }
    | { readonly status: "error"; readonly message: string };

/** The analysis's anchor/launch folder on disk, or null when it can't be located (moved/deleted anchor). */
function anchorFolder(anchorId: string): string | null {
    return resolveAnchor(anchorId).map(resolvedPathOrCached).unwrapOr(null);
}

function askRequest(action: "add" | "remove", analysisId: string, paths: readonly string[]): AskRequest {
    return {
        title: action === "add" ? "Add analysis inputs" : "Remove analysis inputs",
        command: `${action} inputs: ${paths.join(", ")}`,
        detail: `Approving "always" lets the agent ${action} inputs in this analysis without asking each time.`,
        grantKey: `manage_inputs:${action}:${analysisId}`,
    };
}

/** Build the in-process `manage_inputs` conversation tool. */
export function createManageInputsTool() {
    return defineTool({
        id: "manage_inputs",
        description:
            "Add, remove, or list this analysis's input files DURING the chat. Use `add` to register files the user " +
            "wants analyzed (discover candidates with list_launch_dir first); `remove` to drop inputs; `list` to see the " +
            "current inputs. Adding verifies each path EXISTS on disk and rejects a name that does not, so do not invent " +
            "filenames — add only files you have confirmed. Removing matches the current input set (a file already deleted " +
            "from disk can still be removed). Adds and removes ask the user to confirm. This registers inputs so the " +
            "analysis re-profiles them; it does not stage or run anything itself.",
        inputSchema: z.object({
            action: z.enum(["add", "remove", "list"]).describe("What to do: add files as inputs, remove current inputs, or list current inputs."),
            paths: z
                .array(z.string())
                .optional()
                .describe("Files to add or remove (relative to the launch folder, or absolute). Required for add/remove; ignored for list."),
        }),
        execute: async (input, ctx): Promise<Result<ManageInputsResult, ToolError>> => {
            const scoped = scopeResource(ctx.session.scope);
            if (scoped.resourceType !== "analysis") return ok({ status: "no_analysis" as const });
            const analysisId = scoped.resourceId;

            // Keep the three ways this can miss distinct: a real DB fault is an `error` (not a
            // silently-degraded `no_anchor`); a vanished analysis row is `no_analysis` (nothing to act
            // on); only an anchor folder that cannot be located on disk is `no_anchor`.
            const found = findAnalysis(analysisId);
            if (found.isErr()) return ok({ status: "error" as const, message: `could not load the analysis: ${found.error.type}` });
            if (!found.value) return ok({ status: "no_analysis" as const });
            const cwd = anchorFolder(found.value.anchorId);
            if (cwd === null) return ok({ status: "no_anchor" as const });

            if (input.action === "list") {
                const inputs = listAnalysisInputs(analysisId);
                if (inputs.isErr()) return ok({ status: "error" as const, message: `could not read inputs: ${inputs.error.type}` });
                return ok({
                    status: "listed" as const,
                    inputs: inputs.value.map((i) => ({ path: i.path, isDir: i.isDir, anchored: i.anchorId !== null })),
                });
            }

            const paths = input.paths ?? [];
            if (paths.length === 0) return ok({ status: "error" as const, message: `${input.action} requires at least one path` });

            // Defense-in-depth for the single-writer provenance invariant (design D4): a mutation must run
            // in the process that holds the analysis lock. The conversation agent is hosted by the open
            // chat, which holds it — but assert rather than assume, so this tool can never append the
            // signed provenance chain from a process that does not own it.
            if (!holdsInstanceLock(analysisId)) {
                return ok({
                    status: "error" as const,
                    message: "this analysis is not held by the current process — input changes must run inside the open chat",
                });
            }

            if (input.action === "add") {
                // Pre-check existence for a precise, path-named message before mutating. `addInputs`
                // re-validates authoritatively (via classifyInputPath) — this only sharpens the error.
                const missing = paths.filter((p) => !existsSync(expandAndResolve(cwd, p)));
                if (missing.length > 0) return ok({ status: "not_found" as const, missing });

                // ctx.ask throws AskRejectedError on denial; deliberately not caught — the loop maps it.
                await ctx.ask(askRequest("add", analysisId, paths));
                const added = addInputs(analysisId, paths, cwd);
                if (added.isErr()) {
                    const e = added.error;
                    if (e.type === "query_failed" && e.op === "classifyInputPath:notFound") return ok({ status: "not_found" as const, missing: paths });
                    return ok({ status: "error" as const, message: `could not add inputs: ${e.type}` });
                }
                return ok({ status: "added" as const, added: added.value.map((i) => i.path) });
            }

            // action === "remove"
            const current = listAnalysisInputs(analysisId);
            if (current.isErr()) return ok({ status: "error" as const, message: `could not read inputs: ${current.error.type}` });
            const { matched, notInputs } = matchInputRefs(current.value, paths, cwd);
            if (matched.length === 0) return ok({ status: "removed" as const, removed: [], notInputs });

            await ctx.ask(
                askRequest(
                    "remove",
                    analysisId,
                    matched.map((i) => i.path),
                ),
            );
            const removed: string[] = [];
            for (const target of matched) {
                const r = removeInput(target);
                if (r.isErr()) {
                    // Name what was already removed (and emitted prov.input_removed for) before the fault,
                    // so the agent sees the remove partially applied instead of reading it as a clean no-op.
                    const done = removed.length > 0 ? ` (already removed: ${removed.join(", ")})` : "";
                    return ok({ status: "error" as const, message: `could not remove ${target.path}: ${r.error.type}${done}` });
                }
                if (r.value !== null) removed.push(target.path);
            }
            return ok({ status: "removed" as const, removed, notInputs });
        },
    });
}
