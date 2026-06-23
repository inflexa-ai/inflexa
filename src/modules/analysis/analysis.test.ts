import { describe, expect, test } from "bun:test";

import { makeBaseSlug } from "./analysis.ts";

describe("makeBaseSlug", () => {
    test("lowercases and kebab-cases a name", () => {
        expect(makeBaseSlug("My Analysis")).toBe("my-analysis");
    });

    test("collapses runs of symbols into a single dash and trims the edges", () => {
        expect(makeBaseSlug("  --Foo___Bar!!!  ")).toBe("foo-bar");
    });

    test("strips diacritics via NFKD normalization", () => {
        expect(makeBaseSlug("Café")).toBe("cafe");
    });

    test("falls back to a generated handle when the name slugs to empty", () => {
        expect(makeBaseSlug("!!!")).toMatch(/^analysis-[0-9a-f]{6}$/);
    });
});
