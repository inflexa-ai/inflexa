interface CacheEntry<Value> {
    readonly value: Value;
    readonly expiresAt: number;
}

export class BoundedTtlCache<Value> {
    private readonly entries = new Map<string, CacheEntry<Value>>();

    constructor(
        private readonly maximum: number,
        private readonly now: () => number = Date.now,
    ) {
        if (!Number.isInteger(maximum) || maximum < 0) throw new Error("cache maximum must be a non-negative integer");
    }

    get(key: string): Value | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: Value, ttlMs: number): void {
        if (this.maximum === 0 || ttlMs <= 0) return;
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
        while (this.entries.size > this.maximum) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }
}
