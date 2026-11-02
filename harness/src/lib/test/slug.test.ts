import { describe, expect, it } from "bun:test";

import { slugify } from "../slug.js";

describe("slugify", () => {
    it("lowercases and joins words with one dash", () => {
        expect(slugify("HMGCR Expression")).toBe("hmgcr-expression");
    });

    it("collapses each non-slug run to one dash", () => {
        expect(slugify("a  --  b")).toBe("a-b");
        expect(slugify("a?!.b")).toBe("a-b");
    });

    it("leaves no dash at either edge", () => {
        expect(slugify("--leading-and-trailing--")).toBe("leading-and-trailing");
    });

    it("returns the empty string for an input with no slug character, unless a fallback names one", () => {
        expect(slugify("!!! ???")).toBe("");
        expect(slugify("!!! ???", { fallback: "unnamed" })).toBe("unnamed");
        expect(slugify("", { fallback: "group" })).toBe("group");
    });

    it("stops before the append that would cross the cap, and slices a straddled dash", () => {
        expect(slugify("abcdefghij", { maxLength: 5 })).toBe("abcde");
        // The straddle: at length 2 the dash and the letter append together, the slice keeps the dash, and
        // the committed loop returns it. Callers that cannot hold a trailing dash trim it beside the call.
        expect(slugify("ab-x", { maxLength: 3 })).toBe("ab-");
    });

    it("leaves an input below the cap alone", () => {
        expect(slugify("abc", { maxLength: 60 })).toBe("abc");
        expect(slugify("a".repeat(50))).toBe("a".repeat(50));
    });

    it("gives the same prefix as the uncapped result, because a stop only shortens the tail", () => {
        const samples = ["The T-Cell Receptor — a study!", "  mixed   CASE_name  ", "x".repeat(80), "!!!"];
        for (const sample of samples) {
            expect(slugify(sample, { maxLength: 10 })).toBe(slugify(sample).slice(0, 10));
        }
    });

    it("uses the fallback only when the capped result is empty", () => {
        expect(slugify("ab", { maxLength: 1, fallback: "none" })).toBe("a");
        expect(slugify("!!", { maxLength: 4, fallback: "none" })).toBe("none");
    });
});
