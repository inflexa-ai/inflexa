import { describe, expect, it } from "bun:test";

import { BoundedRateLimiter, createRateLimitSchedule } from "./rate-limit.js";

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

describe("createRateLimitSchedule", () => {
    it("paces an arbitrary operation, so a caller can arm its timeout after admission", async () => {
        let now = 0;
        const waits: number[] = [];
        let admitted = 0;
        const schedule = createRateLimitSchedule(
            { maxConcurrency: 1, requestsPerSecond: 10, maxRetries: 0, maxRetryDelayMs: 0 },
            {
                now: () => now,
                sleep: async (milliseconds) => {
                    if (milliseconds > 0) waits.push(milliseconds);
                    now += milliseconds;
                },
            },
        );

        const results = await Promise.all(
            Array.from({ length: 3 }, (_, index) =>
                schedule(async () => {
                    admitted += 1;
                    return index;
                }),
            ),
        );

        expect(results).toEqual([0, 1, 2]);
        expect(admitted).toBe(3);
        expect(waits).toEqual([100, 100]);
    });
});
