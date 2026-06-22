import { createSignal } from "solid-js";

// The chat's live status, held here (not inside `app.tsx`) so the holder of the state is
// decoupled from its renderer: `app.tsx` only READS `chatStatus()` to paint the status bar,
// while any code sets it indirectly via `setChatStatus`. Mirrors the `theme.ts` store shape
// (a reactive accessor + a single setter). One chat screen is mounted at a time, so a module
// singleton is correct.

/** The chat session's coarse activity state. */
export type ChatStatus = "idle" | "busy" | "error";

const [status, setStatus] = createSignal<ChatStatus>("idle");

/** Read the current chat status — call inside a tracking scope for reactivity. */
export const chatStatus = status;

/** Set the chat status. The single indirect mutator the bus handler / session swap call. */
export function setChatStatus(next: ChatStatus): void {
    setStatus(next);
}
