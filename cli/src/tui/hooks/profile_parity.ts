import { createEffect, on } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { ChatContext, DataProfileState, ProfileOutcome, ProfileRerunResult } from "../../api/runs.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { fetchChatContext, rerunDataProfile } from "../../client/runs.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Notice } from "../theme.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { bootState } from "./boot.ts";
import { notify } from "./notice.ts";
import { profileSnapshot, refreshSidebarData } from "./sidebar_live.ts";

// The data-profile lifecycle's reactive side, held here (not inside app.tsx) so the wiring lives beside
// the boot/notice/sidebar hooks it reads. `watchProfileParity` is the one app-level hook App calls in
// setup; it drives TWO managed-parity edges (boot ready / analysis swap, and a profile run completing)
// through `GET {A}/chat-context`, and two fire-and-forget drivers map the outcome of the server onto
// notices: `driveProfileParity` (auto parity — skips stay silent) and `driveForceReprofile` (the
// deliberate re-profile — skips speak).
//
// The server owns the rest: it serializes the profile work of each analysis, and it re-profiles after an
// input change, from any writer. The de-dup memory below is module state — the same singleton shape as
// status.ts / notice.ts, correct because one chat screen is mounted at a time.

// The analysis id we last fired the BOOT/SWAP parity check for. Module state so a repaint or a settled
// boot phase never re-fires for an analysis already handled; a genuine swap to a different id fires
// again. A re-open of the same id after swapping away is harmless — the server reports already_running /
// already_profiled, which the driver treats as a silent skip. NOTE: only the boot/swap edge consults
// this guard; the completion edge deliberately does NOT (its whole point is to re-check the SAME
// analysis after its state changed).
let lastTriggeredAnalysisId: string | null = null;

/** Test hook: forget the last-triggered analysis. Test-only. */
export function __resetProfileParityForTest(): void {
    lastTriggeredAnalysisId = null;
}

/**
 * The reactive watch's effectful edge, injectable so the boot/swap and completion triggers are
 * unit-testable offline. Every trigger funnels through `drive`, so one test spy covers both edges.
 * Production callers omit the argument and get the real edge.
 */
export type ParityWatchOpts = {
    /** Run the profile driver for a live analysis, fire-and-forget. Real: {@link gatedProfileParity}. */
    readonly drive: (analysis: Analysis, currentAnalysisId: () => string | null) => void;
};

const DEFAULT_PARITY_WATCH_OPTS: ParityWatchOpts = {
    drive: (analysis, currentAnalysisId) => gatedProfileParity(analysis, currentAnalysisId),
};

/**
 * The hold before a profile drive: `ready` when no transfer is live, `blocked` when the transfer state
 * cannot be read. The server decides if a sandbox can start. Injectable so the composition runs offline
 * in a test.
 */
export type SandboxGate = () => Promise<"ready" | "blocked">;

const realSandboxGate: SandboxGate = async () => {
    const { awaitTransfersSettled } = await import("./sandbox_gate.tsx");
    return awaitTransfersSettled();
};

/** The effectful edges of a gated drive, injectable so the gating decision is unit-tested without the real gate. */
export type GatedDriveOpts = {
    readonly gate: SandboxGate;
    readonly drive: (analysis: Analysis, currentAnalysisId: () => string | null) => void;
};

const DEFAULT_GATED_PARITY_OPTS: GatedDriveOpts = {
    gate: realSandboxGate,
    drive: (analysis, currentAnalysisId) => void driveProfileParity(analysis, currentAnalysisId),
};

const DEFAULT_GATED_FORCE_OPTS: GatedDriveOpts = {
    gate: realSandboxGate,
    drive: (analysis, currentAnalysisId) => void driveForceReprofile(analysis, currentAnalysisId),
};

/**
 * Auto-parity behind the transfer hold: hold the drive while the transfers move, then run
 * {@link driveProfileParity}. A blocked hold drops the drive with its reason already reported. The
 * chat itself stays open — only this sandbox-making action waits (the package-store-transfers spec).
 */
export function gatedProfileParity(analysis: Analysis, currentAnalysisId: () => string | null, opts: GatedDriveOpts = DEFAULT_GATED_PARITY_OPTS): void {
    void opts.gate().then((verdict) => {
        // A swap during the wait is caught again by `driveProfileParity`'s own guards.
        if (verdict === "ready") opts.drive(analysis, currentAnalysisId);
    });
}

/** The deliberate re-profile behind the same hold — the force twin of {@link gatedProfileParity}. */
export function gatedForceReprofile(analysis: Analysis, currentAnalysisId: () => string | null, opts: GatedDriveOpts = DEFAULT_GATED_FORCE_OPTS): void {
    void opts.gate().then((verdict) => {
        if (verdict === "ready") opts.drive(analysis, currentAnalysisId);
    });
}

/**
 * Reactively keep the data profile at managed parity. Wires two edges, both fire-and-forget through
 * `GET {A}/chat-context`:
 *
 *  1. **boot ready / analysis swap** — fire when boot reaches `ready` with an analysis open, and again
 *     whenever the open analysis changes (an in-place swap). De-duped per analysis id so a repaint or a
 *     boot-phase settle does not re-fire; never fires before `ready` (no runtime to trigger against).
 *  2. **profile run reaching a terminal state** — everything a live run deferred (staging included, since
 *     its sandbox was reading the tree) was skipped as `already_running`, so re-check when the run
 *     settles — on `failed` as well as `completed`, or a run that dies leaves the deferred work stranded
 *     until the next open. Free: the sidebar already polls a running profile.
 *
 * An input change re-profiles in the server, whichever client or tool made it, thus no edge here
 * watches the inputs. Called once from App's setup body (inside its reactive owner). `opts` is
 * injected only by tests.
 */
export function watchProfileParity(workspace: Workspace, opts: ParityWatchOpts = DEFAULT_PARITY_WATCH_OPTS): void {
    // Edge 1 — boot ready + in-place analysis swap.
    createEffect(
        on(
            () => [bootState().phase, workspace.analysis?.id ?? null] as const,
            ([phase, analysisId]) => {
                if (phase !== "ready" || analysisId === null) return;
                if (analysisId === lastTriggeredAnalysisId) return;
                // The analysis is the store's, re-read here (not the destructured id) so the driver holds
                // the object, not just its id.
                const analysis = workspace.analysis;
                if (!analysis) return;
                lastTriggeredAnalysisId = analysisId;
                // Hand the driver a LIVE read of the open analysis (not the captured `analysis`) so it
                // can detect a mid-check swap when its request resolves — see `driveProfileParity`.
                opts.drive(analysis, () => workspace.analysis?.id ?? null);
            },
        ),
    );

    // Edge 2 — a profile run reaching a terminal state (the running→completed/failed down-edge).
    // Keyed by analysis id, not just status: the profile snapshot is a SHARED store, so an analysis
    // swap can transition it A-running → B-completed (B's ledger, freshly refreshed) — a status pair
    // that reads as a completion but is not B's. Record the id alongside the previous status and fire
    // only when it is unchanged across the transition, so a swap fabricates no false drive.
    let prevProfile: { status: DataProfileState["status"] | null; analysisId: string | null } = { status: null, analysisId: null };
    createEffect(() => {
        const snap = profileSnapshot();
        const status: DataProfileState["status"] | null = snap.kind === "loaded" ? snap.profile.status : null;
        const analysisId = workspace.analysis?.id ?? null;
        const prev = prevProfile;
        prevProfile = { status, analysisId };
        // Only a running→terminal transition FOR THE SAME analysis. A live run suppresses the whole
        // check, materialization included, so BOTH terminal outcomes have to release it: a run that
        // fails leaves the same deferred work behind as one that completes, and waiting for the next
        // chat open to notice is how inputs registered mid-profile went missing from the tree. This
        // costs no new polling — the sidebar already polls a running profile, so both edges are
        // observable here for free.
        const settled = status === "completed" || status === "failed";
        if (!(prev.status === "running" && settled && prev.analysisId === analysisId)) return;
        const analysis = workspace.analysis;
        if (bootState().phase !== "ready" || !analysis) return;
        opts.drive(analysis, () => workspace.analysis?.id ?? null);
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
 * offline. Production callers omit the argument and get the real edges.
 */
export type ParityDriverOpts = {
    /** The chat-open drive: materialize, never re-profile. Real: `GET {A}/chat-context`. */
    readonly check: (analysisId: string) => ResultAsync<ChatContext, ClientError>;
    /** Re-read the sidebar's snapshots for an analysis. Real: {@link refreshSidebarData}. */
    readonly refreshSidebar: (analysisId: string) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. Injected so the swap-guard test can observe it. */
    readonly notify: (notice: Notice) => void;
};

const DEFAULT_PARITY_DRIVER_OPTS: ParityDriverOpts = {
    check: (analysisId) => fetchChatContext(analysisId),
    refreshSidebar: refreshSidebarData,
    notify,
};

/**
 * Ask the server for the chat context, which runs the parity drive, and map its outcome onto the notice
 * channel; managed-parity skips stay silent. Exported for the unit test — production calls it via
 * {@link watchProfileParity} with the real edges.
 *
 * `currentAnalysisId` is a LIVE read of the open analysis. The drive stages the analysis's inputs
 * (hundreds of ms, or longer), during which the user can swap analyses. `refreshSidebarData`'s
 * generation token is last-STARTED-wins, not analysis-keyed, so poking it with this now-stale captured
 * id would tear the OLD analysis's snapshots into the shared store the user is viewing for the NEW one —
 * and a toast about analysis A while B is on screen is the same class of bug. So if the open analysis
 * changed while the request was in flight, drop BOTH the poke and the notice. The drive itself is the
 * server's, and it completes either way.
 */
export async function driveProfileParity(
    analysis: Analysis,
    currentAnalysisId: () => string | null,
    opts: ParityDriverOpts = DEFAULT_PARITY_DRIVER_OPTS,
): Promise<void> {
    // A drive that waited on the transfer hold while the user swapped away is not asked for at all.
    if (currentAnalysisId() !== analysis.id) return;
    const context = await opts.check(analysis.id);
    if (currentAnalysisId() !== analysis.id) return;
    context.match(
        (body) => applyParityOutcome(analysis, body.parity, opts),
        (e) => opts.notify(couldNotStartNotice(analysis, describeClientError(e))),
    );
}

/**
 * The parity outcome mapping. What the user should be told about a trigger, a clear, or a fault does
 * not depend on which edge asked, only on what the drive did.
 */
function applyParityOutcome(analysis: Analysis, outcome: ProfileOutcome, opts: ParityDriverOpts): void {
    switch (outcome.kind) {
        case "triggered":
            opts.notify(profilingNotice(analysis, outcome.restarted));
            // `triggered` and `cleared` are the TWO lifecycle edges that change ledger state outside the
            // sidebar's own refresh triggers. For `triggered`: the drive just seeded a pending/running
            // data-profile row, but the sidebar snapshotted this analysis as `absent` before the row
            // existed, and on an idle screen no later edge (turn completion, analysis swap) re-reads it —
            // so `hasActiveWork` never arms the poll and the DATA PROFILE section sits on "not profiled"
            // forever. Poke the store ourselves (fire-and-forget) so the running snapshot lands,
            // `hasActiveWork` arms the poll, and the poll flips the section to completed when the workflow
            // finishes. (`cleared` is the mirror edge — see its case below.) Every other skip and failure
            // changes no ledger state the sidebar needs, so it deliberately does NOT refresh.
            void opts.refreshSidebar(analysis.id);
            return;
        case "cleared":
            opts.notify({ kind: "info", text: `Data profile cleared — "${analysis.name}" has no inputs` });
            // The other ledger-state edge (see `triggered`): the profile row was just nulled because the
            // input set emptied, but the sidebar still holds the old completed snapshot — without a poke
            // the section would keep advertising a profile that no longer exists. Re-read so it falls back
            // to "not profiled".
            void opts.refreshSidebar(analysis.id);
            return;
        case "failed":
            opts.notify(couldNotStartNotice(analysis, outcome.reason));
            return;
        case "skipped_failed":
            // Silent on purpose: `skipped_failed` means the failed attempt's own input set is still the
            // one on disk, so the user's files ARE materialized and the sidebar already renders the
            // failure + its error. Nothing is withheld and nothing is pending — a toast would only nag on
            // every open about a retry the user makes deliberately ({@link driveForceReprofile}). A set
            // that drifted takes the `triggered` path above instead.
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
 * The force driver's effectful edges — the deliberate-re-profile twin of {@link ParityDriverOpts}.
 * Production callers omit the argument and get the real edges.
 */
export type ForceDriverOpts = {
    /** Ask for the deliberate re-profile. Real: `POST {A}/data-profile/rerun`. */
    readonly force: (analysisId: string) => ResultAsync<ProfileRerunResult, ClientError>;
    /** Re-read the sidebar's snapshots for an analysis. Real: {@link refreshSidebarData}. */
    readonly refreshSidebar: (analysisId: string) => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
};

const DEFAULT_FORCE_DRIVER_OPTS: ForceDriverOpts = {
    force: (analysisId) => rerunDataProfile(analysisId),
    refreshSidebar: refreshSidebarData,
    notify,
};

/**
 * Map a deliberate re-profile's outcome onto the notice channel (the palette command / dialog action).
 * Unlike {@link driveProfileParity}, the skips SPEAK: the user asked for a run, so "already running" /
 * "no inputs" are refusals worth a toast, not silent managed-parity no-ops. Shares the mid-request swap
 * guard — if the open analysis changed while the server staged files, drop both the poke and the
 * notice. Exported for the unit test; production drives it from the palette / dialog action.
 */
export async function driveForceReprofile(
    analysis: Analysis,
    currentAnalysisId: () => string | null,
    opts: ForceDriverOpts = DEFAULT_FORCE_DRIVER_OPTS,
): Promise<void> {
    const result = await opts.force(analysis.id);
    if (currentAnalysisId() !== analysis.id) return;
    if (result.isErr()) {
        opts.notify(couldNotStartNotice(analysis, describeClientError(result.error)));
        return;
    }
    const outcome = result.value.outcome;
    switch (outcome.kind) {
        case "triggered":
            opts.notify(profilingNotice(analysis, outcome.restarted));
            // Same ledger-visibility gap as the parity `triggered` poke: seed the running snapshot so the
            // sidebar arms its poll and flips to completed when the workflow finishes.
            void opts.refreshSidebar(analysis.id);
            return;
        case "already_running":
            opts.notify({ kind: "info", text: "A profile run is already in progress" });
            return;
        case "no_inputs":
            opts.notify({ kind: "warn", text: "No inputs to profile — add inputs first" });
            return;
        case "failed":
            opts.notify(couldNotStartNotice(analysis, outcome.reason));
            return;
        case "already_profiled":
        case "cleared":
        case "skipped_failed":
            // Unreachable from the force drive: force is the user's explicit will, so past its live-run
            // check it ALWAYS materializes → seeds → triggers. It never compares input sets
            // (`already_profiled`), never consults the already-materialized predicate, never clears an
            // emptied set (an empty enumerate short-circuits to `no_inputs`), and never skips a failed
            // row (it retries it). Handled here only to keep the switch exhaustive over the
            // shared outcome union — silent rather than throwing, so that a future refactor which made one
            // reachable degrades quietly rather than crashing a fire-and-forget UI action.
            return;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled force outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
