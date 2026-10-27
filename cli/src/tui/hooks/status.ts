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

/** The retry of a model request that the envelope of the provider waits for: the `data-model-retry` part. */
export type ModelRetryStatus = {
    readonly attempt: number;
    readonly maxRetries: number;
    /** The HTTP status of the failed attempt. Absent for a failure with no status, for example a lost connection. */
    readonly status?: number;
};

const [retry, setRetry] = createSignal<ModelRetryStatus | null>(null);

/** The retry of a model request of the turn of this client, or `null`. A later frame of the turn clears it. */
export const modelRetry = retry;

/** Set or clear the retry of a model request. */
export function setModelRetry(next: ModelRetryStatus | null): void {
    setRetry(next);
}

/** The words of the state segment of the header while a model request retries, for example `retrying the model request (3/10)`. */
export function modelRetryText(retry: ModelRetryStatus): string {
    const why = retry.status === undefined ? "no connection" : `HTTP ${retry.status}`;
    return `retrying the model request (${retry.attempt}/${retry.maxRetries}, ${why})`;
}
