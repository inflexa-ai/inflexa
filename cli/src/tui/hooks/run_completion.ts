import { createEffect, untrack } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { RunDetail, RunStatus, RunSummary } from "../../api/runs.ts";
import type { ClientError } from "../../client/api.ts";
import { fetchRun } from "../../client/runs.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";
import { activeRunProgress, idTail, RUN_STATUS_TERMINAL, runsSnapshot, type RunsSnapshot } from "./sidebar_live.ts";

// A run finishing is the one event in this app the user did not just ask for. Everything else on
// screen answers a keystroke; a run terminates on its own schedule, possibly minutes after the
// question that launched it, possibly while the user is reading something else entirely. So it gets
// a transient notice, which needs no particular surface to be visible (not the sidebar, not the
// activity panel — either may be hidden). No record goes on the conversation thread, the same as in
// Cortex: the run ledger is the durable record of the outcome.
//
// The transition is detected from the runs snapshot the sidebar already maintains: the server sends
// no event when a run ends, and the snapshot covers the active runs and the newest runs of the
// analysis, whichever client started them. A run that ends after enough newer runs started is in
// neither list, so the watcher reads such a run by its id.

/** The terminal statuses, in the tone each should be announced with. */
function noticeKindFor(status: RunStatus): Notice["kind"] {
    switch (status) {
        case "completed":
            return "info";
        case "failed":
        case "canceled":
            return "error";
        // Finished with gaps, and suspended-for-funds is actionable rather than broken. Neither is a
        // success, and announcing either in the success tone would be worse than silence.
        case "partial":
        case "suspended_insufficient_funds":
            return "warn";
        case "running":
            return "info";
        default: {
            const _exhaustive: never = status;
            return "info";
        }
    }
}

/** The past-tense verb for a terminal status, as the notice phrases it. */
function outcomeWord(status: RunStatus): string {
    switch (status) {
        case "completed":
            return "completed";
        case "failed":
            return "failed";
        case "canceled":
            return "was canceled";
        case "partial":
            return "finished partially";
        case "suspended_insufficient_funds":
            return "was suspended (insufficient funds)";
        case "running":
            return "is running";
        default: {
            const _exhaustive: never = status;
            return String(_exhaustive);
        }
    }
}

/** A run's wall-clock duration, or `null` when either endpoint is missing or unparseable. */
function durationOf(run: RunSummary): string | null {
    const start = Date.parse(run.startedAt);
    const end = run.completedAt === null ? NaN : Date.parse(run.completedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return Date.formatDuration(end - start);
}

/**
 * What this process knew about a run while it was still active — its human label, its step counts,
 * and its analysis. Captured on the way past, because a terminal run has already left
 * `activeRunProgress` (that snapshot holds only active runs, by design) and re-reading its plan just
 * to title a toast would be a database round-trip for a line of text. The analysis says which
 * analysis path reads the run by its id.
 */
type LastKnownRun = { label: string; done: number; total: number; analysisId: string };

/** The edges of {@link watchRunCompletions}, injectable so it is unit-testable offline (no server). */
export type RunCompletionOpts = {
    /** Read one run by its id. Real: `GET {A}/run/:runId`. */
    readonly loadRun: (analysisId: string, runId: string) => ResultAsync<RunDetail, ClientError>;
};

/** The real edges of {@link watchRunCompletions}. */
export const DEFAULT_RUN_COMPLETION_OPTS: RunCompletionOpts = {
    loadRun: (analysisId, runId) => fetchRun(analysisId, runId),
};

/**
 * The most by-id reads of vanished runs that are open at one time. A run whose read keeps failing
 * stays observed, so without a bound the open reads could grow with the number of such runs over a
 * long session. A vanished run with no free read waits for a later runs read.
 */
const MAX_OPEN_RUN_READS = 4;

/** The toast is one transient line, thus it keeps only the start of a long failure message. */
const NOTICE_REASON_LIMIT = 200;

/** Clip to `limit`, marking the cut so a truncated reason is never mistaken for the whole message. */
function clip(text: string, limit: number): string {
    const flat = text.trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}… (truncated)`;
}

/**
 * The toast text for a terminal run: what finished, how it ended, how far it got, how long it took,
 * and — for a non-success — why. Pure, so every status's phrasing is unit-testable without a
 * reactive root.
 */
export function completionNoticeText(run: RunSummary, known: Pick<LastKnownRun, "label" | "done" | "total">): string {
    const duration = durationOf(run);
    const steps = known.total > 0 ? ` (${known.done}/${known.total} steps)` : "";
    const head = `Run ${known.label} ${outcomeWord(run.status)}${duration ? ` in ${duration}` : ""}${steps}`;
    // The reason is the whole value of a failure notice — a bare "failed" tells the reader only that
    // they now have to go looking.
    return run.status === "completed" || !run.error ? head : `${head}: ${clip(run.error, NOTICE_REASON_LIMIT)}`;
}

// Every `(runId, terminal status)` this process has already reacted to. A durable-runtime recovery can
// move a run's row through its terminal state again, so a terminal transition can be seen more than
// once — without this a recovery would toast twice. Keyed by the PAIR,
// not the run id, so the (impossible today, cheap to allow) case of a run reporting two distinct
// terminal statuses is not silently collapsed into one.
const reacted = new Set<string>();

// Every run this process has seen NON-TERMINAL, with what it knew about it at the time. Membership
// is the edge detector: a run is announced only when it was seen running and is now seen terminal.
// Without it, the first snapshot after opening an analysis would announce every historical run it
// carries, which is the loudest possible way to be wrong. The value is what the announcement needs
// and the terminal row cannot supply (see {@link LastKnownRun}). A run leaves the map when its end
// is announced or already announced, or when its row is gone. The insertion order is the order of
// the by-id reads, and a kept run moves to the back (see {@link keepBehindOthers}).
const seenActive = new Map<string, LastKnownRun>();

// The runs whose by-id read is open. Membership keeps one tick from starting the same read twice,
// and its size is the bound of {@link MAX_OPEN_RUN_READS}.
const openReads = new Set<string>();

/** The de-dup key of one reaction. */
function reactionKey(runId: string, status: RunStatus): string {
    return `${runId}:${status}`;
}

/**
 * Wire the run-completion announcement. Call once from `App` (inside its reactive root).
 *
 * One effect over the sidebar's runs snapshot. For each run it sees terminal, having previously seen
 * it running, it raises a notice IMMEDIATELY — a run landing mid-turn announces at once, not after the
 * turn.
 *
 * A run that this process saw running and that a later snapshot of its analysis does not hold has left
 * the snapshot window (the active runs and the newest runs). The effect reads such a run by its id,
 * once for each snapshot, and announces it when the read shows it terminal. A 404 drops the run
 * silently. A running status, or a failed read, keeps the run for the next snapshot, behind the other
 * observed runs, so each run that waits for a free read gets one in turn. A terminal status whose
 * reaction exists drops the run, because its end was announced already.
 *
 * SCOPE — the OPEN analysis only. `runsSnapshot` is refreshed for whichever analysis the workspace
 * currently holds, so a run belonging to a different analysis is neither announced nor read while the
 * user is away from it; switching back re-reads that analysis's ledger, and the run announces then (its
 * `seenActive` entry survives the switch, since these maps are per-process and not per-analysis).
 * Deliberate: a toast about work in a conversation the reader is not looking at has no context to land
 * in. Making it cross-analysis means a background reader for every analysis, which is a different
 * feature.
 */
export function watchRunCompletions(opts: RunCompletionOpts = DEFAULT_RUN_COMPLETION_OPTS): void {
    // The effect also re-runs when the progress map changes, which a refresh does after the snapshot.
    // The scan for vanished runs runs once for each snapshot, so a run that stays running reads once
    // for each runs read and not once for each re-run.
    let scanned: RunsSnapshot | null = null;
    createEffect(() => {
        const snap: RunsSnapshot = runsSnapshot();
        if (snap.kind !== "loaded") return;
        // Read once per effect run, not per run row: it is a signal, and the loop must not make the
        // effect's dependency set vary with how many runs happen to be listed.
        const progress = activeRunProgress();
        for (const run of snap.runs) {
            if (!RUN_STATUS_TERMINAL[run.status]) {
                const live = progress.get(run.runId);
                seenActive.set(run.runId, {
                    label: live?.name ?? idTail(run.runId),
                    done: live?.done ?? 0,
                    total: live?.total ?? 0,
                    analysisId: snap.analysisId,
                });
                continue;
            }
            // Terminal. Only an observed transition announces — a run already finished when this
            // analysis was opened is history, not news.
            const known = seenActive.get(run.runId);
            if (!known) continue;
            const key = reactionKey(run.runId, run.status);
            seenActive.delete(run.runId);
            if (reacted.has(key)) continue;
            reacted.add(key);
            announce(run, known);
        }
        if (scanned === snap) return;
        scanned = snap;
        const held = new Set(snap.runs.map((run) => run.runId));
        for (const [runId, known] of seenActive) {
            if (known.analysisId !== snap.analysisId || held.has(runId) || openReads.has(runId)) continue;
            if (openReads.size >= MAX_OPEN_RUN_READS) break;
            readVanishedRun(runId, snap.analysisId, opts);
        }
    });
}

/** Read one vanished run by its id and act on the answer. See {@link watchRunCompletions}. */
function readVanishedRun(runId: string, analysisId: string, opts: RunCompletionOpts): void {
    openReads.add(runId);
    // `.match` consumes the Result into a promise, which satisfies the `must-use-result` lint.
    void opts.loadRun(analysisId, runId).match(
        (detail) => {
            openReads.delete(runId);
            announceVanishedRun(runId, detail);
        },
        (error) => {
            openReads.delete(runId);
            // The row is gone, which is a normal condition for this client. Every other error keeps the
            // run, and the next snapshot that misses it reads it again.
            if (error.type === "http" && error.status === 404) seenActive.delete(runId);
            else keepBehindOthers(runId);
        },
    );
}

/**
 * Move a kept run behind the other observed runs. The scan reads in `seenActive` order up to
 * {@link MAX_OPEN_RUN_READS}, so runs whose reads keep giving a non-terminal status or an error
 * would hold the head and starve the runs behind them. The move is in the read callback and not in
 * the scan loop, because a Map visits an entry that is inserted again during its iteration.
 */
function keepBehindOthers(runId: string): void {
    const known = seenActive.get(runId);
    if (!known) return;
    seenActive.delete(runId);
    seenActive.set(runId, known);
}

/**
 * Act on the answer of a by-id read of a vanished run. A non-terminal status keeps the run behind the
 * other observed runs. A terminal status announces the run. The read is async, so the world can have
 * moved: the run must still be observed, its reaction must not exist yet (the runs read can have
 * shown it terminal first), and its analysis must be the one the newest runs snapshot belongs to.
 * When the reaction exists, the end was announced already and the run stops being observed. After a
 * swap of the analysis the run stays observed, and the next snapshot of its analysis reads it again.
 */
function announceVanishedRun(runId: string, detail: RunDetail): void {
    if (!RUN_STATUS_TERMINAL[detail.status]) {
        keepBehindOthers(runId);
        return;
    }
    const known = seenActive.get(runId);
    if (!known) return;
    const key = reactionKey(runId, detail.status);
    if (reacted.has(key)) {
        seenActive.delete(runId);
        return;
    }
    const current = untrack(runsSnapshot);
    if (current.kind !== "loaded" || current.analysisId !== known.analysisId) return;
    reacted.add(key);
    seenActive.delete(runId);
    announce(detail, known);
}

/** Raise the notice now. */
function announce(run: RunSummary, known: LastKnownRun): void {
    // `queue: true` — this is the unsolicited case the notice queue exists for. Two runs landing
    // inside one display window must both be seen; replace-on-arrival would destroy the first, and a
    // run completing is the user's only signal that work they did not just ask for has finished.
    notify({ kind: noticeKindFor(run.status), text: completionNoticeText(run, known) }, 4000, { queue: true });
}

/** Test hook: forget every observed run and every reaction already taken. */
export function __resetRunCompletionsForTest(): void {
    reacted.clear();
    seenActive.clear();
    openReads.clear();
}
