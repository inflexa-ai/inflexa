import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ResultAsync } from "neverthrow";
import type { CortexRunRow, DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { GLYPHS, space } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { Bold, Fg } from "../emphasis.tsx";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";
import { RunBlock, type RunStepView } from "../run_block.tsx";
import { relAge, runMark, shortRunName, type RunsSnapshot } from "../../hooks/sidebar_live.ts";

/**
 * Map a harness step-execution status onto the design-system run-step state (design D5). Pure and
 * exhaustive over {@link StepExecutionRow.status} — a `never`-typed default breaks the build if the
 * harness enum grows, so a new status is classified honestly rather than silently mis-bucketed.
 *
 * The four buckets are `done | running | failed | queued`; the honest mapping of the seven harness
 * statuses:
 *  - `pending` / `skipped` → `queued` — neither ran: pending awaits its turn, skipped never will.
 *    The muted hollow glyph reads as "inactive", which is truthful for both (skipped is not a
 *    success and not an error).
 *  - `running` → `running`, `completed` → `done`, `failed` → `failed` — direct.
 *  - `canceled` → `failed` — a fail-fast sibling stopped mid-flight; a non-success terminal, shown
 *    error-toned to match the sidebar's run-level `canceled`.
 *  - `blocked` → `failed` — an agent-declared blocker; `executeAnalysis` treats it as a failure
 *    (`step_blocked`), so the error tone is the honest signal.
 */
export function stepStateOf(status: StepExecutionRow["status"]): RunStepView["state"] {
    switch (status) {
        case "pending":
        case "skipped":
            return "queued";
        case "running":
            return "running";
        case "completed":
            return "done";
        case "failed":
        case "canceled":
        case "blocked":
            return "failed";
        default: {
            const _exhaustive: never = status;
            // Unreachable: the `never` assignment above proves every status is handled. The cast only
            // satisfies the return type on this dead branch — if it ever runs, the harness added a
            // status the switch does not cover, and we surface its raw string rather than crash.
            return String(_exhaustive) as RunStepView["state"];
        }
    }
}

/** The latest run's step-fetch state — fetched once on open (design D5), not by the sidebar poll. */
type StepsState = { kind: "loading" } | { kind: "loaded"; views: RunStepView[] } | { kind: "unavailable" };

/** Props for {@link RunsDialog}. */
export type RunsDialogProps = {
    /** Dialog title — the open function composes it from the analysis name. */
    title: string;
    /**
     * The runs snapshot captured at open (a point-in-time view; the sidebar poll keeps the store
     * live, but this dialog snapshots on open). Production: `runsSnapshot()`.
     */
    runs: RunsSnapshot;
    /**
     * Fetch a run's steps — called once on open for the latest run only. Production: `queryStepsByRun`
     * over the booted pool. Injected (not read from the store here) so the dialog stays offline-
     * testable and gallery-showcaseable, mirroring the seam pattern the sidebar store uses.
     */
    loadSteps: (runId: string) => ResultAsync<StepExecutionRow[], DbError>;
    /** Wired to every non-commit close (esc, click-outside, ctrl+c) and the q/enter close keys. */
    onClose: () => void;
};

/** A short, human-scannable tail of a uuid (dashes stripped). */
function idTail(id: string): string {
    return id.replace(/-/g, "").slice(-6);
}

/**
 * The runs details view: a read-only, scrollable list of the analysis's recent runs plus the latest
 * run's steps rendered through {@link RunBlock} (design D5). Dialog-system compliant — no own esc
 * binding (the host owns it), cancel wired via {@link useDialogCancel}, initial focus declared on the
 * scroll pane, `lg` preset from `dialogSize`, and showcase-inert (its q/enter close keys gate on the
 * entry's `isTop`). Degrades pre-ready to the same muted not-ready line the sidebar shows, without
 * querying; a step-fetch `DbError` degrades to a muted "steps unavailable" line, never a crash.
 */
export function RunsDialog(props: RunsDialogProps): JSX.Element {
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
    // Fetch the latest run's steps exactly once, when the view opens (design D5: not in the sidebar
    // poll). `props.runs` is itself a point-in-time capture taken at open (see its prop doc), so both
    // this fetch and the render below reflect that fixed snapshot — not later sidebar-poll updates.
    onMount(() => {
        const snap = props.runs;
        if (snap.kind !== "loaded" || snap.runs.length === 0) return;
        // Non-null: the guard one line above returned unless `runs` is a loaded, non-empty array.
        const latest = snap.runs[0]!;
        void props.loadSteps(latest.runId).match(
            (rows) => setSteps({ kind: "loaded", views: rows.map((r) => ({ label: r.stepId, state: stepStateOf(r.status) })) }),
            () => setSteps({ kind: "unavailable" }),
        );
    });

    const runsList = (): CortexRunRow[] => (props.runs.kind === "loaded" ? props.runs.runs : []);
    const loadedViews = (): RunStepView[] => {
        const s = steps();
        return s.kind === "loaded" ? s.views : [];
    };

    return (
        <DialogPanel title={props.title} size="lg" footer={`${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}>
            <ScrollPane focusOnMount={false} onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={1}>
                <Switch>
                    <Match when={props.runs.kind === "not_ready"}>
                        <text fg={theme().fgMuted}>runtime not ready</text>
                    </Match>
                    <Match when={props.runs.kind === "unavailable"}>
                        <text fg={theme().fgMuted}>runs unavailable</text>
                    </Match>
                    <Match when={props.runs.kind === "loaded"}>
                        <Show when={runsList().length > 0} fallback={<text fg={theme().fgMuted}>no runs</text>}>
                            <box flexDirection="column" paddingBottom={space.sm}>
                                <text fg={theme().fgMuted}>
                                    <Bold>RECENT RUNS</Bold>
                                </text>
                                <For each={runsList()}>
                                    {(run) => {
                                        const m = runMark(run.status);
                                        return (
                                            <text>
                                                <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                                <Fg role="fg">{idTail(run.runId)}</Fg>
                                                <Fg role="fgMuted">{` ${GLYPHS.middot} ${run.status} ${GLYPHS.middot} ${relAge(run.startedAt)}`}</Fg>
                                            </text>
                                        );
                                    }}
                                </For>
                            </box>
                            {/* The latest run's steps (keyed so a swap re-mounts the block cleanly). */}
                            <Show when={runsList()[0]} keyed>
                                {(run: CortexRunRow) => (
                                    <Switch>
                                        <Match when={steps().kind === "loading"}>
                                            <text fg={theme().fgMuted}>loading steps{GLYPHS.ellipsis}</text>
                                        </Match>
                                        <Match when={steps().kind === "unavailable"}>
                                            <text fg={theme().fgMuted}>steps unavailable</text>
                                        </Match>
                                        <Match when={steps().kind === "loaded"}>
                                            <RunBlock
                                                name={shortRunName(run)}
                                                tag={idTail(run.runId)}
                                                done={loadedViews().filter((v) => v.state === "done").length}
                                                total={loadedViews().length}
                                                steps={loadedViews()}
                                                // esc closes the dialog here (not the run) and no abort chord is bound,
                                                // so the detach/abort footer would advertise keys this view does not own.
                                                hint={false}
                                            />
                                        </Match>
                                    </Switch>
                                )}
                            </Show>
                        </Show>
                    </Match>
                </Switch>
            </ScrollPane>
        </DialogPanel>
    );
}
