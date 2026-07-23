import { createSignal, For, Match, onMount, Switch } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ResultAsync } from "neverthrow";
import type { CortexRunRow, DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";
import { RunBlock, type RunStepView } from "../run_block.tsx";
import { absTime, idTail, shortRunName, stepStateOf } from "../../hooks/sidebar_live.ts";

/** The run's step-fetch state — fetched once on open, never re-polled while the dialog is up. */
type StepsState = { kind: "loading" } | { kind: "loaded"; views: RunStepView[] } | { kind: "unavailable" };

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
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) and the q/enter close keys. */
    onClose: () => void;
};

/**
 * Compose a run row's metadata into the detail view's plain lines. Pure (row → string[]) so every
 * state is unit-testable. Durable-record rule: absolute local timestamps plus a `duration` line
 * (completed − started); a still-running run shows its elapsed-at-open age instead — the same
 * vocabulary `profileDetailLines` pins for the profile dialog. The error renders verbatim on
 * failure, one line per source line.
 */
export function runDetailLines(run: CortexRunRow): string[] {
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
            (rows) => setSteps({ kind: "loaded", views: rows.map((r) => ({ label: r.stepId, state: stepStateOf(r.status), startedAt: r.startedAt })) }),
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
                <For each={runDetailLines(props.run)}>{(line) => <text fg={theme().fgMuted}>{line || " "}</text>}</For>
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
