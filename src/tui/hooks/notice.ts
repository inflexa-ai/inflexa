import { createSignal } from "solid-js";

import type { Notice } from "../theme.ts";

// The transient toast feedback channel, held here (not inside `app.tsx`) so any code — palette
// commands, bus handlers, a future module — can raise a notice without threading a callback
// through `CommandContext`. Mirrors the `status.ts` / `theme.ts` store shape (a reactive accessor
// + a single mutator). One chat screen renders the overlay at a time, so a module singleton is the
// right holder. Single slot, single timer, no queue — the same model as OpenCode's `toast.tsx`: a
// new notice overwrites the showing one rather than stacking.

const [current, setCurrent] = createSignal<Notice | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

/** The active toast, or null. Read inside a tracking scope so the overlay renders reactively. */
export const currentNotice = current;

/**
 * Raise a transient toast. A new call REPLACES any showing notice and resets the dismiss timer
 * (single slot, no queue). The timer is `.unref()`'d so a pending dismissal never keeps the
 * process alive at shutdown.
 */
export function notify(notice: Notice, durationMs = 4000): void {
    if (timer) clearTimeout(timer);
    setCurrent(notice);
    timer = setTimeout(() => setCurrent(null), durationMs);
    timer.unref();
}
