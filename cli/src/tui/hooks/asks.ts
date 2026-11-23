import type { ResultAsync } from "neverthrow";
import { createStore, produce } from "solid-js/store";

import type { AskList } from "../../api/conversation.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { fetchAsks } from "../../client/conversation.ts";
import { MAX_PER_PAGE } from "../../api/common.ts";
import { getLogger } from "../../lib/log.ts";

// The pending-asks queue, held here (not inside `app.tsx`) so the holder of the state is decoupled
// from its renderer — the same split as `status.ts`. Two writers fill it. The conversation adapter's
// `data-ask` case pushes the asks of a turn (a `pending` ask pushes; its terminal re-emission settles),
// and turn teardown (`finishTurn`/reset) removes them, covering an abort where a terminal re-emit may
// never arrive. The sidebar poll docks each pending ask of the open analysis that the queue does not
// hold, for example the ask of a run step, which no turn streams, and it removes such an ask when the
// server stops listing it. Turn teardown never removes an ask that the poll docked: the step still waits.
// It is read by `app.tsx` (docking + focus) and the docked prompt. FIFO: the head is the ask being
// answered, and answers advance it one by one. One chat screen is mounted at a time, so a module
// singleton is correct.

/** One pending ask awaiting the user's decision — primitive fields only (copied at push, copy-on-receive). */
export type PendingAsk = {
    /** The ask's ledger id — the settle key and what the prompt answers through the gateway. */
    askId: string;
    /** Human-facing headline for the approval. */
    title: string;
    /** The exact command / operation being approved. */
    command: string;
    /** Optional extra context the prompt may render. */
    detail?: string;
};

/** Who docked an entry: a turn, or the poll of an analysis. */
type AskOrigin = { kind: "turn" } | { kind: "poll"; analysisId: string };

type QueuedAsk = PendingAsk & { origin: AskOrigin };

const [asks, setAsks] = createStore<QueuedAsk[]>([]);

/** The head pending ask (the one the docked prompt answers), or `null` when the queue is empty — read reactively. */
export function activeAsk(): PendingAsk | null {
    return asks[0] ?? null;
}

/** How many asks are queued BEHIND the head — drives the prompt's `+N more` hint; read reactively. */
export function queuedCount(): number {
    return asks.length > 0 ? asks.length - 1 : 0;
}

/**
 * Enqueue a pending ask of a turn at the tail. Copies each primitive into a fresh object so a later mutation of
 * the caller's reference (the in-process emit hazard) cannot reach the store — the store owns its copy. An
 * ask that the poll docked first keeps its place, and the turn takes it over, thus turn teardown removes it.
 */
export function pushAsk(ask: PendingAsk): void {
    setAsks(
        produce((queue) => {
            const held = queue.find((a) => a.askId === ask.askId);
            if (held !== undefined) {
                held.origin = { kind: "turn" };
                return;
            }
            queue.push({ askId: ask.askId, title: ask.title, command: ask.command, detail: ask.detail, origin: { kind: "turn" } });
        }),
    );
}

/**
 * Make the queue agree with one read of the pending asks of `analysisId`. Each listed ask that the queue does
 * not hold docks at the tail, in the order of the list. Each entry that the poll docked leaves when the list
 * no longer holds it (a different client answered it, or its step ended), or when it belongs to a different
 * analysis. An entry of a turn stays: its own frames and turn teardown settle it.
 */
export function syncPolledAsks(analysisId: string, listed: readonly PendingAsk[]): void {
    const listedIds = new Set(listed.map((ask) => ask.askId));
    setAsks(
        produce((queue) => {
            for (let i = queue.length - 1; i >= 0; i--) {
                const origin = queue[i]?.origin;
                if (origin?.kind === "poll" && (origin.analysisId !== analysisId || !listedIds.has(queue[i]?.askId ?? ""))) queue.splice(i, 1);
            }
            const held = new Set(queue.map((a) => a.askId));
            for (const ask of listed) {
                if (held.has(ask.askId)) continue;
                queue.push({ askId: ask.askId, title: ask.title, command: ask.command, detail: ask.detail, origin: { kind: "poll", analysisId } });
            }
        }),
    );
}

/**
 * Remove the ask with `askId` from the queue, advancing the head to the next pending ask. A no-op when
 * no entry matches (a stale answer, or an already-drained id), so a settle can never wedge the queue.
 */
export function settleAsk(askId: string): void {
    setAsks(
        produce((queue) => {
            const idx = queue.findIndex((a) => a.askId === askId);
            if (idx !== -1) queue.splice(idx, 1);
        }),
    );
}

/**
 * Remove each ask of a turn — called by turn teardown so an abort never leaves a stale docked prompt. The asks
 * that the poll docked stay, because no turn waits for them. Idempotent.
 */
export function clearTurnAsks(): void {
    setAsks((queue) => queue.filter((a) => a.origin.kind !== "turn"));
}

/** The read of {@link refreshPolledAsks}. Tests replace it. */
export type PolledAsksReadOpts = {
    /** Real: `GET {A}/asks`. */
    readonly fetch: (analysisId: string) => ResultAsync<AskList, ClientError>;
};

const DEFAULT_POLLED_ASKS_READ_OPTS: PolledAsksReadOpts = {
    // The pending asks of one analysis are few: each waits for a person. One page of the largest size bounds the read.
    fetch: (analysisId) => fetchAsks(analysisId, { page: 0, perPage: MAX_PER_PAGE }),
};

// The newest read wins: a slow read of a previous analysis must not dock its asks over the read of the open one.
let readGeneration = 0;

/**
 * Read the pending asks of an analysis, and make the queue agree with them ({@link syncPolledAsks}). A failed read
 * changes nothing, thus a blip does not take a docked prompt away and back.
 */
export async function refreshPolledAsks(analysisId: string, opts: PolledAsksReadOpts = DEFAULT_POLLED_ASKS_READ_OPTS): Promise<void> {
    const mine = ++readGeneration;
    const read = await opts.fetch(analysisId);
    if (mine !== readGeneration) return;
    read.match(
        (list) =>
            syncPolledAsks(
                analysisId,
                list.asks.map((ask): PendingAsk => ({ askId: ask.id, title: ask.title, command: ask.command, detail: ask.detail ?? undefined })),
            ),
        (e) => getLogger("chat").debug({ analysisId, err: describeClientError(e) }, "the pending asks could not be read"),
    );
}
