/**
 * Generic single-flight LRU+TTL resolver.
 *
 * Resolves an input to a value via `fetch`, caching success only behind a
 * bounded LRU with per-entry TTL. Concurrent callers for the same key coalesce
 * onto one in-flight fetch; a fetch that throws is not cached and clears its
 * in-flight slot. Callers supply their own key formula, fetch+validate step,
 * and (optionally) cache hit/miss metrics; this module owns eviction,
 * coalescing, and expiry — the deep, drift-prone plumbing.
 */

export interface CachedResolverMetrics {
    onHit(): void;
    /** Recorded once per upstream fetch — coalesced callers do not count. */
    onMiss(): void;
}

export interface CachedResolverConfig<In, Out> {
    readonly ttlMs: number;
    readonly maxEntries: number;
    readonly keyFn: (input: In) => string;
    readonly fetch: (input: In) => Promise<Out>;
    readonly metrics?: CachedResolverMetrics;
}

export function createCachedResolver<In, Out>(cfg: CachedResolverConfig<In, Out>): (input: In) => Promise<Out> {
    interface Entry {
        readonly value: Out;
        readonly expiresAt: number;
    }
    // Map insertion order doubles as LRU recency: a hit re-inserts the key at
    // the tail; eviction drops the head (oldest).
    const cache = new Map<string, Entry>();
    const inflight = new Map<string, Promise<Out>>();

    function readFresh(key: string): Out | undefined {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return undefined;
        }
        cache.delete(key);
        cache.set(key, entry);
        return entry.value;
    }

    function store(key: string, value: Out): void {
        cache.set(key, { value, expiresAt: Date.now() + cfg.ttlMs });
        while (cache.size > cfg.maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    }

    return async function resolve(input: In): Promise<Out> {
        const key = cfg.keyFn(input);

        const fresh = readFresh(key);
        if (fresh !== undefined) {
            cfg.metrics?.onHit();
            return fresh;
        }

        const pending = inflight.get(key);
        if (pending) return pending;

        cfg.metrics?.onMiss();
        const promise = (async () => {
            const value = await cfg.fetch(input);
            store(key, value);
            return value;
        })();

        inflight.set(key, promise);
        try {
            return await promise;
        } finally {
            inflight.delete(key);
        }
    };
}
