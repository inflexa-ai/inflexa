import { createSignal, For, Match, onMount, Switch } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ResultAsync } from "neverthrow";
import type { CortexRunRow, DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { GLYPHS } from "../../../lib/design_system.ts";
import { formatTokenFigure, formatTokenFigureLabelled, NOT_REPORTED } from "../../../lib/usage_format.ts";
import type { LlmUsageTotals } from "../../../db/primary_query.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";
import { RunBlock, type RunStepView } from "../run_block.tsx";
import { absTime, idTail, shortRunName, stepStateOf } from "../../hooks/sidebar_live.ts";

/** The run's step-fetch state — fetched once on open, never re-polled while the dialog is up. */
type StepsState = { kind: "loading" } | { kind: "loaded"; views: RunStepView[] } | { kind: "unavailable" };

/**
 * One run's ledger spend, split into the part its steps account for and the part none of them does.
 *
 * The split exists because the step list and the figures come from two different stores: the list is
 * the run's step-execution rows, and the figures are usage rows joined onto them by step id. A usage
 * row carrying no step id — a run-level call — has nothing in that list to attach to, so a plain
 * `Map<stepId, …>` cannot represent it and a caller building one silently drops it. The run's own
 * `usage` headline counts those calls, which is how a total comes to disagree with its parts.
 *
 * `unattributed` is REQUIRED and nullable rather than optional for exactly that reason: an optional
 * field is omitted by forgetting, a nullable one only by writing `null`. The caller has to say which
 * case it holds — the same reasoning that makes the turn engine's usage recorder a required argument
 * rather than an optional one.
 */
export type RunStepUsage = {
    /**
     * Per step, keyed by step id. A step the map has no entry for carries no figure — never a zeroed
     * one. Absent covers the step that made no calls, the step whose provider reported nothing, and
     * the read that failed; none of those is a measurement.
     */
    readonly byStep: ReadonlyMap<string, LlmUsageTotals>;
    /**
     * The run's calls belonging to no step, or `null` when every call has one. Rendered as its own
     * line rather than a synthetic step row: it is not a step, has no lifecycle, and standing among
     * real steps is precisely what would make it read as one.
     */
    readonly unattributed: LlmUsageTotals | null;
};

/** Props for {@link RunDetailDialog}. */
export type RunDetailDialogProps = {
    /** The picked run row (a point-in-time capture from the picker's fresh fetch). */
    run: CortexRunRow;
    /**
     * Fetch the run's steps — called once on open. Production: `queryStepsByRun` over the booted
     * pool. Injected so the dialog stays offline-testable and gallery-showcaseable (the seam
     * pattern the old runs dialog and the sidebar store share).
     */
    loadSteps: (runId: string) => ResultAsync<StepExecutionRow[], DbError>;
    /**
     * What this run consumed, from the CLI's local ledger — handed in as DATA (the picker already
     * batches one read across every row it drew) rather than queried here, which is what keeps
     * {@link runDetailLines} pure and this dialog gallery-showcaseable offline.
     *
     * Absent when the run has no ledger rows or the usage read failed; the line is then omitted
     * entirely rather than printed as a zero.
     */
    usage?: LlmUsageTotals;
    /**
     * What the run's steps consumed, and what none of them accounts for. Handed in as data for the
     * same reason {@link RunDetailDialogProps.usage} is: the caller owns the ledger reads, and this
     * dialog stays pure and showcaseable with no database in sight.
     *
     * Absent entirely when no ledger read was made (the gallery exhibit, a showcase).
     */
    stepUsage?: RunStepUsage;
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) and the q/enter close keys. */
    onClose: () => void;
};

/**
 * Compose a run row's metadata into the detail view's plain lines. Pure (row → string[]) so every
 * state is unit-testable. Durable-record rule: absolute local timestamps plus a `duration` line
 * (completed − started); a still-running run shows its elapsed-at-open age instead — the same
 * vocabulary `profileDetailLines` pins for the profile dialog. The error renders verbatim on
 * failure, one line per source line.
 *
 * `usage` is one more property of the run, printed in that same vocabulary and in the LONG token form
 * — `label value` like every line around it, in a full-width dialog being read deliberately rather
 * than a rail column being scanned. It is a PARAMETER rather than a lookup so this stays pure: the
 * caller batches the ledger read across every row it drew. Passing nothing omits the line, which
 * covers both "this run has no recorded calls" and "the usage read failed" — neither is a figure, and
 * a zero would assert one.
 *
 * `unattributed` is the part of `usage` that no step below accounts for, printed as an indented line
 * under it so the headline visibly reconciles with the step list. Printing it is not decoration: the
 * step list is a join of usage rows onto step-execution rows, so a run-level call has no row to land
 * on and would otherwise be counted in the headline and shown nowhere — a total disagreeing with its
 * parts, which reads as a broken ledger rather than as work that ran outside a step.
 */
export function runDetailLines(run: CortexRunRow, usage?: LlmUsageTotals, unattributed?: LlmUsageTotals | null): string[] {
    const lines: string[] = [`status: ${run.status}`];
    if (run.startedAt) lines.push(`started ${absTime(run.startedAt)}`);
    if (run.completedAt) lines.push(`completed ${absTime(run.completedAt)}`);
    const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const completedMs = run.completedAt ? Date.parse(run.completedAt) : NaN;
    if (!Number.isNaN(startedMs) && !Number.isNaN(completedMs)) {
        lines.push(`duration ${Date.formatDuration(completedMs - startedMs)}`);
    } else if (!Number.isNaN(startedMs)) {
        lines.push(`elapsed ${Date.relativeAge(startedMs)}`);
    }
    if (usage) {
        // The call count rides beside the figure because it is the only thing that tells a run whose
        // provider reported nothing from a run that made no calls at all — the two-armed figure reads
        // identically ("not reported") in both.
        lines.push(`usage ${formatTokenFigureLabelled(usage) || NOT_REPORTED} ${GLYPHS.middot} ${usage.calls} ${usage.calls === 1 ? "call" : "calls"}`);
        // Gated on the CALL count, not on whether figures came back: a run-level call whose provider
        // reported nothing is still a call the headline counted and no step shows, so it is exactly
        // the gap this line exists to name. Gating on the figures would hide the one case where the
        // reader has no other way to notice the discrepancy.
        if (unattributed && unattributed.calls > 0) {
            const figure = formatTokenFigureLabelled(unattributed) || NOT_REPORTED;
            lines.push(`  outside any step ${figure} ${GLYPHS.middot} ${unattributed.calls} ${unattributed.calls === 1 ? "call" : "calls"}`);
        }
    }
    if (run.error) {
        lines.push("");
        for (const line of run.error.split("\n")) lines.push(line);
    }
    return lines;
}

/**
 * The run-detail view for ONE run picked from the runs picker: the run's metadata lines (see
 * {@link runDetailLines}) above its FULL step list through {@link RunBlock} — no `maxSteps`
 * window; the detail dialog is where the whole DAG belongs, seeded `pending`/`skipped` rows
 * included (they render as the queued hollow state via {@link stepStateOf}). Dialog-system
 * compliant — no own esc binding (the host owns it), cancel via {@link useDialogCancel}, initial
 * focus on the scroll pane, `lg` preset, showcase-inert q/enter closes. It stacks OVER the picker
 * (the opener does not close it), so dismissing here returns to browsing. A step-fetch `DbError`
 * degrades to a muted "steps unavailable" line, never a crash.
 */
export function RunDetailDialog(props: RunDetailDialogProps): JSX.Element {
    const dialog = useDialogEntry();

    useDialogCancel(() => props.onClose());
    // `q`/enter close. Bare printables are compliant here: the dialog hosts no text input.
    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: KEYS.enter, run: () => props.onClose() },
        ],
    }));

    const [steps, setSteps] = createSignal<StepsState>({ kind: "loading" });
    onMount(() => {
        void props.loadSteps(props.run.runId).match(
            /* eslint-disable-next-line solid/reactivity -- read-once by contract: the step figures are a point-in-time capture handed in at open, exactly like the run row and its totals, and this resolve callback runs once from onMount */
            (rows) =>
                setSteps({
                    kind: "loaded",
                    views: rows.map((r) => {
                        // Written HERE rather than in `RunBlock`, because that component takes its step
                        // figures already written — one contract for the live rail, this dialog, and the
                        // gallery, none of which can then disagree about the notation.
                        const figure = formatTokenFigure(props.stepUsage?.byStep.get(r.stepId) ?? {});
                        return {
                            label: r.stepId,
                            state: stepStateOf(r.status),
                            startedAt: r.startedAt,
                            // Absent, not "", so a step that reported nothing adds no row at all — the
                            // same absence rule every other figure on this surface follows.
                            ...(figure === "" ? {} : { usageFigure: figure }),
                        };
                    }),
                }),
            () => setSteps({ kind: "unavailable" }),
        );
    });

    const loadedViews = (): RunStepView[] => {
        const s = steps();
        return s.kind === "loaded" ? s.views : [];
    };

    return (
        <DialogPanel
            title={`${shortRunName(props.run)} ${GLYPHS.middot} ${idTail(props.run.runId)}`}
            size="lg"
            footer={`${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}
        >
            <ScrollPane focusOnMount={false} onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={1}>
                {/* Metadata is static (the row is a point-in-time capture), so plain rendered-once lines. */}
                <For each={runDetailLines(props.run, props.usage, props.stepUsage?.unattributed)}>
                    {(line) => <text fg={theme().fgMuted}>{line || " "}</text>}
                </For>
                <box paddingTop={1}>
                    <Switch>
                        <Match when={steps().kind === "loading"}>
                            <text fg={theme().fgMuted}>loading steps{GLYPHS.ellipsis}</text>
                        </Match>
                        <Match when={steps().kind === "unavailable"}>
                            <text fg={theme().fgMuted}>steps unavailable</text>
                        </Match>
                        <Match when={steps().kind === "loaded"}>
                            <RunBlock
                                name={shortRunName(props.run)}
                                tag={idTail(props.run.runId)}
                                done={loadedViews().filter((v) => v.state === "done").length}
                                total={loadedViews().length}
                                steps={loadedViews()}
                                // esc closes the dialog here (not the run) and no abort chord is bound,
                                // so the detach/abort footer would advertise keys this view does not own.
                                hint={false}
                            />
                        </Match>
                    </Switch>
                </box>
            </ScrollPane>
        </DialogPanel>
    );
}
