import type { TurnStatus, TurnSummary } from "../api/conversation.ts";

// The turn registry of the server (draft section 3): each chat turn that runs, with the controller that
// stops it, and the summaries of the newest ended turns. It is process memory: the harness keeps the turn
// itself in its workflow, and the registry keeps what this server started. The busy gate reads
// `hasRunningTurn` before a rename or a delete moves the workspace of an analysis.

/** The count of ended summaries that the registry keeps for `GET {T}/turns/:turnId`. It forgets an older one. */
export const ENDED_TURN_LIMIT = 100;

/** The identity of a turn: its id, and the thread and the analysis that it runs on. */
export type TurnIdentity = {
    readonly turnId: string;
    readonly threadId: string;
    readonly analysisId: string;
};

/** The fields of an ended turn that the end of the turn supplies. */
export type TurnEnding = Omit<TurnSummary, "turnId" | "threadId" | "analysisId" | "startedAt" | "status" | "endedAt" | "durationMs"> & {
    readonly status: Exclude<TurnStatus, "running">;
};

const running = new Map<string, { summary: TurnSummary; controller: AbortController }>();
// The turns that open now. The harness gives the id of a turn at its open, thus such a turn has no entry yet.
let opening = 0;
// The insertion order is the order of the ends, thus the first key is the oldest ended turn.
const ended = new Map<string, TurnSummary>();
// The stop of the server sets it, and nothing clears it: a server that stops takes no new turn.
let refusing = false;
const idleWaiters: (() => void)[] = [];

/**
 * Hold the place of a turn that opens now, thus a stop of the server waits for it. Call the release one time, after
 * {@link startTurn} or after a refusal.
 */
export function holdOpening(): () => void {
    opening += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        opening -= 1;
        releaseIdleWaiters();
    };
}

/** Register a turn that started. `controller` aborts when a client sends the abort of the turn. */
export function startTurn(identity: TurnIdentity, startedAt: Date, controller: AbortController): void {
    running.set(identity.turnId, {
        controller,
        summary: {
            turnId: identity.turnId,
            threadId: identity.threadId,
            analysisId: identity.analysisId,
            status: "running",
            startedAt: startedAt.toISOString(),
        },
    });
}

/** Move a running turn to the ended summaries. It does nothing for a turn that is not running. */
export function endTurn(turnId: string, ending: TurnEnding, endedAt: Date): void {
    const entry = running.get(turnId);
    if (entry === undefined) return;
    running.delete(turnId);
    const durationMs = endedAt.getTime() - Date.parse(entry.summary.startedAt);
    ended.set(turnId, { ...entry.summary, ...ending, endedAt: endedAt.toISOString(), durationMs });
    for (const oldest of ended.keys()) {
        if (ended.size <= ENDED_TURN_LIMIT) break;
        ended.delete(oldest);
    }
    releaseIdleWaiters();
}

/** From now on, the chat route refuses each new turn. The stop of the server calls it. */
export function refuseNewTurns(): void {
    refusing = true;
}

/** True after {@link refuseNewTurns}. */
export function newTurnsRefused(): boolean {
    return refusing;
}

/** The count of the chat turns that run or open now, over each analysis. */
export function runningTurnCount(): number {
    return running.size + opening;
}

/** Abort each running turn. Each one ends when the harness unwinds it. */
export function abortRunningTurns(): void {
    for (const entry of running.values()) entry.controller.abort();
}

/** Settles when no turn runs or opens: at once when none does now, else at the end of the last one. */
export function whenNoRunningTurns(): Promise<void> {
    if (running.size === 0 && opening === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
}

function releaseIdleWaiters(): void {
    if (running.size > 0 || opening > 0) return;
    for (const release of idleWaiters.splice(0)) release();
}

/** The summary of one turn, or `null` when the registry does not hold it. */
export function findTurn(turnId: string): TurnSummary | null {
    const summary = running.get(turnId)?.summary ?? ended.get(turnId);
    return summary === undefined ? null : { ...summary };
}

/** The turns of one thread that the registry holds: each running turn, then each ended one, the newest first. */
export function listThreadTurns(analysisId: string, threadId: string): TurnSummary[] {
    const ofThread = (summary: TurnSummary): boolean => summary.analysisId === analysisId && summary.threadId === threadId;
    const newestFirst = (a: TurnSummary, b: TurnSummary): number => Date.parse(b.startedAt) - Date.parse(a.startedAt);
    const live = [...running.values()].map((entry) => entry.summary).filter(ofThread);
    const done = [...ended.values()].filter(ofThread);
    return [...live.sort(newestFirst), ...done.sort(newestFirst)].map((summary) => ({ ...summary }));
}

/**
 * The newest running turn of each thread that has one, as a map from the thread id to the turn id. The newest
 * turn has the latest `startedAt`, and the greater turn id breaks a tie. A thread whose turns all ended has no
 * entry. One read of the registry serves every thread, whatever their count.
 */
export function runningTurnsByThread(): Map<string, string> {
    const newest = new Map<string, TurnSummary>();
    for (const { summary } of running.values()) {
        const held = newest.get(summary.threadId);
        if (held === undefined || isNewerTurn(summary, held)) newest.set(summary.threadId, summary);
    }
    return new Map([...newest].map(([threadId, summary]) => [threadId, summary.turnId]));
}

/** True when `a` started after `b`, or at the same time with the greater turn id. A UUIDv7 turn id sorts by its start. */
function isNewerTurn(a: TurnSummary, b: TurnSummary): boolean {
    const byStart = Date.parse(a.startedAt) - Date.parse(b.startedAt);
    return byStart !== 0 ? byStart > 0 : a.turnId > b.turnId;
}

/**
 * Abort a turn. `aborting` when the turn runs: it ends when the harness unwinds. `already_ended` when the
 * registry holds its summary. `null` when the registry does not know the turn.
 */
export function abortTurn(turnId: string): "aborting" | "already_ended" | null {
    const entry = running.get(turnId);
    if (entry !== undefined) {
        entry.controller.abort();
        return "aborting";
    }
    return ended.has(turnId) ? "already_ended" : null;
}

/** True while a chat turn of the analysis runs. */
export function hasRunningTurn(analysisId: string): boolean {
    for (const entry of running.values()) {
        if (entry.summary.analysisId === analysisId) return true;
    }
    return false;
}

/** Test hook: forget each turn. Test-only. */
export function __resetTurnsForTest(): void {
    running.clear();
    ended.clear();
    opening = 0;
    refusing = false;
    releaseIdleWaiters();
}
