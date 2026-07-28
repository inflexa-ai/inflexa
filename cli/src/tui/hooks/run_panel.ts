import { createEffect, createMemo, createSignal } from "solid-js";

import { readNewestWorkflowStep, runWorkflowFamily } from "../../modules/harness/profile.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { harnessRuntime } from "./boot.ts";
import { activeRunProgress, type ActiveRunProgress } from "./sidebar_live.ts";

// Which run the run-activity panel is showing, whether it is dismissed, and what its focused run is
// doing right now — held here (not inside `app.tsx`) so the state is decoupled from its renderer, the
// same split as `status.ts` / `notice.ts` / `sidebar_live.ts`. One chat screen is mounted at a time,
// so a module singleton is correct.
//
// The store owns NO run data. Every run fact it renders comes from `sidebar_live`'s keyed snapshot;
// this module holds only the three things that are the panel's own — focus, dismissal, and the
// activity label, which is the one datum the rail deliberately does not read (it cannot fit it).

/** The focused run id, or null before the user has chosen one (the panel then shows the first active run). */
const [focusedId, setFocusedId] = createSignal<string | null>(null);
const [dismissed, setDismissed] = createSignal(false);
const [activity, setActivity] = createSignal<string | null>(null);

/**
 * The run the panel is showing, or `null` when there is nothing to show.
 *
 * DERIVED, not stored, and that is what implements auto-advance: the focused id is a *preference*,
 * and this resolves it against the live active set each time that set changes. A run that reaches a
 * terminal status leaves `activeRunProgress`, its id stops resolving, and the memo falls to the
 * first still-active run — the panel advances with no effect, no writer, and no chance of the
 * fix-up loop a "correct the stored id" effect would risk. When the set empties, this is `null` and
 * the panel takes no rows.
 *
 * The stale preference is deliberately left alone rather than rewritten: {@link focusNextRun} reads
 * THIS accessor, so navigation always steps from the run the user can actually see.
 */
export const focusedRun = createMemo((): ActiveRunProgress | null => {
    const active = activeRunProgress();
    const id = focusedId();
    if (id !== null) {
        const match = active.get(id);
        if (match) return match;
    }
    // `Map` iterates in insertion order, which the refresh builds newest-run-first.
    for (const run of active.values()) return run;
    return null;
});

/** Whether the panel should render: it has a run to show and the user has not dismissed it. */
export const runPanelVisible = createMemo((): boolean => focusedRun() !== null && !dismissed());

/** How many runs are active — the denominator of the panel's position indicator. */
export const activeRunCount = createMemo((): number => activeRunProgress().size);

/** The focused run's 1-based position within the active set, or 0 when nothing is focused. */
export const focusedRunPosition = createMemo((): number => {
    const run = focusedRun();
    if (!run) return 0;
    return [...activeRunProgress().keys()].indexOf(run.runId) + 1;
});

/**
 * A human phrase for what the focused run's newest durable workflow step is doing, or `null` when it
 * cannot be resolved. Omitted rather than substituted at the render site — a placeholder would claim
 * knowledge the reader does not have.
 */
export const focusedRunActivity = activity;

/**
 * Advance to the next active run, wrapping past the last back to the first. A no-op when nothing is
 * active. Steps from {@link focusedRun} (the run on screen) rather than the stored preference, so
 * advancing off an auto-advanced panel goes where the reader expects.
 */
export function focusNextRun(): void {
    const ids = [...activeRunProgress().keys()];
    if (ids.length === 0) return;
    const current = focusedRun()?.runId ?? null;
    const i = current === null ? -1 : ids.indexOf(current);
    setFocusedId(ids[(i + 1) % ids.length] ?? null);
}

/**
 * Hide or restore the panel. Dismissal is a view state ONLY: the run keeps running, the sidebar keeps
 * showing it, and its completion still announces — nothing here reaches the run.
 *
 * SCOPE: a dismissal lasts until no run is active, then clears (see {@link watchRunPanel}). It means
 * "not this, not now", not "never again" — it is scoped to the work that was on screen when it was
 * issued, so a later, unrelated run brings the panel back rather than being silently invisible with
 * no indication why. The alternative, a dismissal that persists for the session, makes the panel
 * disappear permanently on a keystroke a user may not remember pressing; that failure is silent and
 * self-reinforcing, whereas this one is merely a panel reappearing, which is visible and re-dismissable.
 */
export function toggleRunPanel(): void {
    setDismissed((d) => !d);
}

/** Restore a dismissed panel (the palette command's target — idempotent when already visible). */
export function restoreRunPanel(): void {
    setDismissed(false);
}

/**
 * Injectable edges so {@link watchRunPanel} is unit-testable offline (no Postgres, no booted runtime)
 * — the `RefreshSeams` / `WatchSeams` pattern from `sidebar_live.ts`.
 */
export type RunPanelSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** The newest durable step of a run's workflow family. Real: `readNewestWorkflowStep` @ `runWorkflowFamily`. */
    readonly readActivity: (runtime: HarnessRuntime, runId: string) => Promise<{ step: number; label: string } | null>;
};

const realRunPanelSeams: RunPanelSeams = {
    runtime: harnessRuntime,
    readActivity: (runtime, runId) => readNewestWorkflowStep(runtime.pool, runWorkflowFamily(runId)),
};

// Monotonic token identifying the newest activity read, so a slow read for a run the panel has since
// advanced off cannot write its label over the current one. Same discipline as `refreshGeneration`.
let activityGeneration = 0;

/**
 * Wire the run-activity panel's two reactive behaviours. Call once from `App` (inside its reactive
 * root). Both are effects over the module's derived state:
 *
 *  1. **the activity read** — re-fires whenever the focused run changes identity OR the sidebar
 *     refresh mints a fresh snapshot for it, which is deliberately the whole cadence: the refresh's
 *     lifecycle edges, its bounded poll, and its run-observation trigger already decide when run
 *     state is worth re-reading, and a second timer here would be a competing cadence for the same
 *     question. A run whose step read blips re-reads once, on the fresh → stale edge that re-stamps
 *     its entry; every blip after that carries the SAME object (see the assembly in
 *     `refreshSidebarData`), so a persistent outage costs one activity read, not one per tick.
 *
 *  2. **dismissal expiry** — clears a dismissal once no run is active. The dismissal meant "not this,
 *     not now"; once the work it referred to is over, keeping the panel suppressed would leave a
 *     later, unrelated run silently invisible with no indication why.
 */
export function watchRunPanel(seams: RunPanelSeams = realRunPanelSeams): void {
    createEffect(() => {
        const run = focusedRun();
        const runtime = seams.runtime();
        const mine = ++activityGeneration;
        if (!run || !runtime) {
            setActivity(null);
            return;
        }
        // `readActivity` resolves `null` on any miss or error rather than rejecting — the activity
        // label is a cosmetic channel, and a DBOS hiccup must degrade to "no label", never to a
        // rejected promise inside a reactive effect.
        void seams.readActivity(runtime, run.runId).then((detail) => {
            if (mine !== activityGeneration) return;
            setActivity(detail?.label ?? null);
        });
    });

    createEffect(() => {
        if (activeRunCount() === 0) setDismissed(false);
    });
}

/** Test hook: clear focus, dismissal, and the activity label, and invalidate any in-flight read. */
export function __resetRunPanelForTest(): void {
    activityGeneration += 1;
    setFocusedId(null);
    setDismissed(false);
    setActivity(null);
}
