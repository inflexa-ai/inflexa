import { createEffect } from "solid-js";
import { createThreadHistory, syntheticUserMessage, type CortexRunRow, type Pool, type RunStatus } from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Notice } from "../theme.ts";
import { harnessRuntime } from "./boot.ts";
import { notify } from "./notice.ts";
import { activeRunProgress, idTail, RUN_STATUS_TERMINAL, runsSnapshot, type RunsSnapshot } from "./sidebar_live.ts";
import { withThreadWriteLock } from "./thread_write.ts";

// A run finishing is the one event in this app the user did not just ask for. Everything else on
// screen answers a keystroke; a run terminates on its own schedule, possibly minutes after the
// question that launched it, possibly while the user is reading something else entirely. So it gets
// BOTH reactions: a transient notice, which needs no particular surface to be visible (not the
// sidebar, not the run panel — either may be hidden), and a durable record on the conversation
// thread, which is what makes the outcome survive a reload and reach the agent's next context.
//
// The transition is detected from the runs snapshot the sidebar already maintains rather than from
// the `run.observed` bus event. Both would work for an in-process run, but only the snapshot also
// covers a run started by a separate `inflexa run` — and one source with one rule beats two sources
// that must agree.

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

/** The past-tense verb for a terminal status, as both the notice and the thread record phrase it. */
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
function durationOf(run: CortexRunRow): string | null {
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

/**
 * The toast text for a terminal run: what finished, how it ended, how far it got, how long it took,
 * and — for a non-success — why. Pure, so every status's phrasing is unit-testable without a
 * reactive root.
 */
export function completionNoticeText(run: CortexRunRow, known: LastKnownRun): string {
    const duration = durationOf(run);
    const steps = known.total > 0 ? ` (${known.done}/${known.total} steps)` : "";
    const head = `Run ${known.label} ${outcomeWord(run.status)}${duration ? ` in ${duration}` : ""}${steps}`;
    // The reason is the whole value of a failure notice — a bare "failed" tells the reader only that
    // they now have to go looking.
    return run.status === "completed" || !run.error ? head : `${head}: ${run.error}`;
}

/**
 * The durable thread record's text. Deliberately fuller than the toast: the toast is glanced at, this
 * is read by the model assembling the next turn's context, so it names the run id explicitly — the
 * handle every follow-up question ("what did that run produce?") has to resolve against.
 */
export function completionRecordText(run: CortexRunRow, known: LastKnownRun): string {
    const duration = durationOf(run);
    const parts = [`Analysis run "${known.label}" (${run.runId}) ${outcomeWord(run.status)}${duration ? ` after ${duration}` : ""}.`];
    if (known.total > 0) parts.push(`${known.done} of ${known.total} steps completed.`);
    if (run.error) parts.push(`Reason: ${run.error}`);
    return parts.join(" ");
}

/**
 * Injectable edges so {@link watchRunCompletions} is unit-testable offline — the `RefreshSeams` /
 * `WatchSeams` pattern from `sidebar_live.ts`.
 */
export type RunCompletionSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** Append the outcome record to a thread. Real: `createThreadHistory(pool).appendTurn`. */
    readonly appendRecord: (pool: Pool, threadId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
};

const realRunCompletionSeams: RunCompletionSeams = {
    runtime: harnessRuntime,
    appendRecord: (pool, threadId, text) =>
        // Built through the harness's constructor, never by hand-assembling its marker: the key and
        // namespace are shared with the turn-boundary predicates, and a local copy would fork them
        // silently — the record would store fine and then be read as a genuine turn start, splitting
        // one turn in two for the token window and handing tail retraction a mid-turn cut point.
        createThreadHistory(pool)
            .appendTurn(threadId, [syntheticUserMessage(text)])
            .match(
                () => ({ ok: true }),
                (e) => ({ ok: false, error: e.type }),
            ),
};

// Every `(runId, terminal status)` this process has already reacted to. The run-observation channel
// re-delivers a run's state after a durable-runtime recovery, so a terminal transition can be seen
// more than once — without this a recovery would toast twice and append twice. Keyed by the PAIR,
// not the run id, so the (impossible today, cheap to allow) case of a run reporting two distinct
// terminal statuses is not silently collapsed into one.
const reacted = new Set<string>();

// Every run this process has seen NON-TERMINAL, with what it knew about it at the time. Membership
// is the edge detector: a run is announced only when it was seen running and is now seen terminal.
// Without it, the first snapshot after opening an analysis would announce every historical run it
// carries, which is the loudest possible way to be wrong. The value is what the announcement needs
// and the terminal row cannot supply (see {@link LastKnownRun}).
const seenActive = new Map<string, LastKnownRun>();

/** Purely presentational state needs no keying; these two reactions are durable, so they do. */
function reactionKey(runId: string, status: RunStatus): string {
    return `${runId}:${status}`;
}

/**
 * Wire the run-completion announcement. Call once from `App` (inside its reactive root).
 *
 * One effect over the sidebar's runs snapshot. For each run it sees terminal, having previously seen
 * it running, it raises a notice IMMEDIATELY and queues the durable record behind whatever else is
 * writing that thread. The two are deliberately independent: the toast must not wait on the thread
 * (a run landing mid-turn would otherwise announce only after the turn finished), and an append
 * failure must not suppress the toast — announcement is an observation channel, and a fault in it is
 * survivable, never something that can fail a turn or the run.
 *
 * `threadIdOf` supplies the thread to record onto. A run with no thread (`inflexa run` from a shell)
 * still notices; there is simply no conversation to record it in.
 */
export function watchRunCompletions(seams: RunCompletionSeams = realRunCompletionSeams): void {
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
            announce(run, known, seams);
        }
    });
}

/** Raise the notice now; queue the durable record behind this thread's other writers. */
function announce(run: CortexRunRow, known: LastKnownRun, seams: RunCompletionSeams): void {
    notify({ kind: noticeKindFor(run.status), text: completionNoticeText(run, known) });

    const runtime = seams.runtime();
    // A run with no thread — one launched by `inflexa run` from a shell — still notices; there is
    // simply no conversation to record it in.
    if (!runtime || run.threadId === null) return;
    const threadId = run.threadId;
    void withThreadWriteLock(threadId, () => seams.appendRecord(runtime.pool, threadId, completionRecordText(run, known))).then((result) => {
        if (result.ok) return;
        // Surfaced, not swallowed: the outcome is now only in the transient toast, and the next turn's
        // context will not carry it — the user should know the record is missing rather than later
        // wonder why the agent has no memory of a run they watched finish.
        getLogger("chat").warn({ runId: run.runId, threadId, err: result.error }, "run outcome record failed to append");
        notify({ kind: "warn", text: `Run ${known.label} finished, but its outcome could not be recorded in this conversation.` });
    });
}

/** Test hook: forget every observed run and every reaction already taken. */
export function __resetRunCompletionsForTest(): void {
    reacted.clear();
    seenActive.clear();
}
