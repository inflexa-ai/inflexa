/**
 * Generic single-flight LRU+TTL resolver.
 *
 * Resolves an input to a value via `fetch`, caching success only behind a
 * bounded LRU with per-entry TTL. Concurrent callers for the same key coalesce
 * onto one in-flight fetch and share its outcome. An `err` is never cached:
 * a host that gates spend per caller must see every refusal again, and a
 * cached refusal or a cached transient fault would outlive its cause. A fetch
 * that rejects is a defect: it is not cached, it clears its in-flight slot,
 * and the rejection passes through. Callers supply their own key formula,
 * fetch+validate step, and (optionally) cache hit/miss metrics; this module
 * owns eviction, coalescing, and expiry — the deep, drift-prone plumbing.
 */

import { ResultAsync, ok, type Result } from "neverthrow";

export interface CachedResolverMetrics {
    onHit(): void;
    /** Recorded once per upstream fetch — coalesced callers do not count. */
    onMiss(): void;
}

export interface CachedResolverConfig<In, Out, E> {
    readonly ttlMs: number;
    readonly maxEntries: number;
    readonly keyFn: (input: In) => string;
    readonly fetch: (input: In) => ResultAsync<Out, E>;
    readonly metrics?: CachedResolverMetrics;
}

export function createCachedResolver<In, Out, E>(cfg: CachedResolverConfig<In, Out, E>): (input: In) => ResultAsync<Out, E> {
    interface Entry {
        readonly value: Out;
        readonly expiresAt: number;
    }
    // Map insertion order doubles as LRU recency: a hit re-inserts the key at
    // the tail; eviction drops the head (oldest).
    const cache = new Map<string, Entry>();
    const inflight = new Map<string, Promise<Result<Out, E>>>();

    function readFresh(key: string): Entry | undefined {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return undefined;
        }
        cache.delete(key);
        cache.set(key, entry);
        return entry;
    }

    function store(key: string, value: Out): void {
        cache.set(key, { value, expiresAt: Date.now() + cfg.ttlMs });
        while (cache.size > cfg.maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    }

    async function resolve(input: In): Promise<Result<Out, E>> {
        const key = cfg.keyFn(input);

        const fresh = readFresh(key);
        if (fresh !== undefined) {
            cfg.metrics?.onHit();
            return ok(fresh.value);
        }

        const pending = inflight.get(key);
        if (pending) return pending;

        cfg.metrics?.onMiss();
        const promise = (async () => {
            const fetched = await cfg.fetch(input);
            if (fetched.isOk()) store(key, fetched.value);
            return fetched;
        })();

        inflight.set(key, promise);
        try {
            return await promise;
        } finally {
            inflight.delete(key);
        }
    }

    return (input) => new ResultAsync(resolve(input));
}
