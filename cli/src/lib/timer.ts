/** Options of a timer. `unref` lets the process exit while the timer is pending. */
export type TimerOpts = { readonly unref?: boolean };

/** The outcome of `withinDeadline`. */
export type DeadlineResult<T> = { kind: "settled"; value: T } | { kind: "timeout" };

/** Runs `fn` one time after `ms`. Returns the stop: calling it before the run cancels the run. */
export function runAfter(ms: number, fn: () => void, opts: TimerOpts = {}): () => void {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- this module is the one owner of a timer handle; the global is read at call time so `jest.useFakeTimers()` controls it
    const handle = setTimeout(fn, ms);
    if (opts.unref) handle.unref();
    return () => {
        clearTimeout(handle);
    };
}

/** Runs `fn` each `ms` until the stop. Returns the stop. */
export function runEvery(ms: number, fn: () => void, opts: TimerOpts = {}): () => void {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- this module is the one owner of a timer handle; the global is read at call time so `jest.useFakeTimers()` controls it
    const handle = setInterval(fn, ms);
    if (opts.unref) handle.unref();
    return () => {
        clearInterval(handle);
    };
}

/**
 * Races `promise` against a deadline. The timer clears when the race settles. A rejection of
 * `promise` propagates, and the loser of the race keeps running: the caller owns its cancel.
 */
export async function withinDeadline<T>(promise: Promise<T>, ms: number, opts: TimerOpts = {}): Promise<DeadlineResult<T>> {
    let stop = (): void => {};
    const deadline = new Promise<DeadlineResult<T>>((resolve) => {
        stop = runAfter(ms, () => resolve({ kind: "timeout" }), opts);
    });
    try {
        return await Promise.race([promise.then((value): DeadlineResult<T> => ({ kind: "settled", value })), deadline]);
    } finally {
        stop();
    }
}
