import { createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { ResultAsync } from "neverthrow";
import {
    loadDataProfileStatus,
    queryRunsByAnalysis,
    type CortexRunRow,
    type DataProfileStatus,
    type DbError,
    type Pool,
    type RunStatus,
} from "@inflexa-ai/harness";

import { GLYPHS } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
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

const [profile, setProfile] = createSignal<ProfileSnapshot>({ kind: "not_ready" });
const [runs, setRuns] = createSignal<RunsSnapshot>({ kind: "not_ready" });

/** The data-profile snapshot — read in a tracking scope to repaint on refresh. */
export const profileSnapshot = profile;
/** The runs snapshot — read in a tracking scope to repaint on refresh. */
export const runsSnapshot = runs;

/**
 * Relative age of an ISO timestamp, or an em dash when absent/unparseable — never a raw date. The
 * em-dash fallback (not the raw ISO string) is the shared choice across every caller: the sidebar
 * rail, the runs dialog, and the data-profile detail lines all render into fixed-width surfaces where
 * a raw timestamp would overflow, so an absent/bad time collapses to the em dash uniformly.
 *
 * Homed in this hooks module (not `layout/sidebar.tsx`) because {@link profileDetailLines} below also
 * needs it AND `sidebar.tsx` imports this module — a `relAge` living in `sidebar.tsx` would force this
 * module to import back into the layout, an import cycle. This is the lowest layer all callers share.
 */
export function relAge(iso: string | null): string {
    if (iso === null) return GLYPHS.emDash;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? GLYPHS.emDash : Date.relativeAge(t);
}

/**
 * Compose the DATA PROFILE details view's lines from a {@link ProfileSnapshot}. Pure
 * (snapshot → string[]) so every kind is unit-testable: the degraded kinds each yield one placeholder
 * line, and `loaded` yields the ledger truth — a status line, the started/completed relative times,
 * the error (on failure), the summary split into lines, the per-file `path — description`, and the
 * seed-input count. Rendered verbatim by `ResultsDialog` (the design gallery drives it over a mock).
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
            if (p.startedAt) lines.push(`started ${relAge(p.startedAt)}`);
            if (p.completedAt) lines.push(`completed ${relAge(p.completedAt)}`);
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
const RUN_STATUS_TERMINAL: Record<RunStatus, boolean> = {
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
};

const realRefreshSeams: RefreshSeams = {
    runtime: harnessRuntime,
    loadProfile: loadDataProfileStatus,
    loadRuns: (pool, analysisId) => queryRunsByAnalysis(pool, analysisId, { limit: RUNS_LIMIT }),
};

// Monotonic token identifying the newest refresh. Two rapid analysis swaps interleave their async
// ledger reads, and the older refresh can resolve LAST; without this it would clobber the newer
// snapshots. Each read's post-await re-check drops a superseded refresh — the last refresh STARTED
// wins regardless of which finishes last. Module-private: only refreshSidebarData touches it.
// Mirrors `loadGeneration` in `conversation.ts`.
let refreshGeneration = 0;

/**
 * Reset BOTH snapshots to `not_ready` together (the torn-pair guarantee) and invalidate any in-flight
 * refresh. Used at an analysis swap so the previous analysis's DATA PROFILE / RUNS never render (nor get
 * dialog-snapshotted) during the swap's one-ledger-round-trip refresh window, and by the test reset hook.
 */
function resetSnapshots(): void {
    refreshGeneration += 1;
    setProfile({ kind: "not_ready" });
    setRuns({ kind: "not_ready" });
}

/**
 * Repopulate both snapshots for `analysisId` from the booted runtime's pool. No-ops to `not_ready`
 * (both snapshots) when the runtime is not booted — the sidebar renders a muted placeholder and no
 * query runs (the no-op guard). Otherwise the two ledger reads are awaited in turn and each
 * `.match`es INDEPENDENTLY into its snapshot: a `DbError` becomes `unavailable` (never a crash), a
 * null profile row becomes `absent`, and every write is a fresh object so Solid always reconciles.
 *
 * Staleness: the refresh claims a {@link refreshGeneration} token at entry and re-checks it after
 * each read; a refresh superseded by a newer swap silently drops rather than writing stale rows.
 */
export async function refreshSidebarData(analysisId: string, seams: RefreshSeams = realRefreshSeams): Promise<void> {
    // Bump BEFORE the runtime guard so even the not_ready path invalidates any in-flight older refresh
    // — a swap to an unbooted scope must not later be overwritten by a slow read from the prior scope.
    const myRefresh = ++refreshGeneration;
    const runtime = seams.runtime();
    if (!runtime) {
        setProfile({ kind: "not_ready" });
        setRuns({ kind: "not_ready" });
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

    profileRes.match(
        (row) => setProfile(row === null ? { kind: "absent" } : { kind: "loaded", profile: row }),
        () => setProfile({ kind: "unavailable" }),
    );
    runsRes.match(
        (rows) => setRuns({ kind: "loaded", runs: rows }),
        () => setRuns({ kind: "unavailable" }),
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
 * Test hook: reset both snapshots to `not_ready` and invalidate any in-flight refresh. Test-only —
 * mirrors `__resetBootForTest`.
 */
export function __resetSidebarLiveForTest(): void {
    resetSnapshots();
}
