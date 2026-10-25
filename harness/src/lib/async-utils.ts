/**
 * Shared async utilities — sleep and a bounded-concurrency `Promise.all`.
 */

import { setTimeout as timerSleep } from "node:timers/promises";

import PQueue from "p-queue";

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
    return timerSleep(ms);
}

/**
 * Run each task with a cap on how many run at the same time, and give back the results in the order of
 * the input.
 *
 * The input is an array of thunks and not an array of promises, because a promise is already running when
 * it is made, and a cap over a set of started promises caps nothing.
 *
 * `concurrency` must be a number at or above 1. p-queue throws a `TypeError` for any other value.
 *
 * The failure behavior is that of `Promise.all`. The first rejection rejects the whole call, and each
 * task that the queue already started still runs to completion.
 */
export function allWithConcurrency<R>(tasks: ReadonlyArray<() => R | PromiseLike<R>>, concurrency: number): Promise<Awaited<R>[]> {
    const queue = new PQueue({ concurrency });
    return Promise.all(tasks.map((task) => queue.add(task)));
}
