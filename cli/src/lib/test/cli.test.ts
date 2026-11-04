import { describe, expect, test } from "bun:test";

import { replaceProperty } from "../../test_support/replace_property.ts";
import { stdinIsTTY } from "../cli.ts";

describe("stdinIsTTY", () => {
    // The same object as `process.stdin`, typed as a pipe sees it: the property can be absent.
    const stdin: { isTTY?: boolean } = process.stdin;

    test("is true when stdin is a terminal", () => {
        replaceProperty(stdin, "isTTY", true);
        expect(stdinIsTTY()).toBe(true);
    });

    test("is false when stdin is not a terminal", () => {
        replaceProperty(stdin, "isTTY", false);
        expect(stdinIsTTY()).toBe(false);
    });

    test("is false when stdin has no isTTY property, as a pipe has none", () => {
        replaceProperty(stdin, "isTTY", undefined);
        expect(stdinIsTTY()).toBe(false);
    });

    test("reads the property at each call", () => {
        replaceProperty(stdin, "isTTY", true);
        expect(stdinIsTTY()).toBe(true);
        replaceProperty(stdin, "isTTY", false);
        expect(stdinIsTTY()).toBe(false);
    });
});
