/**
 * Shared async utilities — sleep and a bounded-concurrency `Promise.all`.
 */

import PQueue from "p-queue";

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run each task with a cap on how many run at the same time, and give back the results in the order of
 * the input.
 *
 * The signature mirrors `Promise.all`. The mapped return type is element-wise, thus a tuple of thunks
 * with different return types keeps each one, and a plain array of thunks gives a plain array. The input
 * is an array of thunks and not an array of promises, because a promise is already running when it is
 * made, and a cap over a set of started promises caps nothing.
 *
 * `concurrency` must be a number at or above 1. p-queue throws a `TypeError` for any other value.
 *
 * The failure behavior is that of `Promise.all`. The first rejection rejects the whole call, and each
 * task that the queue already started still runs to completion.
 */
export function allWithConcurrency<T extends readonly (() => unknown)[] | []>(
    tasks: T,
    concurrency: number,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P] extends () => infer R ? R : never> }> {
    const queue = new PQueue({ concurrency });
    // `addAll` collapses every task onto one result type, thus it cannot express the element-wise type
    // above. The cast is sound because `addAll` maps the input array through `Promise.all`, which keeps
    // the position of each task, and each element is the awaited return of the task at that position.
    return queue.addAll(tasks as ReadonlyArray<() => unknown>) as Promise<{
        -readonly [P in keyof T]: Awaited<T[P] extends () => infer R ? R : never>;
    }>;
}
