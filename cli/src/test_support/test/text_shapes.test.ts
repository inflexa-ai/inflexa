import { describe, expect, test } from "bun:test";

import { countOccurrences, hasDigitRatio, hasNumberBefore, isHexColor, isLowerHex, literalWithHoles, WORD, WORD_DASH, wordTokens } from "../text_shapes.ts";

describe("isLowerHex", () => {
    test("accepts exactly the length of lowercase hex digits", () => {
        expect(isLowerHex("0123456789abcdef", 16)).toBe(true);
        expect(isLowerHex("abc", 4)).toBe(false);
        expect(isLowerHex("abcde", 4)).toBe(false);
    });

    test("refuses an uppercase digit, a non-hex letter, and the empty text", () => {
        expect(isLowerHex("abcD", 4)).toBe(false);
        expect(isLowerHex("abcg", 4)).toBe(false);
        expect(isLowerHex("", 0)).toBe(false);
    });

    test("with no length it takes any non-empty run of lowercase hex digits", () => {
        expect(isLowerHex("0f9")).toBe(true);
        expect(isLowerHex("")).toBe(false);
        expect(isLowerHex("0F9")).toBe(false);
    });
});

describe("isHexColor", () => {
    test("accepts a hash and six hex digits of either case", () => {
        expect(isHexColor("#0a1B2c")).toBe(true);
        expect(isHexColor("#FFFFFF")).toBe(true);
    });

    test("refuses a short or long run, a missing hash, a non-hex digit, and a trailing newline", () => {
        expect(isHexColor("#fff")).toBe(false);
        expect(isHexColor("#0a1B2c3")).toBe(false);
        expect(isHexColor("0a1B2c0")).toBe(false);
        expect(isHexColor("#0a1B2g")).toBe(false);
        expect(isHexColor("#0a1B2c\n")).toBe(false);
        expect(isHexColor("")).toBe(false);
    });
});

describe("wordTokens", () => {
    test("cuts the text at each character that is not an ASCII word character", () => {
        expect(wordTokens("S1 | S10, a_b-c")).toEqual(["S1", "S10", "a_b", "c"]);
        expect(wordTokens("  ")).toEqual([]);
        expect(wordTokens("")).toEqual([]);
        expect(wordTokens("800.5 1800 800")).toEqual(["800", "5", "1800", "800"]);
    });

    test("a non-ASCII letter is a boundary, as it is for a pattern boundary", () => {
        expect(wordTokens("aéb")).toEqual(["a", "b"]);
    });
});

describe("hasNumberBefore", () => {
    test("needs an ASCII digit right before the suffix", () => {
        expect(hasNumberBefore("took 5s", "s")).toBe(true);
        expect(hasNumberBefore("took 5 s", "s")).toBe(false);
        expect(hasNumberBefore("2 inputs", " input")).toBe(true);
        expect(hasNumberBefore("no inputs", " input")).toBe(false);
        expect(hasNumberBefore("s", "s")).toBe(false);
        expect(hasNumberBefore("1s then s", "s")).toBe(true);
    });
});

describe("hasDigitRatio", () => {
    test("needs a digit on each side of a slash", () => {
        expect(hasDigitRatio("7/13")).toBe(true);
        expect(hasDigitRatio("7 / 13")).toBe(false);
        expect(hasDigitRatio("a/13")).toBe(false);
        expect(hasDigitRatio("7/")).toBe(false);
        expect(hasDigitRatio("/")).toBe(false);
        expect(hasDigitRatio("a/b 3/4")).toBe(true);
    });

    test("with spaced it also takes white space around the slash", () => {
        expect(hasDigitRatio("7 / 13", true)).toBe(true);
        expect(hasDigitRatio("7\u00a0/\t13", true)).toBe(true);
        expect(hasDigitRatio("7 / x", true)).toBe(false);
        expect(hasDigitRatio("7 /", true)).toBe(false);
    });
});

describe("countOccurrences", () => {
    test("counts non-overlapping copies of a literal", () => {
        expect(countOccurrences("a(b(c(", "(")).toBe(3);
        expect(countOccurrences("aaaa", "aa")).toBe(2);
        expect(countOccurrences("abc", "x")).toBe(0);
    });

    test("counts non-overlapping matches of a pattern with a hole", () => {
        const pattern = literalWithHoles`used(${WORD_DASH}, `;
        expect(countOccurrences("used(a-b, used(c, x used(, ", pattern)).toBe(2);
        expect(countOccurrences("none", pattern)).toBe(0);
    });

    test("counts two adjacent matches and a match at each end of the text", () => {
        const pattern = literalWithHoles`<${WORD}>`;
        expect(countOccurrences("<a><bc>", pattern)).toBe(2);
        expect(countOccurrences("<a>", pattern)).toBe(1);
        expect(countOccurrences("x<a>y<b>z", pattern)).toBe(2);
    });

    test("a pattern that cannot match gives zero, and the empty text gives zero", () => {
        expect(countOccurrences("abc", literalWithHoles`${WORD}-`)).toBe(0);
        expect(countOccurrences("", literalWithHoles`a${WORD}`)).toBe(0);
        expect(countOccurrences("", "x")).toBe(0);
    });
});

describe("literalWithHoles", () => {
    test("escapes the literal parts and the string values", () => {
        const pattern = literalWithHoles`used(${"a.b"}; `;
        expect(pattern.test("used(a.b; ")).toBe(true);
        expect(pattern.test("used(aXb; ")).toBe(false);
    });

    test("a word hole takes word characters and a dash hole also takes hyphens", () => {
        expect(literalWithHoles`x-${WORD};`.test("x-ab_1;")).toBe(true);
        expect(literalWithHoles`x-${WORD};`.test("x-a-b;")).toBe(false);
        expect(literalWithHoles`x-${WORD_DASH};`.test("x-a-b;")).toBe(true);
        expect(literalWithHoles`x-${WORD};`.test("x-;")).toBe(false);
    });
});
