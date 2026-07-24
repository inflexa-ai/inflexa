/**
 * `inflexa inputs` command actions — the TERMINAL surface for managing an analysis's
 * inputs (`add`/`remove`/`ls`). The agent does NOT reach these: `add`/`remove` are
 * agent-blocked (the conversation agent uses the in-process `manage_inputs` tool
 * instead, per the provenance single-writer discipline); this is for a human at a
 * shell, and for a standalone add/remove when no chat is open.
 *
 * `add`/`remove` acquire the per-analysis instance lock and refuse if a live instance
 * holds it, so a standalone mutation can never write provenance concurrently with an
 * open chat. The lock is released by the process-exit hook (`src/index.ts`). Mutation
 * is register-only — it stages nothing and boots no runtime; the parity engine
 * re-profiles on the next open.
 */

import { existsSync } from "node:fs";

import { dieOn, fail } from "../../lib/cli.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { addInputs, removeInput } from "./analysis.ts";
import { expandAndResolve, matchInputRefs } from "./input.ts";
import { claimAnalysisOrFail, resolveSingleAnalysis, type ContextFlags } from "./context.ts";

/** The `empty`-context hint for the inputs commands (see `resolveSingleAnalysis`). */
const EMPTY_HINT = "No analysis here. Run `inflexa` to start or open one, then manage its inputs.";

/** The refusal tail for a standalone add/remove blocked by a live instance (see `claimAnalysisOrFail`). */
const HELD_REMEDY = "Add or remove inputs there, or close it and re-run.";

/** `inflexa inputs ls` — list the analysis's current registered inputs. Read-only. */
export function runInputsLs(flags: ContextFlags): void {
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT);
    const inputs = listAnalysisInputs(analysis.id).match((v) => v, dieOn("Failed to read inputs"));
    if (inputs.length === 0) {
        console.log(`  "${analysis.name}" has no inputs. Add some with \`inflexa inputs add <paths...>\`.`);
        return;
    }
    console.log(`  Inputs for "${analysis.name}":`);
    for (const input of inputs) console.log(`    ${input.isDir ? "dir " : "file"}  ${input.path}${input.anchorId === null ? "  (absolute)" : ""}`);
}

/** `inflexa inputs add <paths...>` — register files as inputs after verifying they exist. */
export function runInputsAdd(flags: ContextFlags, paths: string[]): void {
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT);
    // Pre-check for a precise, path-named message before mutating; addInputs re-checks authoritatively.
    const missing = paths.filter((p) => !existsSync(expandAndResolve(process.cwd(), p)));
    if (missing.length > 0) fail(`no such file: ${missing.join(", ")}`);

    claimAnalysisOrFail(analysis, HELD_REMEDY);
    const added = addInputs(analysis.id, paths, process.cwd()).match(
        (v) => v,
        (e) =>
            e.type === "query_failed" && e.op === "classifyInputPath:notFound"
                ? fail(`no such file among: ${paths.join(", ")}`)
                : dieOn("Failed to add inputs")(e),
    );
    console.log(
        added.length === 0
            ? `  Nothing new to add — those paths are already inputs of "${analysis.name}".`
            : `  Added ${added.length} input(s) to "${analysis.name}": ${added.map((i) => i.path).join(", ")}`,
    );
}

/** `inflexa inputs remove <paths...>` — drop inputs, matching the registered set (no on-disk check). */
export function runInputsRemove(flags: ContextFlags, paths: string[]): void {
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT);
    claimAnalysisOrFail(analysis, HELD_REMEDY);
    const current = listAnalysisInputs(analysis.id).match((v) => v, dieOn("Failed to read inputs"));
    const { matched, notInputs } = matchInputRefs(current, paths, process.cwd());

    const removed: string[] = [];
    for (const target of matched) {
        const result = removeInput(target).match((v) => v, dieOn("Failed to remove input"));
        if (result !== null) removed.push(target.path);
    }
    if (removed.length > 0) console.log(`  Removed from "${analysis.name}": ${removed.join(", ")}`);
    if (notInputs.length > 0) console.log(`  Not current inputs (skipped): ${notInputs.join(", ")}`);
    if (removed.length === 0 && notInputs.length === 0) console.log(`  Nothing to remove.`);
}
