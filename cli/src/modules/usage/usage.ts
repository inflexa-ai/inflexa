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

import { getAnalysisUsageTotals, listAnalysisUsageByAgent, listAnalysisUsageByModel, type LlmUsageTotals } from "../../db/primary_query.ts";
import { dieOn } from "../../lib/cli.ts";
import { resolveSingleAnalysis, type ContextFlags } from "../analysis/context.ts";

/** The `empty`-context hint for the usage command (see `resolveSingleAnalysis`). */
const EMPTY_HINT = "No analysis here. Run `inflexa` to start or open one, then ask what it has consumed.";

/**
 * Printed in place of any quantity the provider never reported. Deliberately a WORD, not a dash and
 * never a `0`: the ledger's central discipline is that an absent figure is an unknown rather than a
 * measurement, and a report that renders it as zero erases exactly the distinction the nullable
 * columns exist to preserve. One spelling in the headline and in both tables, so a reader never has
 * to learn two vocabularies for the same fact.
 */
const NOT_REPORTED = "not reported";

/** Group label for calls whose endpoint reported no served model id — the absence of an id, not a model actually named this. */
const NO_SERVED_MODEL = "(not reported)";

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
