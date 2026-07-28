import { createSignal } from "solid-js";

import type { Notice } from "../theme.ts";

// The transient toast feedback channel, held here (not inside `app.tsx`) so any code — palette
// commands, bus handlers, a future module — can raise a notice without threading a callback
// through the workspace context. Mirrors the `status.ts` / `theme.ts` store shape (a reactive accessor
// + a single mutator). One chat screen renders the overlay at a time, so a module singleton is the
// right holder.
//
// TWO delivery disciplines, because the channel carries two kinds of notice and they want opposite
// things. Which one a caller gets is its own choice (`queue`), defaulting to replace.
//
//   - SOLICITED (the default, and the overwhelming majority): the user pressed copy, switched theme,
//     ran a command that failed. They are watching for the answer to a keystroke they just made, so
//     the NEWEST one is the one that matters and a superseded predecessor loses nothing. Queueing
//     these would be actively worse — two copies in a row would play two identical toasts back to
//     back, making the second keystroke look like it did something different from the first.
//
//   - UNSOLICITED (`queue: true`): a run completing is the user's only signal that work they did not
//     initiate this second has finished, and two runs landing inside one display window is an
//     ordinary event, not a corner case. Under replace-on-arrival the first would be silently
//     destroyed, which is precisely the class of loss this channel exists to prevent.
//
// The queue drops nothing on arrival. Concurrency is bounded by how many runs one analysis can have
// in flight, which is small, so there is no realistic backlog worth a discard policy. A solicited
// notice arriving mid-queue does cut the showing one's window short — accepted deliberately: it is a
// direct answer to a keystroke and must not wait behind background chatter, the queue behind it is
// preserved rather than discarded, and every completion notice also has a durable thread record
// behind it, so the transient channel is never the only copy.

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

/** Delivery discipline for one {@link notify} call. */
export type NotifyOptions = {
    /**
     * Queue behind whatever is showing instead of replacing it, so this notice gets its own full
     * display window and nothing already queued is lost.
     *
     * For UNSOLICITED notices only — ones announcing something the user did not just ask for, where
     * being superseded means the event is never seen at all. Solicited feedback must leave this off:
     * it answers a keystroke, so it wants to be the thing on screen now.
     */
    readonly queue?: boolean;
};

/**
 * Raise a transient toast. By default REPLACES whatever is showing and restarts the dismiss window —
 * the right shape for feedback the user just asked for. Pass `{ queue: true }` for an unsolicited
 * announcement that must not be destroyed by the next one to arrive.
 *
 * A replacing notice does not discard the queue: queued notices resume once its window ends.
 */
export function notify(notice: Notice, durationMs = 4000, opts: NotifyOptions = {}): void {
    if (opts.queue) {
        pending.push({ notice, durationMs });
        // A live timer means something is showing and will call `advance` itself when its window
        // ends; promoting now would cut that notice short, which is the loss the queue prevents.
        if (timer === null) advance();
        return;
    }
    // Replace: take the slot now. `advance` still owns what happens next, so anything queued behind
    // this one is delivered after it rather than dropped.
    if (timer) clearTimeout(timer);
    setCurrent(notice);
    // `.unref()`'d so a pending dismissal never keeps the process alive at shutdown.
    timer = setTimeout(advance, durationMs);
    timer.unref();
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
