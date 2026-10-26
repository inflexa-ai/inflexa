import { describe, expect, it } from "bun:test";

import { textOf } from "../unknown-text.js";

describe("textOf", () => {
    it("keeps a string itself, and gives each primitive and function its String render", () => {
        expect(textOf("plain")).toBe("plain");
        expect(textOf("")).toBe("");
        expect(textOf(0)).toBe("0");
        expect(textOf(1.5)).toBe("1.5");
        expect(textOf(false)).toBe("false");
        expect(textOf(10n)).toBe("10");
        expect(textOf(Symbol("s"))).toBe("Symbol(s)");
        expect(textOf(function named() {})).toContain("named");
    });

    it("names a missing value as null and undefined, the String render", () => {
        expect(textOf(null)).toBe("null");
        expect(textOf(undefined)).toBe("undefined");
    });

    it("renders a record and an array as JSON", () => {
        expect(textOf({ a: 1 })).toBe('{"a":1}');
        expect(textOf([1, "two"])).toBe('[1,"two"]');
    });

    it("falls back to the default object stringification when JSON cannot render", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(textOf(cyclic)).toBe("[object Object]");
        expect(textOf({ big: 1n })).toBe("[object Object]");
    });

    it("falls back to the default object stringification when a toJSON gives undefined", () => {
        // `JSON.stringify` returns `undefined` for such a value rather than throwing.
        expect(textOf({ toJSON: () => undefined })).toBe("[object Object]");
    });
});
