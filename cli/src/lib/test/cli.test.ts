import { afterEach, describe, expect, test } from "bun:test";

import { stdinIsTTY } from "../cli.ts";

describe("stdinIsTTY", () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    afterEach(() => {
        // A stdin that had no own `isTTY` reads `undefined` again after this.
        Object.defineProperty(process.stdin, "isTTY", original ?? { value: undefined, configurable: true });
    });

    test("is true when stdin is a terminal", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        expect(stdinIsTTY()).toBe(true);
    });

    test("is false when stdin is not a terminal", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
        expect(stdinIsTTY()).toBe(false);
    });

    test("is false when stdin has no isTTY property, as a pipe has none", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
        expect(stdinIsTTY()).toBe(false);
    });

    test("reads the property at each call", () => {
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        expect(stdinIsTTY()).toBe(true);
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
        expect(stdinIsTTY()).toBe(false);
    });
});
