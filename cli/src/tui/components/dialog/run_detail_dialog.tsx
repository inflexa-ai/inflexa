import { createSignal, For, Match, onMount, Switch } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ResultAsync } from "neverthrow";

import type { RunDetail, RunSummary } from "../../../api/runs.ts";
import type { UsageTotals } from "../../../api/usage.ts";
import type { ClientError } from "../../../client/api.ts";
import { GLYPHS } from "../../../lib/design_system.ts";
import { formatTokenFigure, formatTokenFigureLabelled, NOT_REPORTED } from "../../../lib/usage_format.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";
import { RunBlock, type RunStepView } from "../run_block.tsx";
import { absTime, idTail, shortRunName, stepStateOf } from "../../hooks/sidebar_live.ts";

/**
 * The run's detail-fetch state — fetched once on open, never re-polled while the dialog is up. A
 * loaded detail carries the step views and the run's calls that belong to no step.
 */
type DetailState = { kind: "loading" } | { kind: "loaded"; views: RunStepView[]; unattributed: UsageTotals | null } | { kind: "unavailable" };

/** Props for {@link RunDetailDialog}. */
export type RunDetailDialogProps = {
    /**
     * The picked run (a point-in-time capture from the picker's fresh fetch). Its `usage` is the
     * headline figure: absent when the run has no ledger rows or the usage read failed, and the line
     * is then omitted entirely rather than printed as a zero.
     */
    run: RunSummary;
    /**
     * Fetch the run's steps with their figures — called once on open. Production: `GET {A}/run/:runId`.
     * Injected so the dialog stays offline-testable and gallery-showcaseable.
     */
    loadDetail: (runId: string) => ResultAsync<RunDetail, ClientError>;
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
 * caller's runs read carries it on each row. Passing nothing omits the line, which
 * covers both "this run has no recorded calls" and "the usage read failed" — neither is a figure, and
 * a zero would assert one.
 *
 * `unattributed` is the part of `usage` that no step below accounts for, printed as an indented line
 * under it so the headline visibly reconciles with the step list. Printing it is not decoration: the
 * step figures are usage rows joined onto step rows, so a run-level call has no row to land on and
 * would otherwise be counted in the headline and shown nowhere — a total disagreeing with its parts,
 * which reads as a broken ledger rather than as work that ran outside a step. It arrives with the
 * detail fetch, thus the line appears once the steps load.
 */
export function runDetailLines(run: RunSummary, usage?: UsageTotals, unattributed?: UsageTotals | null): string[] {
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
 * (the opener does not close it), so dismissing here returns to browsing. A failed detail fetch
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

    const [detail, setDetail] = createSignal<DetailState>({ kind: "loading" });
    onMount(() => {
        void props.loadDetail(props.run.runId).match(
            (loaded) =>
                setDetail({
                    kind: "loaded",
                    views: loaded.steps.map((step) => {
                        // Written HERE rather than in `RunBlock`, because that component takes its step
                        // figures already written — one contract for the live rail, this dialog, and the
                        // gallery, none of which can then disagree about the notation.
                        const figure = formatTokenFigure(step.usage ?? {});
                        return {
                            label: step.stepId,
                            state: stepStateOf(step.status),
                            startedAt: step.startedAt,
                            // Absent, not "", so a step that reported nothing adds no row at all — the
                            // same absence rule every other figure on this surface follows.
                            ...(figure === "" ? {} : { usageFigure: figure }),
                        };
                    }),
                    unattributed: loaded.unattributedUsage,
                }),
            () => setDetail({ kind: "unavailable" }),
        );
    });

    const loadedViews = (): RunStepView[] => {
        const d = detail();
        return d.kind === "loaded" ? d.views : [];
    };
    const unattributed = (): UsageTotals | null => {
        const d = detail();
        return d.kind === "loaded" ? d.unattributed : null;
    };

    return (
        <DialogPanel
            title={`${shortRunName(props.run)} ${GLYPHS.middot} ${idTail(props.run.runId)}`}
            size="lg"
            footer={`${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}
        >
            <ScrollPane focusOnMount={false} onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={1}>
                {/* The row is a point-in-time capture; only the outside-any-step line waits for the detail. */}
                <For each={runDetailLines(props.run, props.run.usage, unattributed())}>{(line) => <text fg={theme().fgMuted}>{line || " "}</text>}</For>
                <box paddingTop={1}>
                    <Switch>
                        <Match when={detail().kind === "loading"}>
                            <text fg={theme().fgMuted}>loading steps{GLYPHS.ellipsis}</text>
                        </Match>
                        <Match when={detail().kind === "unavailable"}>
                            <text fg={theme().fgMuted}>steps unavailable</text>
                        </Match>
                        <Match when={detail().kind === "loaded"}>
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
