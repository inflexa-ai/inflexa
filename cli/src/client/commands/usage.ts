/**
 * `inflexa usage` — the local answer to "what has this analysis consumed", from the usage ledger of the
 * local server (`GET {A}/usage`).
 *
 * The ledger is SQLite that the CLI owns, thus the report answers while the durable engine, its Postgres,
 * and the model proxy are all cold: a report about tokens already spent must not need the engine that
 * spent them.
 *
 * The five token quantities are NEVER added together, here or on any other surface. Cache-write,
 * cache-read, and reasoning counts are breakdowns OF the input and output counts (a provider reports
 * them as details of those two), so a single summed "total tokens" would count a cached prefix twice
 * and reasoning twice. Consumption is therefore two figures, with the other three nested under the
 * figure each one details.
 */

import type { UsageGroup, UsageTotals, UsageView } from "../../api/usage.ts";
import { fail } from "../../lib/cli.ts";
import { NOT_REPORTED } from "../../lib/usage_format.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientError, type ClientOpts } from "../api.ts";
import { fetchUsage } from "../usage.ts";

/** The analysis that a usage report reads: the id for the route, the name for the headings. */
export type UsageAnalysis = { id: string; name: string };

/**
 * Group label for a group whose key the ledger holds no value for: in the model grouping, the calls whose
 * endpoint reported no served model id — the absence of an id, not a model actually named this. The
 * agent, session, and run groupings always carry a key.
 */
const NO_KEY = `(${NOT_REPORTED})`;

/**
 * Row label for calls belonging to NEITHER a session nor a run — background and boot-time work, which
 * runs under an analysis scope carrying no frame of either kind. The label says exactly which absence
 * it is, so it is never read as "the calls this table missed".
 *
 * It labels a row in ONE report: the analysis report below, beside the headline these calls are part
 * of. See `usageRuns` for why the grain tables name the bucket without carrying its figures.
 */
const NO_FRAME = "(no session or run)";

/**
 * The grain reports' signpost to the bucket they do not carry. Deliberately carries NO figure — not
 * the token counts, not even the call count — because the whole point of moving the bucket out of the
 * grain tables is that its figures live in exactly one printed report; a count here would put one of
 * them back into two, which is the same defect in smaller type.
 */
const UNATTRIBUTED_SIGNPOST = "Calls belonging to no session or run are reported by `inflexa usage`.";

/**
 * The grain reports' signpost to the data profile, on the same figure-free terms as
 * {@link UNATTRIBUTED_SIGNPOST}.
 *
 * It matters most in `usage runs`, where the profile's rows used to print as a run: a reader who saw
 * them there and no longer does needs to be told they moved rather than left. `usage sessions` carries
 * it for the same reason it carries the unattributed one — the profile stamps no thread, so it can
 * never appear under a session either, and a grain report that stays silent about consumption it
 * structurally cannot hold is where a reader starts doubting the ledger.
 */
const DATA_PROFILE_SIGNPOST = "The data profile's calls are reported by `inflexa usage`.";

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
function headlineLines(totals: UsageTotals): string[] {
    const rows: string[][] = [["input", figure(totals.inputTokens)]];
    if (totals.cacheCreationInputTokens !== undefined) rows.push(["  cache write", totals.cacheCreationInputTokens.formatTokens()]);
    if (totals.cacheReadInputTokens !== undefined) rows.push(["  cache read", totals.cacheReadInputTokens.formatTokens()]);
    rows.push(["output", figure(totals.outputTokens)]);
    if (totals.reasoningTokens !== undefined) rows.push(["  reasoning", totals.reasoningTokens.formatTokens()]);
    return alignedLines(rows, [false, true], "    ");
}

/** One breakdown table: the grouping column named by `header`, then the group's call count and its two figures. */
function breakdownLines(header: string, groups: readonly { label: string; totals: UsageTotals }[]): string[] {
    const rows: string[][] = [
        [header, "calls", "input", "output"],
        ...groups.map((g) => [g.label, String(g.totals.calls), figure(g.totals.inputTokens), figure(g.totals.outputTokens)]),
    ];
    return alignedLines(rows, [false, true, true, true], "    ");
}

/** The groups of a view, labelled. A `null` key takes `absent`, the label of the absence that the grouping names. */
function labelled(view: UsageView, absent: string): { label: string; totals: UsageTotals }[] {
    return (view.groups ?? []).map((g: UsageGroup) => ({ label: g.key ?? absent, totals: g.totals }));
}

/** The read of a report, or the end of the command with the cause. */
async function read(analysis: UsageAnalysis, query: Parameters<typeof fetchUsage>[1], opts: ClientOpts): Promise<UsageView> {
    return (await fetchUsage(analysis.id, query, opts)).match(
        (view) => view,
        (e) => fail(describeClientError(e)),
    );
}

/** The data profile and the unattributed calls of an analysis view. The server always sends them for the analysis scope. */
function grainsOf(view: UsageView): { dataProfile: UsageTotals; unattributed: UsageTotals } {
    return view.grains ?? { dataProfile: { calls: 0 }, unattributed: { calls: 0 } };
}

/** `inflexa usage [--analysis <id|name>]` — report an analysis's recorded LLM consumption, by served model and by agent. */
export async function usageReport(analysis: UsageAnalysis, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const byModel = await read(analysis, { by: "model" }, opts);
    const totals = byModel.totals;

    // The call COUNT, not the token figures, is what separates "nothing has been spent here yet" from
    // "calls ran whose provider reported no figures". The second is a legitimate report and prints as
    // one; the first is not a report at all and must not be dressed up as zeroed figures or an empty
    // table, which would read as "this analysis spent nothing" — a claim the ledger cannot make.
    if (totals.calls === 0) {
        console.log(`\n  No usage recorded for "${analysis.name}".\n`);
        return;
    }

    // Two reads, one for each grouping. They can straddle a call that lands between them, and then the
    // agent table counts one call more than the headline. A report is read when the analysis is idle,
    // thus the window is accepted rather than a grouping parameter that takes two values.
    const byAgent = await read(analysis, { by: "agent" }, opts);
    const { dataProfile, unattributed } = grainsOf(byModel);

    console.log(`\n  Usage for "${analysis.name}" — ${plural(totals.calls, "call")}\n`);
    for (const line of headlineLines(totals)) console.log(line);

    // The data profile is a grain of its own, not a run — it has no run row, no run listing shows it,
    // and it is the only grain that runs at most once per analysis. That last part is why it prints as
    // a nested figure block like the headline rather than as a one-row table: there is nothing to
    // enumerate, and the block carries the cache breakdown a profile's long cached prefixes actually
    // produce, which a two-column grain table would drop.
    //
    // Its calls stay in the by-model and by-agent tables below — those are analysis-wide and always
    // were. The grain sections partition WHERE the work ran; the breakdown tables cut the same
    // headline a different way, and reporting a call in both is not double-counting.
    if (dataProfile.calls > 0) {
        console.log(`\n  Data profile — ${plural(dataProfile.calls, "call")}\n`);
        for (const line of headlineLines(dataProfile)) console.log(line);
    }

    // Where the where-it-ran partition reconciles, and the ONLY report that carries the unattributed
    // figures. The grain subcommands each print one grain; this report prints the headline, so it is
    // the one place a bucket that belongs to no grain can be named without a reader having to decide
    // which table it is a member of. Printing it in `usage sessions` AND `usage runs` — one set of
    // calls in two tables — meant summing the two printed reports counted it twice, and it summed
    // into a grain column it was never a member of.
    //
    // Shown only when it holds calls, matching the usage dialog: a section announcing the absence of
    // work that never happened is noise, not information.
    if (unattributed.calls > 0) {
        console.log("\n  Unattributed\n");
        for (const line of breakdownLines("where", [{ label: NO_FRAME, totals: unattributed }])) console.log(line);
    }

    console.log("\n  By served model\n");
    for (const line of breakdownLines("model", labelled(byModel, NO_KEY))) console.log(line);

    console.log("\n  By agent\n");
    for (const line of breakdownLines("agent", labelled(byAgent, NO_KEY))) console.log(line);
    console.log();
}

// --- The where-it-ran grains ---
//
// Subcommands rather than flags on the report above. Every grain is a read, so the effect class does
// not change — but the same instinct the house rule encodes applies to the agent surface: each grain
// is separately classified, and a grain added later cannot silently widen an existing command's
// safe-flag allowlist. It also fixes each subcommand's output shape, which matters for a report an
// agent may parse.

/**
 * Print one grain's table, or say plainly that the grain recorded nothing.
 *
 * The emptiness test is `groups.length === 0` — whether the grain has GROUPS, not whether they carry
 * figures. A grain holding groups whose providers reported nothing is a report and prints as one; a
 * grain holding no groups is not a report at all, and an empty table or a zeroed row would read as
 * "this analysis spent nothing here", which is a claim the ledger cannot make.
 *
 * `notes` trail BOTH branches — an emptied grain is exactly when a reader most needs to be told that
 * consumption they can see elsewhere is accounted for somewhere they haven't looked yet. Each is
 * printed on its own line rather than joined, so a grain missing two buckets names them separately
 * instead of running them into one sentence a reader has to parse apart.
 */
function printGrain(
    heading: string,
    column: string,
    groups: readonly { label: string; totals: UsageTotals }[],
    emptyLine: string,
    notes: readonly string[] = [],
): void {
    if (groups.length === 0) {
        console.log(`\n  ${emptyLine}`);
    } else {
        console.log(`\n  ${heading}\n`);
        for (const line of breakdownLines(column, groups)) console.log(line);
    }
    for (const note of notes) console.log(`\n  ${note}`);
    console.log();
}

/**
 * The signposts a grain report owes its reader: one per bucket that holds calls and that this grain
 * structurally cannot show. Both are figure-free by design (see {@link UNATTRIBUTED_SIGNPOST}), so
 * each read here is for its call COUNT alone — whether there is anything to point at.
 *
 * Shared by the session and run grains because the two buckets are invisible to both: the data profile
 * stamps no thread and is not a run, and unattributed calls carry neither frame.
 */
function grainSignposts(view: UsageView): string[] {
    const { dataProfile, unattributed } = grainsOf(view);
    const notes: string[] = [];
    if (dataProfile.calls > 0) notes.push(DATA_PROFILE_SIGNPOST);
    if (unattributed.calls > 0) notes.push(UNATTRIBUTED_SIGNPOST);
    return notes;
}

/** `inflexa usage sessions [--analysis <id|name>]` — what each of the analysis's conversations consumed. */
export async function usageSessions(analysis: UsageAnalysis, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const view = await read(analysis, { by: "thread" }, opts);
    // A session's figures cover its own chat turns; a run launched from that conversation reports
    // under `usage runs`, because attribution follows the frame the call actually ran in. The sidebar
    // folds a session's runs INTO it instead and says so — both readings are legitimate and they
    // differ by the whole of a run, which is why each surface names the one it shows.
    printGrain(`Sessions for "${analysis.name}"`, "session", labelled(view, NO_KEY), `No session usage recorded for "${analysis.name}".`, grainSignposts(view));
}

/** `inflexa usage runs [--analysis <id|name>]` — what each of the analysis's runs consumed. */
export async function usageRuns(analysis: UsageAnalysis, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const view = await read(analysis, { by: "run" }, opts);
    // Runs only: the data profile rides the same ledger column but has no run row for a reader to
    // cross-reference this table against, so it reports as its own grain in `inflexa usage`.
    printGrain(`Runs for "${analysis.name}"`, "run", labelled(view, NO_KEY), `No run usage recorded for "${analysis.name}".`, grainSignposts(view));
}

/** A 404 of the step read: no run with recorded usage matches the reference. */
function isRunMiss(e: ClientError): boolean {
    return e.type === "http" && e.body.error === "not_found";
}

/**
 * `inflexa usage steps --run <id> [--analysis <id|name>]` — what each step of one run consumed.
 *
 * `--run` accepts a trailing abbreviation as well as the full id, because the id tail is what the
 * sidebar and the usage dialog print. The server matches it against the runs of the analysis that HAVE
 * ledger rows, and refuses an abbreviation that names two of them: two runs' steps blended into one
 * table would be wrong in a way nothing on screen could reveal.
 */
export async function usageSteps(analysis: UsageAnalysis, run: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const view = (await fetchUsage(analysis.id, { runId: run, by: "step" }, opts)).match(
        (v): UsageView | null => v,
        (e) => (isRunMiss(e) ? null : fail(describeClientError(e))),
    );
    if (view === null || view.scope.kind !== "run") {
        console.log(`\n  No usage recorded for run "${run}" in "${analysis.name}".\n`);
        return;
    }
    // The full run id in the heading whatever the caller typed: an abbreviation is an input convenience,
    // never the identity, and the report must name the run it actually read.
    const runId = view.scope.runId;
    printGrain(`Steps for run ${runId} in "${analysis.name}"`, "step", labelled(view, NO_STEP), `No step usage recorded for run ${runId}.`);
}
