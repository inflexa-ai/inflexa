/**
 * Unit tests for the guaranteed-read family in `present.ts`.
 *
 * Each helper serves a read whose construction guarantees presence: the
 * present path returns the value, and a false guarantee throws an `Error`
 * whose message names the read — the given description when one is passed,
 * the default naming otherwise. The message is the observable failure
 * surface, so the absent paths assert it.
 */

import { describe, expect, it } from "bun:test";

import { presentAt, presentFind, presentFirst, presentGet, presentLast } from "../present.js";

describe("presentFirst", () => {
    it("returns the first element of a non-empty array", () => {
        expect(presentFirst(["a", "b"])).toBe("a");
    });

    it("throws the default message on an empty array", () => {
        expect(() => presentFirst<number>([])).toThrow("the first element is absent");
    });

    it("throws the given description on an empty array", () => {
        expect(() => presentFirst([], "the leading series")).toThrow("the leading series is absent");
    });
});

describe("presentAt", () => {
    it("returns the element at an in-range index", () => {
        expect(presentAt(["a", "b", "c"], 1)).toBe("b");
    });

    it("throws the default message on an out-of-range index", () => {
        expect(() => presentAt(["a"], 5)).toThrow("the element at index 5 is absent");
    });

    it("throws the given description on a negative index", () => {
        expect(() => presentAt(["a"], -1, "the anchor row")).toThrow("the anchor row is absent");
    });
});

describe("presentLast", () => {
    it("returns the last element of a non-empty array", () => {
        expect(presentLast(["a", "b"])).toBe("b");
    });

    it("throws the default message on an empty array", () => {
        expect(() => presentLast<number>([])).toThrow("the last element is absent");
    });

    it("throws the given description on an empty array", () => {
        expect(() => presentLast([], "the closing row")).toThrow("the closing row is absent");
    });
});

describe("presentFind", () => {
    it("returns the first element the predicate accepts", () => {
        expect(presentFind([3, 1, 2], (value) => value < 3)).toBe(1);
    });

    it("throws the default message when no element matches", () => {
        expect(() => presentFind([1], (value) => value > 5)).toThrow("the matching element is absent");
    });

    it("throws the given description when no element matches", () => {
        expect(() => presentFind([], (value) => value > 5, "the failing record")).toThrow("the failing record is absent");
    });
});

describe("presentGet", () => {
    it("returns the value of a present Map key", () => {
        const source = new Map([["run-1", 7]]);
        expect(presentGet(source, "run-1")).toBe(7);
    });

    it("throws the default message on a Map key that misses, naming the key", () => {
        const source = new Map<string, number>();
        expect(() => presentGet(source, "run-1")).toThrow('the entry for "run-1" is absent');
    });

    it("returns the value of a present record key", () => {
        const source: Readonly<Record<string, number>> = { stage: 2 };
        expect(presentGet(source, "stage")).toBe(2);
    });

    it("throws the given description on a record key that misses", () => {
        const source: Readonly<Record<string, number>> = {};
        expect(() => presentGet(source, "stage", "the stage index")).toThrow("the stage index is absent");
    });

    it("serves the keyed Map overload with a non-string key", () => {
        const source = new Map([[42, "answer"]]);
        expect(presentGet(source, 42)).toBe("answer");
    });
});
