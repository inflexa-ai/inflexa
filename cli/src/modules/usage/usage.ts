/**
 * `inflexa usage` — the local answer to "what has this analysis consumed", read straight from the
 * SQLite ledger the harness's usage-recorder seam writes into.
 *
 * READ-ONLY and engine-free by construction: the report touches nothing but the local database, so it
 * answers while the durable engine, its Postgres, and the model proxy are all cold. That is the whole
 * reason the ledger is CLI-owned local storage rather than a table inside the harness's own database
 * — a report about tokens already spent must not require the engine that spent them to be running.
 *
 * The five token quantities are NEVER added together, here or on any other surface. Cache-write,
 * cache-read, and reasoning counts are breakdowns OF the input and output counts (a provider reports
 * them as details of those two), so a single summed "total tokens" would count a cached prefix twice
 * and reasoning twice. Consumption is therefore two figures, with the other three nested under the
 * figure each one details.
 */

import {
    getAnalysisUnattributedUsageTotals,
    getAnalysisUsageTotals,
    listAnalysisUsageByAgent,
    listAnalysisUsageByModel,
    listAnalysisUsageByRun,
    listAnalysisUsageBySession,
    listRunUsageByStep,
    type LlmUsageTotals,
} from "../../db/primary_query.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import { resolveSingleAnalysis, type ContextFlags } from "../analysis/context.ts";

/** The `empty`-context hint for the usage command (see `resolveSingleAnalysis`). */
const EMPTY_HINT = "No analysis here. Run `inflexa` to start or open one, then ask what it has consumed.";

/**
 * Rendered in place of any quantity the provider never reported. Deliberately a WORD, not a dash and
 * never a `0`: the ledger's central discipline is that an absent figure is an unknown rather than a
 * measurement, and a surface that renders it as zero erases exactly the distinction the nullable
 * columns exist to preserve. One spelling in the headline and in every table, so a reader never has
 * to learn two vocabularies for the same fact.
 *
 * Exported because the TUI's usage dialog reports the same figures and must say the same word. It is
 * the vocabulary that is shared, not the composition — the dialog paints label and figure in
 * different theme roles, which a pre-joined line cannot express.
 */
export const NOT_REPORTED = "not reported";

/** Group label for calls whose endpoint reported no served model id — the absence of an id, not a model actually named this. */
const NO_SERVED_MODEL = `(${NOT_REPORTED})`;

/**
 * Row label for calls belonging to NEITHER a session nor a run — background and boot-time work, which
 * runs under an analysis scope carrying no frame of either kind.
 *
 * The same row appears in the session report AND in the run report, which is deliberate: it is one set
 * of calls, and each grain has to name it or its own table would not account for everything the
 * analysis headline holds. The label says exactly which absence it is, so a reader of either table
 * never mistakes it for "the calls this grain missed".
 */
const NO_FRAME = "(no session or run)";

/** Row label for a run's calls that ran outside any step — its plan and synthesis frames. */
const NO_STEP = "(no step)";

function figure(value: number | undefined): string {
    return value === undefined ? NOT_REPORTED : value.formatTokens();
}

function plural(n: number, one: string): string {
    return `${n} ${n === 1 ? one : `${one}s`}`;
}

/**
 * Render `rows` as columns padded to their widest cell. Local to this module on purpose: the tree
 * already carries three private table helpers and shares none of them, so a fourth stays beside its
 * only caller rather than becoming a cross-module import that nothing else asked for.
 */
function alignedLines(rows: readonly (readonly string[])[], rightAligned: readonly boolean[], indent: string): string[] {
    const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
    return rows.map((r) => (indent + r.map((c, i) => (rightAligned[i] ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0))).join("  ")).trimEnd());
}

/**
 * The two headline figures, with each breakdown nested under the figure it details — cache writes and
 * cache reads under input, reasoning under output. A breakdown line is omitted entirely when its
 * quantity is absent: nesting is what states the relationship, and an omitted line stays
 * distinguishable from a reported `0`, which does print.
 */
function headlineLines(totals: LlmUsageTotals): string[] {
    const rows: string[][] = [["input", figure(totals.inputTokens)]];
    if (totals.cacheCreationInputTokens !== undefined) rows.push(["  cache write", totals.cacheCreationInputTokens.formatTokens()]);
    if (totals.cacheReadInputTokens !== undefined) rows.push(["  cache read", totals.cacheReadInputTokens.formatTokens()]);
    rows.push(["output", figure(totals.outputTokens)]);
    if (totals.reasoningTokens !== undefined) rows.push(["  reasoning", totals.reasoningTokens.formatTokens()]);
    return alignedLines(rows, [false, true], "    ");
}

/** One breakdown table: the grouping column named by `header`, then the group's call count and its two figures. */
function breakdownLines(header: string, groups: readonly { label: string; totals: LlmUsageTotals }[]): string[] {
    const rows: string[][] = [
        [header, "calls", "input", "output"],
        ...groups.map((g) => [g.label, String(g.totals.calls), figure(g.totals.inputTokens), figure(g.totals.outputTokens)]),
    ];
    return alignedLines(rows, [false, true, true, true], "    ");
}

/** `inflexa usage [--analysis <id|name>]` — report an analysis's recorded LLM consumption, by served model and by agent. */
export function runUsage(flags: ContextFlags): void {
    // `touch: false` — a report is not a sighting. This command carries an `auto` agent policy, so an
    // agent may run it unprompted; a heartbeat here would make the anchor's `lastSeen` measure agent
    // polling rather than the user's presence, and would make a command classified as read-only write.
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT, { touch: false });
    const totals = getAnalysisUsageTotals(analysis.id).match((t) => t, dieOn("Failed to read usage"));

    // The call COUNT, not the token figures, is what separates "nothing has been spent here yet" from
    // "calls ran whose provider reported no figures". The second is a legitimate report and prints as
    // one; the first is not a report at all and must not be dressed up as zeroed figures or an empty
    // table, which would read as "this analysis spent nothing" — a claim the ledger cannot make.
    if (totals.calls === 0) {
        console.log(`\n  No usage recorded for "${analysis.name}".\n`);
        return;
    }

    const byModel = listAnalysisUsageByModel(analysis.id).match((g) => g, dieOn("Failed to read usage by model"));
    const byAgent = listAnalysisUsageByAgent(analysis.id).match((g) => g, dieOn("Failed to read usage by agent"));

    console.log(`\n  Usage for "${analysis.name}" — ${plural(totals.calls, "call")}\n`);
    for (const line of headlineLines(totals)) console.log(line);

    console.log("\n  By served model\n");
    const modelGroups = byModel.map((g) => ({ label: g.servedModelId ?? NO_SERVED_MODEL, totals: g.totals }));
    for (const line of breakdownLines("model", modelGroups)) console.log(line);

    console.log("\n  By agent\n");
    const agentGroups = byAgent.map((g) => ({ label: g.agentId, totals: g.totals }));
    for (const line of breakdownLines("agent", agentGroups)) console.log(line);
    console.log();
}

// --- The where-it-ran grains ---
//
// Subcommands rather than flags on the report above. Every grain is a read, so the effect class does
// not change — but the same instinct the house rule encodes applies to the agent surface: each grain
// is separately classified, and a grain added later cannot silently widen an existing command's
// safe-flag allowlist. It also fixes each subcommand's output shape, which matters for a report an
// agent may parse.
//
// All three resolve their analysis with `touch: false`, exactly as `runUsage` does: reporting is not a
// sighting, and each carries an `auto` policy an agent may run unprompted.

/**
 * Print one grain's table, or say plainly that the grain recorded nothing.
 *
 * The emptiness test is `groups.length === 0` — whether the grain has GROUPS, not whether they carry
 * figures. A grain holding groups whose providers reported nothing is a report and prints as one; a
 * grain holding no groups is not a report at all, and an empty table or a zeroed row would read as
 * "this analysis spent nothing here", which is a claim the ledger cannot make.
 */
function printGrain(heading: string, column: string, groups: readonly { label: string; totals: LlmUsageTotals }[], emptyLine: string): void {
    if (groups.length === 0) {
        console.log(`\n  ${emptyLine}\n`);
        return;
    }
    console.log(`\n  ${heading}\n`);
    for (const line of breakdownLines(column, groups)) console.log(line);
    console.log();
}

/** `inflexa usage sessions [--analysis <id|name>]` — what each of the analysis's conversations consumed. */
export function runUsageSessions(flags: ContextFlags): void {
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT, { touch: false });
    const sessions = listAnalysisUsageBySession(analysis.id).match((g) => g, dieOn("Failed to read usage by session"));
    const unattributed = getAnalysisUnattributedUsageTotals(analysis.id).match((t) => t, dieOn("Failed to read unattributed usage"));

    // A session's figures cover its own chat turns; a run launched from that conversation reports
    // under `usage runs`, because attribution follows the frame the call actually ran in.
    const groups = sessions.map((g) => ({ label: g.threadId, totals: g.totals }));
    if (unattributed.calls > 0) groups.push({ label: NO_FRAME, totals: unattributed });

    printGrain(`Sessions for "${analysis.name}"`, "session", groups, `No session usage recorded for "${analysis.name}".`);
}

/** `inflexa usage runs [--analysis <id|name>]` — what each of the analysis's runs consumed. */
export function runUsageRuns(flags: ContextFlags): void {
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT, { touch: false });
    const runs = listAnalysisUsageByRun(analysis.id).match((g) => g, dieOn("Failed to read usage by run"));
    const unattributed = getAnalysisUnattributedUsageTotals(analysis.id).match((t) => t, dieOn("Failed to read unattributed usage"));

    const groups = runs.map((g) => ({ label: g.runId, totals: g.totals }));
    if (unattributed.calls > 0) groups.push({ label: NO_FRAME, totals: unattributed });

    printGrain(`Runs for "${analysis.name}"`, "run", groups, `No run usage recorded for "${analysis.name}".`);
}

/** A run id with its dashes removed — the space an abbreviation is matched against from the right. */
function bareId(id: string): string {
    return id.replace(/-/g, "");
}

/** Flags for the step grain: the analysis selector plus the run whose steps to report. */
export type StepGrainFlags = ContextFlags & {
    /** The run, as its full id or as a trailing abbreviation of one (the tail every other surface prints). */
    run: string;
};

/**
 * `inflexa usage steps --run <id> [--analysis <id|name>]` — what each step of one run consumed.
 *
 * `--run` accepts a trailing abbreviation as well as the full id, because the id tail is what the
 * sidebar and the usage dialog print — a user reading a figure there and reaching for this command has
 * the tail, not the uuid. The candidate set is the analysis's runs that HAVE ledger rows, which is the
 * same aggregate this command reports over, so the match costs no extra query and an abbreviation that
 * names two of them is reported as ambiguous rather than silently resolving to the first: two runs'
 * steps blended into one table would be wrong in a way nothing on screen could reveal.
 */
export function runUsageSteps(flags: StepGrainFlags): void {
    const analysis = resolveSingleAnalysis(flags, EMPTY_HINT, { touch: false });
    const runs = listAnalysisUsageByRun(analysis.id).match((g) => g, dieOn("Failed to read usage by run"));

    const ref = bareId(flags.run);
    const exact = runs.find((r) => r.runId === flags.run);
    const candidates = exact ? [exact] : runs.filter((r) => ref.length > 0 && bareId(r.runId).endsWith(ref));
    if (candidates.length > 1) {
        fail(`Ambiguous run "${flags.run}" — ${candidates.length} runs match:\n${candidates.map((r) => `  ${r.runId}`).join("\n")}`);
    }
    const run = candidates[0];
    if (!run) {
        console.log(`\n  No usage recorded for run "${flags.run}" in "${analysis.name}".\n`);
        return;
    }

    const steps = listRunUsageByStep(analysis.id, run.runId).match((g) => g, dieOn("Failed to read usage by step"));
    const groups = steps.map((g) => ({ label: g.stepId ?? NO_STEP, totals: g.totals }));

    // The full run id in the heading whatever the caller typed: an abbreviation is an input convenience,
    // never the identity, and the report must name the run it actually read.
    printGrain(`Steps for run ${run.runId} in "${analysis.name}"`, "step", groups, `No step usage recorded for run ${run.runId}.`);
}
