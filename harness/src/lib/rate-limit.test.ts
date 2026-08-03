import { describe, expect, it } from "bun:test";

import { BoundedRateLimiter, createRateLimitSchedule, sleepWithSignal } from "./rate-limit.js";

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

    it("releases the slot when the operation throws, so a failure cannot wedge the limiter", async () => {
        const limiter = new BoundedRateLimiter({ maxConcurrency: 1, requestsPerSecond: 1_000_000, maxRetries: 0, maxRetryDelayMs: 0 });

        await expect(
            limiter.run(async () => {
                throw new Error("upstream exploded");
            }),
        ).rejects.toThrow("upstream exploded");

        expect(await limiter.run(async () => "recovered")).toBe("recovered");
    });

    it("returns each operation's own value, in the face of interleaving", async () => {
        const limiter = new BoundedRateLimiter({ maxConcurrency: 3, requestsPerSecond: 1_000_000, maxRetries: 0, maxRetryDelayMs: 0 });

        const results = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                limiter.run(async () => {
                    await new Promise((resolve) => setTimeout(resolve, (index % 3) + 1));
                    return index;
                }),
            ),
        );

        expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
    });

    it("refuses a signal that is already aborted before any slot is taken", async () => {
        const limiter = new BoundedRateLimiter({ maxConcurrency: 1, requestsPerSecond: 1_000_000, maxRetries: 0, maxRetryDelayMs: 0 });
        let ran = false;

        await expect(limiter.run(async () => (ran = true), AbortSignal.abort(new DOMException("gone", "AbortError")))).rejects.toThrow("gone");

        expect(ran).toBe(false);
        expect(await limiter.run(async () => "still usable")).toBe("still usable");
    });

    it("paces from the later of now and the last reservation, so an idle limiter does not bank credit", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new BoundedRateLimiter(
            { maxConcurrency: 1, requestsPerSecond: 10, maxRetries: 0, maxRetryDelayMs: 0 },
            {
                now: () => now,
                sleep: async (milliseconds) => {
                    if (milliseconds > 0) waits.push(milliseconds);
                    now += milliseconds;
                },
            },
        );

        await limiter.run(async () => undefined);
        now = 5_000;
        await limiter.run(async () => undefined);

        expect(waits).toEqual([]);
    });

    it("rejects a configuration that could not bound anything", () => {
        expect(() => new BoundedRateLimiter({ maxConcurrency: 0, requestsPerSecond: 1, maxRetries: 0, maxRetryDelayMs: 0 })).toThrow("maxConcurrency");
        expect(() => new BoundedRateLimiter({ maxConcurrency: 1.5, requestsPerSecond: 1, maxRetries: 0, maxRetryDelayMs: 0 })).toThrow("maxConcurrency");
        expect(() => new BoundedRateLimiter({ maxConcurrency: 1, requestsPerSecond: 0, maxRetries: 0, maxRetryDelayMs: 0 })).toThrow("requestsPerSecond");
    });
});

describe("sleepWithSignal", () => {
    it("resolves immediately for a non-positive duration, without consulting the signal", async () => {
        await expect(sleepWithSignal(0, AbortSignal.abort(new DOMException("gone", "AbortError")))).resolves.toBeUndefined();
    });

    it("rejects an in-flight wait when the signal fires, and stops waiting", async () => {
        const controller = new AbortController();
        const pending = sleepWithSignal(60_000, controller.signal);
        controller.abort(new DOMException("cancelled", "AbortError"));
        await expect(pending).rejects.toThrow("cancelled");
    });

    it("rejects a signal that had already aborted", async () => {
        await expect(sleepWithSignal(10, AbortSignal.abort(new DOMException("already gone", "AbortError")))).rejects.toThrow("already gone");
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
