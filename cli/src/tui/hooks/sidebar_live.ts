import { createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { ResultAsync } from "neverthrow";
import {
    loadDataProfileStatus,
    loadPlan,
    queryActiveRunsByAnalysis,
    queryRunsByAnalysis,
    queryStepsByRun,
    type CortexRunRow,
    type DataProfileStatus,
    type DbError,
    type Pool,
    type RunStatus,
    type StepExecutionRow,
} from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { RunStepView } from "../components/run_block.tsx";
import { bootState, harnessRuntime } from "./boot.ts";
import { chatStatus, type ChatStatus } from "./status.ts";

// The sidebar's live ledger data — the data-profile status and the analysis's newest runs — held
// here (not inside `sidebar.tsx`) so the holder is decoupled from its renderer, the same split as
// `status.ts` / `boot.ts` / `conversation.ts`. The `Sidebar` reads the two snapshots reactively;
// `refreshSidebarData` (re)populates them from the booted runtime's pool; `watchSidebarData` wires
// the lifecycle triggers + the bounded poll from `App`. One chat screen is mounted at a time, so a
// module singleton is correct — and the two snapshots are the only reactive cells (the generation
// token and the interval handle are plain infrastructure, nothing reacts to them).
//
// Polling is the deliberate v1 transport — the harness run-event stream's read side is
// not OSS-side yet, so this reads ledger rows on lifecycle edges and, ONLY while work is active, a
// bounded interval. When the harness ships the stream read helper, `refreshSidebarData` is the one
// swap point.

/**
 * The data-profile section's render input. `not_ready` before the runtime boots (no query is
 * attempted); `unavailable` on a `DbError` (never a crash); `absent` when the ledger row is null
 * (the analysis has not been profiled); `loaded` carries the ledger truth.
 */
export type ProfileSnapshot = { kind: "not_ready" } | { kind: "unavailable" } | { kind: "absent" } | { kind: "loaded"; profile: DataProfileStatus };

/**
 * The runs section's render input. `not_ready` before the runtime boots; `unavailable` on a
 * `DbError`; `loaded` carries the newest run rows (possibly empty → the section renders "no runs").
 * There is no `absent` kind — an analysis with no runs is a `loaded` empty array, not an absence.
 */
export type RunsSnapshot = { kind: "not_ready" } | { kind: "unavailable" } | { kind: "loaded"; runs: CortexRunRow[] };

/**
 * Live progress of ONE non-terminal run — the feed for that run's block in the sidebar RUNS section
 * (the run-block vocabulary: the segmented bar, `done/total`, and the ordered steps) and for the
 * run-activity panel's frontier.
 */
export type ActiveRunProgress = {
    /** The run this progress belongs to — the map key, carried inline so a consumer holding one entry still knows whose it is. */
    runId: string;
    /** The run's human label (see {@link runLabelOf}). */
    name: string;
    /** The run's short id tail (see {@link idTail}). */
    tag: string;
    /** When the run started (ISO), for the elapsed readout. */
    startedAt: string;
    /** Completed step count (bar numerator). */
    done: number;
    /** Total step count (bar denominator). */
    total: number;
    /** The run's ordered step views. */
    steps: RunStepView[];
    /**
     * True when this entry was carried forward from a previous refresh because THIS run's step read
     * failed — the run is still active, but what is shown is the last known state rather than the
     * current one.
     *
     * Carried here rather than inferred by a consumer because the carry-forward is invisible from
     * outside: a stale entry and a fresh one are the same shape, so a surface that must mute itself
     * on a blip (the run-activity panel) has no other way to tell them apart.
     */
    stale: boolean;
};

/**
 * Every active run's progress, keyed by run id. Empty when nothing is active: no runs, all runs
 * terminal, or the runtime not booted.
 *
 * Keyed rather than the single newest-run slot it replaces. The old shape bought its
 * "no run-row/progress mismatch is representable" guarantee from there being exactly one snapshot;
 * this one buys the same guarantee from the KEY — a block renders under the row whose id it is
 * keyed by, so attributing one run's steps to another is still not representable, and a second
 * concurrent run stops being invisible.
 */
export type ActiveRunProgressMap = ReadonlyMap<string, ActiveRunProgress>;

const [profile, setProfile] = createSignal<ProfileSnapshot>({ kind: "not_ready" });
const [runs, setRuns] = createSignal<RunsSnapshot>({ kind: "not_ready" });
// A fresh Map object per publish: Solid's default equality is referential, so mutating one in place
// would update no consumer.
const [activeRun, setActiveRun] = createSignal<ActiveRunProgressMap>(new Map());

/** The data-profile snapshot — read in a tracking scope to repaint on refresh. */
export const profileSnapshot = profile;
/** The runs snapshot — read in a tracking scope to repaint on refresh. */
export const runsSnapshot = runs;
/** Every active run's progress keyed by run id (empty when nothing is active) — read in a tracking scope. */
export const activeRunProgress = activeRun;

/**
 * Compact relative age of an ISO timestamp (`5m31s`, `8h54m`), or an em dash when absent/unparseable.
 * This is the live-rail vocabulary: the sidebar's fixed-width readouts (the session age, the run rows)
 * answer "how long ago" at a glance, where a full timestamp would overflow the rail and a slightly-stale
 * age still reads right. Durable-record readouts render the opposite — an absolute local time (see
 * {@link absTime}) — because a referenced record (a detail dialog, the rail's completed-profile line)
 * is read long after "5m ago" meant anything.
 *
 * Homed in this hooks module (not `layout/sidebar.tsx`) beside {@link runMark} / {@link shortRunName},
 * the pure sidebar helpers the rail and the runs dialog share, so callers reach them without importing
 * the JSX layout and nothing forces this module to import back into it.
 */
export function relAge(iso: string | null): string {
    // `String.relativeAge` owns the parse-then-age; this wrapper only supplies the rail's em-dash
    // fallback for an absent or unparseable time (the extension stays glyph-free — see string.ext.ts).
    return iso?.relativeAge() ?? GLYPHS.emDash;
}

/**
 * Absolute local timestamp of an ISO string (`toLocaleString`), or an em dash when absent/unparseable.
 * The detail-dialog counterpart to {@link relAge}: the data-profile and runs dialogs render durable,
 * referenced records read long after the fact — when a compact "5m" has lost its anchor — so they pin
 * the full local time. Same em-dash guard shape as {@link relAge}, so an absent/bad time collapses
 * identically across the rail and the dialogs.
 */
export function absTime(iso: string | null): string {
    if (iso === null) return GLYPHS.emDash;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? GLYPHS.emDash : new Date(t).toLocaleString();
}

/**
 * Compact absolute local timestamp (`7/13/26, 10:52 AM`) — the fixed-width rail's absolute
 * vocabulary. A finished run's rail row must carry a workflow name AND an absolute anchor inside
 * ~37 usable cells; {@link absTime}'s seconds-bearing long form pushes that past the rail and
 * soft-wraps mid-token on every row, so the rail trades the seconds for the fit. Detail dialogs
 * (unconstrained width) keep the long form. Same em-dash guard shape as {@link absTime}.
 */
export function absTimeShort(iso: string | null): string {
    if (iso === null) return GLYPHS.emDash;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? GLYPHS.emDash : new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Compose the DATA PROFILE details view's lines from a {@link ProfileSnapshot}. Pure
 * (snapshot → string[]) so every kind is unit-testable: the degraded kinds each yield one placeholder
 * line, and `loaded` yields the ledger truth — a status line, the started/completed absolute local
 * times plus the run duration (or the elapsed-at-open age while a profile is still running), the error
 * (on failure), the summary split into lines, the per-file `path — description`, and the seed-input
 * count. Rendered verbatim by `ResultsDialog` (the design gallery drives it over a mock).
 */
export function profileDetailLines(snap: ProfileSnapshot): string[] {
    switch (snap.kind) {
        case "not_ready":
            return ["runtime not ready"];
        case "absent":
            return ["not profiled yet"];
        case "unavailable":
            return ["profile status unavailable"];
        case "loaded": {
            const p = snap.profile;
            const lines: string[] = [`status: ${p.status}`];
            if (p.startedAt) lines.push(`started ${absTime(p.startedAt)}`);
            if (p.completedAt) lines.push(`completed ${absTime(p.completedAt)}`);
            // A finished profile (completed OR failed — the ledger stamps `completedAt` on both) shows
            // how long it took; a still-running profile has no end yet, so the dialog — a point-in-time
            // snapshot — shows the age elapsed at the moment it was opened instead of a duration.
            const startedMs = p.startedAt ? Date.parse(p.startedAt) : NaN;
            const completedMs = p.completedAt ? Date.parse(p.completedAt) : NaN;
            if (!Number.isNaN(startedMs) && !Number.isNaN(completedMs)) {
                lines.push(`duration ${Date.formatDuration(completedMs - startedMs)}`);
            } else if (!Number.isNaN(startedMs)) {
                lines.push(`elapsed ${Date.relativeAge(startedMs)}`);
            }
            if (p.status === "failed" && p.error) {
                lines.push("");
                for (const line of p.error.split("\n")) lines.push(line);
            }
            if (p.result) {
                if (p.result.summary.trim().length > 0) {
                    lines.push("");
                    for (const line of p.result.summary.split("\n")) lines.push(line);
                }
                if (p.result.files.length > 0) {
                    lines.push("");
                    lines.push(`files (${p.result.files.length}):`);
                    for (const f of p.result.files) lines.push(`  ${f.path} ${GLYPHS.emDash} ${f.description}`);
                }
            }
            // `seedInputFileIds` is the desired-parity set; fall back to the profiled inputs when the
            // seed set was not recorded (older rows), else 0.
            const seedCount = p.seedInputFileIds?.length ?? p.result?.inputFileIds.length ?? 0;
            lines.push("");
            lines.push(`${seedCount} seed input${seedCount === 1 ? "" : "s"}`);
            return lines;
        }
        default: {
            const _exhaustive: never = snap;
            return [String(_exhaustive)];
        }
    }
}

/**
 * The themed glyph + color role for a run's status. The single exhaustive `runMark`,
 * shared by the sidebar rail and the runs dialog (both need the identical status→glyph/role mapping).
 * running=warn, completed=success, failed/canceled=error, `suspended_insufficient_funds`=warn,
 * `partial`=muted. A `never`-typed default breaks the build if the harness enum grows, forcing a new
 * status to be classified rather than silently mis-toned.
 *
 * Homed in this hooks module (not `layout/sidebar.tsx`) beside the other pure, non-JSX sidebar helpers
 * so the runs dialog can share it without importing the JSX layout module.
 */
export function runMark(status: RunStatus): { glyph: string; role: keyof ThemeColors } {
    switch (status) {
        case "running":
            return { glyph: GLYPHS.circleHalf, role: "warning" };
        case "completed":
            return { glyph: GLYPHS.check, role: "success" };
        case "failed":
        case "canceled":
            return { glyph: GLYPHS.cross, role: "error" };
        case "suspended_insufficient_funds":
            // Actionable, not just terminal: the run is paused awaiting funds/resume, so it warrants
            // the "needs attention" warn tone rather than the muted grey of `partial` (which is simply
            // a finished-with-gaps end state the user cannot act on).
            return { glyph: GLYPHS.circle, role: "warning" };
        case "partial":
            return { glyph: GLYPHS.circle, role: "fgMuted" };
        default: {
            const _exhaustive: never = status;
            return { glyph: GLYPHS.circle, role: "fgMuted" };
        }
    }
}

/** A run's short label: the workflow name, else the plan id tail, else the run id tail. */
export function shortRunName(run: CortexRunRow): string {
    if (run.workflowName.length > 0) return run.workflowName;
    const id = run.planId ?? run.runId;
    return id.replace(/-/g, "").slice(-6);
}

/**
 * The plan's human title, or `null` when the plan is absent, unreadable, or predates titles.
 *
 * Takes `unknown` because the persisted plan is a JSON blob whose schema types `title` as optional:
 * the runtime shape is not guaranteed by the type, so it is checked rather than trusted.
 */
export function planTitleOf(plan: unknown): string | null {
    if (typeof plan !== "object" || plan === null || !("title" in plan)) return null;
    const title = plan.title;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

/**
 * A run's display label: its plan's title when there is one, else the run's id tail.
 *
 * The fallback deliberately skips {@link shortRunName}. That returns `workflowName`, which is
 * `"executeAnalysis"` on every row in the ledger and therefore distinguishes nothing — falling back
 * to it would label every unresolvable run identically, which is strictly worse than the id tail
 * the rail has always used for exactly this reason. The readable 3–8-word name the planner wrote
 * lives on the plan, one join away, and is what this exists to surface when it is there.
 */
export function runLabelOf(run: CortexRunRow, plan: unknown): string {
    return planTitleOf(plan) ?? idTail(run.runId);
}

/**
 * Each plan step's human name, keyed by the step id the ledger rows carry.
 *
 * Same `unknown` discipline as {@link planTitleOf}: the plan is a stored blob, so every hop is
 * checked. A plan that is missing, malformed, or whose steps carry no names yields an empty map and
 * every step falls back to its slug — a poorer label, never a crash.
 */
export function planStepNames(plan: unknown): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    if (typeof plan !== "object" || plan === null || !("steps" in plan)) return names;
    const steps = plan.steps;
    if (!Array.isArray(steps)) return names;
    for (const step of steps) {
        if (typeof step !== "object" || step === null) continue;
        const id = "id" in step ? step.id : undefined;
        const name = "name" in step ? step.name : undefined;
        if (typeof id === "string" && typeof name === "string" && name.trim().length > 0) names.set(id, name.trim());
    }
    return names;
}

/** A short, human-scannable tail of a uuid (dashes stripped) — the run tag the run-detail dialog + sidebar progress embed show. */
export function idTail(id: string): string {
    return id.replace(/-/g, "").slice(-6);
}

/**
 * Map a harness step-execution status onto the design-system run-step state. Pure and
 * exhaustive over {@link StepExecutionRow.status} — a `never`-typed default breaks the build if the
 * harness enum grows, so a new status is classified honestly rather than silently mis-bucketed.
 *
 * The five buckets are `done | running | failed | queued | skipped`; the honest mapping of the seven
 * harness statuses:
 *  - `pending` → `queued` — has not run and is still going to.
 *  - `skipped` → `skipped` — never ran and never will, because an upstream step failed or blocked.
 *    Kept distinct from `queued`: folding them made a doomed dependent read as work still ahead,
 *    which is the opposite of what it is. Neither is a success or an error, so both stay muted.
 *  - `running` → `running`, `completed` → `done`, `failed` → `failed` — direct.
 *  - `canceled` → `failed` — a fail-fast sibling stopped mid-flight; a non-success terminal, shown
 *    error-toned to match the sidebar's run-level `canceled`.
 *  - `blocked` → `failed` — an agent-declared blocker; `executeAnalysis` treats it as a failure
 *    (`step_blocked`), so the error tone is the honest signal.
 *
 * Homed here beside {@link runMark} / {@link shortRunName} (the pure, non-JSX run helpers) so both the
 * runs dialog and the sidebar-live refresh loop share the identical status→state mapping without one
 * reaching into the other.
 */
export function stepStateOf(status: StepExecutionRow["status"]): RunStepView["state"] {
    switch (status) {
        case "pending":
            return "queued";
        case "skipped":
            return "skipped";
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

/** How many run rows a refresh pulls. The sidebar renders the newest few; the store holds the head. */
const RUNS_LIMIT = 10;

/** The bounded poll cadence while work is active. Idle sidebars issue zero queries. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Terminal run statuses — a run that reached a final state polling cannot advance. A NON-terminal run
 * (`running`, or a fund-suspended run awaiting a resume) can still change its ledger row under us,
 * which is exactly what arms the poll. Declared exhaustively over {@link RunStatus} (a full record,
 * not a set literal) so adding a status to the harness enum is a compile error here until it is
 * classified — the arming rule must never silently mis-treat a new status as terminal.
 *
 * Trade-off: a genuinely wedged non-terminal run keeps the 5s poll alive. Accepted
 * — it is bounded, cheap (≤10 rows), and visible; the alternative (guessing wedged-ness) is worse.
 */
/** Whether a run status means the run is finished — i.e. nothing is still writing to its workspace. */
export const RUN_STATUS_TERMINAL: Record<RunStatus, boolean> = {
    running: false,
    completed: true,
    failed: true,
    partial: true,
    canceled: true,
    suspended_insufficient_funds: false,
};

/**
 * Whether the snapshots should keep the bounded poll armed: a pending/running data profile, any run
 * in a non-terminal status, OR an `unavailable` snapshot. This is the sole gate on the poll — pure so
 * the arming decision is unit-testable without a reactive root.
 *
 * `unavailable` arms because it is the `DbError` degrade: a transient DB blip mid-profile/mid-run
 * would otherwise tear the poll down on an idle screen and nothing would ever re-read to recover, so
 * the section would stay stuck at "unavailable" until the next lifecycle edge. Re-arming lets the
 * SAME cheap 5s poll self-heal the moment the read succeeds again. A persistent outage keeps that one
 * failing read alive — accepted, exactly like a genuinely wedged non-terminal run: it is
 * bounded, cheap (≤10 rows), and the alternative (guessing transient-vs-persistent) is worse.
 */
export function hasActiveWork(profileSnap: ProfileSnapshot, runsSnap: RunsSnapshot): boolean {
    const anyUnavailable = profileSnap.kind === "unavailable" || runsSnap.kind === "unavailable";
    const profileActive = profileSnap.kind === "loaded" && (profileSnap.profile.status === "pending" || profileSnap.profile.status === "running");
    const runsActive = runsSnap.kind === "loaded" && runsSnap.runs.some((r) => !RUN_STATUS_TERMINAL[r.status]);
    return anyUnavailable || profileActive || runsActive;
}

/**
 * Injectable edges so {@link refreshSidebarData} is unit-testable offline (no Postgres, no booted
 * runtime) — mirrors `LoadSeams`/`SendSeams` in `conversation.ts`. Production callers omit the
 * argument and get the real booted runtime + harness ledger reads; tests pass fakes whose reads
 * resolve on the test's schedule, so interleaving two rapid refreshes (the staleness guard) and the
 * `DbError → unavailable` / `null → absent` ladder are exercisable without a database.
 */
export type RefreshSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** Read the data-profile status row. Real: `loadDataProfileStatus`. */
    readonly loadProfile: (pool: Pool, analysisId: string) => ResultAsync<DataProfileStatus | null, DbError>;
    /** Read the analysis's newest runs (newest-first, capped). Real: `queryRunsByAnalysis` @ {@link RUNS_LIMIT}. */
    readonly loadRuns: (pool: Pool, analysisId: string) => ResultAsync<CortexRunRow[], DbError>;
    /**
     * Read EVERY non-terminal run, uncapped. Real: `queryActiveRunsByAnalysis`.
     *
     * Separate from {@link loadRuns} because the two answer different questions and only one of them
     * may be windowed. `loadRuns` answers "the newest N" — right for a listing. Live work cannot be
     * windowed at all: ordering by start time and capping drops the OLDEST running run first, which
     * is the long analysis this whole surface exists to keep visible. Ten short runs starting after
     * it would push it off the list, taking its rail block, its panel entry, its completion notice,
     * and its durable outcome record with it.
     */
    readonly loadActiveRuns: (pool: Pool, analysisId: string) => ResultAsync<CortexRunRow[], DbError>;
    /** Read a run's step ledger — fired once per NON-TERMINAL run, never for a terminal one. Real: `queryStepsByRun`. */
    readonly loadSteps: (pool: Pool, runId: string) => ResultAsync<StepExecutionRow[], DbError>;
    /** Read a stored plan — fired once per DISTINCT plan among the active runs. Real: `loadPlan`. */
    readonly loadPlan: (pool: Pool, planId: string, analysisId: string) => ResultAsync<unknown | null, DbError>;
};

const realRefreshSeams: RefreshSeams = {
    runtime: harnessRuntime,
    loadProfile: loadDataProfileStatus,
    loadRuns: (pool, analysisId) => queryRunsByAnalysis(pool, analysisId, { limit: RUNS_LIMIT }),
    loadActiveRuns: queryActiveRunsByAnalysis,
    loadSteps: queryStepsByRun,
    loadPlan: (pool, planId, analysisId) => loadPlan(pool, planId, { analysisId }),
};

// Monotonic token identifying the newest refresh. Two rapid analysis swaps interleave their async
// ledger reads, and the older refresh can resolve LAST; without this it would clobber the newer
// snapshots. Each read's post-await re-check drops a superseded refresh — the last refresh STARTED
// wins regardless of which finishes last. Module-private: only refreshSidebarData touches it.
// Mirrors `loadGeneration` in `conversation.ts`.
let refreshGeneration = 0;

/**
 * Reset BOTH snapshots to `not_ready` together (the torn-pair guarantee), clear the active-run progress
 * snapshot, and invalidate any in-flight refresh. Used at an analysis swap so the previous analysis's DATA
 * PROFILE / RUNS / progress embed never render (nor get dialog-snapshotted) during the swap's
 * one-ledger-round-trip refresh window, and by the test reset hook.
 */
function resetSnapshots(): void {
    refreshGeneration += 1;
    setProfile({ kind: "not_ready" });
    setRuns({ kind: "not_ready" });
    setActiveRun(new Map());
}

/**
 * Repopulate both snapshots (and the active-run progress snapshot) for `analysisId` from the booted
 * runtime's pool. No-ops to `not_ready` (both snapshots) and clears the progress snapshot when the runtime
 * is not booted — the sidebar renders a muted placeholder and no query runs (the no-op guard).
 * Otherwise the two ledger reads are awaited in turn and each `.match`es INDEPENDENTLY into its
 * snapshot: a `DbError` becomes `unavailable` (never a crash), a null profile row becomes `absent`,
 * and every write is a fresh object so Solid always reconciles.
 *
 * The progress snapshot is derived from the runs read: when the NEWEST run is non-terminal a third read
 * fetches its steps and publishes {@link activeRunProgress}; a terminal (or absent) newest run clears
 * it and fires NO step query — so an idle analysis stays at zero step reads. A failed step read keeps
 * the previous row only when it is THIS run's (avoiding a blink of a genuinely running run); if the
 * newest run changed on the same tick it clears instead, so one run's progress is never shown for another.
 *
 * Staleness: the refresh claims a {@link refreshGeneration} token at entry and re-checks it after
 * each read (including the step read); a refresh superseded by a newer swap silently drops rather than
 * writing stale rows.
 */
export async function refreshSidebarData(analysisId: string, seams: RefreshSeams = realRefreshSeams): Promise<void> {
    // Bump BEFORE the runtime guard so even the not_ready path invalidates any in-flight older refresh
    // — a swap to an unbooted scope must not later be overwritten by a slow read from the prior scope.
    const myRefresh = ++refreshGeneration;
    const runtime = seams.runtime();
    if (!runtime) {
        setProfile({ kind: "not_ready" });
        setRuns({ kind: "not_ready" });
        setActiveRun(new Map());
        return;
    }

    // Two awaited-inline reads (the `loadMessages` pattern — a `ResultAsync` handed to `Promise.all`
    // reads to the `must-use-result` lint as an unconsumed Result). Each `.match`es INDEPENDENTLY, so
    // a profile `DbError` can degrade the profile section to `unavailable` while the runs section
    // still loads (and vice versa) — the two sections never share a failure. The generation token is
    // re-checked after EACH await so a superseded refresh drops at the first opportunity.
    const profileRes = await seams.loadProfile(runtime.pool, analysisId);
    if (myRefresh !== refreshGeneration) return;
    const runsRes = await seams.loadRuns(runtime.pool, analysisId);
    if (myRefresh !== refreshGeneration) return;
    const activeRes = await seams.loadActiveRuns(runtime.pool, analysisId);
    if (myRefresh !== refreshGeneration) return;

    profileRes.match(
        (row) => setProfile(row === null ? { kind: "absent" } : { kind: "loaded", profile: row }),
        () => setProfile({ kind: "unavailable" }),
    );

    // EVERY non-terminal run publishes a progress entry, keyed by its run id. A terminal run (or no
    // runs at all) publishes none, and only a non-terminal run fires a step read — so an idle
    // analysis still issues zero step queries, the property the poll's arming condition depends on.
    await runsRes.match(
        async (rows) => {
            // The uncapped active read is the AUTHORITY on what is live; the windowed listing only
            // decides what the RUNS section lists. Merging the two — active first, then the window's
            // rows minus anything already present — means a long-running analysis that has fallen off
            // the newest-N window is still both listed and tracked. A failed active read degrades to
            // the window's own view rather than blanking the section: strictly the old behaviour.
            const merged = activeRes.match(
                (live) => {
                    const seen = new Set(live.map((r) => r.runId));
                    return [...live, ...rows.filter((r) => !seen.has(r.runId))];
                },
                () => rows,
            );
            setRuns({ kind: "loaded", runs: merged });
            const active = merged.filter((r) => !RUN_STATUS_TERMINAL[r.status]);
            if (active.length === 0) {
                setActiveRun(new Map());
                return;
            }

            // Resolve each distinct plan ONCE per refresh. Re-runs of one plan share a `planId`, and
            // a rail showing three runs of the same plan must not pay three plan reads for one title.
            const planIds = [...new Set(active.map((r) => r.planId).filter((id): id is string => id !== null))];
            const plans = new Map<string, unknown>();
            for (const planId of planIds) {
                const planRes = await seams.loadPlan(runtime.pool, planId, analysisId);
                if (myRefresh !== refreshGeneration) return;
                // A plan that cannot be read degrades that run's label to its workflow name / id tail.
                // The rail must still render; a missing title is a poorer row, never an error.
                planRes.match(
                    (plan) => plans.set(planId, plan),
                    () => {},
                );
            }

            // Runs that read cleanly this tick. The published map is assembled from this in the
            // setter below rather than written here, because a run whose read blipped must be carried
            // forward from the PREVIOUS map — and reading that signal here would both track
            // reactivity nothing wants and pin the value to loop-entry rather than write time.
            const fresh = new Map<string, ActiveRunProgress>();
            for (const run of active) {
                const stepsRes = await seams.loadSteps(runtime.pool, run.runId);
                if (myRefresh !== refreshGeneration) return;
                stepsRes.match(
                    (stepRows) => {
                        const plan = run.planId === null ? undefined : plans.get(run.planId);
                        const nameByStepId = planStepNames(plan);
                        const steps: RunStepView[] = stepRows.map((r) => ({
                            // The plan's human phrase for the step, falling back to the slug the ledger
                            // keys on. This is the join that answers "what is being worked on" in words:
                            // the step row itself carries only `T{track}S{step}`.
                            label: nameByStepId.get(r.stepId) ?? r.stepId,
                            state: stepStateOf(r.status),
                            startedAt: r.startedAt,
                            agent: r.agentId,
                            blockedReason: r.blockedReason,
                            attempts: r.attempts,
                        }));
                        fresh.set(run.runId, {
                            runId: run.runId,
                            name: runLabelOf(run, plan),
                            tag: idTail(run.runId),
                            startedAt: run.startedAt,
                            done: steps.filter((s) => s.state === "done").length,
                            total: steps.length,
                            steps,
                            stale: false,
                        });
                    },
                    // This run is active but its steps could not be read (a transient DB blip). It is
                    // simply absent from `fresh`, and the assembly below carries its previous entry
                    // forward — so the bounded poll self-heals without blinking a genuinely running
                    // run away. Keying by run id is what makes this safe: the old single-slot store
                    // had to compare tags to avoid showing one run's steps under another's row, and
                    // that mismatch is no longer representable.
                    () => {},
                );
            }
            setActiveRun((prev) => {
                // Assembled in `active` order — the runs query's newest-first order — NOT in the order
                // the reads happened to succeed. Map iteration order is what every consumer reads as
                // run order: the rail's blocks, and the panel's position indicator and implicit focus.
                // Appending carried-forward entries instead would let a transient blip on one run
                // reorder the whole set, silently swapping which run the panel shows.
                const next = new Map<string, ActiveRunProgress>();
                for (const run of active) {
                    const read = fresh.get(run.runId);
                    if (read) {
                        next.set(run.runId, read);
                        continue;
                    }
                    const kept = prev.get(run.runId);
                    // Re-stamped `stale` rather than reused verbatim: the entry's CONTENT is the last
                    // known state, but its freshness is a property of THIS refresh, so a run that read
                    // cleanly last tick and blipped this one must not keep advertising itself as fresh.
                    if (kept) next.set(run.runId, { ...kept, stale: true });
                }
                return next;
            });
        },
        // A runs `DbError` is a transient degrade that itself re-arms the poll (`hasActiveWork`). Keep
        // any existing progress entries so a blip does not flash the whole section away and back.
        async () => setRuns({ kind: "unavailable" }),
    );
}

/**
 * Injectable edges so {@link watchSidebarData}'s trigger + arming logic is unit-testable offline —
 * mirrors the seam pattern the boot store (`BootDriver`) and send path use. Production callers omit
 * the argument. `arm` wraps `setInterval`/`clearInterval` into a single arm→disarm closure so a test
 * can capture the tick callback and drive it deterministically (no fake global clock), and assert the
 * disarm fires when work goes terminal or the watcher tears down.
 */
export type WatchSeams = {
    /** Repopulate the snapshots for an analysis. Real: {@link refreshSidebarData}. */
    readonly refresh: (analysisId: string) => Promise<void>;
    /** Arm a repeating timer; returns its disarm. Real: wraps `setInterval`/`clearInterval`. */
    readonly arm: (fn: () => void, ms: number) => () => void;
};

const realWatchSeams: WatchSeams = {
    refresh: refreshSidebarData,
    arm: (fn, ms) => {
        const handle = setInterval(fn, ms);
        return () => clearInterval(handle);
    },
};

/**
 * Wire the sidebar's live-data lifecycle. Call once from `App` (inside its reactive root). Three
 * triggers, each an effect over the module's reactive sources:
 *
 *  1. **ready / analysis swap** — refresh when boot reaches `ready` and an analysis is open, and
 *     again whenever the open analysis changes.
 *  2. **turn completion** — refresh on the `busy → idle` down-edge of {@link chatStatus}, so a run or
 *     profile the agent launched during the turn is reflected without user action. `refresh` itself
 *     no-ops when the runtime is not ready, so this needs no boot guard of its own.
 *  3. **bounded poll** — an interval armed ONLY while {@link hasActiveWork} holds for the open
 *     analysis, torn down the moment work goes terminal (or the analysis swaps, or the watcher
 *     unmounts). The arming key is a MEMO (`active ? analysisId : null`) so the interval is not
 *     re-armed on every snapshot identity change (each refresh mints fresh snapshot objects) — it
 *     re-arms only when the arm/disarm decision or the analysis actually changes, keeping the 5s
 *     cadence steady and guaranteeing an idle sidebar issues zero queries.
 */
export function watchSidebarData(workspace: Workspace, seams: WatchSeams = realWatchSeams): void {
    // Trigger 1 — ready + analysis (and analysis swap). On a genuine swap the two snapshots still hold
    // the PREVIOUS analysis's ledger data, and the refresh below is a full ledger round-trip — so
    // without a synchronous reset the old analysis's DATA PROFILE / RUNS (and any dialog snapshot of
    // them) would render for that whole window. Reset both to not_ready together BEFORE the refresh; the
    // refresh then repopulates for the new analysis (its generation token drops any prior in-flight read).
    let prevAnalysisId: string | null = null;
    createEffect(() => {
        const phase = bootState().phase;
        const analysisId = workspace.analysis?.id ?? null;
        if (phase !== "ready" || analysisId === null) {
            prevAnalysisId = analysisId;
            return;
        }
        // Reset only on a genuine swap between two open analyses — the first ready edge finds the
        // snapshots already not_ready, so a reset there would be a redundant same-value write.
        if (prevAnalysisId !== null && prevAnalysisId !== analysisId) resetSnapshots();
        prevAnalysisId = analysisId;
        void seams.refresh(analysisId);
    });

    // Trigger 2 — the busy→idle down-edge. `prev` is closure-local per watcher invocation; seeded to
    // the current status so the effect's initial (synchronous) run never fires a false edge.
    let prev: ChatStatus = chatStatus();
    createEffect(() => {
        const status = chatStatus();
        const analysisId = workspace.analysis?.id;
        if (prev === "busy" && status === "idle" && analysisId) void seams.refresh(analysisId);
        prev = status;
    });

    // Trigger 3 — the bounded poll. `disarm` is the live interval's teardown (null when idle).
    let disarm: (() => void) | null = null;
    const teardown = (): void => {
        if (disarm) {
            disarm();
            disarm = null;
        }
    };
    const armKey = createMemo<string | null>(() => {
        const active = hasActiveWork(profileSnapshot(), runsSnapshot());
        const analysisId = workspace.analysis?.id;
        return active && analysisId ? analysisId : null;
    });
    // A tick fired while the previous refresh is still awaiting Postgres is DROPPED, not queued.
    // `refreshSidebarData` claims the generation token at entry, so a newer refresh CANCELS an older
    // one — without this flag, reads slower than the interval would leave every tick superseded by the
    // next and the store would never receive a write at all. That failure is self-sustaining: an
    // `unavailable` snapshot is itself an arming condition (`hasActiveWork`), so a struggling database
    // would be re-queried every 5s behind a permanently frozen section. Skipping degrades cadence
    // instead. Only the POLL skips: lifecycle edges carry new information and must supersede.
    let pollInFlight = false;

    // Trigger 4 — the run-observation push. The embedded runtime reports a run's state change
    // in-process, and this pokes the SAME refresh the lifecycle edges poke: the event is a TRIGGER,
    // never a data source. The refresh already owns the generation-token ordering and the plan
    // resolution, and rendering the pushed payload directly would give the store a second writer
    // with its own staleness rules.
    //
    // It follows the POLL's skip rule rather than the lifecycle rule: events can arrive faster than
    // a refresh completes, and without the skip every one would supersede the last, leaving the
    // store with no write at all — the same failure the poll's flag prevents.
    //
    // Polling stays armed regardless. This channel is in-process only, so a run launched by a
    // separate `inflexa run` never reaches it; the interval remains the backstop that makes such a
    // run visible at all.
    const onRunEvent = (event: StampedEvent): void => {
        if (event.type !== "run.observed") return;
        const analysisId = workspace.analysis?.id;
        if (!analysisId || event.analysisId !== analysisId) return;
        if (pollInFlight) return;
        pollInFlight = true;
        void seams.refresh(analysisId).finally(() => {
            pollInFlight = false;
        });
    };
    Bus.on("inflexa", onRunEvent);
    onCleanup(() => Bus.off("inflexa", onRunEvent));

    createEffect(() => {
        const key = armKey();
        teardown();
        if (!key) return;
        disarm = seams.arm(() => {
            if (pollInFlight) return;
            pollInFlight = true;
            void seams.refresh(key).finally(() => {
                pollInFlight = false;
            });
        }, POLL_INTERVAL_MS);
    });
    onCleanup(teardown);
}

/**
 * Test hook: reset both snapshots to `not_ready`, clear the active-run progress snapshot, and invalidate any
 * in-flight refresh. Test-only — mirrors `__resetBootForTest`.
 */
export function __resetSidebarLiveForTest(): void {
    resetSnapshots();
}
