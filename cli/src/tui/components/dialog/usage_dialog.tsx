import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { Result } from "neverthrow";

import { GLYPHS, space } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { FixedList } from "../fixed_list.tsx";
import type { SelectItem } from "../list_core.tsx";
import { Bold, Fg } from "../emphasis.tsx";
import { idTail } from "../../hooks/sidebar_live.ts";
import { NOT_REPORTED } from "../../../modules/usage/usage.ts";
import {
    getAnalysisUnattributedUsageTotals,
    getAnalysisUsageTotals,
    listAnalysisUsageByAgent,
    listAnalysisUsageByModel,
    listAnalysisUsageByRun,
    listAnalysisUsageBySession,
    type LlmUsageByAgent,
    type LlmUsageByModel,
    type LlmUsageByRun,
    type LlmUsageBySession,
    type LlmUsageByStep,
    type LlmUsageTotals,
} from "../../../db/primary_query.ts";
import type { DbError } from "../../../db/errors.ts";

// The usage dialog: what one analysis consumed, and WHERE. The headline is the analysis total; the
// rows below partition it by the frame each call ran in (session / run / neither), then re-cut the
// same total by served model and by agent. A run row drills into that run's steps.
//
// Two rules govern everything in this file:
//
//  1. NOTHING is ever summed across quantities. The cache counts are a breakdown OF the input count
//     and the reasoning count a breakdown OF the output count, so a combined "total tokens" would
//     count a cached prefix twice. Every row shows an input figure and an output figure, and the
//     ordering is lexicographic over those two rather than over a magnitude that does not exist.
//  2. Absent is not zero. A quantity no call in a group reported renders as the word the report uses
//     ({@link NOT_REPORTED}), never as `0` — a provider that measured nothing and a provider that
//     measured zero are different facts, and the call count beside the figures is what tells a
//     reported-nothing row from a row for work that never happened.
//
// It reads the local SQLite ledger only, so it opens with the durable engine, its Postgres, and the
// model proxy all cold — the same property the sidebar section that launches it has.

/** Everything the dialog paints, gathered in ONE point-in-time read at open. */
export type UsageSnapshot = {
    /** The analysis headline — the total over every recorded call, which the grains below partition. */
    totals: LlmUsageTotals;
    /** Chat-turn consumption per conversation thread. */
    sessions: LlmUsageBySession[];
    /** Run consumption per run. */
    runs: LlmUsageByRun[];
    /** Calls belonging to neither a session nor a run — background and boot-time work. */
    unattributed: LlmUsageTotals;
    /** The same total re-cut by the model that answered. */
    byModel: LlmUsageByModel[];
    /** The same total re-cut by the agent that spent it. */
    byAgent: LlmUsageByAgent[];
};

/**
 * Read every grain for one analysis in one go.
 *
 * All six reads or none: a breakdown assembled from a partial read would show grains that do not
 * reconcile with their headline, which is precisely the defect the unattributed bucket exists to
 * prevent. The caller renders the `Err` as the dialog's unavailable state — the dialog still opens.
 */
export function readAnalysisUsage(analysisId: string): Result<UsageSnapshot, DbError> {
    return getAnalysisUsageTotals(analysisId).andThen((totals) =>
        listAnalysisUsageBySession(analysisId).andThen((sessions) =>
            listAnalysisUsageByRun(analysisId).andThen((runs) =>
                getAnalysisUnattributedUsageTotals(analysisId).andThen((unattributed) =>
                    listAnalysisUsageByModel(analysisId).andThen((byModel) =>
                        listAnalysisUsageByAgent(analysisId).map((byAgent) => ({ totals, sessions, runs, unattributed, byModel, byAgent })),
                    ),
                ),
            ),
        ),
    );
}

/** What a breakdown row points at: a run drills into its step grain; every other row is a readout only. */
export type UsageRowTarget = { kind: "run"; runId: string } | { kind: "inert" };

/** The dialog's grain section headings, in the order the panel stacks them. */
const CATEGORY = {
    session: "By session",
    run: "By run",
    unattributed: "Unattributed",
    model: "By served model",
    agent: "By agent",
} as const;

/** Row label for the unattributed group — the absence of a frame, parenthesized like every other named absence here. */
const NO_FRAME = "(no session or run)";

/** Row label for calls whose endpoint reported no served model id — an absence, not a model actually named this. */
const NO_SERVED_MODEL = `(${NOT_REPORTED})`;

/** Row label for a run's calls that ran outside any step (its plan/synthesis frames). */
const NO_STEP = "(no step)";

/**
 * Column width for the headline's labels — wide enough for the longest of them (`  cache write`)
 * plus a separating space, so the figures form one column whichever breakdown lines are present.
 */
const HEADLINE_LABEL_WIDTH = 14;

function figure(value: number | undefined): string {
    return value === undefined ? NOT_REPORTED : value.formatTokens();
}

/**
 * Row order: input tokens desc, then output tokens desc, then call count desc — the same
 * lexicographic order the grain reads apply in SQL, applied here to the model and agent grains, whose
 * reads order by id so the text report stays stable and greppable. Every section of this dialog must
 * rank the same way or the eye learns a rule that only half the panel follows.
 *
 * An absent quantity sorts as `-1` so it falls BELOW a reported `0`, matching SQLite's NULL-last
 * behaviour under DESC — a group that measured nothing belongs under one that measured nothing spent.
 */
function byConsumption(a: LlmUsageTotals, b: LlmUsageTotals): number {
    return (b.inputTokens ?? -1) - (a.inputTokens ?? -1) || (b.outputTokens ?? -1) - (a.outputTokens ?? -1) || b.calls - a.calls;
}

/** A uuid's characters with the dashes removed — the space {@link idTail} takes its tail from. */
function bare(id: string): string {
    return id.replace(/-/g, "");
}

/**
 * Label every id by its {@link idTail}, extending ONLY the ids that would collide to the shortest
 * length that tells them apart — git's abbreviation rule.
 *
 * Six characters is 24 bits, so a clash inside one analysis is unlikely but not impossible, and its
 * failure mode is silent: two different runs rendering one label in the same list, with no hint that
 * the reader is comparing the wrong things. Extending only the colliding rows costs nothing when
 * there is no clash, which is nearly always.
 *
 * Exported for its unit test — "these two rows are told apart, and the others keep the tail every
 * other surface prints" is a claim about this arithmetic, not about a painted frame.
 */
export function distinctIdTails(ids: readonly string[]): ReadonlyMap<string, string> {
    const unique = [...new Set(ids)];
    const labels = new Map<string, string>(unique.map((id) => [id, idTail(id)]));

    const groups = new Map<string, string[]>();
    for (const [id, label] of labels) {
        const members = groups.get(label);
        if (members) members.push(id);
        else groups.set(label, [id]);
    }

    for (const [label, members] of groups) {
        if (members.length < 2) continue;
        // Grow the whole colliding set together, one character at a time, and stop at the first length
        // that separates every member — so the extension is the shortest one that actually works
        // rather than a fixed wider tail nobody needs. Ids identical even at full length (which
        // distinct uuids never are) simply keep the shared tail: there is no honest label for them.
        const longest = Math.max(...members.map((id) => bare(id).length));
        for (let len = label.length + 1; len <= longest; len++) {
            const grown = members.map((id) => bare(id).slice(-len));
            if (new Set(grown).size === members.length) {
                for (const [i, id] of members.entries()) labels.set(id, grown[i]!);
                break;
            }
        }
    }
    return labels;
}

/**
 * One grain row before it is padded into columns. `kind: "empty"` is a grain with no groups at all —
 * a section that exists but has nothing under it, which must SAY so rather than vanish and leave the
 * reader wondering whether the dialog forgot it.
 */
type BreakdownEntry =
    { kind: "group"; category: string; label: string; totals: LlmUsageTotals; target: UsageRowTarget } | { kind: "empty"; category: string; text: string };

/** The composed breakdown: the column header and the rows it aligns with. */
export type UsageBreakdown = {
    /** Column header line, padded to the rows' widths and indented past the list's cursor gutter. */
    header: string;
    /** The rows, grouped into sections by `category` — the list renders one bold header per section. */
    items: SelectItem<UsageRowTarget>[];
};

/**
 * Compose the breakdown rows for one snapshot.
 *
 * `names` supplies a human label for an id the application ALREADY holds one for (the open thread's
 * title, a live run's plan title). It decorates the row; it never replaces the id. Names for runs
 * live in the harness's Postgres, so whether one is in memory depends on boot state — a label that
 * appeared and disappeared with unrelated state would not be an identity, and keeping the id present
 * is what lets the name be absent without consequence. Nothing is ever fetched to fill this in.
 *
 * Exported for its unit tests: that a row carries its call count beside exactly two figures, that the
 * five quantities are never combined, and that an absent figure reads as a word are claims about this
 * composition — a character frame holding two numbers cannot say WHICH numbers they are.
 */
export function usageBreakdown(snapshot: UsageSnapshot, names?: ReadonlyMap<string, string>): UsageBreakdown {
    const decorate = (id: string, tail: string): string => {
        const name = names?.get(id);
        return name ? `${tail} ${GLYPHS.middot} ${name}` : tail;
    };

    const sessionTails = distinctIdTails(snapshot.sessions.map((s) => s.threadId));
    const runTails = distinctIdTails(snapshot.runs.map((r) => r.runId));

    const entries: BreakdownEntry[] = [];

    if (snapshot.sessions.length === 0) {
        entries.push({ kind: "empty", category: CATEGORY.session, text: "no sessions recorded" });
    } else {
        for (const s of snapshot.sessions) {
            entries.push({
                kind: "group",
                category: CATEGORY.session,
                label: decorate(s.threadId, sessionTails.get(s.threadId) ?? idTail(s.threadId)),
                totals: s.totals,
                target: { kind: "inert" },
            });
        }
    }

    if (snapshot.runs.length === 0) {
        entries.push({ kind: "empty", category: CATEGORY.run, text: "no runs recorded" });
    } else {
        for (const r of snapshot.runs) {
            entries.push({
                kind: "group",
                category: CATEGORY.run,
                label: decorate(r.runId, runTails.get(r.runId) ?? idTail(r.runId)),
                totals: r.totals,
                target: { kind: "run", runId: r.runId },
            });
        }
    }

    // Shown only when it holds calls. The bucket exists so the parts can reach the headline, and when
    // there is nothing outside a session or a run there is nothing for it to account for — a section
    // announcing the absence of work that never happened is noise, not information.
    if (snapshot.unattributed.calls > 0) {
        entries.push({
            kind: "group",
            category: CATEGORY.unattributed,
            label: NO_FRAME,
            totals: snapshot.unattributed,
            target: { kind: "inert" },
        });
    }

    for (const m of [...snapshot.byModel].sort((a, b) => byConsumption(a.totals, b.totals))) {
        entries.push({
            kind: "group",
            category: CATEGORY.model,
            label: m.servedModelId ?? NO_SERVED_MODEL,
            totals: m.totals,
            target: { kind: "inert" },
        });
    }
    for (const a of [...snapshot.byAgent].sort((x, y) => byConsumption(x.totals, y.totals))) {
        entries.push({ kind: "group", category: CATEGORY.agent, label: a.agentId, totals: a.totals, target: { kind: "inert" } });
    }

    // Columns are measured across EVERY section, so the figures line up down the whole panel rather
    // than restarting per section — the comparison the dialog exists for is between sections as much
    // as within one.
    const header = ["", "calls", "input", "output"];
    const cells: string[][] = [
        header,
        ...entries.flatMap((e) => (e.kind === "group" ? [[e.label, String(e.totals.calls), figure(e.totals.inputTokens), figure(e.totals.outputTokens)]] : [])),
    ];
    const widths = header.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? "").length)));
    const line = (row: readonly string[]): string => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  ");

    return {
        // Two leading spaces so the header sits over the row TEXT, past the list's cursor gutter.
        header: `  ${line(header)}`,
        items: entries.map((e) =>
            e.kind === "group"
                ? {
                      value: e.target,
                      title: line([e.label, String(e.totals.calls), figure(e.totals.inputTokens), figure(e.totals.outputTokens)]),
                      category: e.category,
                  }
                : { value: { kind: "inert" } as UsageRowTarget, title: e.text, category: e.category },
        ),
    };
}

/**
 * The step grain as plain lines, for the drill-down view the caller stacks over this dialog.
 *
 * Lines rather than rows because a step list is a readout with nothing to select — the same shape the
 * data-profile details use. The step id is rendered verbatim: unlike a session or a run it is already
 * a human-readable slug the planner wrote, so there is no tail to take and nothing to decorate it with.
 */
export function usageStepLines(steps: readonly LlmUsageByStep[]): string[] {
    const header = ["step", "calls", "input", "output"];
    const rows = [header, ...steps.map((s) => [s.stepId ?? NO_STEP, String(s.totals.calls), figure(s.totals.inputTokens), figure(s.totals.outputTokens)])];
    const widths = header.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
    return rows.map((row) =>
        row
            .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
            .join("  ")
            .trimEnd(),
    );
}

/**
 * The headline's label/figure pairs: the two figures with each breakdown nested under the figure it
 * details — cache writes and cache reads under input, reasoning under output.
 *
 * A breakdown line is omitted entirely when its quantity is absent. Nesting is what states the
 * relationship, and an omitted line stays distinguishable from a reported `0`, which does render.
 * The two headline figures always render, as the word when unreported.
 */
export function usageHeadlineRows(totals: LlmUsageTotals): readonly (readonly [string, string])[] {
    const rows: [string, string][] = [["input", figure(totals.inputTokens)]];
    if (totals.cacheCreationInputTokens !== undefined) rows.push([`  cache write`, totals.cacheCreationInputTokens.formatTokens()]);
    if (totals.cacheReadInputTokens !== undefined) rows.push([`  cache read`, totals.cacheReadInputTokens.formatTokens()]);
    rows.push(["output", figure(totals.outputTokens)]);
    if (totals.reasoningTokens !== undefined) rows.push([`  reasoning`, totals.reasoningTokens.formatTokens()]);
    return rows;
}

/** Props for {@link UsageDialog}. */
export type UsageDialogProps = {
    /** The analysis being reported on; titles the panel. `null` renders the bare title. */
    analysisName: string | null;
    /**
     * Read the whole snapshot — called ONCE, in the component body, because this is a point-in-time
     * view (the same contract `RunDetailDialog` gives its run row). An `Err` renders the unavailable
     * state INSIDE the dialog: a failed read must never be the reason a dialog refuses to open.
     */
    loadUsage: () => Result<UsageSnapshot, DbError>;
    /**
     * Human labels the application already holds, keyed by thread or run id. Optional and always
     * incomplete — see {@link usageBreakdown} for why a missing one changes nothing.
     */
    names?: ReadonlyMap<string, string>;
    /** A run row was chosen: the caller stacks that run's step view over this dialog. */
    onOpenRun: (runId: string) => void;
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) and the q/enter close keys. */
    onClose: () => void;
};

/**
 * What one analysis consumed and where it went: the headline, then the grains beneath it.
 *
 * Dialog-system compliant — no own esc binding (the host owns it), cancel via {@link useDialogCancel},
 * `lg` preset. The run rows are the only actionable ones; selecting one calls `onOpenRun`, and the
 * caller STACKS the step view rather than replacing this panel, so dismissing the step view lands
 * back here with the breakdown still on screen (the runs picker → run detail shape).
 */
export function UsageDialog(props: UsageDialogProps): JSX.Element {
    useDialogCancel(() => props.onClose());
    // `q` closes. A bare printable is compliant here: the dialog hosts no text input. Enter is NOT
    // bound to close — the list owns it, because enter is how a run row drills in.
    useDialogBindings(() => ({ bindings: [{ chord: KEYS.q, run: () => props.onClose() }] }));

    // Read once, in the body: this is a point-in-time view, so there is nothing to keep in sync and a
    // signal would only invite a re-read that could disagree with the headline already painted. The
    // rows are composed here too, once, because FixedList reads its items at mount by contract.
    /* eslint-disable solid/reactivity -- seed-once by contract: the dialog is a point-in-time view, so `loadUsage` reads at open and `names` is the label set as of that same moment */
    const snapshot = props.loadUsage().match(
        (s): UsageSnapshot | null => s,
        (): UsageSnapshot | null => null,
    );
    const breakdown = snapshot ? usageBreakdown(snapshot, props.names) : null;
    /* eslint-enable solid/reactivity */

    const title = (): string => (props.analysisName ? `Usage ${GLYPHS.emDash} ${props.analysisName}` : "Usage");
    const footer = [
        `${chordLabel(KEYS.up)}/${chordLabel(KEYS.down)} move`,
        `${chordLabel(KEYS.enter)} run steps`,
        `${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`,
    ].join(` ${GLYPHS.middot} `);

    return (
        <DialogPanel title={title()} size="lg" padY footer={footer}>
            <Show when={snapshot && breakdown ? { snapshot, breakdown } : null} keyed fallback={<text fg={theme().fgMuted}>usage unavailable</text>}>
                {(view: { snapshot: UsageSnapshot; breakdown: UsageBreakdown }) => (
                    <Show
                        when={view.snapshot.totals.calls > 0}
                        // The call count, not the figures, is what separates "nothing spent here yet" from
                        // "calls ran whose provider reported nothing". Zeroed figures would assert the first,
                        // which is a claim the ledger cannot make.
                        fallback={<text fg={theme().fgMuted}>no usage recorded</text>}
                    >
                        {/* flexShrink={0} on the whole headline block, not on the rows: a `<text>` has a
                            non-numeric size, so it defaults to shrinkable, and the list's flexGrow
                            scrollbox squeezes every one of these to zero height on a short panel —
                            painting the figure lines on top of each other. The scroll region absorbs
                            the squeeze instead; the headline keeps its rows.

                            Static chrome ABOVE the scrollbox, so the transparent gap row is safe here:
                            the one-cell scrollbox bleed only spills onto the sibling BELOW it. */}
                        <box flexDirection="column" width="100%" flexShrink={0}>
                            <text fg={theme().fg}>
                                <Bold>{`${view.snapshot.totals.calls} call${view.snapshot.totals.calls === 1 ? "" : "s"}`}</Bold>
                            </text>
                            <For each={usageHeadlineRows(view.snapshot.totals)}>
                                {([label, value]) => (
                                    <text>
                                        <Fg role="fgMuted">{label.padEnd(HEADLINE_LABEL_WIDTH)}</Fg>
                                        <Fg role="fg">{value}</Fg>
                                    </text>
                                )}
                            </For>
                            <box height={space.sm} flexShrink={0} />
                            <text fg={theme().fgSubtle}>{view.breakdown.header}</text>
                        </box>
                        <FixedList
                            items={view.breakdown.items}
                            emptyText="no usage recorded"
                            onSelect={(target: UsageRowTarget) => {
                                if (target.kind === "run") props.onOpenRun(target.runId);
                            }}
                        />
                    </Show>
                )}
            </Show>
        </DialogPanel>
    );
}
