/**
 * Shared async utilities — sleep and bounded-concurrency map.
 */

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map over items with bounded concurrency.
 * At most `concurrency` items are processed simultaneously.
 */
export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i]!, i);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
