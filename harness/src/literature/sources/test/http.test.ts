import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { createRateLimitSchedule } from "../../../lib/rate-limit.js";
import { requestJson } from "../http.js";
import { must } from "@inflexa-ai/harness/lib/test/guards.js";
import { errorMessage, errorOf } from "../../../lib/thrown.js";
import { fetchDouble } from "../../../lib/test/doubles.js";

const BodySchema = z.object({ ok: z.boolean() });

describe("shared source HTTP request policy", () => {
    it("charges the timeout to the network call, not to time spent queueing", async () => {
        // Real time, one request at a time, paced 40ms apart: the last of four
        // is admitted around 120ms — well past a 60ms timeout that a caller
        // armed before queueing. Each attempt must be timed from its own start.
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const options = {
            schedule: createRateLimitSchedule({ maxConcurrency: 1, requestsPerSecond: 25, maxRetries: 0, maxRetryDelayMs: 0 }),
            timeoutMs: 60,
            fetch: fetchDouble((_url, init) => {
                if (init?.signal?.aborted) throw init.signal.reason;
                return Promise.resolve(Response.json({ ok: true }));
            }),
        };

        const results = await Promise.all(Array.from({ length: 4 }, () => requestJson("https://example.test", BodySchema, options)));

        expect(results.map((result) => result.status)).toEqual(["ok", "ok", "ok", "ok"]);
    });

    it("reports a slow network call as a timeout", async () => {
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const result = await requestJson("https://example.test", BodySchema, {
            timeoutMs: 5,
            fetch: fetchDouble(
                (_url, init) =>
                    new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener(
                            "abort",
                            () => {
                                const reason: unknown = must(must(init, "init").signal, 'must(init, "init").signal').reason;
                                reject(errorOf(reason) ?? new Error(errorMessage(reason)));
                            },
                            { once: true },
                        );
                    }),
            ),
        });

        expect(result).toMatchObject({ status: "unavailable", detail: "request timed out after 5ms" });
    });

    it("honors Retry-After within the configured delay bound", async () => {
        let calls = 0;
        const waits: number[] = [];
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const result = await requestJson("https://example.test", BodySchema, {
            maxRetries: 2,
            maxRetryDelayMs: 1_000,
            sleep: (milliseconds: number): Promise<void> => {
                waits.push(milliseconds);
                return Promise.resolve();
            },
            fetch: fetchDouble(() => {
                calls += 1;
                return Promise.resolve(calls === 1 ? new Response("later", { status: 429, headers: { "retry-after": "2" } }) : Response.json({ ok: true }));
            }),
        });

        expect(result).toMatchObject({ status: "ok" });
        expect(calls).toBe(2);
        expect(waits).toEqual([1_000]);
    });

    it("stops retrying after the configured retry count", async () => {
        let calls = 0;
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const result = await requestJson("https://example.test", BodySchema, {
            maxRetries: 2,
            maxRetryDelayMs: 10,
            sleep: (): Promise<void> => {
                return Promise.resolve();
            },
            fetch: fetchDouble(() => {
                calls += 1;
                return Promise.resolve(new Response("unavailable", { status: 503 }));
            }),
        });

        expect(result).toMatchObject({ status: "unavailable", detail: "HTTP 503" });
        expect(calls).toBe(3);
    });

    it("re-enters the admission gate on every retry", async () => {
        let admitted = 0;
        let calls = 0;
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const result = await requestJson("https://example.test", BodySchema, {
            maxRetries: 1,
            maxRetryDelayMs: 0,
            sleep: (): Promise<void> => {
                return Promise.resolve();
            },
            schedule: async <T>(operation: () => Promise<T>): Promise<T> => {
                admitted += 1;
                return await operation();
            },
            fetch: fetchDouble(() => {
                calls += 1;
                return Promise.resolve(calls === 1 ? new Response("later", { status: 429 }) : Response.json({ ok: true }));
            }),
        });

        expect(result).toMatchObject({ status: "ok" });
        expect(admitted).toBe(2);
    });
});
