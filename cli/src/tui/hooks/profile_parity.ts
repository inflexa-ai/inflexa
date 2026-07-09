import { createEffect, on, onCleanup } from "solid-js";
import type { DataProfileStatus } from "@inflexa-ai/harness";

import { GLYPHS } from "../../lib/design_system.ts";
import { Bus } from "../../lib/bus.ts";
import { ensureProfileAtParity, forceReprofile, type ProfileParityOutcome } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { Notice } from "../theme.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { bootState, harnessRuntime } from "./boot.ts";
import { notify } from "./notice.ts";
import { profileSnapshot, refreshSidebarData } from "./sidebar_live.ts";

// The data-profile lifecycle's reactive side, held here (not inside app.tsx) so the
// wiring lives beside the boot/notice/sidebar hooks it reads. `watchProfileParity` is the one
// app-level hook App calls in setup; it drives THREE managed-parity edges (boot ready / analysis
// swap, a live input mutation on the open analysis, and a profile run completing) plus, alongside it,
// two fire-and-forget drivers map the headless engine's outcome union onto notices: `driveProfileParity`
// (auto parity — skips stay silent) and `driveForceReprofile` (the deliberate re-profile — skips speak).
// The drivers + the de-dup memory are module state — the same singleton shape as status.ts / notice.ts,
// correct because one chat screen is mounted at a time.

// The analysis id we last fired the BOOT/SWAP parity check for. Module state so a repaint or a settled
// boot phase never re-fires for an analysis already handled; a genuine swap to a different id fires
// again. A re-open of the same id after swapping away is harmless — the helper reports already_running /
// already_profiled, which the driver treats as a silent skip. NOTE: only the boot/swap edge consults
// this guard; the input-mutation and completion edges deliberately do NOT (their whole point is to
// re-check the SAME analysis after its state changed).
let lastTriggeredAnalysisId: string | null = null;

// The tail of the profile-work queue. EVERY entry into the profile lifecycle — the three parity edges
// and the deliberate force — runs its whole stage → seed → trigger sequence through here, one at a time.
//
// The harness ledger CAS serializes the workflow DISPATCH, but it runs only after staging, so it cannot
// serialize the two things that actually race. First, `stageInputs` rm/relinks files under one session
// tree and then deletes every on-disk file absent from ITS OWN manifest (`reconcileStagedTree`), so a
// drive holding a stale manifest can delete files another just linked — under a sandbox that is already
// reading them. Second, the empty-set branch's `clearDataProfile` nulls `seed_input_file_ids`, which
// landing between another drive's seed and its trigger refuses that drive for an absent seed.
//
// The per-analysis instance lock excludes other PROCESSES but is re-entrant per pid (lib/lock.ts), so it
// cannot serve as the in-process guard. One chat screen with one open analysis is mounted at a time, so
// an unkeyed queue is correct.
//
// Arrivals QUEUE, they do not drop: the edges fire precisely because state changed, so a drive arriving
// during another must still run afterwards, against the new state. Dropping it would reopen the window
// those edges were added to close.
let profileQueueTail: Promise<unknown> = Promise.resolve();

/**
 * Run `work` after everything already queued. `.then(work, work)` so a rejected predecessor still lets
 * its successors run, and the tail is kept rejection-free so one failure cannot skip every later drive.
 * The returned promise carries `work`'s own outcome, so a caller (or a test) still observes it.
 */
function serializeProfileWork(work: () => Promise<void>): Promise<void> {
    const next = profileQueueTail.then(work, work);
    profileQueueTail = next.then(
        () => {},
        () => {},
    );
    return next;
}

/** Test hook: forget the last-triggered analysis and drain the work queue. Test-only. */
export function __resetProfileParityForTest(): void {
    lastTriggeredAnalysisId = null;
    profileQueueTail = Promise.resolve();
}

// Trailing-edge debounce for the live input-mutation drift check: a batch edit (a multi-file add via
// the picker) emits a BURST of prov.input_* events, and we want ONE parity check per burst, not one per
// file. 500ms comfortably outlasts a burst while staying imperceptible for a single edit.
const DRIFT_DEBOUNCE_MS = 500;

/**
 * The reactive watch's effectful edges, injectable so the boot/swap, live-input, and completion
 * triggers are unit-testable offline (no real parity check, no wall-clock timer) — mirrors `WatchSeams`
 * in `sidebar_live.ts`. Every trigger funnels through `drive` (so one test spy covers all three edges),
 * and `schedule` wraps `setTimeout`/`clearTimeout` into an arm→cancel closure so the debounce is drivable
 * without a fake clock. Production callers omit the argument and get the real edges.
 */
export type ParityWatchSeams = {
    /** Run the parity driver for a live analysis, fire-and-forget. Real: {@link driveProfileParity}. */
    readonly drive: (runtime: HarnessRuntime, analysis: Analysis, currentAnalysisId: () => string | null) => void;
    /** Arm a one-shot trailing-edge timer; returns its cancel. Real: wraps `setTimeout`/`clearTimeout`. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
};

const realParityWatchSeams: ParityWatchSeams = {
    drive: (runtime, analysis, currentAnalysisId) => void driveProfileParity(runtime, analysis, currentAnalysisId),
    schedule: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        // A half-elapsed debounce must never keep the process alive (matters for tests + clean shutdown).
        handle.unref?.();
        return () => clearTimeout(handle);
    },
};

/**
 * Reactively keep the data profile at managed parity. Wires three edges, all fire-and-forget
 * through {@link driveProfileParity}:
 *
 *  1. **boot ready / analysis swap** — fire when boot reaches `ready` with an analysis open, and again
 *     whenever the open analysis changes (an in-place swap). De-duped per analysis id so a repaint or a
 *     boot-phase settle does not re-fire; never fires before `ready` (no runtime to trigger against).
 *  2. **live input mutation** — a `prov.input_added`/`prov.input_removed` for the OPEN analysis can drift
 *     it off its profiled set, but edge 1 only fires on open/swap, so without this an edit mid-session
 *     would never re-check. Debounced (trailing edge) to one check per burst; the timer's fire re-reads
 *     live state so a swap or teardown during the debounce window is a no-op.
 *  3. **profile run completion** — edits made WHILE a profile ran were skipped (`already_running`), so
 *     re-check on the running→completed transition. Free: the sidebar already polls a running profile.
 *
 * Called once from App's setup body (inside its reactive owner). `seams` is injected only by tests.
 */
export function watchProfileParity(workspace: Workspace, seams: ParityWatchSeams = realParityWatchSeams): void {
    // Edge 1 — boot ready + in-place analysis swap.
    createEffect(
        on(
            () => [bootState().phase, workspace.analysis?.id ?? null] as const,
            ([phase, analysisId]) => {
                if (phase !== "ready" || analysisId === null) return;
                if (analysisId === lastTriggeredAnalysisId) return;
                // `ready` guarantees a booted runtime handle; the analysis is the store's, re-read here
                // (not the destructured id) so the driver holds the object, not just its id.
                const runtime = harnessRuntime();
                const analysis = workspace.analysis;
                if (!runtime || !analysis) return;
                lastTriggeredAnalysisId = analysisId;
                // Hand the driver a LIVE read of the open analysis (not the captured `analysis`) so it
                // can detect a mid-check swap when its async work resolves — see `driveProfileParity`.
                seams.drive(runtime, analysis, () => workspace.analysis?.id ?? null);
            },
        ),
    );

    // Edge 2 — a live input mutation on the open analysis, debounced to one drift check per burst.
    let driftCancel: (() => void) | null = null;
    let pendingDriftId: string | null = null;
    const cancelDrift = (): void => {
        if (driftCancel) {
            driftCancel();
            driftCancel = null;
        }
    };
    const onInputEvent = (e: StampedEvent): void => {
        if (e.type !== "prov.input_added" && e.type !== "prov.input_removed") return;
        // Only edits to the analysis on screen, and only once booted (no runtime to check against
        // before then). This deliberately does NOT touch `lastTriggeredAnalysisId`: that guard de-dups
        // edge 1, but an input edit MUST re-fire for the SAME analysis (its set just changed), and a
        // no-drift check is cheap by design.
        if (bootState().phase !== "ready") return;
        const openId = workspace.analysis?.id ?? null;
        if (openId === null || e.analysisId !== openId) return;
        pendingDriftId = openId;
        // Trailing edge: each event in a burst re-arms, so only the burst's LAST event's timer fires.
        cancelDrift();
        driftCancel = seams.schedule(() => {
            driftCancel = null;
            const targetId = pendingDriftId;
            pendingDriftId = null;
            // Re-read live at fire time — never the values captured when the event arrived: the debounce
            // window can outlast a swap or a runtime teardown. If the open analysis moved on (or the
            // runtime is gone), skip; the driver's own swap guard is the second net.
            const runtime = harnessRuntime();
            const analysis = workspace.analysis;
            if (!runtime || !analysis || analysis.id !== targetId) return;
            seams.drive(runtime, analysis, () => workspace.analysis?.id ?? null);
        }, DRIFT_DEBOUNCE_MS);
    };
    Bus.on("inflexa", onInputEvent);
    onCleanup(() => {
        Bus.off("inflexa", onInputEvent);
        cancelDrift();
    });

    // Edge 3 — a profile run completing (the running→completed down-edge).
    let prevProfileStatus: DataProfileStatus["status"] | null = null;
    createEffect(() => {
        const snap = profileSnapshot();
        const status: DataProfileStatus["status"] | null = snap.kind === "loaded" ? snap.profile.status : null;
        const wasRunning = prevProfileStatus === "running";
        prevProfileStatus = status;
        // Only the running→completed transition. Edits made WHILE a profile ran were skipped
        // (`already_running`); this closes that window without any new polling, because the sidebar
        // already polls a running profile, so the transition is observable here for free.
        if (!(wasRunning && status === "completed")) return;
        const runtime = harnessRuntime();
        const analysis = workspace.analysis;
        if (!runtime || !analysis) return;
        seams.drive(runtime, analysis, () => workspace.analysis?.id ?? null);
    });
}

/** The (re-)profiling info toast both drivers raise when a workflow starts. `restarted` words it. */
function profilingNotice(analysis: Analysis, restarted: boolean): Notice {
    return { kind: "info", text: `${restarted ? "Re-profiling" : "Profiling"} "${analysis.name}" data${GLYPHS.ellipsis}` };
}

/** The warn toast both drivers raise when the workflow could not be started. */
function couldNotStartNotice(analysis: Analysis, reason: string): Notice {
    return { kind: "warn", text: `Could not start profiling "${analysis.name}": ${reason}` };
}

/**
 * The parity driver's effectful edges, injectable so the outcome→side-effect mapping is unit-testable
 * offline — mirrors the seam bundles in `sidebar_live.ts` (`WatchSeams`) and `profile_trigger.ts`.
 * Production callers omit the argument and get the real edges.
 */
export type ParityDriverSeams = {
    /** Produce the parity outcome for this analysis. Real: {@link ensureProfileAtParity}. */
    readonly check: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** Re-read the sidebar's ledger snapshots for an analysis. Real: {@link refreshSidebarData}. */
    readonly refreshSidebar: (analysisId: string) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. Injected so the swap-guard test can observe it. */
    readonly notify: (notice: Notice) => void;
};

const realParityDriverSeams: ParityDriverSeams = {
    check: ensureProfileAtParity,
    refreshSidebar: refreshSidebarData,
    notify,
};

/**
 * Run the helper and map its outcome onto the notice channel; managed-parity skips stay silent (design
 * D8). Exported for the unit test — production calls it via {@link watchProfileParity} with the real seams.
 *
 * `currentAnalysisId` is a LIVE read of the open analysis, checked once `check` resolves. `check` stages
 * the analysis's inputs (hundreds of ms), during which the user can swap analyses. This is the ONE
 * refresh path not naturally keyed to the current workspace: `refreshSidebarData`'s generation token is
 * last-STARTED-wins, not analysis-keyed, so poking it with this now-stale captured id would tear the OLD
 * analysis's snapshots into the shared store the user is viewing for the NEW one — and a toast about
 * analysis A while B is on screen is the same class of bug. So if the open analysis changed while `check`
 * was in flight, drop BOTH the poke and the notice.
 */
export function driveProfileParity(
    runtime: HarnessRuntime,
    analysis: Analysis,
    currentAnalysisId: () => string | null,
    seams: ParityDriverSeams = realParityDriverSeams,
): Promise<void> {
    return serializeProfileWork(() => runParityDrive(runtime, analysis, currentAnalysisId, seams));
}

/** {@link driveProfileParity}'s body, run under the shared profile-work queue. */
async function runParityDrive(runtime: HarnessRuntime, analysis: Analysis, currentAnalysisId: () => string | null, seams: ParityDriverSeams): Promise<void> {
    const outcome = await seams.check(runtime, analysis);
    // Swapped analyses while `check` staged files? Drop both the poke and the notice (see the doc above).
    if (currentAnalysisId() !== analysis.id) return;
    switch (outcome.kind) {
        case "triggered":
            seams.notify(profilingNotice(analysis, outcome.restarted));
            // `triggered` and `cleared` are the TWO lifecycle edges that change ledger state outside the
            // sidebar's own refresh triggers. For `triggered`: the check just seeded a pending/running
            // data-profile row, but the sidebar snapshotted this analysis as `absent` before the row
            // existed, and on an idle screen no later edge (turn completion, analysis swap) re-reads it —
            // so `hasActiveWork` never arms the poll and the DATA PROFILE section sits on "not profiled"
            // forever. Poke the store ourselves (fire-and-forget) so the running snapshot lands,
            // `hasActiveWork` arms the poll, and the poll flips the section to completed when the workflow
            // finishes. (`cleared` is the mirror edge — see its case below.) Every other skip and failure
            // changes no ledger state the sidebar needs, so it deliberately does NOT refresh.
            void seams.refreshSidebar(analysis.id);
            return;
        case "cleared":
            seams.notify({ kind: "info", text: `Data profile cleared — "${analysis.name}" has no inputs` });
            // The other ledger-state edge (see `triggered`): the profile row was just nulled because the
            // input set emptied, but the sidebar still holds the old completed snapshot — without a poke
            // the section would keep advertising a profile that no longer exists. Re-read so it falls back
            // to "not profiled".
            void seams.refreshSidebar(analysis.id);
            return;
        case "failed":
            seams.notify(couldNotStartNotice(analysis, outcome.reason));
            return;
        case "skipped_failed":
            // Silent on purpose: the sidebar already renders the failed state + its error, and retry is a
            // DELIBERATE action ({@link driveForceReprofile}), so a toast here would nag on every open
            // while the user has decided to retry manually.
            return;
        case "already_profiled":
        case "already_running":
        case "no_inputs":
            return;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled parity outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * The force driver's effectful edges — the deliberate-re-profile twin of {@link ParityDriverSeams}.
 * Production callers omit the argument and get the real edges.
 */
export type ForceDriverSeams = {
    /** Produce the force outcome for this analysis. Real: {@link forceReprofile}. */
    readonly force: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** Re-read the sidebar's ledger snapshots for an analysis. Real: {@link refreshSidebarData}. */
    readonly refreshSidebar: (analysisId: string) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
};

const realForceDriverSeams: ForceDriverSeams = {
    force: forceReprofile,
    refreshSidebar: refreshSidebarData,
    notify,
};

/**
 * Map a {@link forceReprofile} outcome onto the notice channel for a DELIBERATE re-profile (the palette
 * command / dialog action). Unlike {@link driveProfileParity}, the skips SPEAK: the user asked for a run,
 * so "already running" / "no inputs" are refusals worth a toast, not silent managed-parity no-ops. Shares
 * the mid-check swap guard — if the open analysis changed while `force` staged files, drop both the poke
 * and the notice. Exported for the unit test; production drives it from the palette / dialog action.
 */
export function driveForceReprofile(
    runtime: HarnessRuntime,
    analysis: Analysis,
    currentAnalysisId: () => string | null,
    seams: ForceDriverSeams = realForceDriverSeams,
): Promise<void> {
    // Shares the parity queue, not a queue of its own: force and parity both stage into the same
    // session tree and both write the same ledger row, so they must exclude each other too.
    return serializeProfileWork(() => runForceDrive(runtime, analysis, currentAnalysisId, seams));
}

/** {@link driveForceReprofile}'s body, run under the shared profile-work queue. */
async function runForceDrive(runtime: HarnessRuntime, analysis: Analysis, currentAnalysisId: () => string | null, seams: ForceDriverSeams): Promise<void> {
    const outcome = await seams.force(runtime, analysis);
    // Swapped analyses while `force` staged files? Drop both the poke and the notice (see driveProfileParity).
    if (currentAnalysisId() !== analysis.id) return;
    switch (outcome.kind) {
        case "triggered":
            seams.notify(profilingNotice(analysis, outcome.restarted));
            // Same ledger-visibility gap as the parity `triggered` poke: seed the running snapshot so the
            // sidebar arms its poll and flips to completed when the workflow finishes.
            void seams.refreshSidebar(analysis.id);
            return;
        case "already_running":
            seams.notify({ kind: "info", text: "A profile run is already in progress" });
            return;
        case "no_inputs":
            seams.notify({ kind: "warn", text: "No inputs to profile — add inputs first" });
            return;
        case "failed":
            seams.notify(couldNotStartNotice(analysis, outcome.reason));
            return;
        case "already_profiled":
        case "cleared":
        case "skipped_failed":
            // Unreachable from `forceReprofile`: force is the user's explicit will, so past its live-run
            // check it ALWAYS stages → seeds → triggers. It never compares input sets (`already_profiled`),
            // never clears an emptied set (an empty enumerate short-circuits to `no_inputs`), and never
            // skips a failed row (it retries it). Handled here only to keep the switch exhaustive over the
            // shared outcome union — silent rather than throwing, so that a future refactor which made one
            // reachable degrades quietly rather than crashing a fire-and-forget UI action.
            return;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled force outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
