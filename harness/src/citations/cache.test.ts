import { describe, expect, it } from "bun:test";

import { BoundedTtlCache } from "./cache.js";

describe("BoundedTtlCache", () => {
    it("evicts the least recently used entry at its maximum", () => {
        const cache = new BoundedTtlCache<number>(2, () => 0);
        cache.set("a", 1, 100);
        cache.set("b", 2, 100);
        expect(cache.get("a")).toBe(1);
        cache.set("c", 3, 100);
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")).toBe(1);
        expect(cache.get("c")).toBe(3);
    });

    it("expires entries without returning stale values", () => {
        let now = 0;
        const cache = new BoundedTtlCache<number>(2, () => now);
        cache.set("a", 1, 10);
        now = 10;
        expect(cache.get("a")).toBeUndefined();
    });
});
