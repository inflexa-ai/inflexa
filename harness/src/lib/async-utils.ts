/**
 * Shared async utilities — sleep and a bounded-concurrency `Promise.all`.
 */

import PQueue from "p-queue";
import { abortReason } from "./thrown.js";

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the package's one raw timer: it resolves on its own and cannot outlive the caller, and every other wait goes through it.
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Promise-based delay that ends early when the signal aborts, rejecting with the
 * abort reason of the signal.
 */
export function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the wait ends on the abort signal: the timer dies with the promise, because whichever of the two fires first clears the other.
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(abortReason(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * A signal that aborts with `reason` after `milliseconds`. The deadline is
 * unref'd, thus an armed deadline does not keep a short-lived process alive.
 */
/** A fresh read of the abort flag: the signal flips in another task, so a narrowed read of `signal.aborted` is stale. */
export function isAborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

export function abortAfter(milliseconds: number, reason?: unknown): AbortSignal {
    const controller = new AbortController();
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the deadline ends on the returned AbortSignal and dies with it: the wait a caller builds on the signal is the replacement of the raw timer.
    const timer = setTimeout(() => controller.abort(reason), milliseconds);
    timer.unref();
    return controller.signal;
}

/**
 * Run each task with a cap on how many run at the same time, and give back the results in the order of
 * the input.
 *
 * The signature mirrors `Promise.all`. The input
 * is an array of thunks and not an array of promises, because a promise is already running when it is
 * made, and a cap over a set of started promises caps nothing.
 *
 * `concurrency` must be a number at or above 1. p-queue throws a `TypeError` for any other value.
 *
 * The failure behavior is that of `Promise.all`. The first rejection rejects the whole call, and each
 * task that the queue already started still runs to completion.
 */
export function allWithConcurrency<R>(tasks: readonly (() => R)[], concurrency: number): Promise<Awaited<R>[]> {
    const queue = new PQueue({ concurrency });
    return Promise.all(tasks.map((task) => queue.add(task)));
}
