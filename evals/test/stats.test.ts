import { describe, expect, test } from "bun:test";

import { pairedMean, passHatK, rateDifference, wilson } from "../lib/stats.js";

describe("wilson", () => {
    test("matches the published interval of 8 successes in 10 trials", () => {
        const interval = wilson(8, 10);
        expect(interval.low).toBeCloseTo(0.4902, 3);
        expect(interval.high).toBeCloseTo(0.9433, 3);
    });

    test("stays inside 0..1 at the edges", () => {
        expect(wilson(0, 5).low).toBe(0);
        expect(wilson(5, 5).high).toBe(1);
        expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    });
});

describe("passHatK", () => {
    test("is the chance that k trials drawn without replacement all pass", () => {
        expect(passHatK(4, 5, 3)).toBeCloseTo(0.4, 10);
        expect(passHatK(5, 5, 3)).toBe(1);
        expect(passHatK(2, 5, 3)).toBe(0);
    });

    test("is undefined when k is above the trials", () => {
        expect(passHatK(2, 2, 3)).toBeUndefined();
    });
});

describe("rateDifference", () => {
    test("marks a drop from 10/10 to 0/10 as below zero", () => {
        const difference = rateDifference({ passes: 10, trials: 10 }, { passes: 0, trials: 10 });
        expect(difference.estimate).toBe(-1);
        expect(difference.high).toBeLessThan(0);
    });

    test("does not mark a drop from 5/5 to 4/5", () => {
        const difference = rateDifference({ passes: 5, trials: 5 }, { passes: 4, trials: 5 });
        expect(difference.low).toBeLessThan(0);
        expect(difference.high).toBeGreaterThan(0);
    });
});

describe("pairedMean", () => {
    test("gives the mean and a symmetric interval", () => {
        const mean = pairedMean([0.2, 0.4, 0.0, 0.2]);
        expect(mean.estimate).toBeCloseTo(0.2, 10);
        expect(mean.high - mean.estimate).toBeCloseTo(mean.estimate - mean.low, 10);
    });
});
