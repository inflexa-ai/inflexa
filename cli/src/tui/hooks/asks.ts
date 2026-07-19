import { createStore, produce } from "solid-js/store";

// The pending-asks queue, held here (not inside `app.tsx`) so the holder of the state is decoupled
// from its renderer — the same split as `status.ts`. It is written ONLY by the conversation adapter's
// `data-ask` case (a `pending` ask pushes; its terminal re-emission settles) and by turn teardown
// (`finishTurn`/reset clear it, covering an abort where a terminal re-emit may never arrive). It is
// read by `app.tsx` (docking + focus) and the docked prompt. FIFO: the head is the ask being answered,
// and answers advance it one by one. One chat screen is mounted at a time, so a module singleton is
// correct.

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

const [asks, setAsks] = createStore<PendingAsk[]>([]);

/** The head pending ask (the one the docked prompt answers), or `null` when the queue is empty — read reactively. */
export function activeAsk(): PendingAsk | null {
    return asks.length > 0 ? asks[0]! : null;
}

/** How many asks are queued BEHIND the head — drives the prompt's `+N more` hint; read reactively. */
export function queuedCount(): number {
    return asks.length > 0 ? asks.length - 1 : 0;
}

/**
 * Enqueue a pending ask at the tail. Copies each primitive into a fresh object so a later mutation of
 * the caller's reference (the in-process emit hazard) cannot reach the store — the store owns its copy.
 */
export function pushAsk(ask: PendingAsk): void {
    setAsks(
        produce((queue) => {
            queue.push({ askId: ask.askId, title: ask.title, command: ask.command, ...(ask.detail !== undefined ? { detail: ask.detail } : {}) });
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

/** Empty the queue — called by turn teardown so an abort never leaves a stale docked prompt. Idempotent. */
export function clearAsks(): void {
    setAsks([]);
}
