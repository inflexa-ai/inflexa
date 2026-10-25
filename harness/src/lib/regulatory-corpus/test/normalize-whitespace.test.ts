import { describe, expect, test } from "bun:test";

import { normalizeWhitespace } from "../normalize-whitespace.js";

describe("normalizeWhitespace", () => {
    test("a CRLF run collapses to one blank line", () => {
        expect(normalizeWhitespace("a\r\n\r\n\r\nb")).toBe("a\n\nb");
        expect(normalizeWhitespace("a\r\n\r\nb")).toBe("a\n\nb");
    });

    test("a lone CRLF stays one newline", () => {
        expect(normalizeWhitespace("a\r\nb")).toBe("a\nb");
    });

    test("an LF run caps at one blank line", () => {
        expect(normalizeWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
        expect(normalizeWhitespace("a\nb")).toBe("a\nb");
    });

    test("space and tab runs inside lines collapse to one space", () => {
        expect(normalizeWhitespace("a \t \t b")).toBe("a b");
        expect(normalizeWhitespace("a  \n  b")).toBe("a \n b");
    });

    // The deleted pass order collapsed space runs before it deleted the CR, so a CR between
    // two spaces leaves both spaces; a CR between letters leaves none.
    test("a CR with no newline beside it drops without merging a space run", () => {
        expect(normalizeWhitespace("a\rb")).toBe("ab");
        expect(normalizeWhitespace("a \r b")).toBe("a  b");
    });

    test("the edges trim", () => {
        expect(normalizeWhitespace("  a\n")).toBe("a");
        expect(normalizeWhitespace("a\r\n\r\n")).toBe("a");
    });
});
