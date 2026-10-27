import type { PauseCause } from "@inflexa-ai/harness/contracts/index.js";

// The words of a pause of durable work, for each surface that shows one: the pause prompt and the marks of the TUI,
// the palette list of the paused work, and the progress of `inflexa run --plan`. One vocabulary, thus the surfaces
// cannot name the same pause in two ways.

/** The cause of a pause in words. The cause `host` carries the reason of the host as it came, unread. */
export function describePauseCause(cause: PauseCause): string {
    switch (cause.kind) {
        case "outage":
            return "the model provider is not available";
        case "credential":
            return "the model endpoint has no valid credential";
        case "host":
            return `the host paused the work (${cause.reason})`;
        default: {
            const exhaustive: never = cause;
            throw new Error(`unhandled pause cause: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The fields of one waiting workflow that its line reads. */
export type PausedWaitView = {
    readonly state: "retrying" | "paused";
    readonly cause: PauseCause;
    /** The count of timer retries before this wait. */
    readonly attempt: number;
    /** ISO 8601. Present for the state `retrying` only. */
    readonly retryAt?: string;
};

/**
 * The next retry of a wait in `retrying`: its number and its local time, for example `retry 2 at 10:32:05`. `null`
 * for a wait in `paused`, which only a resume ends. The number counts from 1, because `attempt` counts the retries
 * that came before this wait.
 */
export function nextRetryOf(wait: PausedWaitView): string | null {
    if (wait.state !== "retrying") return null;
    const at = wait.retryAt === undefined ? NaN : Date.parse(wait.retryAt);
    const when = Number.isNaN(at) ? "" : ` at ${new Date(at).toLocaleTimeString()}`;
    return `retry ${wait.attempt + 1}${when}`;
}

/** One waiting workflow in one line: its state, its cause, and the next retry of a wait in `retrying`. */
export function describePausedWait(wait: PausedWaitView): string {
    const retry = nextRetryOf(wait);
    return retry === null ? `paused: ${describePauseCause(wait.cause)}` : `retrying: ${describePauseCause(wait.cause)}, ${retry}`;
}
