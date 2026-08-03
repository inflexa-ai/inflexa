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

    it("counts a read as a use, so recency order follows gets and not only sets", () => {
        const cache = new BoundedTtlCache<string>(3, () => 0);
        for (const key of ["a", "b", "c"]) cache.set(key, key, 100);
        cache.get("a");
        cache.get("b");
        cache.set("d", "d", 100);

        expect(cache.get("c")).toBeUndefined();
        expect([cache.get("a"), cache.get("b"), cache.get("d")]).toEqual(["a", "b", "d"]);
    });

    it("re-setting an existing key refreshes it in place rather than growing the map", () => {
        const cache = new BoundedTtlCache<number>(2, () => 0);
        cache.set("a", 1, 100);
        cache.set("b", 2, 100);
        cache.set("a", 10, 100);
        cache.set("c", 3, 100);

        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")).toBe(10);
        expect(cache.get("c")).toBe(3);
    });

    it("expires entries without returning stale values", () => {
        let now = 0;
        const cache = new BoundedTtlCache<number>(2, () => now);
        cache.set("a", 1, 10);
        now = 10;
        expect(cache.get("a")).toBeUndefined();
    });

    it("holds an entry up to its deadline and drops it exactly at it", () => {
        let now = 0;
        const cache = new BoundedTtlCache<number>(2, () => now);
        cache.set("a", 1, 10);
        now = 9;
        expect(cache.get("a")).toBe(1);
        now = 10;
        expect(cache.get("a")).toBeUndefined();
    });

    it("reclaims an expired entry on read rather than leaving it to occupy the bound", () => {
        let now = 0;
        const cache = new BoundedTtlCache<number>(1, () => now);
        cache.set("a", 1, 10);
        now = 20;
        expect(cache.get("a")).toBeUndefined();
        cache.set("b", 2, 10);
        expect(cache.get("b")).toBe(2);
    });

    it("stores nothing for a non-positive ttl", () => {
        const cache = new BoundedTtlCache<number>(2, () => 0);
        cache.set("a", 1, 0);
        cache.set("b", 2, -5);
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBeUndefined();
    });

    it("stores nothing at a maximum of zero", () => {
        const cache = new BoundedTtlCache<number>(0, () => 0);
        cache.set("a", 1, 100);
        expect(cache.get("a")).toBeUndefined();
    });

    it("holds its bound under sustained insertion", () => {
        const cache = new BoundedTtlCache<number>(3, () => 0);
        for (let index = 0; index < 100; index += 1) cache.set(`k${index}`, index, 100);

        expect([97, 98, 99].map((index) => cache.get(`k${index}`))).toEqual([97, 98, 99]);
        expect(cache.get("k96")).toBeUndefined();
        expect(cache.get("k0")).toBeUndefined();
    });

    it("rejects a maximum that is not a non-negative integer", () => {
        expect(() => new BoundedTtlCache<number>(-1)).toThrow("non-negative integer");
        expect(() => new BoundedTtlCache<number>(1.5)).toThrow("non-negative integer");
    });

    it("returns a miss for a key it was never given", () => {
        expect(new BoundedTtlCache<number>(2, () => 0).get("absent")).toBeUndefined();
    });
});
