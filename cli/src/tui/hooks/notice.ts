import { createSignal } from "solid-js";

import type { Notice } from "../theme.ts";

// The transient toast feedback channel, held here (not inside `app.tsx`) so any code — palette
// commands, bus handlers, a future module — can raise a notice without threading a callback
// through the workspace context. Mirrors the `status.ts` / `theme.ts` store shape (a reactive accessor
// + a single mutator). One chat screen renders the overlay at a time, so a module singleton is the
// right holder.
//
// FIFO queue, not a single slot. The replace-on-arrival model this channel started with (OpenCode's
// `toast.tsx` shape) is correct for a SOLICITED notice: the user pressed copy, they know what
// happened, and a second copy superseding the first loses nothing. It is wrong for an UNSOLICITED
// one. A run completing is the user's only signal that work they did not initiate this second has
// finished, and two runs landing inside one display window is an ordinary event, not a corner case —
// under replace-on-arrival the first would be silently destroyed, which is precisely the class of
// loss this channel exists to prevent.
//
// The queue drops nothing. Concurrency is bounded by how many runs one analysis can have in flight,
// which is small, so there is no realistic backlog worth a discard policy — and every completion
// notice also has a durable thread record behind it, so the transient channel is not the only copy.

const [current, setCurrent] = createSignal<Notice | null>(null);
const pending: { notice: Notice; durationMs: number }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** The showing toast, or null. Read inside a tracking scope so the overlay renders reactively. */
export const currentNotice = current;

/** Show the queue's head, or clear the slot when it is empty. */
function advance(): void {
    const next = pending.shift();
    if (!next) {
        timer = null;
        setCurrent(null);
        return;
    }
    setCurrent(next.notice);
    // `.unref()`'d so a pending dismissal never keeps the process alive at shutdown.
    timer = setTimeout(advance, next.durationMs);
    timer.unref();
}

/**
 * Raise a transient toast. Shows immediately when nothing is displaying, otherwise queues behind
 * what is — in arrival order, discarding nothing. Each notice gets its own full display window.
 */
export function notify(notice: Notice, durationMs = 4000): void {
    pending.push({ notice, durationMs });
    // A live timer means something is showing and will call `advance` itself when its window ends;
    // promoting now would cut that notice short, which is the loss this queue exists to prevent.
    if (timer === null) advance();
}

/** How many notices are waiting behind the one showing. Test-only view of the queue's depth. */
export function __pendingNoticeCountForTest(): number {
    return pending.length;
}

/** Test hook: clear the showing notice, drain the queue, and cancel the dismiss timer. */
export function __resetNoticesForTest(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    pending.length = 0;
    setCurrent(null);
}
