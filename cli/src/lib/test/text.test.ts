import { describe, expect, test } from "bun:test";

import {
    ASCII_DIGITS,
    ASCII_LOWERCASE,
    ASCII_UPPERCASE,
    collapseWhitespace,
    consistsOf,
    hasWhitespace,
    isAsciiDigits,
    isPrintableAscii,
    isWhitespace,
    mentionsAny,
    splitWhitespace,
    trimTrailing,
    withoutPrefix,
    withoutSuffix,
} from "../text.ts";

// Each reference below is the pattern that a helper replaces. The test holds the helper to the exact
// result of the pattern on edge inputs, so a call site can swap one for the other.
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the reference pattern that `trimTrailing` replaces; the test compares the two
const TRAILING_SLASHES = /\/+$/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the reference pattern that `trimTrailing` replaces; the test compares the two
const TRAILING_SEPARATORS = /[/\\]+$/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the reference pattern that `isAsciiDigits` replaces; the test compares the two
const DIGITS = /^\d+$/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the reference pattern that `isWhitespace` and `hasWhitespace` replace; the test compares the two
const WHITESPACE = /\s/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the reference pattern that `splitWhitespace` replaces; the test compares the two
const WHITESPACE_RUN = /\s+/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the reference pattern that `collapseWhitespace` replaces; the test compares the two
const WHITESPACE_RUNS = /\s+/g;

const SPACE_INPUTS = [
    "",
    " ",
    "a",
    "a b",
    " a",
    "a ",
    " a ",
    "a   b",
    "a \t\n b",
    "  ",
    "a\u00a0b",
    "\u00a0a",
    "a\ufeff",
    "a\u3000b\u3000",
    "\u2028a\u2029",
    "a\u200bb",
    "a\u0085b",
    "a\u180eb",
    "x\u{1f600} y",
];

describe("trimTrailing", () => {
    const inputs = ["", "/", "///", "a", "a/", "a//", "/a", "//a//", "a/b", "a\\", "a\\/\\", "a/\n", "a\u00a0/"];

    test("matches the replace of a trailing run on each input", () => {
        for (const input of inputs) {
            expect(trimTrailing(input, "/")).toBe(input.replace(TRAILING_SLASHES, ""));
            expect(trimTrailing(input, "/\\")).toBe(input.replace(TRAILING_SEPARATORS, ""));
        }
    });

    test("cuts only the trailing run", () => {
        expect(trimTrailing("//a//b//", "/")).toBe("//a//b");
        expect(trimTrailing("abc", "")).toBe("abc");
    });
});

describe("isAsciiDigits", () => {
    const inputs = ["", "0", "7", "0123", "12a", "a12", "+1", "-1", "1e3", "1.5", " 1", "1 ", "1\n", "\u0661\u0662", "\uff11", "1\u0661", "\u{1f600}"];

    test("matches the digit pattern on each input", () => {
        for (const input of inputs) {
            expect(isAsciiDigits(input)).toBe(DIGITS.test(input));
        }
    });

    test("refuses the empty text and a non-ASCII digit", () => {
        expect(isAsciiDigits("")).toBe(false);
        expect(isAsciiDigits("\u0661")).toBe(false);
        expect(isAsciiDigits("12\n")).toBe(false);
    });
});

describe("whitespace helpers", () => {
    test("isWhitespace and hasWhitespace match `\\s` on each input", () => {
        for (const input of SPACE_INPUTS) {
            expect(hasWhitespace(input)).toBe(WHITESPACE.test(input));
        }
        for (const char of ["", " ", "\t", "\u00a0", "\ufeff", "\u3000", "\u2028", "\u200b", "\u0085", "\u180e", "a"]) {
            expect(isWhitespace(char)).toBe(char !== "" && WHITESPACE.test(char));
        }
    });

    test("splitWhitespace gives the array of `split(/\\s+/)` on each input", () => {
        for (const input of SPACE_INPUTS) {
            expect(splitWhitespace(input)).toEqual(input.split(WHITESPACE_RUN));
        }
    });

    test("splitWhitespace keeps the empty first and last item and gives one item for the empty text", () => {
        expect(splitWhitespace(" a ")).toEqual(["", "a", ""]);
        expect(splitWhitespace("")).toEqual([""]);
    });

    test("collapseWhitespace gives the result of the global replace on each input", () => {
        for (const input of SPACE_INPUTS) {
            expect(collapseWhitespace(input)).toBe(input.replace(WHITESPACE_RUNS, " "));
        }
    });
});

describe("withoutPrefix and withoutSuffix", () => {
    test("cut one copy at the edge and nothing else", () => {
        expect(withoutPrefix("W/abc", "W/")).toBe("abc");
        expect(withoutPrefix("W/W/abc", "W/")).toBe("W/abc");
        expect(withoutPrefix("abcW/", "W/")).toBe("abcW/");
        expect(withoutPrefix("", "W/")).toBe("");
        expect(withoutPrefix("W/", "W/")).toBe("");
        expect(withoutSuffix("a\r", "\r")).toBe("a");
        expect(withoutSuffix("a/v1/v1", "/v1")).toBe("a/v1");
        expect(withoutSuffix("/v1a", "/v1")).toBe("/v1a");
        expect(withoutSuffix("", "/v1")).toBe("");
        expect(withoutSuffix("/v1", "/v1")).toBe("");
    });
});

describe("mentionsAny", () => {
    test("compares the lowercase text with each lowercase phrase", () => {
        expect(mentionsAny("Error: No Such Image: x", ["no such image", "image not known"])).toBe(true);
        expect(mentionsAny("IMAGE NOT KNOWN", ["no such image", "image not known"])).toBe(true);
        expect(mentionsAny("no such", ["no such image"])).toBe(false);
        expect(mentionsAny("", ["no such image"])).toBe(false);
        expect(mentionsAny("anything", [])).toBe(false);
    });
});

describe("consistsOf", () => {
    const slugChars = ASCII_LOWERCASE + ASCII_DIGITS + "._-";

    test("holds the first character to its own alphabet", () => {
        expect(consistsOf("a1._-", slugChars, ASCII_LOWERCASE + ASCII_DIGITS)).toBe(true);
        expect(consistsOf("-a", slugChars, ASCII_LOWERCASE + ASCII_DIGITS)).toBe(false);
        expect(consistsOf("A", slugChars, ASCII_LOWERCASE + ASCII_DIGITS)).toBe(false);
        expect(consistsOf("aB", slugChars, ASCII_LOWERCASE + ASCII_DIGITS)).toBe(false);
    });

    test("refuses the empty text, a line break, and a non-ASCII character", () => {
        expect(consistsOf("", slugChars)).toBe(false);
        expect(consistsOf("a\n", slugChars)).toBe(false);
        expect(consistsOf("a\u00e9", slugChars)).toBe(false);
        expect(consistsOf("a\u{1f600}", slugChars)).toBe(false);
        expect(consistsOf("Az09", ASCII_UPPERCASE + ASCII_LOWERCASE + ASCII_DIGITS)).toBe(true);
    });
});

describe("isPrintableAscii", () => {
    test("accepts the space to the tilde and nothing else", () => {
        for (const char of [" ", "a", "~", "0", "!"]) expect(isPrintableAscii(char)).toBe(true);
        for (const char of ["", "\t", "\n", "\x7f", "\u00e9", "\u{1f600}", "ab"]) expect(isPrintableAscii(char)).toBe(false);
    });
});
