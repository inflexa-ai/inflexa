import { createEffect } from "solid-js";

import type { RunStatus, RunSummary } from "../../api/runs.ts";
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
// no event when a run ends, and the snapshot covers each run of the analysis, whichever client
// started it.

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
 * What this process knew about a run while it was still active — its human label and its step
 * counts. Captured on the way past, because a terminal run has already left `activeRunProgress`
 * (that snapshot holds only active runs, by design) and re-reading its plan just to title a toast
 * would be a database round-trip for a line of text.
 */
type LastKnownRun = { label: string; done: number; total: number };

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
export function completionNoticeText(run: RunSummary, known: LastKnownRun): string {
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
// and the terminal row cannot supply (see {@link LastKnownRun}).
const seenActive = new Map<string, LastKnownRun>();

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
 * SCOPE — the OPEN analysis only. `runsSnapshot` is refreshed for whichever analysis the workspace
 * currently holds, so a run belonging to a different analysis is not announced while the user is
 * away from it; switching back re-reads that analysis's ledger, and the run announces then (its
 * `seenActive` entry survives the switch, since these maps are per-process and not per-analysis).
 * Deliberate: a toast about work in a conversation the reader is not looking at has no context to land
 * in. Making it cross-analysis means a background reader for every analysis, which is a different
 * feature.
 */
export function watchRunCompletions(): void {
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
                });
                continue;
            }
            // Terminal. Only an observed transition announces — a run already finished when this
            // analysis was opened is history, not news.
            const known = seenActive.get(run.runId);
            if (!known) continue;
            const key = reactionKey(run.runId, run.status);
            if (reacted.has(key)) continue;
            reacted.add(key);
            seenActive.delete(run.runId);
            announce(run, known);
        }
    });
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
}
