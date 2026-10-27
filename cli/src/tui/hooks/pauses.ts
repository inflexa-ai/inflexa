import { createMemo, createSignal } from "solid-js";
import type { ResultAsync } from "neverthrow";
import { checkChatPart, isKnownPartFrame, type ChatFrame, type PauseCause, type PausePart } from "@inflexa-ai/harness/contracts/index.js";

import type { PausedWork, PausedWorkList } from "../../api/paused_work.ts";
import type { ClientError } from "../../client/api.ts";
import { fetchPausedWork } from "../../client/paused_work.ts";
import { describeClientError } from "../../client/api.ts";
import { getLogger } from "../../lib/log.ts";

// The pause state of the TUI, held here (not inside `app.tsx`) so the holder is decoupled from its renderers — the
// same split as `asks.ts`. Two cells:
//
// - The pause of the chat turn of the open thread, from the `data-pause` frames of the turn. The conversation
//   adapter writes it for the turn that this client sends and for a paused turn that it reads again. The docked
//   pause prompt of `app.tsx` reads it.
// - The paused work of the open analysis, from `GET {A}/paused-work`. The poll writes it. The sidebar marks, the
//   palette command, and the remedy line of the prompt read it.
//
// One chat screen is mounted at a time, so a module singleton is correct.

/** One waiting workflow of a turn, as the latest `data-pause` frame of the workflow gives it. */
export type TurnWait = {
    readonly workflowId: string;
    readonly state: "retrying" | "paused";
    readonly cause: PauseCause;
    /** The count of timer retries before this wait. */
    readonly attempt: number;
    /** ISO 8601. Present for the state `retrying` only. */
    readonly retryAt?: string;
};

/** Where a paused turn runs: the analysis, the thread, and the turn id, which is the work id of a resume. */
export type TurnScope = {
    readonly analysisId: string;
    readonly threadId: string;
    readonly turnId: string;
};

/** The pause of one chat turn: its scope, and each workflow of the turn that waits. Never holds an empty list. */
export type TurnPause = TurnScope & { readonly waits: readonly TurnWait[] };

/**
 * The waits of a turn after one `data-pause` frame. The part reconciles by its id, the workflow id: `retrying` and
 * `paused` put the wait of that workflow in place, and `running` removes it. A part in a waiting state with no cause
 * is not a wait that the prompt can explain, thus it changes nothing.
 */
export function applyPausePart(waits: readonly TurnWait[], part: PausePart): TurnWait[] {
    const others = waits.filter((wait) => wait.workflowId !== part.id);
    if (part.state === "running") return others;
    if (part.cause === undefined) return [...waits];
    const wait: TurnWait = {
        workflowId: part.id,
        state: part.state,
        cause: part.cause,
        attempt: part.attempt ?? 0,
        ...(part.retryAt === undefined ? {} : { retryAt: part.retryAt }),
    };
    const index = waits.findIndex((existing) => existing.workflowId === part.id);
    if (index === -1) return [...waits, wait];
    return waits.map((existing, i) => (i === index ? wait : existing));
}

/**
 * The wait that the prompt shows: the first wait in `paused`, else the first wait. A wait in `paused` comes first
 * because only the user can end it, while a wait in `retrying` ends on its timer.
 */
export function headWait(waits: readonly TurnWait[]): TurnWait | null {
    return waits.find((wait) => wait.state === "paused") ?? waits[0] ?? null;
}

const [turnPause, setTurnPause] = createSignal<TurnPause | null>(null);

/** The pause of the turn of the open thread, or `null` when no workflow of the turn waits. Read reactively. */
export { turnPause };

/**
 * The `data-pause` part of a frame, or `null` for a different frame or for a pause part that fails the check of its
 * type. The conversation adapter routes a sub-agent frame away from the translation of the turn, thus the pause of a
 * sub-agent reaches the prompt only through this read of the frame itself.
 */
export function pausePartOf(frame: ChatFrame): PausePart | null {
    if (frame.type !== "data-pause") return null;
    const checked = checkChatPart(frame);
    if (!checked.ok) {
        getLogger("chat").warn({ type: frame.type, error: checked.error }, "pause part dropped: it failed the check of its type");
        return null;
    }
    return isKnownPartFrame(checked.frame) && checked.frame.type === "data-pause" ? checked.frame : null;
}

/**
 * Apply one `data-pause` part of a turn. A part of a different turn than the one that the cell holds starts the
 * pause of that turn: one turn of the open thread runs at a time.
 */
export function notePausePart(scope: Omit<TurnScope, "turnId">, part: PausePart): void {
    setTurnPause((current) => {
        const held = current !== null && current.turnId === part.workId ? current.waits : [];
        const waits = applyPausePart(held, part);
        return waits.length === 0 ? null : { analysisId: scope.analysisId, threadId: scope.threadId, turnId: part.workId, waits };
    });
}

/** Forget the pause of a turn: the turn ended, or the screen left it. With no id, forget each pause. */
export function clearTurnPause(turnId?: string): void {
    setTurnPause((current) => (current === null || turnId === undefined || current.turnId === turnId ? null : current));
}

/**
 * The paused work of the open analysis: `not_ready` before the first read, `unavailable` after a failed read that
 * had no earlier read of the same analysis to keep, and `loaded` with the items of the analysis.
 */
export type PausedWorkSnapshot =
    | { readonly kind: "not_ready" }
    | { readonly kind: "unavailable" }
    | { readonly kind: "loaded"; readonly analysisId: string; readonly items: readonly PausedWork[] };

const [pausedWork, setPausedWork] = createSignal<PausedWorkSnapshot>({ kind: "not_ready" });

/** The paused work of the open analysis. Read reactively. */
export const pausedWorkSnapshot = pausedWork;

/** The paused-work items of `analysisId`, or none when the snapshot holds a different analysis or no read. */
export function pausedItemsOf(analysisId: string | null | undefined): readonly PausedWork[] {
    const snap = pausedWork();
    return snap.kind === "loaded" && snap.analysisId === analysisId ? snap.items : [];
}

/** The paused item of a run of the open analysis, matched by the run id. */
export function pausedRunOf(analysisId: string | null | undefined, runId: string): PausedWork | undefined {
    return pausedItemsOf(analysisId).find((work) => work.kind === "run" && work.workId === runId);
}

/**
 * The one word of a mark of paused work: `paused` when a wait of the work waits for the user, else `retrying`. The
 * user can act on a wait in `paused`, thus that word wins.
 */
export function pauseWordOf(work: PausedWork): "paused" | "retrying" {
    return work.waiting.some((wait) => wait.state === "paused") ? "paused" : "retrying";
}

/** The paused item of the data profile of the open analysis. An analysis has one profile. */
export function pausedProfileOf(analysisId: string | null | undefined): PausedWork | undefined {
    return pausedItemsOf(analysisId).find((work) => work.kind === "profile");
}

/** The read of {@link refreshPausedWork}. Tests replace it. */
export type PausedWorkReadOpts = {
    /** Real: `GET {A}/paused-work`. */
    readonly fetch: (analysisId: string) => ResultAsync<PausedWorkList, ClientError>;
};

const DEFAULT_PAUSED_WORK_READ_OPTS: PausedWorkReadOpts = { fetch: (analysisId) => fetchPausedWork(analysisId) };

// The newest read wins: a slow read of a previous analysis must not write over the read of the open one.
let readGeneration = 0;

/**
 * Read the paused work of an analysis into {@link pausedWorkSnapshot}, and give the items, or `null` when the read
 * failed or a newer read superseded it. A failed read keeps a loaded snapshot of the same analysis, thus a blip does
 * not take the marks away and back.
 */
export async function refreshPausedWork(analysisId: string, opts: PausedWorkReadOpts = DEFAULT_PAUSED_WORK_READ_OPTS): Promise<readonly PausedWork[] | null> {
    const mine = ++readGeneration;
    const read = await opts.fetch(analysisId);
    if (mine !== readGeneration) return null;
    return read.match(
        (list) => {
            setPausedWork({ kind: "loaded", analysisId, items: list.pausedWork });
            return list.pausedWork;
        },
        (e) => {
            getLogger("chat").debug({ analysisId, err: describeClientError(e) }, "the paused work could not be read");
            setPausedWork((previous) => (previous.kind === "loaded" && previous.analysisId === analysisId ? previous : { kind: "unavailable" }));
            return null;
        },
    );
}

/**
 * The remedy that the server gives for the paused work `workId` of the open analysis, for the cause `credential`. A
 * frame of a pause carries no remedy, thus the prompt reads it from the list.
 */
export function remedyOf(analysisId: string, workId: string): string | undefined {
    return pausedItemsOf(analysisId).find((work) => work.workId === workId)?.remedy;
}

/** The pause that the prompt docks, with the wait that it shows: derived, thus it holds no state of its own. */
export const dockedPause = createMemo((): (TurnScope & { readonly wait: TurnWait; readonly others: number }) | null => {
    const pause = turnPause();
    if (pause === null) return null;
    const wait = headWait(pause.waits);
    if (wait === null) return null;
    return { analysisId: pause.analysisId, threadId: pause.threadId, turnId: pause.turnId, wait, others: pause.waits.length - 1 };
});

/** Test hook: forget each pause and the paused work. Test-only. */
export function __resetPausesForTest(): void {
    readGeneration += 1;
    setTurnPause(null);
    setPausedWork({ kind: "not_ready" });
}
