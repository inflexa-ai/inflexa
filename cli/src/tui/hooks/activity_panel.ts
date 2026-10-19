import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ResultAsync } from "neverthrow";
import type { StepActivityPart, StepPhase } from "@inflexa-ai/harness/contracts/index.js";

import type { CancelRunResult } from "../../api/runs.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { cancelRun, streamRun } from "../../client/runs.ts";
import { getLogger } from "../../lib/log.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import { bootState } from "./boot.ts";
import { notify, type NotifyOptions } from "./notice.ts";
import { activeSubjects, refreshSidebarData, RUN_STATUS_TERMINAL, type PanelSubject } from "./sidebar_live.ts";

// Which subject the activity panel is showing, whether it is dismissed, and what that subject is
// doing right now — held here (not inside `app.tsx`) so the state is decoupled from its renderer, the
// same split as `status.ts` / `notice.ts` / `sidebar_live.ts`. One chat screen is mounted at a time,
// so a module singleton is correct.
//
// The store owns NO subject data. Every fact it renders comes from `sidebar_live`'s published subject
// set; this module holds only the three things that are the panel's own — focus, dismissal, and the
// live activity the run stream of the server reports, which is the one datum the rail deliberately
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

/** Call-time parameters of one {@link ActivityPanelOpts.subscribeActivity}. */
export type ActivitySubscription = {
    /** The analysis whose run or profile this is: the stream route lives under it. */
    readonly analysisId: string;
    /**
     * The stream to observe. Named for a run because that is the route's own path segment, where the
     * two coincide: an analysis run's stream id IS its run id. A profile deliberately passes its
     * recorded workflow id here — the stream is keyed by the workflow that writes it, and a profile's
     * workflow is not a run.
     */
    readonly runId: string;
    /**
     * Receives each step activity the subject reports. The harness reader folds its reconciling parts
     * latest-wins before delivery, so what arrives is a step's CURRENT value — a subscriber
     * attaching mid-flight converges rather than replaying superseded intermediates.
     */
    readonly onActivity: (part: StepActivityPart) => void;
    /**
     * Aborting closes the stream. A part already in flight can still arrive after the abort, which is
     * precisely why {@link watchActivityPanel} also carries a generation token.
     */
    readonly signal: AbortSignal;
};

/** The edges of {@link watchActivityPanel}, injectable so it is unit-testable offline (no server). */
export type ActivityPanelOpts = {
    /** Whether the runtime of the server is ready. Real: the boot phase is `ready`. */
    readonly ready: () => boolean;
    /**
     * Observe one workflow's step activity until it is terminal or the signal aborts. Real:
     * `GET {A}/run/:runId/stream`, narrowed to `data-step-activity`.
     */
    readonly subscribeActivity: (options: ActivitySubscription) => Promise<void>;
};

const DEFAULT_ACTIVITY_PANEL_OPTS: ActivityPanelOpts = {
    ready: () => bootState().phase === "ready",
    // The panel deliberately does NOT read the newest row of the durability engine's step cache, as the
    // headless `inflexa run` wait once did. That table records a step only when it RETURNS — so a
    // completed-step record cannot describe in-flight work. It names whatever finished last, which
    // around the slowest operation in a run is an instantaneous internal checkpoint. No repair changes
    // what the source is a record of, which is why this path takes the event stream.
    subscribeActivity: async ({ analysisId, runId, onActivity, signal }) => {
        const opened = await streamRun(analysisId, runId, signal);
        // A refused or broken stream costs the activity line only: the subject still renders from the
        // sidebar snapshots, and the next focus change opens the stream again.
        if (opened.isErr()) return;
        for await (const frame of opened.value) {
            if (frame.isOk() && frame.value.type === "data-step-activity") onActivity(frame.value);
        }
    },
};

// Monotonic token identifying the newest subscription, so a subject the panel has since advanced off
// cannot write its activity over the current one. The abort below is best-effort by construction —
// the engine's reader can be suspended inside an await when it is asked to wind down — so teardown
// alone does not guarantee silence, and this is what makes a late part harmless. Same discipline as
// `refreshGeneration`.
let activityGeneration = 0;

/**
 * Wire the activity panel's two reactive behaviours. Call once from `App` (inside its reactive
 * root). Both are effects over the module's derived state, and the stream route lives under the open
 * analysis of `workspace`:
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
export function watchActivityPanel(workspace: Workspace, opts: ActivityPanelOpts = DEFAULT_ACTIVITY_PANEL_OPTS): void {
    createEffect(() => {
        const runId = focusedStreamId();
        const analysisId = workspace.analysis?.id ?? null;
        const ready = opts.ready();
        const mine = ++activityGeneration;
        setStepActivity(new Map());
        if (runId === null || analysisId === null || !ready) return;

        const controller = new AbortController();
        onCleanup(() => controller.abort());

        void opts
            .subscribeActivity({
                analysisId,
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
                // Defensive: the subscription contains every stream failure and resolves rather than
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

/** The run an abort names: captured when the action starts, so the confirmation and the cancel use these values only. */
export type RunAbortTarget = {
    readonly runId: string;
    /** The label the confirmation shows, taken from the focused run at the time of the action. */
    readonly name: string;
};

/** The edges of {@link abortFocusedRun}, injectable so it is unit-testable offline (no server). */
export type RunAbortOpts = {
    /**
     * Ask the user to confirm the abort of `run`, and call `onAnswer` once: `true` to abort, `false` for
     * a decline or a dismissal. Has no default, because opening a dialog needs JSX and the dialog host
     * of the chat screen (`app.tsx`).
     */
    readonly confirm: (run: RunAbortTarget, onAnswer: (confirmed: boolean) => void) => void;
    /** Cancel the run and settle its ledgers. Real: `POST {A}/run/:runId/cancel`. */
    readonly cancel: (analysisId: string, runId: string) => ResultAsync<CancelRunResult, ClientError>;
    /** Read the runs of the analysis again at once. Real: {@link refreshSidebarData}. */
    readonly refresh: (analysisId: string) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice, durationMs?: number, opts?: NotifyOptions) => void;
};

const DEFAULT_RUN_ABORT_OPTS: Omit<RunAbortOpts, "confirm"> = {
    cancel: (analysisId, runId) => cancelRun(analysisId, runId),
    refresh: (analysisId) => refreshSidebarData(analysisId),
    notify,
};

/**
 * The runs whose cancel request is open. A set, not a single slot: a request for one run must not stop
 * the abort of a different run, and a single slot would let the second request clear the first's guard.
 */
const pendingAborts = new Set<string>();

/** The ledgers of a canceled run that did not settle, named for the user. */
function unsettledLedgers(converged: CancelRunResult["converged"]): string[] {
    const names: string[] = [];
    if (!converged.steps) names.push("the step rows");
    if (!converged.charge) names.push("the charge");
    if (!converged.mandate) names.push("the mandate");
    return names;
}

/** Join names as prose: "a", "a and b", "a, b, and c". */
function joinNames(names: readonly string[]): string {
    if (names.length <= 2) return names.join(" and ");
    return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Abort the run that the panel shows, behind a confirmation, and report what the cancel really did.
 * Resolves when the flow ends: a decline, a skipped call, or the handled outcome.
 *
 * Returns at once when no analysis is open, when no subject shows, when the subject is a data profile
 * (the run canceler cancels analysis runs only), or when the cancel request of that run is still open.
 *
 * The run id and the name are read ONE time, before the confirmation. The focus can move while the
 * dialog is open (the run ends and the panel advances), and the abort must go to the run the user
 * confirmed, not to the subject the panel shows later.
 *
 * Every replacing notice is raised BEFORE the refresh. The refresh makes the completion watcher announce
 * a canceled run with a queued notice, and a replacing notice raised after it would destroy that
 * announcement while it shows. The abort raises no notice of its own for the cancel: the watcher
 * announces the canceled run, also when the refreshed runs do not hold it, because it reads such a run
 * by its id.
 */
export async function abortFocusedRun(analysisId: string | null, opts: Pick<RunAbortOpts, "confirm"> & Partial<RunAbortOpts>): Promise<void> {
    if (analysisId === null) return;
    const subject = focusedSubject();
    if (subject?.kind !== "run") return;
    const target: RunAbortTarget = { runId: subject.run.runId, name: subject.run.name };
    if (pendingAborts.has(target.runId)) return;
    const edges: RunAbortOpts = { ...DEFAULT_RUN_ABORT_OPTS, ...opts };

    const confirmed = await new Promise<boolean>((resolve) => edges.confirm(target, resolve));
    if (!confirmed) return;

    pendingAborts.add(target.runId);
    // A `ResultAsync` carries every failure in its value and never rejects, so the guard cannot leak here.
    const result = await edges.cancel(analysisId, target.runId);
    pendingAborts.delete(target.runId);

    if (result.isErr()) {
        // The canceler can reject after the engine cancel took effect, and a transport failure leaves the
        // outcome unknown. Only a fresh read gives the real status.
        edges.notify({ kind: "error", text: `Could not abort ${target.name}: ${describeClientError(result.error)}` });
        await edges.refresh(analysisId);
        return;
    }

    const { outcome, finalStatus, converged } = result.value;
    if (outcome === "canceled" && finalStatus === "canceled") {
        // The completion watcher announces the cancel after the refresh, so no notice here says the same
        // thing twice. A ledger that did not settle is the exception: the canceler logs the cause, and a
        // second cancel gives `already_terminal`, so this notice is the only report the user gets.
        const unsettled = unsettledLedgers(converged);
        if (unsettled.length > 0) {
            edges.notify({ kind: "warn", text: `${target.name} was canceled, but ${joinNames(unsettled)} did not settle.` });
        }
        await edges.refresh(analysisId);
        return;
    }
    if (outcome === "canceled" && !RUN_STATUS_TERMINAL[finalStatus]) {
        // The canceler stopped the workflow, but its write of the run row failed and the re-read gave the old status.
        edges.notify({ kind: "error", text: `${target.name} did not settle: the workflow stopped, but the run row still shows ${finalStatus}.` });
    } else {
        edges.notify({ kind: "info", text: `${target.name} already finished (${finalStatus}), so nothing was aborted.` });
    }
    await edges.refresh(analysisId);
}

/** Test hook: clear focus, dismissal, the activity map, and the open abort requests, and invalidate any live subscription. */
export function __resetActivityPanelForTest(): void {
    activityGeneration += 1;
    pendingAborts.clear();
    setFocusedKey(null);
    setDismissed(false);
    setStepActivity(new Map());
}
