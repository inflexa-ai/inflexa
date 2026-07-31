import { For, Show } from "solid-js";
import { ok, type Result } from "neverthrow";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { GLYPHS, space } from "../../../lib/design_system.ts";
import { formatTokenFigure, tokenFigureDetail, type TokenFigureArm } from "../../../lib/usage_format.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";
import { Bold, Fg } from "../emphasis.tsx";
import { NOT_REPORTED } from "../../../modules/usage/usage.ts";
import {
    getSessionUsageTotalsIncludingRuns,
    listSessionUsageByAgent,
    listSessionUsageByModel,
    type LlmUsageByAgent,
    type LlmUsageByModel,
    type LlmUsageTotals,
} from "../../../db/primary_query.ts";
import type { DbError } from "../../../db/errors.ts";

// The usage dialog: what the OPEN CONVERSATION has consumed, cut by the model that answered and by
// the agent that spent it.
//
// Those two dimensions are all that is left here because they are the only ones with no entity to
// hang off: there is no model card and no agent card in the TUI, and there never will be, since
// neither is something the user creates or opens. Every grain this dialog used to table — session,
// run, step — now reports on the thing itself (the rail's session figure, each run row, each step in
// the run block), and two sources for one number is how they come to disagree. `inflexa usage` stays
// the exhaustive cross-grain surface: a wide, scriptable, non-interactive medium is where a full
// table belongs.
//
// Two rules govern everything in this file:
//
//  1. NOTHING is ever summed across quantities. The cache counts are parts OF the input count, so a
//     combined "total tokens" would count a cached prefix twice; the reasoning count is reported
//     exactly as the provider stated it and is never reconciled against the output total ("whether
//     reasoning tokens sit inside the output total varies by provider" — the harness's
//     `TokenUsageRollup`), so arithmetic between those two is a guess as well. Every figure is
//     therefore two arms, with the other three nested UNDER the arm they detail: nesting states a
//     part-of relationship the reader cannot add across, which is the safe layout whether or not the
//     containment happens to be exact.
//  2. Absent is not zero. A quantity no call reported renders as the word the report uses
//     ({@link NOT_REPORTED}), never as `0` — a provider that measured nothing and a provider that
//     measured zero are different facts, and the call count beside the figures is what tells a
//     reported-nothing row from a row for work that never happened.
//
// It reads the local SQLite ledger only, so it opens with the durable engine, its Postgres, and the
// model proxy all cold — the same property the sidebar section that launches it has.

/** Everything the dialog paints, gathered in ONE point-in-time read at open. */
export type SessionUsageSnapshot = {
    /**
     * The open conversation's headline, the runs it launched INCLUDED — the reading the rail section
     * that opens this dialog shows, and the one the two groupings below partition. Deliberately NOT
     * the session GRAIN (`inflexa usage sessions`), which excludes runs so the grains still add up to
     * the analysis total; the two differ by the whole of a run, and each surface says which it shows.
     */
    totals: LlmUsageTotals;
    /** The same total re-cut by the model that answered. */
    byModel: LlmUsageByModel[];
    /** The same total re-cut by the agent that spent it. */
    byAgent: LlmUsageByAgent[];
};

/**
 * Read one conversation's usage in one go.
 *
 * All three reads or none: a headline paired with groupings from a partial read would show parts that
 * do not reconcile with the total above them. The caller renders the `Err` as the dialog's
 * unavailable state — the dialog still opens.
 *
 * `threadId` is nullable because the chat's Postgres thread identity is not bound until boot reaches
 * ready. A chat with no thread has recorded nothing under one BY CONSTRUCTION, so there is nothing to
 * ask the ledger; answering with the empty snapshot here rather than making each caller branch lands
 * the dialog on its "no usage recorded" state, which is the honest report for that chat.
 */
export function readSessionUsage(analysisId: string, threadId: string | null): Result<SessionUsageSnapshot, DbError> {
    if (threadId === null) return ok({ totals: { calls: 0 }, byModel: [], byAgent: [] });
    return getSessionUsageTotalsIncludingRuns(analysisId, threadId).andThen((totals) =>
        listSessionUsageByModel(analysisId, threadId).andThen((byModel) =>
            listSessionUsageByAgent(analysisId, threadId).map((byAgent) => ({ totals, byModel, byAgent })),
        ),
    );
}

/** The dialog's section headings, in the order the panel stacks them. */
const CATEGORY = {
    model: "By served model",
    agent: "By agent",
} as const;

/** Row label for calls whose endpoint reported no served model id — an absence, not a model actually named this. */
const NO_SERVED_MODEL = `(${NOT_REPORTED})`;

/** Group rows are indented under their heading, so the heading reads as a heading without a rule under it. */
const ROW_INDENT = "  ";

/**
 * One group's figure in the shared notation, or the absent word when the provider reported neither
 * quantity.
 *
 * ONE cell rather than an input column beside an output column: the two arms are a single figure, and
 * splitting them into separately-aligned columns would be a second dialect of the same notation — as
 * well as leaving nowhere honest to print the absent word, which belongs to the figure as a whole and
 * not to either arm.
 */
function figureOf(totals: LlmUsageTotals): string {
    return formatTokenFigure(totals) || NOT_REPORTED;
}

/**
 * Row order: input tokens desc, then output tokens desc, then call count desc — the same
 * lexicographic order the grain reads apply in SQL, applied here because the model and agent reads
 * order by id so the text report stays stable and greppable. Both sections of this dialog rank the
 * same way or the eye learns a rule that only half the panel follows.
 *
 * An absent quantity sorts as `-1` so it falls BELOW a reported `0`, matching SQLite's NULL-last
 * behaviour under DESC — a group that measured nothing belongs under one that measured nothing spent.
 */
function byConsumption(a: LlmUsageTotals, b: LlmUsageTotals): number {
    return (b.inputTokens ?? -1) - (a.inputTokens ?? -1) || (b.outputTokens ?? -1) - (a.outputTokens ?? -1) || b.calls - a.calls;
}

/**
 * One painted line of the breakdown. A heading names the section; a row is already padded into its
 * columns. Split rather than pre-joined because the two are painted in different theme roles, which a
 * flat string list cannot express.
 */
export type UsageBreakdownLine = { kind: "heading"; text: string } | { kind: "row"; text: string };

/** The composed breakdown: the column header and the lines it aligns with. */
export type UsageBreakdown = {
    /** Column header line, aligned over the group rows' columns. */
    header: string;
    /** Headings and rows in paint order. */
    lines: UsageBreakdownLine[];
};

/**
 * Compose the breakdown lines for one snapshot.
 *
 * There is deliberately no "this section is empty" placeholder. The headline and both groupings come
 * from the same predicate over the same rows, so a non-zero call count guarantees at least one group
 * in each section — an empty section is only reachable when the whole snapshot is empty, which the
 * caller renders as a single "no usage recorded" line instead of two headings over nothing.
 *
 * Exported for its unit tests: that a row carries its call count beside exactly one two-armed figure,
 * that the five quantities are never combined, and that an absent figure reads as a word are claims
 * about this composition — a character frame holding two numbers cannot say WHICH numbers they are.
 */
export function usageBreakdown(snapshot: SessionUsageSnapshot): UsageBreakdown {
    const groups: { category: string; label: string; totals: LlmUsageTotals }[] = [
        ...[...snapshot.byModel]
            .sort((a, b) => byConsumption(a.totals, b.totals))
            .map((m) => ({ category: CATEGORY.model, label: m.servedModelId ?? NO_SERVED_MODEL, totals: m.totals })),
        ...[...snapshot.byAgent]
            .sort((a, b) => byConsumption(a.totals, b.totals))
            .map((a) => ({ category: CATEGORY.agent, label: a.agentId, totals: a.totals })),
    ];

    // Columns are measured across BOTH sections, so the figures line up down the whole panel rather
    // than restarting per section — the comparison this dialog exists for is between a model and the
    // agent that drove it as much as within either list.
    const header = ["", "calls", "tokens"];
    const cells = groups.map((g) => [ROW_INDENT + g.label, String(g.totals.calls), figureOf(g.totals)]);
    const widths = header.map((_, i) => Math.max(...[header, ...cells].map((row) => (row[i] ?? "").length)));
    // The count is right-aligned (a column of numbers) and the figure left-aligned, which is what puts
    // every row's up-arm in one column — the arms vary in width, so aligning the cell's right edge
    // would scatter them.
    const line = (row: readonly string[]): string =>
        row
            .map((cell, i) => (i === 1 ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0)))
            .join("  ")
            .trimEnd();

    const lines: UsageBreakdownLine[] = [];
    let heading: string | null = null;
    for (const [i, g] of groups.entries()) {
        if (g.category !== heading) {
            heading = g.category;
            lines.push({ kind: "heading", text: g.category });
        }
        lines.push({ kind: "row", text: line(cells[i]!) });
    }
    return { header: line(header), lines };
}

/**
 * One arm of the headline: the LABELLED figure with its own breakdowns stacked under it.
 *
 * Labelled (`806.9k in`) rather than the compact arrows the grouping rows below carry: the headline
 * is this dialog's subject and has a whole panel width to spend, while a grouping row is one of many
 * being compared down a column, where words would push the figures apart. Both writings come from the
 * same arm, so the two halves of this panel can never disagree about a value.
 *
 * A column rather than a row, and the breakdowns indented, because that nesting is the ONLY thing
 * stating "these are parts of the figure above" — levelled onto one line they read as three peers a
 * reader may add. An arm the provider never reported renders the absent word: the column still exists
 * (input is always on the left, output always on the right), it just has nothing to report.
 *
 * `lead` is what puts the two arms at opposite EDGES rather than at the head of one half-panel each.
 * The leading arm grows into all the slack, so the trailing arm — sized to its own content and
 * explicitly unshrinkable, since an unsized box defaults to `flexShrink: 1` and would otherwise be
 * squeezed by the row — is pushed flush against the panel's trailing edge. Two `flexGrow={1}` halves
 * were the defect this replaces: each arm owned half the panel and left-aligned inside it, so the
 * output figure floated mid-panel adjacent to nothing.
 *
 * Both arms keep their contents LEFT-aligned, which is deliberate and is what the trailing arm's
 * `alignItems` must not undo: a right-aligned column would flush its nested quantities against the
 * panel edge too, collapsing the indent that states they are parts of the arm above. The accepted
 * cost is that the trailing arm is as wide as its widest LINE, so an arm whose nested quantity is
 * longer than its figure (`reasoning 9.1k` against `42.4k out`) carries that figure a few cells in
 * from the edge — the arm is still flush, and the indent still reads as an indent.
 */
function UsageArm(props: { arm: TokenFigureArm | null; lead?: boolean }): JSX.Element {
    return (
        <box flexDirection="column" flexGrow={props.lead ? 1 : 0} flexShrink={props.lead ? 1 : 0}>
            <Show when={props.arm} keyed fallback={<text fg={theme().fgMuted}>{NOT_REPORTED}</text>}>
                {(arm: TokenFigureArm) => (
                    <>
                        <text fg={theme().fg}>
                            <Bold>{arm.labelled}</Bold>
                        </text>
                        <For each={arm.breakdown}>
                            {(part) => (
                                <text>
                                    <Fg role="fgMuted">{`${ROW_INDENT}${part.label} `}</Fg>
                                    <Fg role="fg">{part.value}</Fg>
                                </text>
                            )}
                        </For>
                    </>
                )}
            </Show>
        </box>
    );
}

/** Props for {@link UsageDialog}. */
export type UsageDialogProps = {
    /** The analysis the open conversation belongs to; titles the panel. `null` renders the bare title. */
    analysisName: string | null;
    /**
     * Read the whole snapshot — called ONCE, in the component body, because this is a point-in-time
     * view (the same contract `RunDetailDialog` gives its run row). An `Err` renders the unavailable
     * state INSIDE the dialog: a failed read must never be the reason a dialog refuses to open.
     */
    loadUsage: () => Result<SessionUsageSnapshot, DbError>;
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) and the q/enter close keys. */
    onClose: () => void;
};

/**
 * What the open conversation has consumed: the two-armed headline, then the same total re-cut by
 * served model and by agent.
 *
 * A readout with nothing to select — hence a {@link ScrollPane} of lines rather than a list with a
 * cursor, the same shape the run-detail metadata and the data-profile details use. A cursor would
 * advertise an action no row has now that the run drill-down is gone.
 *
 * Dialog-system compliant — no own esc binding (the host owns it), cancel via {@link useDialogCancel},
 * initial focus on the scroll pane, `lg` preset.
 */
export function UsageDialog(props: UsageDialogProps): JSX.Element {
    const dialog = useDialogEntry();

    useDialogCancel(() => props.onClose());
    // `q`/enter close. Bare printables are compliant here: the dialog hosts no text input, and enter
    // is free now that no row drills.
    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: KEYS.enter, run: () => props.onClose() },
        ],
    }));

    // Read once, in the body: this is a point-in-time view, so there is nothing to keep in sync and a
    // signal would only invite a re-read that could disagree with the headline already painted.
    /* eslint-disable-next-line solid/reactivity -- seed-once by contract: the dialog is a point-in-time view, so `loadUsage` reads at open */
    const snapshot = props.loadUsage().match(
        (s): SessionUsageSnapshot | null => s,
        (): SessionUsageSnapshot | null => null,
    );

    const title = (): string => (props.analysisName ? `Usage ${GLYPHS.emDash} ${props.analysisName}` : "Usage");
    const footer = `${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`;

    return (
        <DialogPanel title={title()} size="lg" padY footer={footer}>
            <Show when={snapshot} keyed fallback={<text fg={theme().fgMuted}>usage unavailable</text>}>
                {(view: SessionUsageSnapshot) => {
                    // Composed once per snapshot, here rather than inline in the JSX below: `view` is a
                    // fixed value (keyed Show over a read-once snapshot), so re-deriving it inside an
                    // `each`/`when` prop would recompute the same answer on every re-track.
                    const breakdown = usageBreakdown(view);
                    const detail = tokenFigureDetail(view.totals);
                    return (
                        <Show
                            when={view.totals.calls > 0}
                            // The call count, not the figures, is what separates "nothing spent here yet" from
                            // "calls ran whose provider reported nothing". Zeroed figures would assert the first,
                            // which is a claim the ledger cannot make.
                            fallback={<text fg={theme().fgMuted}>no usage recorded</text>}
                        >
                            {/* flexShrink={0} on the whole headline block, not on the rows: a `<text>` has a
                            non-numeric size, so it defaults to shrinkable, and the scroll pane's flexGrow
                            squeezes every one of these to zero height on a short panel — painting the
                            figure lines on top of each other. The scroll region absorbs the squeeze
                            instead; the headline keeps its rows.

                            Static chrome ABOVE the scrollbox, so the transparent gap row is safe here:
                            the one-cell scrollbox bleed only spills onto the sibling BELOW it. */}
                            <box flexDirection="column" width="100%" flexShrink={0}>
                                <text fg={theme().fg}>
                                    <Bold>{`${view.totals.calls} call${view.totals.calls === 1 ? "" : "s"}`}</Bold>
                                    {/* Which reading this is. The rail's session figure and `inflexa usage
                                    sessions` differ by the whole of every run the conversation launched,
                                    so a surface that shows one without naming it is where a reader starts
                                    doubting the ledger. */}
                                    <Fg role="fgMuted">{` ${GLYPHS.middot} this conversation, runs included`}</Fg>
                                </text>
                                {/* Input at the leading edge, output at the trailing one: they are peers
                                and the reader is comparing them, so each belongs at an edge it can be
                                found at without scanning. The leading arm grows; the trailing one takes
                                its natural width — see {@link UsageArm}. */}
                                <box flexDirection="row" width="100%" flexShrink={0}>
                                    <UsageArm arm={detail.input} lead />
                                    <UsageArm arm={detail.output} />
                                </box>
                                <box height={space.sm} flexShrink={0} />
                                <text fg={theme().fgSubtle}>{breakdown.header}</text>
                            </box>
                            <ScrollPane
                                focusOnMount={false}
                                onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)}
                                flexGrow={1}
                                minHeight={0}
                                width="100%"
                            >
                                <For each={breakdown.lines}>
                                    {(l) =>
                                        l.kind === "heading" ? (
                                            <text fg={theme().accent}>
                                                <Bold>{l.text}</Bold>
                                            </text>
                                        ) : (
                                            <text fg={theme().fg}>{l.text}</text>
                                        )
                                    }
                                </For>
                            </ScrollPane>
                        </Show>
                    );
                }}
            </Show>
        </DialogPanel>
    );
}
