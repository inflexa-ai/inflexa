/**
 * Shared AsyncIterable test helper. It yields the items in order, so a test
 * drives a stream consumer with no timer.
 */

/**
 * Yields each item of the array in order. When `toThrow` is given, the
 * iterator rejects with it after the last item instead of finishing.
 */
export function asyncIterableOf<T>(items: readonly T[], toThrow?: unknown): AsyncIterable<T> {
    let i = 0;
    return {
        [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<T>> => {
                if (i < items.length) {
                    const value = items[i];
                    if (value === undefined) return Promise.resolve({ done: true, value: undefined });
                    i += 1;
                    return Promise.resolve({ done: false, value });
                }
                // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a test rejects with the exact abort reason that the production stream carries (DOMException or Error), and the test matches it.
                if (toThrow !== undefined) return Promise.reject(toThrow);
                return Promise.resolve({ done: true, value: undefined });
            },
        }),
    };
}
