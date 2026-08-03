import { describe, expect, it } from "bun:test";

import { BoundedRateLimiter, createRateLimitedFetch } from "./rate-limit.js";

describe("BoundedRateLimiter", () => {
    it("never exceeds the configured concurrency ceiling", async () => {
        const limiter = new BoundedRateLimiter({ maxConcurrency: 2, requestsPerSecond: 1_000_000, maxRetries: 0, maxRetryDelayMs: 0 });
        let active = 0;
        let maximum = 0;
        await Promise.all(
            Array.from({ length: 12 }, () =>
                limiter.run(async () => {
                    active += 1;
                    maximum = Math.max(maximum, active);
                    await new Promise((resolve) => setTimeout(resolve, 2));
                    active -= 1;
                }),
            ),
        );
        expect(maximum).toBe(2);
    });

    it("paces operation starts using injected time", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new BoundedRateLimiter(
            { maxConcurrency: 3, requestsPerSecond: 10, maxRetries: 0, maxRetryDelayMs: 0 },
            {
                now: () => now,
                sleep: async (milliseconds) => {
                    if (milliseconds > 0) waits.push(milliseconds);
                    now += milliseconds;
                },
            },
        );
        await Promise.all([limiter.run(async () => 1), limiter.run(async () => 2), limiter.run(async () => 3)]);
        expect(waits).toEqual([100, 100]);
    });

    it("removes a canceled waiter from the semaphore queue", async () => {
        const limiter = new BoundedRateLimiter({ maxConcurrency: 1, requestsPerSecond: 1_000_000, maxRetries: 0, maxRetryDelayMs: 0 });
        let release!: () => void;
        const first = limiter.run(async () => await new Promise<void>((resolve) => (release = resolve)));
        await Promise.resolve();
        const controller = new AbortController();
        const second = limiter.run(async () => undefined, controller.signal);
        controller.abort(new DOMException("stop waiting", "AbortError"));
        await expect(second).rejects.toThrow("stop waiting");
        release();
        await first;
    });
});

describe("createRateLimitedFetch", () => {
    it("honors Retry-After within the configured delay bound", async () => {
        let calls = 0;
        let now = 0;
        const waits: number[] = [];
        const fetcher = createRateLimitedFetch(
            async () => {
                calls += 1;
                return calls === 1 ? new Response("later", { status: 429, headers: { "retry-after": "2" } }) : new Response("ok");
            },
            { maxConcurrency: 1, requestsPerSecond: 1_000, maxRetries: 2, maxRetryDelayMs: 1_000 },
            {
                now: () => now,
                sleep: async (milliseconds) => {
                    if (milliseconds > 0) waits.push(milliseconds);
                    now += milliseconds;
                },
            },
        );
        const response = await fetcher("https://example.test");
        expect(response.status).toBe(200);
        expect(calls).toBe(2);
        expect(waits).toContain(1_000);
    });

    it("stops retrying after the configured retry count", async () => {
        let calls = 0;
        const fetcher = createRateLimitedFetch(
            async () => {
                calls += 1;
                return new Response("unavailable", { status: 503 });
            },
            { maxConcurrency: 1, requestsPerSecond: 1_000, maxRetries: 2, maxRetryDelayMs: 10 },
            { now: () => 0, sleep: async () => {} },
        );
        expect((await fetcher("https://example.test")).status).toBe(503);
        expect(calls).toBe(3);
    });
});
