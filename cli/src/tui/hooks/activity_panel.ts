import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createRunEventStream, type StepActivityPart, type StepPhase } from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { harnessRuntime } from "./boot.ts";
import { activeSubjects, type PanelSubject } from "./sidebar_live.ts";

// Which subject the activity panel is showing, whether it is dismissed, and what that subject is
// doing right now — held here (not inside `app.tsx`) so the state is decoupled from its renderer, the
// same split as `status.ts` / `notice.ts` / `sidebar_live.ts`. One chat screen is mounted at a time,
// so a module singleton is correct.
//
// The store owns NO subject data. Every fact it renders comes from `sidebar_live`'s published subject
// set; this module holds only the three things that are the panel's own — focus, dismissal, and the
// live activity the harness's run-event stream reports, which is the one datum the rail deliberately
// does not read (it cannot fit it).

/**
 * Identity of one subject, stable across refreshes so a focus preference survives the sidebar minting
 * fresh objects on every five-second poll.
 *
 * Tagged by kind rather than the bare id: a run id and an analysis id come from separate spaces that
 * nothing forces apart, and a key that cannot collide across kinds by construction costs one prefix.
 *
 * A profile keys on its ANALYSIS, not on the workflow id it reports activity through. The workflow id
 * is `null` until the body records it and changes again on a re-profile, so keying on it would move a
 * focused profile out from under the reader mid-flight; the analysis is the thing the reader focused.
 */
function subjectKey(subject: PanelSubject): string {
    return subject.kind === "run" ? `run:${subject.run.runId}` : `profile:${subject.profile.analysisId}`;
}

/** The focused subject's key, or null before the user has chosen one (the panel then shows the first active subject). */
const [focusedKey, setFocusedKey] = createSignal<string | null>(null);
const [dismissed, setDismissed] = createSignal(false);
/**
 * The focused subject's live activity, keyed by step id — one entry per step the subscription has
 * heard from, each holding that step's latest report. A profile reports under a single synthetic step
 * id, so its map holds exactly one entry; a run's holds one per step it has heard from.
 *
 * Insertion order is REPORT RECENCY (a re-report is deleted before it is re-set), which is what
 * {@link focusedSubjectActivity} reads to pick between steps running concurrently. A fresh `Map` per
 * write, because Solid's default equality is referential.
 */
const [stepActivity, setStepActivity] = createSignal<ReadonlyMap<string, StepActivityPart>>(new Map());

/**
 * The subject the panel is showing, or `null` when there is nothing to show.
 *
 * DERIVED, not stored, and that is what implements auto-advance: the focused key is a *preference*,
 * and this resolves it against the live active set each time that set changes. A subject that reaches
 * a terminal state leaves {@link activeSubjects}, its key stops resolving, and the memo falls to the
 * first still-active subject — the panel advances with no effect, no writer, and no chance of the
 * fix-up loop a "correct the stored key" effect would risk. When the set empties, this is `null` and
 * the panel takes no rows.
 *
 * The stale preference is deliberately left alone rather than rewritten: {@link focusNextSubject}
 * reads THIS accessor, so navigation always steps from the subject the user can actually see.
 *
 * Falling to index 0 respects the set's own ordering — runs newest-first, then the profile — so an
 * auto-advance never lands on a background parity profile while a run the user launched is still live.
 */
export const focusedSubject = createMemo((): PanelSubject | null => {
    const subjects = activeSubjects();
    const key = focusedKey();
    if (key !== null) {
        const match = subjects.find((subject) => subjectKey(subject) === key);
        if (match) return match;
    }
    return subjects[0] ?? null;
});

/**
 * The stream the focused subject's activity arrives on, or `null` when there is nothing to subscribe
 * to — and the ONLY thing about the focused subject the subscription is allowed to depend on.
 *
 * A run's stream is its run id; a profile's is the workflow id its ledger row records. Both are what
 * {@link ActivitySubscription.runId} takes, which is the whole payoff of resolving the id in the
 * store: the subscription needs one code path, not one per kind.
 *
 * A profile whose row records no workflow id yet resolves to `null`, so no subscription opens and the
 * subject renders with no activity line. That is a normal state — the body writes its id as its first
 * durable step — and is deliberately not logged as a failure.
 *
 * {@link focusedSubject} mints a fresh object on every sidebar refresh (see the assembly in
 * `refreshSidebarData`), so an effect tracking it would tear down and re-open the stream on every poll
 * tick, replaying the subject's whole history each time for work that has not changed. Narrowing to a
 * string lets Solid's referential equality stop the propagation: this re-fires only when focus
 * genuinely moves or a re-profile records a new workflow id, which is exactly the subscription's
 * lifetime.
 */
const focusedStreamId = createMemo((): string | null => {
    const subject = focusedSubject();
    if (!subject) return null;
    // A ternary rather than a switch so a third subject kind is a compile error here (the profile arm
    // would stop narrowing) instead of silently resolving to no stream.
    return subject.kind === "run" ? subject.run.runId : subject.profile.workflowId;
});

/**
 * Whether a step-activity phase means that step has stopped working.
 *
 * The stream is the panel's only evidence of which steps are live: the ledger-derived frontier the
 * panel renders is a display shape (`RunStepView`) that carries no step id, so an activity cannot be
 * joined back to a frontier row. A step's own terminal report is the honest substitute — the
 * workflow emits `complete` / `failed` as the last thing it says about itself, so a step whose
 * latest report is one of those is no longer describing work in flight. A profile's single synthetic
 * step reports its terminal the same way, so the same rule settles it.
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

/** Whether the panel should render: it has a subject to show and the user has not dismissed it. */
export const activityPanelVisible = createMemo((): boolean => focusedSubject() !== null && !dismissed());

/** How many subjects are active — the denominator of the panel's position indicator. */
export const activeSubjectCount = createMemo((): number => activeSubjects().length);

/** The focused subject's 1-based position within the active set, or 0 when nothing is focused. */
export const focusedSubjectPosition = createMemo((): number => {
    const subject = focusedSubject();
    if (!subject) return 0;
    const key = subjectKey(subject);
    return activeSubjects().findIndex((candidate) => subjectKey(candidate) === key) + 1;
});

/**
 * A human phrase for what the focused subject is doing (`Running script deseq2.R`), or `null` when
 * nothing has been reported. Omitted rather than substituted at the render site — a placeholder would
 * claim knowledge the reader does not have.
 *
 * The phrase is the harness's, passed through verbatim: the producer emits one on every tool call its
 * agent makes and it already reads as a sentence, so re-mapping it here could only degrade it.
 *
 * The panel has ONE activity line and a run may have several steps in flight, so this picks the
 * newest report among the steps still working ({@link STEP_PHASE_SETTLED}). Newest rather than
 * first-in-the-frontier because that ordering is not available: `RunStepView` carries no step id, so
 * the two sets cannot be joined — and of the orderings that ARE available, the freshest report is
 * the one that answers "what is happening right now".
 */
export const focusedSubjectActivity = createMemo((): string | null => {
    // No stream means no subscription, so nothing can be attributed to this subject — which is also
    // what renders a profile with no recorded workflow id as a subject with no activity line.
    if (focusedStreamId() === null) return null;
    let live: StepActivityPart | null = null;
    // Deliberately NOT filtered by the part's own `runId`. A profile's parts carry a constant literal
    // as that field — the same string for every analysis — and the harness contract states normatively
    // that consumers must not key on it, so comparing it against the focused subject's identity would
    // discard every profile activity. The comparison would be redundant besides: the subscription is
    // scoped to one workflow and its children, so every delivered part belongs to the focused subject
    // by construction. `activity_panel.test.ts` pins that invariant — a part carrying a foreign identifier
    // must still show — so re-adding the check fails a test instead of silently breaking profiles.
    //
    // Later entries are more recently reported, so the last survivor of the scan wins.
    for (const part of stepActivity().values()) {
        if (STEP_PHASE_SETTLED[part.phase]) continue;
        live = part;
    }
    return live?.activity ?? null;
});

/**
 * Advance to the next active subject, wrapping past the last back to the first. A no-op when nothing
 * is active. Steps from {@link focusedSubject} (the subject on screen) rather than the stored
 * preference, so advancing off an auto-advanced panel goes where the reader expects.
 */
export function focusNextSubject(): void {
    const subjects = activeSubjects();
    if (subjects.length === 0) return;
    const current = focusedSubject();
    const key = current === null ? null : subjectKey(current);
    const i = key === null ? -1 : subjects.findIndex((subject) => subjectKey(subject) === key);
    const next = subjects[(i + 1) % subjects.length];
    setFocusedKey(next ? subjectKey(next) : null);
}

/**
 * Hide or restore the panel. Dismissal is a view state ONLY: the work keeps running, the sidebar keeps
 * showing it, and a run's completion still announces — nothing here reaches the work itself.
 *
 * SCOPE: a dismissal lasts until no subject is active, then clears (see {@link watchActivityPanel}). It
 * means "not this, not now", not "never again" — it is scoped to the work that was on screen when it
 * was issued, so later, unrelated work brings the panel back rather than being silently invisible with
 * no indication why. The alternative, a dismissal that persists for the session, makes the panel
 * disappear permanently on a keystroke a user may not remember pressing; that failure is silent and
 * self-reinforcing, whereas this one is merely a panel reappearing, which is visible and re-dismissable.
 */
export function toggleActivityPanel(): void {
    setDismissed((d) => !d);
}

/** Restore a dismissed panel (the palette command's target — idempotent when already visible). */
export function restoreActivityPanel(): void {
    setDismissed(false);
}

/** Call-time parameters of one {@link ActivityPanelSeams.subscribeActivity}. */
export type ActivitySubscription = {
    /**
     * The stream to observe. Named for a run because that is the harness seam's own parameter name,
     * where the two coincide: an analysis run's stream id IS its run id. A profile deliberately passes
     * its recorded workflow id here — the stream is keyed by the workflow that writes it, and a
     * profile's workflow is not a run.
     */
    readonly runId: string;
    /**
     * Receives each step activity the subject reports. The harness seam folds its reconciling parts
     * latest-wins before delivery, so what arrives is a step's CURRENT value — a subscriber
     * attaching mid-flight converges rather than replaying superseded intermediates.
     */
    readonly onActivity: (part: StepActivityPart) => void;
    /**
     * Aborting stops delivery. Best-effort by construction — the durability engine's reader exposes
     * no cancellation, so a part can still arrive after the abort (documented on the harness seam).
     * That is precisely why {@link watchActivityPanel} also carries a generation token.
     */
    readonly signal: AbortSignal;
};

/**
 * Injectable edges so {@link watchActivityPanel} is unit-testable offline (no Postgres, no booted runtime)
 * — the `RefreshSeams` / `WatchSeams` pattern from `sidebar_live.ts`.
 */
export type ActivityPanelSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /**
     * Observe one workflow's step activity until it is terminal or the signal aborts. Real:
     * `createRunEventStream` @ the runtime pool, narrowed to `data-step-activity`.
     */
    readonly subscribeActivity: (runtime: HarnessRuntime, options: ActivitySubscription) => Promise<void>;
};

const realActivityPanelSeams: ActivityPanelSeams = {
    runtime: harnessRuntime,
    // The panel deliberately does NOT read `readNewestWorkflowStep` / `runWorkflowFamily` /
    // `friendlyStepLabel` (`modules/harness/dev/status.ts`), which the headless `inflexa run` wait still
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

// Monotonic token identifying the newest subscription, so a subject the panel has since advanced off
// cannot write its activity over the current one. The abort below is best-effort by construction —
// the engine's reader can be suspended inside an await when it is asked to wind down — so teardown
// alone does not guarantee silence, and this is what makes a late part harmless. Same discipline as
// `refreshGeneration`.
let activityGeneration = 0;

/**
 * Wire the activity panel's two reactive behaviours. Call once from `App` (inside its reactive
 * root). Both are effects over the module's derived state:
 *
 *  1. **the activity subscription** — one open stream for the focused subject, keyed on
 *     {@link focusedStreamId} so it survives the sidebar's poll and re-opens only when the stream
 *     itself changes. It is torn down on focus change, on the subject terminating (a terminal subject
 *     leaves {@link activeSubjects}, so focus resolves elsewhere), and on unmount — all three through
 *     the same `onCleanup` abort, because they are the same event as far as this effect is concerned.
 *     The accumulated activity is cleared at the same moment, so the panel never shows one subject's
 *     work under another's name.
 *
 *  2. **dismissal expiry** — clears a dismissal once no subject is active. The dismissal meant "not
 *     this, not now"; once the work it referred to is over, keeping the panel suppressed would leave
 *     later, unrelated work silently invisible with no indication why.
 */
export function watchActivityPanel(seams: ActivityPanelSeams = realActivityPanelSeams): void {
    createEffect(() => {
        const runId = focusedStreamId();
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
        if (activeSubjectCount() === 0) setDismissed(false);
    });
}

/** Test hook: clear focus, dismissal, and the activity map, and invalidate any live subscription. */
export function __resetActivityPanelForTest(): void {
    activityGeneration += 1;
    setFocusedKey(null);
    setDismissed(false);
    setStepActivity(new Map());
}
