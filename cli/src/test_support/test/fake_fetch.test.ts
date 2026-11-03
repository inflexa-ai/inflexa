import { describe, expect, test } from "bun:test";

import { respondWith } from "../fake_fetch.ts";

describe("respondWith", () => {
    test("gives a new readable Response with the given text and status on each call", async () => {
        const fetcher = respondWith("hello", { status: 201 });
        const first = await fetcher();
        const second = await fetcher();
        expect(first).not.toBe(second);
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(await first.text()).toBe("hello");
        expect(await second.text()).toBe("hello");
    });

    test("gives an empty 200 Response with no arguments", async () => {
        const res = await respondWith()();
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
    });

    test("rejects with a RangeError for a status that Response refuses, and does not throw at the call", async () => {
        const fetcher = respondWith("x", { status: 1 });
        let pending: Promise<Response> | undefined;
        expect(() => {
            pending = fetcher();
        }).not.toThrow();
        await expect(pending).rejects.toBeInstanceOf(RangeError);
    });
});
