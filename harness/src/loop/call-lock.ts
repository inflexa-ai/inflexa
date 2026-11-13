/** Runs one body at a time, in the order of the calls of `run`. A failed body does not stop the next one. */
export type CallLock = {
    run<T>(body: () => Promise<T>): Promise<T>;
};

export function createCallLock(): CallLock {
    let tail: Promise<unknown> = Promise.resolve();
    return {
        run<T>(body: () => Promise<T>): Promise<T> {
            const result = tail.then(body);
            tail = result.then(
                () => undefined,
                () => undefined,
            );
            return result;
        },
    };
}
