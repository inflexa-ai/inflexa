import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createRunEventStream, type StepActivityPart, type StepPhase } from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { harnessRuntime } from "./boot.ts";
import { activeRunProgress, type ActiveRunProgress } from "./sidebar_live.ts";

// Which run the run-activity panel is showing, whether it is dismissed, and what its focused run is
// doing right now — held here (not inside `app.tsx`) so the state is decoupled from its renderer, the
// same split as `status.ts` / `notice.ts` / `sidebar_live.ts`. One chat screen is mounted at a time,
// so a module singleton is correct.
//
// The store owns NO run data. Every run fact it renders comes from `sidebar_live`'s keyed snapshot;
// this module holds only the three things that are the panel's own — focus, dismissal, and the live
// step activity the harness's run-event stream reports, which is the one datum the rail deliberately
// does not read (it cannot fit it).

/** The focused run id, or null before the user has chosen one (the panel then shows the first active run). */
const [focusedId, setFocusedId] = createSignal<string | null>(null);
const [dismissed, setDismissed] = createSignal(false);
/**
 * The focused run's live step activity, keyed by step id — one entry per step the subscription has
 * heard from, each holding that step's latest report.
 *
 * Insertion order is REPORT RECENCY (a re-report is deleted before it is re-set), which is what
 * {@link focusedRunActivity} reads to pick between steps running concurrently. A fresh `Map` per
 * write, because Solid's default equality is referential.
 */
const [stepActivity, setStepActivity] = createSignal<ReadonlyMap<string, StepActivityPart>>(new Map());

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

/**
 * The focused run's id alone — the subscription's key, and the ONLY thing about the focused run the
 * subscription is allowed to depend on.
 *
 * `focusedRun` mints a fresh object on every sidebar refresh (see the assembly in
 * `refreshSidebarData`), so an effect tracking it would tear down and re-open the stream on every
 * poll tick, replaying the run's whole history each time for a run that has not changed. Narrowing
 * to the id lets Solid's referential equality stop the propagation: this re-fires only when focus
 * genuinely moves, which is exactly the subscription's lifetime.
 */
const focusedRunId = createMemo((): string | null => focusedRun()?.runId ?? null);

/**
 * Whether a step-activity phase means that step has stopped working.
 *
 * The stream is the panel's only evidence of which steps are live: the ledger-derived frontier the
 * panel renders is a display shape (`RunStepView`) that carries no step id, so an activity cannot be
 * joined back to a frontier row. A step's own terminal report is the honest substitute — the
 * workflow emits `complete` / `failed` as the last thing it says about itself, so a step whose
 * latest report is one of those is no longer describing work in flight.
 *
 * Declared as an exhaustive `Record<StepPhase, boolean>` rather than a set literal (the
 * `RUN_STATUS_TERMINAL` idiom) so a phase added to the harness contract is a compile error here
 * until it is classified, instead of silently defaulting to "still working".
 */
const STEP_PHASE_SETTLED: Record<StepPhase, boolean> = {
    "sandbox-init": false,
    executing: false,
    "generating-metadata": false,
    "generating-summary": false,
    indexing: false,
    persisting: false,
    retrying: false,
    warning: false,
    complete: true,
    failed: true,
};

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
 * A human phrase for what the focused run's running step is doing (`Running script deseq2.R`), or
 * `null` when nothing has been reported. Omitted rather than substituted at the render site — a
 * placeholder would claim knowledge the reader does not have.
 *
 * The phrase is the harness's, passed through verbatim: the producer emits one on every tool call
 * its agent makes and it already reads as a sentence, so re-mapping it here could only degrade it.
 *
 * The panel has ONE activity line and a run may have several steps in flight, so this picks the
 * newest report among the steps still working ({@link STEP_PHASE_SETTLED}). Newest rather than
 * first-in-the-frontier because that ordering is not available: `RunStepView` carries no step id, so
 * the two sets cannot be joined — and of the orderings that ARE available, the freshest report is
 * the one that answers "what is happening right now".
 */
export const focusedRunActivity = createMemo((): string | null => {
    const runId = focusedRunId();
    if (runId === null) return null;
    let live: StepActivityPart | null = null;
    // Later entries are more recently reported, so the last survivor of the scan wins.
    for (const part of stepActivity().values()) {
        if (part.runId !== runId || STEP_PHASE_SETTLED[part.phase]) continue;
        live = part;
    }
    return live?.activity ?? null;
});

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

/** Call-time parameters of one {@link RunPanelSeams.subscribeActivity}. */
export type RunActivitySubscription = {
    /** The run to observe. */
    readonly runId: string;
    /**
     * Receives each step activity the run reports. The harness seam folds its reconciling parts
     * latest-wins before delivery, so what arrives is a step's CURRENT value — a subscriber
     * attaching mid-run converges rather than replaying superseded intermediates.
     */
    readonly onActivity: (part: StepActivityPart) => void;
    /**
     * Aborting stops delivery. Best-effort by construction — the durability engine's reader exposes
     * no cancellation, so a part can still arrive after the abort (documented on the harness seam).
     * That is precisely why {@link watchRunPanel} also carries a generation token.
     */
    readonly signal: AbortSignal;
};

/**
 * Injectable edges so {@link watchRunPanel} is unit-testable offline (no Postgres, no booted runtime)
 * — the `RefreshSeams` / `WatchSeams` pattern from `sidebar_live.ts`.
 */
export type RunPanelSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /**
     * Observe one run's step activity until the run is terminal or the signal aborts. Real:
     * `createRunEventStream` @ the runtime pool, narrowed to `data-step-activity`.
     */
    readonly subscribeActivity: (runtime: HarnessRuntime, options: RunActivitySubscription) => Promise<void>;
};

const realRunPanelSeams: RunPanelSeams = {
    runtime: harnessRuntime,
    // The panel deliberately does NOT read `readNewestWorkflowStep` / `runWorkflowFamily` /
    // `friendlyStepLabel` (`modules/harness/profile.ts`), which the headless `inflexa run` wait still
    // uses. Those select the newest row of the durability engine's step cache, and that table records
    // a step only when it RETURNS — so a completed-step record cannot describe in-flight work. It
    // names whatever finished last, which around the slowest operation in a run is an instantaneous
    // internal checkpoint, and the engine's own stream-write bookkeeping lands in the same table and
    // would be shown verbatim. No repair changes what the source is a record of, which is why this
    // path takes the event stream instead of a fixed mapper.
    subscribeActivity: (runtime, { runId, onActivity, signal }) =>
        createRunEventStream({ pool: runtime.pool }).subscribe({
            runId,
            onPart: (part) => {
                if (part.type === "data-step-activity") onActivity(part);
            },
            signal,
        }),
};

// Monotonic token identifying the newest subscription, so a run the panel has since advanced off
// cannot write its activity over the current one. The abort below is best-effort by construction —
// the engine's reader can be suspended inside an await when it is asked to wind down — so teardown
// alone does not guarantee silence, and this is what makes a late part harmless. Same discipline as
// `refreshGeneration`.
let activityGeneration = 0;

/**
 * Wire the run-activity panel's two reactive behaviours. Call once from `App` (inside its reactive
 * root). Both are effects over the module's derived state:
 *
 *  1. **the activity subscription** — one open stream for the focused run, keyed on
 *     {@link focusedRunId} so it survives the sidebar's poll and re-opens only when focus actually
 *     moves. It is torn down on focus change, on the run terminating (a terminal run leaves
 *     `activeRunProgress`, so focus resolves elsewhere), and on unmount — all three through the same
 *     `onCleanup` abort, because they are the same event as far as this effect is concerned. The
 *     accumulated activity is cleared at the same moment, so the panel never shows one run's work
 *     under another's name.
 *
 *  2. **dismissal expiry** — clears a dismissal once no run is active. The dismissal meant "not this,
 *     not now"; once the work it referred to is over, keeping the panel suppressed would leave a
 *     later, unrelated run silently invisible with no indication why.
 */
export function watchRunPanel(seams: RunPanelSeams = realRunPanelSeams): void {
    createEffect(() => {
        const runId = focusedRunId();
        const runtime = seams.runtime();
        const mine = ++activityGeneration;
        setStepActivity(new Map());
        if (runId === null || !runtime) return;

        const controller = new AbortController();
        onCleanup(() => controller.abort());

        void seams
            .subscribeActivity(runtime, {
                runId,
                onActivity: (part) => {
                    if (mine !== activityGeneration) return;
                    setStepActivity((prev) => {
                        const next = new Map(prev);
                        // Delete before set so a re-reporting step moves to the END of the iteration
                        // order: `Map` keeps a key's ORIGINAL position on overwrite, which would make
                        // the order first-heard rather than last-heard and hand the panel a stale
                        // step's phrase whenever two steps run at once.
                        next.delete(part.stepId);
                        next.set(part.stepId, part);
                        return next;
                    });
                },
                signal: controller.signal,
            })
            .catch((err: unknown) => {
                // Defensive: the seam contains every stream failure and resolves rather than
                // rejecting, so arriving here is a defect in it — but an unhandled rejection would
                // take the TUI process down over a cosmetic channel, which is strictly worse than
                // losing the label.
                getLogger("chat").debug({ err, runId }, "run-activity subscription rejected");
            });
    });

    createEffect(() => {
        if (activeRunCount() === 0) setDismissed(false);
    });
}

/** Test hook: clear focus, dismissal, and the activity map, and invalidate any live subscription. */
export function __resetRunPanelForTest(): void {
    activityGeneration += 1;
    setFocusedId(null);
    setDismissed(false);
    setStepActivity(new Map());
}
