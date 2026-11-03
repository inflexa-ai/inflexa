import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";

import { runAfter, runEvery, withinDeadline } from "../timer.ts";

type Handle = ReturnType<typeof setTimeout>;

// A Bun timer handle has `hasRef`. The spy records each returned handle as `{}`, so the guard reads the
// one method that the tests call, and a result without it is left out of the list.
function isHandle(value: unknown): value is Handle {
    return typeof value === "object" && value !== null && "hasRef" in value;
}

function handlesOf(spy: { mock: { results: { value?: unknown }[] } }): Handle[] {
    return spy.mock.results.map((result) => result.value).filter(isHandle);
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("runAfter", () => {
    test("runs after the delay and not before", () => {
        let runs = 0;
        runAfter(50, () => runs++);
        jest.advanceTimersByTime(49);
        expect(runs).toBe(0);
        jest.advanceTimersByTime(1);
        expect(runs).toBe(1);
        jest.advanceTimersByTime(500);
        expect(runs).toBe(1);
    });

    test("does not run after the stop", () => {
        let runs = 0;
        const stop = runAfter(50, () => runs++);
        stop();
        jest.advanceTimersByTime(100);
        expect(runs).toBe(0);
    });

    test("a stop after the run does nothing", () => {
        let runs = 0;
        const stop = runAfter(10, () => runs++);
        jest.advanceTimersByTime(10);
        stop();
        expect(runs).toBe(1);
    });

    test("unref gives a handle that does not hold the process, and the default holds it", () => {
        const spy = spyOn(globalThis, "setTimeout");
        try {
            const stopUnref = runAfter(10, () => {}, { unref: true });
            const stopRef = runAfter(10, () => {});
            expect(handlesOf(spy).map((handle) => handle.hasRef())).toEqual([false, true]);
            stopUnref();
            stopRef();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("runEvery", () => {
    test("runs at each interval until the stop", () => {
        let runs = 0;
        const stop = runEvery(10, () => runs++);
        jest.advanceTimersByTime(9);
        expect(runs).toBe(0);
        jest.advanceTimersByTime(21);
        expect(runs).toBe(3);
        stop();
        jest.advanceTimersByTime(100);
        expect(runs).toBe(3);
    });

    test("unref gives a handle that does not hold the process", () => {
        const spy = spyOn(globalThis, "setInterval");
        try {
            const stop = runEvery(10, () => {}, { unref: true });
            expect(handlesOf(spy).map((handle) => handle.hasRef())).toEqual([false]);
            stop();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("withinDeadline", () => {
    test("settles with the value when the promise wins", async () => {
        const outcome = withinDeadline(Promise.resolve("done"), 100);
        expect(await outcome).toEqual({ kind: "settled", value: "done" });
        expect(jest.getTimerCount()).toBe(0);
    });

    test("times out when the deadline wins", async () => {
        const outcome = withinDeadline(new Promise<string>(() => {}), 100);
        jest.advanceTimersByTime(100);
        expect(await outcome).toEqual({ kind: "timeout" });
    });

    test("propagates a rejection and clears the timer", async () => {
        const outcome = withinDeadline(Promise.reject(new Error("boom")), 100);
        await expect(outcome).rejects.toThrow("boom");
        expect(jest.getTimerCount()).toBe(0);
    });
});
